import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, LIVE } from "./config.js";

function file(name: string) {
  return path.join(DATA_DIR, name);
}

export function loadJson<T>(name: string, dflt: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8")) as T;
  } catch {
    return dflt;
  }
}

export function saveJson(name: string, value: unknown) {
  const tmp = file(name) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, replacer, 2));
  fs.renameSync(tmp, file(name));
}

export function appendJsonl(name: string, record: unknown) {
  fs.appendFileSync(file(name), JSON.stringify(record, replacer) + "\n");
}

export function readJsonl<T>(name: string): T[] {
  try {
    return fs
      .readFileSync(file(name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

function replacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

// --- typed stores -----------------------------------------------------------

export type Position = {
  id: string;
  live?: boolean;            // opened by a live agent; absent/false = paper
  strategy: "momentum" | "newListing";
  token: `0x${string}`;
  symbol: string;
  pool: `0x${string}`;
  fee: number;
  tokenIsToken0: boolean;
  decimals: number;
  costEth: number;           // ETH spent incl. assumed slippage
  tokenAmount: string;       // bigint as string
  entryPriceEthPerToken: number;
  peakPriceEthPerToken: number;
  poolWethAtEntry: number;   // WETH-side liquidity at entry, for rug detection
  launchpad?: string;        // contract that created the pool (rug-rate correlation)
  entryTxHash?: string;      // live buys: on-chain proof
  partialTaken?: boolean;    // scaled out at TP once; remainder rides the trail
  openedAt: number;
  entrySignal: Record<string, number>; // feature snapshot for the learning loop
  paramsAtEntry: Record<string, number>;
};

export type DailyBook = { day: string; live?: boolean; spendEth: number; realizedPnlEth: number };

export const positions = {
  load: (): Position[] => loadJson<Position[]>("positions.json", []),
  save: (p: Position[]) => saveJson("positions.json", p),
};

export const daily = {
  // A fresh book on a new UTC day — or when the mode flips, so paper spend/losses
  // never consume the live day's caps (and vice versa).
  load: (day: string): DailyBook => {
    const d = loadJson<DailyBook>("daily.json", { day, live: LIVE, spendEth: 0, realizedPnlEth: 0 });
    return d.day === day && !!d.live === LIVE ? d : { day, live: LIVE, spendEth: 0, realizedPnlEth: 0 };
  },
  save: (d: DailyBook) => saveJson("daily.json", { ...d, live: LIVE }),
};

/**
 * Call once at startup: park positions opened in the other mode. A LIVE agent
 * must never try to sell paper positions (the wallet doesn't own those tokens),
 * and a paper agent must never "manage" real holdings.
 */
export function archiveForeignModePositions(): number {
  const all = positions.load();
  const mine = all.filter((p) => !!p.live === LIVE);
  const foreign = all.filter((p) => !!p.live !== LIVE);
  if (foreign.length) {
    for (const p of foreign) appendJsonl("positions-archive.jsonl", { archivedAt: Date.now(), reason: `mode switch (agent now ${LIVE ? "LIVE" : "DRY"})`, position: p });
    positions.save(mine);
  }
  return foreign.length;
}

export type Blacklist = { tokens: string[]; creators: string[] };
export const blacklist = {
  load: (): Blacklist => loadJson<Blacklist>("blacklist.json", { tokens: [], creators: [] }),
  save: (b: Blacklist) => saveJson("blacklist.json", b),
};
