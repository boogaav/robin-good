import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { loadParams, saveParams, BOUNDS, type Params } from "./params.js";
import { readTrades, type ClosedTrade } from "./journal.js";
import { loadJson, saveJson } from "./state.js";
import { log, pct } from "./util.js";

/**
 * Learning loop. After every closed trade we re-analyze the recent record and
 * nudge strategy parameters — always inside BOUNDS, never touching the .env
 * hard caps. Every change is written to LESSONS.md with the evidence, so the
 * agent's "beliefs" stay auditable.
 */

const LESSONS = path.join(DATA_DIR, "LESSONS.md");
const WINDOW = 20;              // trades per strategy considered
const MIN_TRADES = 5;           // don't adapt on noise
const COOLDOWN = 5;             // closed trades between adaptations per strategy

type LearnState = { adaptedAtCount: Record<string, number> };

export type StrategyStats = {
  n: number;
  winRate: number;
  netPnlEth: number;
  avgPnlPct: number;
  avgPeakGainPct: number;
  avgWinPct: number;
  avgLossPct: number;
  exits: Record<string, number>;
};

export function statsFor(trades: ClosedTrade[]): StrategyStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlEth > 0);
  const losses = trades.filter((t) => t.pnlEth <= 0);
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    n,
    winRate: n ? wins.length / n : 0,
    netPnlEth: trades.reduce((a, t) => a + t.pnlEth, 0),
    avgPnlPct: avg(trades.map((t) => t.pnlPct)),
    avgPeakGainPct: avg(trades.map((t) => t.peakGainPct)),
    avgWinPct: avg(wins.map((t) => t.pnlPct)),
    avgLossPct: avg(losses.map((t) => t.pnlPct)),
    exits,
  };
}

function nudge(p: Params, key: keyof Params, factor: number): { from: number; to: number } {
  const [lo, hi] = BOUNDS[key];
  const from = p[key];
  p[key] = Math.min(hi, Math.max(lo, from * factor));
  return { from, to: p[key] };
}

function lesson(lines: string[], text: string, change?: { key: string; from: number; to: number }) {
  const suffix = change ? ` → \`${change.key}\`: ${round(change.from)} → ${round(change.to)}` : "";
  lines.push(`- ${text}${suffix}`);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Called after every closed trade. Returns true if params changed. */
export function reflect(): boolean {
  const all = readTrades();
  const state = loadJson<LearnState>("learn-state.json", { adaptedAtCount: {} });
  const params = loadParams();
  const before = JSON.stringify(params);
  const lessons: string[] = [];

  for (const strategy of ["momentum", "newListing", "social", "noxa", "copytrade"] as const) {
    const trades = all.filter((t) => t.strategy === strategy);
    if (trades.length < MIN_TRADES) continue;
    if (trades.length - (state.adaptedAtCount[strategy] ?? 0) < COOLDOWN) continue;
    const recent = trades.slice(-WINDOW);
    const s = statsFor(recent);
    const header = `**${strategy}** (${s.n} trades, win ${pct(s.winRate)}, net ${s.netPnlEth.toFixed(4)} ETH)`;

    if (strategy === "momentum") {
      if (s.winRate < 0.35) {
        lesson(lessons, `${header}: win rate low — entries too loose; demanding stronger breakouts`, { key: "momentumEntryPct", ...nudge(params, "momentumEntryPct", 1.15) });
        lesson(lessons, `${header}: also requiring a bigger volume spike`, { key: "volumeMultiple", ...nudge(params, "volumeMultiple", 1.1) });
      } else if (s.winRate > 0.65 && s.netPnlEth > 0) {
        lesson(lessons, `${header}: win rate high — loosening entry slightly to take more trades`, { key: "momentumEntryPct", ...nudge(params, "momentumEntryPct", 0.95) });
      }
    } else {
      const rugs = recent.filter((t) => t.exitReason === "rug").length;
      if (rugs >= 2) {
        lesson(lessons, `${header}: ${rugs} rugs in window — requiring deeper liquidity`, { key: "minPoolWethEth", ...nudge(params, "minPoolWethEth", 1.3) });
        lesson(lessons, `${header}: cutting new-listing size`, { key: "newListingSizeEth", ...nudge(params, "newListingSizeEth", 0.7) });
      }
    }

    // Exit tuning, shared logic.
    const stopOuts = recent.filter((t) => t.exitReason === "hardStop");
    const peakedThenStopped = stopOuts.filter((t) => t.peakGainPct > 10);
    if (stopOuts.length >= 3 && peakedThenStopped.length / stopOuts.length > 0.5) {
      lesson(lessons, `${header}: winners are round-tripping to stops (avg peak ${round(s.avgPeakGainPct)}%) — taking profit earlier and trailing tighter`, { key: "takeProfitPct", ...nudge(params, "takeProfitPct", 0.85) });
      lesson(lessons, `${header}: tightening trail`, { key: "trailingStopPct", ...nudge(params, "trailingStopPct", 0.85) });
    }
    const tps = recent.filter((t) => t.exitReason === "takeProfit");
    if (tps.length >= 3 && s.avgPeakGainPct > params.takeProfitPct * 1.5) {
      lesson(lessons, `${header}: exits leaving money on the table (avg peak ${round(s.avgPeakGainPct)}% vs TP ${params.takeProfitPct}%) — letting winners run`, { key: "takeProfitPct", ...nudge(params, "takeProfitPct", 1.2) });
    }
    const deadHolds = recent.filter((t) => t.exitReason === "maxHold" && t.pnlEth < 0);
    if (deadHolds.length >= 3) {
      lesson(lessons, `${header}: stale positions bleeding — cutting max hold`, { key: "maxHoldMin", ...nudge(params, "maxHoldMin", 0.8) });
    }

    // Sizing by realized performance (still under HARD.MAX_TRADE_ETH).
    const sizeKey =
      strategy === "momentum" ? "tradeSizeEth" :
      strategy === "social" ? "socialSizeEth" :
      strategy === "noxa" ? "noxaSizeEth" :
      strategy === "copytrade" ? "copytradeSizeEth" :
      "newListingSizeEth";
    if (s.netPnlEth < 0 && s.n >= 8) {
      lesson(lessons, `${header}: net negative — reducing size until the edge returns`, { key: sizeKey, ...nudge(params, sizeKey, 0.8) });
    } else if (s.netPnlEth > 0 && s.winRate >= 0.5 && s.n >= 8) {
      lesson(lessons, `${header}: net positive with decent hit rate — sizing up modestly`, { key: sizeKey, ...nudge(params, sizeKey, 1.1) });
    }

    if (lessons.length) state.adaptedAtCount[strategy] = trades.length;
  }

  if (JSON.stringify(params) !== before) {
    saveParams(params, lessons.join(" | "));
    saveJson("learn-state.json", state);
    const entry = `\n## ${new Date().toISOString()}\n${lessons.join("\n")}\n`;
    fs.appendFileSync(LESSONS, entry);
    log("learn", `adapted params:\n${lessons.map((l) => "  " + l).join("\n")}`);
    return true;
  }
  return false;
}

// --- launchpad trust ---------------------------------------------------------

export type LaunchpadStats = { launchpad: string; trades: number; rugs: number; netPnlEth: number };

let lpCache: { at: number; stats: LaunchpadStats[] } | null = null;

/** Per-launchpad record from the journal — who ships rugs, who ships winners. */
export function launchpadStats(): LaunchpadStats[] {
  if (lpCache && Date.now() - lpCache.at < 60_000) return lpCache.stats;
  const byPad = new Map<string, LaunchpadStats>();
  for (const t of readTrades()) {
    if (!t.launchpad) continue;
    const k = t.launchpad.toLowerCase();
    const s = byPad.get(k) ?? { launchpad: t.launchpad, trades: 0, rugs: 0, netPnlEth: 0 };
    s.trades++;
    s.netPnlEth += t.pnlEth;
    if (t.exitReason === "rug") s.rugs++;
    byPad.set(k, s);
  }
  const stats = [...byPad.values()].sort((a, b) => b.netPnlEth - a.netPnlEth);
  saveJson("launchpads.json", stats);
  lpCache = { at: Date.now(), stats };
  return stats;
}

const DISTRUST_MIN_TRADES = 3;
const DISTRUST_RUG_RATE = 0.5;

/** True when a launchpad's record is bad enough that new listings from it are skipped. */
export function launchpadDistrusted(launchpad: string | undefined): boolean {
  if (!launchpad) return false;
  const s = launchpadStats().find((x) => x.launchpad.toLowerCase() === launchpad.toLowerCase());
  return !!s && s.trades >= DISTRUST_MIN_TRADES && s.rugs / s.trades >= DISTRUST_RUG_RATE;
}

export function recordEventLesson(text: string) {
  fs.appendFileSync(LESSONS, `\n## ${new Date().toISOString()}\n- ${text}\n`);
}

// --- CLI report: npm run reflect --------------------------------------------
if (process.argv.includes("--report")) {
  const all = readTrades();
  if (!all.length) {
    console.log("No trades journaled yet.");
  } else {
    for (const strategy of ["momentum", "newListing", "social", "noxa", "copytrade"] as const) {
      const trades = all.filter((t) => t.strategy === strategy);
      if (!trades.length) continue;
      const s = statsFor(trades.slice(-WINDOW));
      console.log(`\n=== ${strategy} (last ${Math.min(WINDOW, trades.length)} of ${trades.length}) ===`);
      console.log(`win rate ${pct(s.winRate)} | net ${s.netPnlEth.toFixed(5)} ETH | avg pnl ${s.avgPnlPct.toFixed(1)}%`);
      console.log(`avg peak gain ${s.avgPeakGainPct.toFixed(1)}% | avg win ${s.avgWinPct.toFixed(1)}% | avg loss ${s.avgLossPct.toFixed(1)}%`);
      console.log(`exits: ${JSON.stringify(s.exits)}`);
    }
    console.log(`\nCurrent params: ${JSON.stringify(loadParams(), null, 2)}`);
  }
}
