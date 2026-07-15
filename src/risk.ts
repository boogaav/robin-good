import fs from "node:fs";
import { HARD, KILL_SWITCH_FILE } from "./config.js";
import { daily, positions } from "./state.js";
import { walletEthBalance } from "./executor.js";
import { utcDay } from "./util.js";

export type RiskVerdict = { allowed: boolean; reason: string };

export function killSwitchOn(): boolean {
  return fs.existsSync(KILL_SWITCH_FILE);
}

/**
 * Gate every entry. Hard caps only — the learning loop has no write access
 * to anything checked here.
 */
export async function canEnter(sizeEth: number): Promise<RiskVerdict> {
  if (killSwitchOn()) return { allowed: false, reason: "kill switch file present" };
  if (sizeEth > HARD.MAX_TRADE_ETH) return { allowed: false, reason: `size ${sizeEth} > MAX_TRADE_ETH ${HARD.MAX_TRADE_ETH}` };

  const open = positions.load();
  if (open.length >= HARD.MAX_OPEN_POSITIONS)
    return { allowed: false, reason: `open positions ${open.length} >= ${HARD.MAX_OPEN_POSITIONS}` };

  const book = daily.load(utcDay());
  if (book.spendEth + sizeEth > HARD.MAX_DAILY_SPEND_ETH)
    return { allowed: false, reason: `daily spend ${book.spendEth.toFixed(4)}+${sizeEth} > ${HARD.MAX_DAILY_SPEND_ETH}` };
  if (-book.realizedPnlEth >= HARD.MAX_DAILY_LOSS_ETH)
    return { allowed: false, reason: `daily loss ${(-book.realizedPnlEth).toFixed(4)} >= ${HARD.MAX_DAILY_LOSS_ETH} — done for today` };

  const bal = await walletEthBalance();
  if (bal - sizeEth < HARD.MIN_WALLET_RESERVE_ETH)
    return { allowed: false, reason: `balance ${bal.toFixed(4)} - ${sizeEth} < reserve ${HARD.MIN_WALLET_RESERVE_ETH}` };

  return { allowed: true, reason: "ok" };
}

export function recordSpend(sizeEth: number) {
  const book = daily.load(utcDay());
  book.spendEth += sizeEth;
  daily.save(book);
}

export function recordPnl(pnlEth: number) {
  const book = daily.load(utcDay());
  book.realizedPnlEth += pnlEth;
  daily.save(book);
}
