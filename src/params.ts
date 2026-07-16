import { HARD } from "./config.js";
import { loadJson, saveJson, appendJsonl } from "./state.js";

/**
 * Adaptive strategy parameters. The learning loop may nudge these, but every
 * write is clamped to [min, max], and sizes are additionally clamped to the
 * immutable HARD caps from .env. The learner can make the agent more careful
 * or more selective — it can never make it bet bigger than you allowed.
 */
export type Params = {
  // entries — momentum
  momentumEntryPct: number;      // % price gain over lookback to trigger entry
  momentumLookbackSec: number;
  volumeMultiple: number;        // recent window volume vs median baseline
  tradeSizeEth: number;
  // entries — new listings
  newListingSizeEth: number;
  // entries — social attention (GMGN hot-search)
  socialSizeEth: number;
  socialMinChange1hPct: number;  // min 1h price gain for a hot-searched token to qualify
  // entries — NOXA launchpad + copy-trade
  noxaSizeEth: number;
  copytradeSizeEth: number;
  maxListingAgeSec: number;      // only snipe pools younger than this
  minPoolWethEth: number;        // min WETH-side liquidity to touch a pool
  maxRoundTripLossPct: number;   // honeypot check: buy+sell quote loss tolerance
  // exits
  takeProfitPct: number;
  takeProfitSellPct: number;     // % of position sold at TP; remainder trails (100 = full exit)
  trailingStopPct: number;
  hardStopPct: number;
  maxHoldMin: number;
};

export const BOUNDS: Record<keyof Params, [number, number]> = {
  momentumEntryPct: [1.5, 15],
  momentumLookbackSec: [60, 600],
  volumeMultiple: [1.5, 8],
  tradeSizeEth: [0.001, HARD.MAX_TRADE_ETH],
  newListingSizeEth: [0.001, HARD.MAX_TRADE_ETH],
  socialSizeEth: [0.001, HARD.MAX_TRADE_ETH],
  socialMinChange1hPct: [5, 100],
  noxaSizeEth: [0.001, HARD.MAX_TRADE_ETH],
  copytradeSizeEth: [0.001, HARD.MAX_TRADE_ETH],
  maxListingAgeSec: [60, 1800],
  minPoolWethEth: [0.5, 20],
  maxRoundTripLossPct: [1, 10],
  takeProfitPct: [10, 200],
  takeProfitSellPct: [25, 100],
  trailingStopPct: [5, 40],
  hardStopPct: [5, 50],
  maxHoldMin: [10, 720],
};

export const DEFAULTS: Params = {
  momentumEntryPct: 4,
  momentumLookbackSec: 180,
  volumeMultiple: 3,
  tradeSizeEth: Math.min(0.01, HARD.MAX_TRADE_ETH),
  newListingSizeEth: Math.min(0.005, HARD.MAX_TRADE_ETH),
  socialSizeEth: Math.min(0.005, HARD.MAX_TRADE_ETH),
  socialMinChange1hPct: 15,
  noxaSizeEth: Math.min(0.005, HARD.MAX_TRADE_ETH),
  copytradeSizeEth: Math.min(0.005, HARD.MAX_TRADE_ETH),
  maxListingAgeSec: 600,
  minPoolWethEth: 2,
  maxRoundTripLossPct: 6,
  takeProfitPct: 40,
  takeProfitSellPct: 50,
  trailingStopPct: 15,
  hardStopPct: 20,
  maxHoldMin: 120,
};

export function clampParams(p: Params): Params {
  const out = { ...p };
  for (const k of Object.keys(BOUNDS) as (keyof Params)[]) {
    const [lo, hi] = BOUNDS[k];
    out[k] = Math.min(hi, Math.max(lo, out[k]));
  }
  return out;
}

export function loadParams(): Params {
  return clampParams({ ...DEFAULTS, ...loadJson<Partial<Params>>("params.json", {}) });
}

export function saveParams(p: Params, reason: string) {
  const clamped = clampParams(p);
  saveJson("params.json", clamped);
  appendJsonl("params-history.jsonl", { ts: Date.now(), reason, params: clamped });
}
