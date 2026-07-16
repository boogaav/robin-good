import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAddress } from "viem";
import { findWethPool, type PoolInfo } from "./market.js";
import { log } from "./util.js";

const exec = promisify(execFile);

/**
 * Copy-trade strategy. Mirror the BUYS of a set of watched wallets (COPY_WALLETS
 * in .env). We poll each wallet's recent buy activity via GMGN, and when a fresh
 * buy names a token with a tradeable WETH pool, we emit a candidate — sized by
 * OUR risk caps, never by theirs. Every copy still passes the full safety gate;
 * a followed wallet buying a honeypot does not make us buy it.
 *
 * We only act on buys newer than startup and within MAX_AGE (we mirror entries,
 * not backfill their whole history), and dedupe by tx hash.
 */

const MAX_AGE_SEC = 300; // only mirror buys from the last ~5 min

export type CopyCandidate = {
  kind: "copytrade";
  info: PoolInfo;
  price: number;
  features: Record<string, number>;
  source: string; // watched wallet
};

type Activity = {
  tx_hash: string;
  timestamp: number;
  event_type: string;
  token?: { address: string; symbol: string };
  quote_amount?: string; // WETH they spent
  cost_usd?: string;
};

export class CopyTrader {
  private wallets: string[];
  private pollMs: number;
  private lastPoll = 0;
  private seenTx = new Set<string>();
  private startedAt = Math.floor(Date.now() / 1000);

  constructor(wallets: string[], pollMs = 30_000) {
    this.wallets = wallets.map((w) => w.trim()).filter(Boolean);
    this.pollMs = pollMs;
  }

  get enabled() {
    return this.wallets.length > 0;
  }

  async candidates(): Promise<CopyCandidate[]> {
    if (!this.enabled || Date.now() - this.lastPoll < this.pollMs) return [];
    this.lastPoll = Date.now();
    const now = Math.floor(Date.now() / 1000);
    const out: CopyCandidate[] = [];

    for (const wallet of this.wallets) {
      let acts: Activity[];
      try {
        const { stdout } = await exec(
          "gmgn-cli",
          ["portfolio", "activity", "--chain", "robinhood", "--wallet", wallet, "--type", "buy", "--limit", "10"],
          { timeout: 12_000 },
        );
        const j = JSON.parse(stdout) as { activities?: Activity[] };
        acts = j.activities ?? [];
      } catch (e) {
        log("copy", `activity ${wallet.slice(0, 8)} unavailable: ${(e as Error).message.slice(0, 70)}`);
        continue;
      }

      for (const a of acts) {
        if (a.event_type !== "buy" || !a.token?.address) continue;
        if (this.seenTx.has(a.tx_hash)) continue;
        this.seenTx.add(a.tx_hash);
        if (a.timestamp < this.startedAt || now - a.timestamp > MAX_AGE_SEC) continue; // only fresh, post-startup buys
        let info: PoolInfo | null;
        try { info = await findWethPool(getAddress(a.token.address)); } catch { continue; }
        if (!info) continue;
        log("copy", `${wallet.slice(0, 8)}… bought ${info.symbol} (${a.quote_amount ?? "?"} WETH) — mirroring`);
        out.push({
          kind: "copytrade",
          info,
          price: 0,
          source: wallet,
          features: { theirWethSpent: Number(a.quote_amount ?? 0), theirCostUsd: Number(a.cost_usd ?? 0), ageSec: now - a.timestamp },
        });
      }
    }
    if (this.seenTx.size > 3000) this.seenTx = new Set([...this.seenTx].slice(-1500));
    return out;
  }
}
