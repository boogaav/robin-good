import "dotenv/config";
import "./rpc.js"; // public-DNS resolution for all fetches — see rpc.ts
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Verified Robinhood Chain (4663) deployment — cross-checked on-chain 2026-07-12:
// router.factory() and quoter.factory() both return FACTORY; both return WETH.
// ---------------------------------------------------------------------------
export const CHAIN_ID = 4663;
export const RPC_URL = process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const ADDR = {
  UNIV3_FACTORY: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  SWAP_ROUTER_02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  QUOTER_V2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
} as const;

export const DATA_DIR = path.resolve(import.meta.dirname, "../data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// HARD CAPS — set only via .env, never modified by the learning loop.
// The adaptive params in params.ts are clamped so they can never exceed these.
// ---------------------------------------------------------------------------
function envNum(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${name}=${v}`);
  return n;
}

export const HARD = {
  /** Max ETH spent on any single entry. */
  MAX_TRADE_ETH: envNum("MAX_TRADE_ETH", 0.02),
  /** Max simultaneously open positions. */
  MAX_OPEN_POSITIONS: envNum("MAX_OPEN_POSITIONS", 3),
  /** Max total ETH deployed into entries per UTC day. */
  MAX_DAILY_SPEND_ETH: envNum("MAX_DAILY_SPEND_ETH", 0.1),
  /** Realized loss per UTC day at which the agent stops entering (keeps managing exits). */
  MAX_DAILY_LOSS_ETH: envNum("MAX_DAILY_LOSS_ETH", 0.05),
  /** Max acceptable slippage on execution, percent. */
  MAX_SLIPPAGE_PCT: envNum("MAX_SLIPPAGE_PCT", 3),
  /** Never touch the wallet below this ETH balance (gas reserve). */
  MIN_WALLET_RESERVE_ETH: envNum("MIN_WALLET_RESERVE_ETH", 0.01),
} as const;

/** Creating this file halts all new entries and exits everything at market. */
export const KILL_SWITCH_FILE = path.join(DATA_DIR, "KILL");

// ---------------------------------------------------------------------------
// Live-mode arming. Both must be set, plus a PRIVATE_KEY, or we stay in DRY_RUN.
// ---------------------------------------------------------------------------
const ARM_PHRASE = "I-UNDERSTAND-THE-RISKS";
export const LIVE =
  process.env.LIVE === "1" &&
  process.env.ARM_LIVE === ARM_PHRASE &&
  !!process.env.PRIVATE_KEY;

export const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;

export function liveModeExplanation(): string {
  if (LIVE) return "LIVE — real orders will be placed";
  const missing: string[] = [];
  if (process.env.LIVE !== "1") missing.push("LIVE=1");
  if (process.env.ARM_LIVE !== ARM_PHRASE) missing.push(`ARM_LIVE=${ARM_PHRASE}`);
  if (!process.env.PRIVATE_KEY) missing.push("PRIVATE_KEY=0x...");
  return `DRY_RUN — to go live set in .env: ${missing.join(", ")}`;
}

export const POLL_MS = envNum("POLL_MS", 5000);
export const LOG_CHUNK_BLOCKS = 2000n;
