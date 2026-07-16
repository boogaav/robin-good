import { parseEther, formatEther, getAddress, keccak256 } from "viem";
import { pub } from "./chain.js";
import { ADDR, EXPLORER } from "./config.js";
import { erc20Abi, poolAbi, quoterAbi } from "./abi.js";
import { blacklist } from "./state.js";
import { log } from "./util.js";

export type SafetyResult = { ok: boolean; reason: string; roundTripLossPct?: number; poolWethEth?: number };

/**
 * Pre-entry safety gate:
 *  1. token/creator not blacklisted (rug history)
 *  2. WETH-side pool liquidity above minimum
 *  3. round-trip quote: buying `sizeEth` then quoting the sale of the received
 *     tokens must not lose more than maxRoundTripLossPct beyond normal price
 *     impact — catches sell-taxed tokens and quoter-visible honeypots.
 * (A token can still hard-block sells at transfer level in ways a quoter can't
 *  see; position sizing and the daily loss cap are the real backstop.)
 */
export async function checkSafety(
  token: `0x${string}`,
  pool: `0x${string}`,
  fee: number,
  sizeEth: number,
  minPoolWethEth: number,
  maxRoundTripLossPct: number,
): Promise<SafetyResult> {
  const bl = blacklist.load();
  if (bl.tokens.includes(token.toLowerCase())) return { ok: false, reason: "token blacklisted" };

  const creator = await tokenCreator(token);
  if (creator && bl.creators.includes(creator.toLowerCase()))
    return { ok: false, reason: `creator ${creator} blacklisted` };

  // Reuse of a token template that has produced a honeypot before → skip it.
  const codehash = await tokenCodeHash(token);
  if (codehash && bl.codehashes?.includes(codehash))
    return { ok: false, reason: `code template ${codehash.slice(0, 12)} tied to a past honeypot` };

  const poolWeth = await pub.readContract({
    address: ADDR.WETH,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [pool],
  });
  const poolWethEth = Number(formatEther(poolWeth));
  if (poolWethEth < minPoolWethEth)
    return { ok: false, reason: `pool WETH ${poolWethEth.toFixed(3)} < min ${minPoolWethEth}`, poolWethEth };

  const amountIn = parseEther(sizeEth.toString());
  try {
    const [tokensOut] = await pub.simulateContract({
      address: ADDR.QUOTER_V2,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: ADDR.WETH, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: 0n }],
    }).then((r) => r.result);
    if (tokensOut === 0n) return { ok: false, reason: "buy quote returned 0", poolWethEth };

    const [ethBack] = await pub.simulateContract({
      address: ADDR.QUOTER_V2,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: token, tokenOut: ADDR.WETH, amountIn: tokensOut, fee, sqrtPriceLimitX96: 0n }],
    }).then((r) => r.result);

    const lossPct = (1 - Number(formatEther(ethBack)) / sizeEth) * 100;
    if (lossPct > maxRoundTripLossPct)
      return { ok: false, reason: `round-trip loss ${lossPct.toFixed(1)}% > ${maxRoundTripLossPct}%`, roundTripLossPct: lossPct, poolWethEth };
    return { ok: true, reason: "passed", roundTripLossPct: lossPct, poolWethEth };
  } catch (e) {
    return { ok: false, reason: `quote reverted (likely honeypot): ${(e as Error).message.slice(0, 120)}`, poolWethEth };
  }
}

/** Token contract creator via Blockscout; null if unavailable. Cached. */
const creatorCache = new Map<string, `0x${string}` | null>();
export async function tokenCreator(token: `0x${string}`): Promise<`0x${string}` | null> {
  const key = token.toLowerCase();
  if (creatorCache.has(key)) return creatorCache.get(key)!;
  try {
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${token}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null; // transient — don't cache
    const j = (await res.json()) as { creator_address_hash?: string };
    const creator = j.creator_address_hash ? getAddress(j.creator_address_hash) : null;
    creatorCache.set(key, creator);
    return creator;
  } catch {
    return null;
  }
}

export type CreatorScreen = { ok: boolean; reason: string; features: Record<string, number> };

/**
 * Dev-wallet screening: a token deployed by a fresh dust-balance EOA is a
 * classic rug setup. Contract deployers (launchpads) pass — they're judged by
 * the launchpad trust record instead. Unknown data passes (never block on a
 * flaky explorer), but everything observed is journaled for the learner.
 */
export async function screenCreator(token: `0x${string}`): Promise<CreatorScreen> {
  const creator = await tokenCreator(token);
  if (!creator) return { ok: true, reason: "creator unknown", features: {} };
  try {
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${creator}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: true, reason: `explorer ${res.status}`, features: {} };
    const j = (await res.json()) as { is_contract?: boolean; coin_balance?: string; transactions_count?: string | number; transaction_count?: string | number };
    if (j.is_contract) return { ok: true, reason: "contract deployer (launchpad)", features: { creatorIsContract: 1 } };
    const balEth = Number(j.coin_balance ?? 0) / 1e18;
    const txRaw = j.transactions_count ?? j.transaction_count;
    const txCount = txRaw === undefined ? -1 : Number(txRaw);
    const features = { creatorIsContract: 0, creatorBalEth: balEth, creatorTxCount: txCount };
    if (txCount >= 0 && txCount < 3 && balEth < 0.002)
      return { ok: false, reason: `fresh burner deployer (${txCount} txs, ${balEth.toFixed(4)} ETH)`, features };
    return { ok: true, reason: "creator passes", features };
  } catch {
    return { ok: true, reason: "screen unavailable", features: {} };
  }
}

/** Detect a rug on an open position: WETH-side liquidity collapsed. */
export async function liquidityCollapsed(pool: `0x${string}`, entryPoolWethEth: number): Promise<boolean> {
  try {
    const bal = await pub.readContract({ address: ADDR.WETH, abi: erc20Abi, functionName: "balanceOf", args: [pool] });
    return Number(formatEther(bal)) < entryPoolWethEth * 0.35;
  } catch (e) {
    log("safety", `liquidity check failed: ${(e as Error).message.slice(0, 80)}`);
    return false;
  }
}

/**
 * keccak256 of the token's deployed bytecode. Honeypot factories reuse a single
 * token template across many launches, so once a template produces ONE honeypot
 * we can refuse every future instance of that exact code — a defense that
 * compounds. (It cannot stop the FIRST honeypot of a brand-new template, and it
 * may also skip a benign token sharing a tainted template — an acceptable trade,
 * since that template is a proven latent trap.)
 */
const codeHashCache = new Map<string, `0x${string}` | null>();
export async function tokenCodeHash(token: `0x${string}`): Promise<`0x${string}` | null> {
  const key = token.toLowerCase();
  if (codeHashCache.has(key)) return codeHashCache.get(key)!;
  try {
    const code = await pub.getCode({ address: token });
    const h = code && code !== "0x" ? keccak256(code) : null;
    codeHashCache.set(key, h);
    return h;
  } catch {
    return null;
  }
}

export async function codehashBlacklisted(token: `0x${string}`): Promise<boolean> {
  const h = await tokenCodeHash(token);
  if (!h) return false;
  return blacklist.load().codehashes?.includes(h) ?? false;
}

export async function addRug(token: `0x${string}`, note: string) {
  const bl = blacklist.load();
  if (!bl.tokens.includes(token.toLowerCase())) bl.tokens.push(token.toLowerCase());
  const creator = await tokenCreator(token);
  if (creator && !bl.creators.includes(creator.toLowerCase())) bl.creators.push(creator.toLowerCase());
  const h = await tokenCodeHash(token);
  bl.codehashes = bl.codehashes ?? [];
  if (h && !bl.codehashes.includes(h)) bl.codehashes.push(h);
  blacklist.save(bl);
  log("safety", `blacklisted token ${token}${creator ? ` + creator ${creator}` : ""}${h ? ` + codehash ${h.slice(0, 12)}` : ""} (${note})`);
}

export { poolAbi };
