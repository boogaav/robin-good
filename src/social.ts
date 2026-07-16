import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAddress } from "viem";
import { findWethPool, type PoolInfo } from "./market.js";
import type { Params } from "./params.js";
import { log } from "./util.js";

const exec = promisify(execFile);

/**
 * Social-attention strategy. GMGN's hot-search ranking is a leading indicator:
 * people search a token before they pile in. We poll the Robinhood-Chain
 * hot-search list, track each token's rank over time, and surface tokens that
 * are BOTH climbing the attention ranking AND showing positive short-term
 * price action — then route them through the same safety gate as every other
 * entry. GMGN's `market signal` (smart-money/large-buy feeds) is sol/bsc only,
 * so hot-search is the attention proxy available on our chain.
 *
 * Optional X-influencer monitoring lives in social-x.ts (needs a paid X key).
 */

type HotToken = {
  address: string;
  symbol: string;
  price_change_percent1h?: number;
  price_change_percent5m?: number;
  volume?: number;
  liquidity?: number;
  market_cap?: number;
};

export type SocialCandidate = {
  kind: "social";
  info: PoolInfo;
  price: number;
  features: Record<string, number>;
};

type RankSample = { rank: number; ts: number };

export class SocialScanner {
  private rankHistory = new Map<string, RankSample[]>(); // token -> recent ranks
  private lastPoll = 0;
  private latest: HotToken[] = [];
  private pollMs: number;

  constructor(pollMs = 120_000) {
    this.pollMs = pollMs;
  }

  /** Refresh the hot-search ranking (rate-limited to pollMs). */
  async poll(): Promise<void> {
    if (Date.now() - this.lastPoll < this.pollMs) return;
    this.lastPoll = Date.now();
    try {
      const { stdout } = await exec("gmgn-cli", ["market", "hot-searches", "--chain", "robinhood"], { timeout: 12_000 });
      const parsed = JSON.parse(stdout) as { interval: string; tokens: HotToken[] }[];
      const day = parsed.find((p) => p.interval === "24h") ?? parsed[0];
      this.latest = day?.tokens ?? [];
      const now = Date.now();
      this.latest.forEach((t, i) => {
        const key = t.address.toLowerCase();
        const hist = this.rankHistory.get(key) ?? [];
        hist.push({ rank: i, ts: now });
        this.rankHistory.set(key, hist.filter((s) => s.ts > now - 30 * 60_000));
      });
      log("social", `hot-search: ${this.latest.length} tokens, top ${this.latest.slice(0, 3).map((t) => t.symbol).join("/")}`);
    } catch (e) {
      log("social", `hot-search unavailable: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  /**
   * Candidates: token is climbing the ranking (or newly appeared high) AND has
   * positive 1h momentum above threshold AND a tradeable WETH pool on-chain.
   */
  async candidates(p: Params): Promise<SocialCandidate[]> {
    const out: SocialCandidate[] = [];
    for (let rank = 0; rank < this.latest.length; rank++) {
      const t = this.latest[rank];
      const change1h = t.price_change_percent1h ?? 0;
      if (change1h < p.socialMinChange1hPct) continue; // must be pumping, not dumping
      const hist = this.rankHistory.get(t.address.toLowerCase()) ?? [];
      const firstRank = hist[0]?.rank ?? rank;
      const climbing = rank < firstRank || hist.length <= 1; // improved rank or just appeared
      if (!climbing && rank > 8) continue; // ignore stale mid-pack tokens
      let info: PoolInfo | null;
      try {
        info = await findWethPool(getAddress(t.address));
      } catch {
        continue;
      }
      if (!info) continue; // not tradeable on a canonical WETH pool
      out.push({
        kind: "social",
        info,
        price: 0, // filled by entry from pool slot0 if needed; scanner price preferred
        features: { searchRank: rank, rankDelta: firstRank - rank, change1hPct: change1h, change5mPct: t.price_change_percent5m ?? 0, mcapUsd: t.market_cap ?? 0 },
      });
      if (out.length >= 5) break; // top movers only
    }
    return out;
  }

  hotList(): { symbol: string; change1hPct: number }[] {
    return this.latest.slice(0, 10).map((t) => ({ symbol: t.symbol, change1hPct: t.price_change_percent1h ?? 0 }));
  }
}
