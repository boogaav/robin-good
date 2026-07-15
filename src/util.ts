import { formatEther } from "viem";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(tag: string, msg: string) {
  console.log(`${new Date().toISOString()} [${tag}] ${msg}`);
}

export function fmtEth(wei: bigint, digits = 6): string {
  return Number(formatEther(wei)).toFixed(digits);
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Median of a numeric array; 0 for empty. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
