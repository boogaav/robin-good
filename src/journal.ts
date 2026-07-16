import { appendJsonl, readJsonl, type Position } from "./state.js";

export type ClosedTrade = {
  id: string;
  strategy: "momentum" | "newListing" | "social" | "noxa" | "copytrade";
  token: string;
  symbol: string;
  pool: string;
  openedAt: number;
  closedAt: number;
  holdMin: number;
  costEth: number;
  proceedsEth: number;
  pnlEth: number;
  pnlPct: number;
  exitReason: "takeProfit" | "trailingStop" | "hardStop" | "maxHold" | "rug" | "killSwitch" | "manual";
  launchpad?: string;
  entryTxHash?: string;      // on-chain proof for live trades
  exitTxHash?: string;
  peakGainPct: number;          // max favorable excursion — how far it ran before exit
  entrySignal: Record<string, number>;
  paramsAtEntry: Record<string, number>;
  simulated: boolean;
};

export function journalTrade(t: ClosedTrade) {
  appendJsonl("journal.jsonl", t);
}

export function readTrades(): ClosedTrade[] {
  return readJsonl<ClosedTrade>("journal.jsonl");
}

export function toClosedTrade(
  pos: Position,
  proceedsEth: number,
  exitReason: ClosedTrade["exitReason"],
  simulated: boolean,
  exitTxHash?: string,
): ClosedTrade {
  const now = Date.now();
  const pnlEth = proceedsEth - pos.costEth;
  return {
    id: pos.id,
    strategy: pos.strategy,
    token: pos.token,
    symbol: pos.symbol,
    pool: pos.pool,
    openedAt: pos.openedAt,
    closedAt: now,
    holdMin: (now - pos.openedAt) / 60_000,
    costEth: pos.costEth,
    proceedsEth,
    pnlEth,
    pnlPct: pos.costEth > 0 ? (pnlEth / pos.costEth) * 100 : 0,
    exitReason,
    launchpad: pos.launchpad,
    entryTxHash: pos.entryTxHash,
    exitTxHash,
    peakGainPct: pos.entryPriceEthPerToken > 0 ? (pos.peakPriceEthPerToken / pos.entryPriceEthPerToken - 1) * 100 : 0,
    entrySignal: pos.entrySignal,
    paramsAtEntry: pos.paramsAtEntry,
    simulated,
  };
}
