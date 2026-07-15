import { formatEther, getAddress } from "viem";
import { pub } from "./chain.js";
import { ADDR } from "./config.js";
import { erc20Abi, factoryAbi, poolAbi } from "./abi.js";

export type PoolInfo = {
  pool: `0x${string}`;
  token: `0x${string}`;      // the non-WETH side
  tokenIsToken0: boolean;
  fee: number;
  symbol: string;
  decimals: number;
  createdAt?: number;        // ms, only known for pools we saw created
};

const cache = new Map<string, PoolInfo | null>(); // null = checked, not a canonical WETH pool

/**
 * Resolve a pool address into PoolInfo iff it is a WETH pair created by the
 * canonical Uniswap v3 factory. Anything else (clone factories, token/token
 * pools) resolves to null and is ignored by the whole agent.
 */
export async function resolvePool(addr: `0x${string}`): Promise<PoolInfo | null> {
  const key = addr.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  try {
    const [token0, token1, fee] = await Promise.all([
      pub.readContract({ address: addr, abi: poolAbi, functionName: "token0" }),
      pub.readContract({ address: addr, abi: poolAbi, functionName: "token1" }),
      pub.readContract({ address: addr, abi: poolAbi, functionName: "fee" }),
    ]);
    const weth = ADDR.WETH.toLowerCase();
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    if (t0 !== weth && t1 !== weth) return remember(key, null);

    const canonical = await pub.readContract({
      address: ADDR.UNIV3_FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, fee],
    });
    if (canonical.toLowerCase() !== key) return remember(key, null);

    const token = getAddress(t0 === weth ? token1 : token0);
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "???"),
      pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ]);
    return remember(key, { pool: getAddress(addr), token, tokenIsToken0: t1 === weth, fee: Number(fee), symbol, decimals: Number(decimals) });
  } catch {
    return remember(key, null); // not a v3 pool at all
  }
}

function remember(key: string, info: PoolInfo | null): PoolInfo | null {
  cache.set(key, info);
  return info;
}

export function markCreated(addr: `0x${string}`) {
  const info = cache.get(addr.toLowerCase());
  if (info) info.createdAt = Date.now();
}

/** ETH per whole token from a pool's sqrtPriceX96. */
export function priceFromSqrt(info: PoolInfo, sqrtPriceX96: bigint): number {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 raw per token0 raw
  const rawEthPerToken = info.tokenIsToken0 ? ratio : 1 / ratio;
  return rawEthPerToken * 10 ** info.decimals / 1e18;
}

export async function currentPrice(info: PoolInfo): Promise<number> {
  const [sqrtPriceX96] = await pub.readContract({ address: info.pool, abi: poolAbi, functionName: "slot0" });
  return priceFromSqrt(info, sqrtPriceX96);
}

export async function poolWethBalanceEth(pool: `0x${string}`): Promise<number> {
  const bal = await pub.readContract({ address: ADDR.WETH, abi: erc20Abi, functionName: "balanceOf", args: [pool] });
  return Number(formatEther(bal));
}
