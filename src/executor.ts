import { encodeFunctionData, formatEther, maxUint256, parseEther } from "viem";
import { pub, wallet, account } from "./chain.js";
import { ADDR, EXPLORER, HARD, LIVE } from "./config.js";
import { ADDRESS_THIS, erc20Abi, quoterAbi, routerAbi } from "./abi.js";
import type { PoolInfo } from "./market.js";
import { fmtEth, log } from "./util.js";

export type Fill = { ethAmount: number; tokenAmount: bigint; txHash?: string; simulated: boolean };

/** Assumed extra slippage applied to dry-run fills so paper results stay honest. */
const DRY_RUN_SLIPPAGE_PCT = 1.0;

async function quote(tokenIn: `0x${string}`, tokenOut: `0x${string}`, fee: number, amountIn: bigint): Promise<bigint> {
  const { result } = await pub.simulateContract({
    address: ADDR.QUOTER_V2,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

/** Buy `sizeEth` of token with native ETH (router wraps). */
export async function buy(info: PoolInfo, sizeEth: number): Promise<Fill> {
  const amountIn = parseEther(sizeEth.toString());
  const quoted = await quote(ADDR.WETH, info.token, info.fee, amountIn);
  const minOut = (quoted * BigInt(Math.floor((100 - HARD.MAX_SLIPPAGE_PCT) * 100))) / 10000n;

  if (!LIVE || !wallet || !account) {
    const tokenAmount = (quoted * BigInt(Math.floor((100 - DRY_RUN_SLIPPAGE_PCT) * 100))) / 10000n;
    log("exec", `DRY BUY ${info.symbol}: ${sizeEth} ETH -> ${tokenAmount} raw`);
    return { ethAmount: sizeEth, tokenAmount, simulated: true };
  }

  const before = await pub.readContract({ address: info.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const hash = await wallet.writeContract({
    address: ADDR.SWAP_ROUTER_02,
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [{ tokenIn: ADDR.WETH, tokenOut: info.token, fee: info.fee, recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    value: amountIn,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (rcpt.status !== "success") throw new Error(`buy tx reverted: ${hash}`);
  const after = await pub.readContract({ address: info.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const got = after - before;
  log("exec", `LIVE BUY ${info.symbol}: ${sizeEth} ETH -> ${got} raw | proof: ${EXPLORER}/tx/${hash}`);
  return { ethAmount: sizeEth, tokenAmount: got, txHash: hash, simulated: false };
}

/** Sell the full token amount back to native ETH (swap to router, unwrap to wallet). */
export async function sell(info: PoolInfo, tokenAmount: bigint): Promise<Fill> {
  const quoted = await quote(info.token, ADDR.WETH, info.fee, tokenAmount);
  const minOut = (quoted * BigInt(Math.floor((100 - HARD.MAX_SLIPPAGE_PCT) * 100))) / 10000n;

  if (!LIVE || !wallet || !account) {
    const ethOut = (quoted * BigInt(Math.floor((100 - DRY_RUN_SLIPPAGE_PCT) * 100))) / 10000n;
    log("exec", `DRY SELL ${info.symbol}: ${tokenAmount} raw -> ${fmtEth(ethOut)} ETH`);
    return { ethAmount: Number(formatEther(ethOut)), tokenAmount, simulated: true };
  }

  const allowance = await pub.readContract({ address: info.token, abi: erc20Abi, functionName: "allowance", args: [account.address, ADDR.SWAP_ROUTER_02] });
  if (allowance < tokenAmount) {
    const h = await wallet.writeContract({ address: info.token, abi: erc20Abi, functionName: "approve", args: [ADDR.SWAP_ROUTER_02, maxUint256] });
    await pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
  }

  const swapCall = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [{ tokenIn: info.token, tokenOut: ADDR.WETH, fee: info.fee, recipient: ADDRESS_THIS, amountIn: tokenAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  });
  const unwrapCall = encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minOut, account.address] });

  const balBefore = await pub.getBalance({ address: account.address });
  const hash = await wallet.writeContract({ address: ADDR.SWAP_ROUTER_02, abi: routerAbi, functionName: "multicall", args: [[swapCall, unwrapCall]] });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (rcpt.status !== "success") throw new Error(`sell tx reverted: ${hash}`);
  const balAfter = await pub.getBalance({ address: account.address });
  const gasWei = rcpt.gasUsed * rcpt.effectiveGasPrice;
  const ethOut = Number(formatEther(balAfter - balBefore + gasWei));
  log("exec", `LIVE SELL ${info.symbol}: ${tokenAmount} raw -> ${ethOut.toFixed(6)} ETH | proof: ${EXPLORER}/tx/${hash}`);
  return { ethAmount: ethOut, tokenAmount, txHash: hash, simulated: false };
}

export async function walletEthBalance(): Promise<number> {
  if (!account) return Number.POSITIVE_INFINITY; // dry-run: unconstrained
  return Number(formatEther(await pub.getBalance({ address: account.address })));
}
