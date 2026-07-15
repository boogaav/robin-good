import { formatEther, parseAbiItem } from "viem";
import { pub } from "./chain.js";
import { ADDR, LOG_CHUNK_BLOCKS } from "./config.js";
import { factoryAbi } from "./abi.js";
import { resolvePool, priceFromSqrt, markCreated, type PoolInfo } from "./market.js";
import type { Params } from "./params.js";
import { log, median } from "./util.js";

const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

type Sample = { ts: number; price: number };
type PoolTrack = {
  info: PoolInfo;
  prices: Sample[];              // ring buffer, ~30 min
  windowVolumes: number[];       // ETH volume per poll window, ~60 windows
  curWindowVolume: number;
};

export type Candidate = {
  kind: "momentum" | "newListing";
  info: PoolInfo;
  price: number;
  features: Record<string, number>; // journaled for the learning loop
  launchpad?: string;               // contract the pool-creation tx called (e.g. NOXA factory)
};

export type RadarRow = {
  symbol: string;
  pool: string;
  token: string;
  price: number | null;
  gainPct: number | null;     // over momentum lookback
  volRatio: number | null;    // recent windows vs baseline
  recentVolEth: number;
  isNew: boolean;
  launchpad?: string;
};

const MAX_PRICE_AGE_MS = 30 * 60_000;
const MAX_WINDOWS = 60;
const STALE_TRACK_MS = 2 * 60 * 60_000; // drop pools with no swaps for 2h

export class Scanner {
  private tracks = new Map<string, PoolTrack>();
  private newPools = new Map<string, { info: PoolInfo; createdAtMs: number; launchpad?: string }>();
  private launchpads = new Map<string, string>(); // pool -> creation-tx target
  private lastBlock: bigint = 0n;

  async init() {
    this.lastBlock = await pub.getBlockNumber();
    log("scanner", `starting from block ${this.lastBlock}`);
  }

  /** One tick: ingest new blocks' PoolCreated + Swap logs, update state. */
  async poll(): Promise<void> {
    const head = await pub.getBlockNumber();
    if (head <= this.lastBlock) return;
    let from = this.lastBlock + 1n;
    // If we fell far behind (restart), skip ahead rather than replaying history.
    if (head - from > LOG_CHUNK_BLOCKS) from = head - LOG_CHUNK_BLOCKS + 1n;

    const [created, swaps] = await Promise.all([
      pub.getLogs({ address: ADDR.UNIV3_FACTORY, event: factoryAbi[0], fromBlock: from, toBlock: head }),
      pub.getLogs({ event: swapEvent, fromBlock: from, toBlock: head }),
    ]);
    this.lastBlock = head;

    for (const c of created) {
      const { token0, token1, pool } = c.args;
      if (!pool || !token0 || !token1) continue;
      const weth = ADDR.WETH.toLowerCase();
      if (token0.toLowerCase() !== weth && token1.toLowerCase() !== weth) continue;
      const info = await resolvePool(pool);
      if (!info) continue;
      markCreated(pool);
      // Which contract launched it? Standard Uniswap position manager vs a
      // launchpad factory (NOXA etc.) — journaled so the learner can correlate
      // rug rates per launchpad.
      let launchpad: string | undefined;
      try {
        const tx = await pub.getTransaction({ hash: c.transactionHash });
        launchpad = tx.to ?? undefined;
      } catch { /* tx lookup is best-effort */ }
      if (launchpad) this.launchpads.set(pool.toLowerCase(), launchpad);
      this.newPools.set(pool.toLowerCase(), { info, createdAtMs: Date.now(), launchpad });
      log("discovery", `new WETH pool: ${info.symbol} ${pool} fee=${info.fee}${launchpad ? ` via ${launchpad}` : ""}`);
    }

    // Aggregate swap volume + latest price per pool.
    const now = Date.now();
    const byPool = new Map<string, { vol: number; lastSqrt: bigint; count: number }>();
    for (const s of swaps) {
      const key = s.address.toLowerCase();
      const cur = byPool.get(key) ?? { vol: 0, lastSqrt: 0n, count: 0 };
      cur.lastSqrt = s.args.sqrtPriceX96 ?? cur.lastSqrt;
      cur.count++;
      byPool.set(key, cur);
    }

    for (const [key, agg] of byPool) {
      let track = this.tracks.get(key);
      if (!track) {
        const info = await resolvePool(key as `0x${string}`);
        if (!info) continue;
        track = { info, prices: [], windowVolumes: [], curWindowVolume: 0 };
        this.tracks.set(key, track);
      }
      // WETH-side volume: re-scan this pool's swaps for the WETH amount.
      for (const s of swaps) {
        if (s.address.toLowerCase() !== key) continue;
        const wethAmt = track.info.tokenIsToken0 ? s.args.amount1 : s.args.amount0;
        if (wethAmt !== undefined) track.curWindowVolume += Math.abs(Number(formatEther(wethAmt < 0n ? -wethAmt : wethAmt)));
      }
      if (agg.lastSqrt > 0n) {
        track.prices.push({ ts: now, price: priceFromSqrt(track.info, agg.lastSqrt) });
      }
    }

    // Close the volume window on every tracked pool, trim history, and drop
    // pools that have gone quiet (~16k new tokens/day — unbounded growth otherwise).
    for (const [key, track] of this.tracks) {
      track.windowVolumes.push(track.curWindowVolume);
      track.curWindowVolume = 0;
      if (track.windowVolumes.length > MAX_WINDOWS) track.windowVolumes.shift();
      while (track.prices.length && track.prices[0].ts < now - MAX_PRICE_AGE_MS) track.prices.shift();
      const lastSeen = track.prices.at(-1)?.ts ?? 0;
      if (now - lastSeen > STALE_TRACK_MS) this.tracks.delete(key);
    }
  }

  /** Momentum entries: price up X% over lookback with a volume spike. */
  momentumCandidates(p: Params): Candidate[] {
    const out: Candidate[] = [];
    const now = Date.now();
    for (const track of this.tracks.values()) {
      const { prices, windowVolumes, info } = track;
      if (prices.length < 4 || windowVolumes.length < 10) continue;
      const latest = prices[prices.length - 1];
      if (now - latest.ts > 60_000) continue; // stale
      const anchor = prices.find((s) => s.ts >= now - p.momentumLookbackSec * 1000);
      if (!anchor || anchor === latest || anchor.price <= 0) continue;
      const gainPct = (latest.price / anchor.price - 1) * 100;
      const recent = windowVolumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const baseline = median(windowVolumes.slice(0, -3));
      const volRatio = baseline > 0 ? recent / baseline : 0;
      if (gainPct >= p.momentumEntryPct && volRatio >= p.volumeMultiple) {
        out.push({
          kind: "momentum",
          info,
          price: latest.price,
          features: { gainPct, volRatio, recentVolEth: recent, baselineVolEth: baseline, lookbackSec: p.momentumLookbackSec },
        });
      }
    }
    return out.sort((a, b) => b.features.volRatio - a.features.volRatio);
  }

  /** New-listing entries: young pools, before they expire from the snipe window. */
  newListingCandidates(p: Params): Candidate[] {
    const out: Candidate[] = [];
    const now = Date.now();
    for (const [key, { info, createdAtMs }] of this.newPools) {
      const ageSec = (now - createdAtMs) / 1000;
      if (ageSec > p.maxListingAgeSec) {
        this.newPools.delete(key);
        continue;
      }
      const price = this.tracks.get(key)?.prices.at(-1)?.price ?? 0;
      if (price <= 0) continue; // no swap yet — no price, wait
      out.push({ kind: "newListing", info, price, features: { ageSec }, launchpad: this.newPools.get(key)?.launchpad });
    }
    return out;
  }

  /** Drop a new-pool entry once we've traded (or rejected) it. */
  consumeNewPool(pool: `0x${string}`) {
    this.newPools.delete(pool.toLowerCase());
  }

  latestPrice(pool: `0x${string}`): number | undefined {
    return this.tracks.get(pool.toLowerCase())?.prices.at(-1)?.price;
  }

  stats() {
    return { trackedPools: this.tracks.size, pendingNewPools: this.newPools.size, lastBlock: this.lastBlock };
  }

  /** What the scanner is watching right now — top pools by recent volume. */
  radar(p: Params, n = 14): RadarRow[] {
    const now = Date.now();
    const rows: RadarRow[] = [];
    for (const [key, track] of this.tracks) {
      const recent = track.windowVolumes.slice(-3).reduce((a, b) => a + b, 0);
      if (recent <= 0) continue;
      const latest = track.prices.at(-1);
      const anchor = track.prices.find((s) => s.ts >= now - p.momentumLookbackSec * 1000);
      const baseline = median(track.windowVolumes.slice(0, -3));
      rows.push({
        symbol: track.info.symbol,
        pool: track.info.pool,
        token: track.info.token,
        price: latest?.price ?? null,
        gainPct: latest && anchor && anchor !== latest && anchor.price > 0 ? (latest.price / anchor.price - 1) * 100 : null,
        volRatio: baseline > 0 ? recent / 3 / baseline : null,
        recentVolEth: recent,
        isNew: this.newPools.has(key),
        launchpad: this.launchpads.get(key) ?? this.newPools.get(key)?.launchpad,
      });
    }
    return rows.sort((a, b) => b.recentVolEth - a.recentVolEth).slice(0, n);
  }
}
