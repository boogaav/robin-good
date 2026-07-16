import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAddress } from "viem";
import { findWethPool, type PoolInfo } from "./market.js";
import type { Params } from "./params.js";
import { log } from "./util.js";

const exec = promisify(execFile);

/**
 * NOXA launchpad strategy. NOXA (fun.noxa.fi) launches tokens straight into
 * Uniswap v3 with permanently-locked LP — structurally immune to liquidity
 * rugs. We poll GMGN's trenches feed filtered to launchpad=noxa, newest first,
 * and surface fresh launches with a tradeable WETH pool. They still pass the
 * full safety gate (honeypot logic can live in the token regardless of who
 * launched it), but NOXA's locked LP removes the biggest rug vector.
 */

type Trench = {
  address: string;
  symbol: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  volume_1h?: number;
  holder_count?: number;
  rug_ratio?: number;
  launchpad_platform?: string;
};

export type NoxaCandidate = {
  kind: "noxa";
  info: PoolInfo;
  price: number;
  features: Record<string, number>;
  launchpad: string;
};

export class NoxaScanner {
  private lastPoll = 0;
  private seen = new Set<string>();
  private pollMs: number;
  private maxAgeSec: number;

  constructor(pollMs = 60_000, maxAgeSec = 1800) {
    this.pollMs = pollMs;
    this.maxAgeSec = maxAgeSec;
  }

  async candidates(_p: Params): Promise<NoxaCandidate[]> {
    if (Date.now() - this.lastPoll < this.pollMs) return [];
    this.lastPoll = Date.now();
    let trenches: Trench[];
    try {
      const { stdout } = await exec(
        "gmgn-cli",
        ["market", "trenches", "--chain", "robinhood", "--type", "new_creation", "--sort-by", "created_timestamp", "--limit", "80"],
        { timeout: 12_000 },
      );
      // Response is keyed by category: { new_creation: [...], completed: [...], pump: [...] }
      const parsed = JSON.parse(stdout) as Record<string, Trench[]>;
      const fresh = parsed.new_creation ?? [];
      // Filter to NOXA client-side (the launchpad label is on each token).
      trenches = fresh.filter((t) => (t.launchpad_platform ?? "").toLowerCase().includes("noxa"));
    } catch (e) {
      log("noxa", `trenches unavailable: ${(e as Error).message.slice(0, 80)}`);
      return [];
    }

    const now = Math.floor(Date.now() / 1000);
    const out: NoxaCandidate[] = [];
    for (const t of trenches) {
      const key = t.address.toLowerCase();
      if (this.seen.has(key)) continue;
      if (t.created_timestamp && now - t.created_timestamp > this.maxAgeSec) continue; // too old
      this.seen.add(key);
      let info: PoolInfo | null;
      try { info = await findWethPool(getAddress(t.address)); } catch { continue; }
      if (!info) continue;
      log("noxa", `new NOXA launch: ${info.symbol} ${info.token} mcap=$${Math.round(t.usd_market_cap ?? 0)}`);
      out.push({
        kind: "noxa",
        info,
        price: 0,
        launchpad: "noxa",
        features: { ageSec: t.created_timestamp ? now - t.created_timestamp : 0, mcapUsd: t.usd_market_cap ?? 0, vol1hUsd: t.volume_1h ?? 0, holders: t.holder_count ?? 0, rugRatio: t.rug_ratio ?? 0 },
      });
      if (out.length >= 5) break;
    }
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    return out;
  }
}
