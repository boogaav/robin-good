import { parseEther, formatEther, getAddress } from "viem";
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

/** Token contract creator via Blockscout; null if unavailable. */
export async function tokenCreator(token: `0x${string}`): Promise<`0x${string}` | null> {
  try {
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${token}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { creator_address_hash?: string };
    return j.creator_address_hash ? getAddress(j.creator_address_hash) : null;
  } catch {
    return null;
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

export async function addRug(token: `0x${string}`, note: string) {
  const bl = blacklist.load();
  if (!bl.tokens.includes(token.toLowerCase())) bl.tokens.push(token.toLowerCase());
  const creator = await tokenCreator(token);
  if (creator && !bl.creators.includes(creator.toLowerCase())) bl.creators.push(creator.toLowerCase());
  blacklist.save(bl);
  log("safety", `blacklisted token ${token}${creator ? ` + creator ${creator}` : ""} (${note})`);
}

export { poolAbi };
