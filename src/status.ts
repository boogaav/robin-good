import { HARD, liveModeExplanation } from "./config.js";
import { loadParams } from "./params.js";
import { positions, daily, blacklist } from "./state.js";
import { readTrades } from "./journal.js";
import { statsFor } from "./learn.js";
import { utcDay, pct } from "./util.js";

const open = positions.load();
const book = daily.load(utcDay());
const trades = readTrades();
const bl = blacklist.load();

console.log(`mode: ${liveModeExplanation()}`);
console.log(`hard caps: ${JSON.stringify(HARD)}`);
console.log(`params: ${JSON.stringify(loadParams())}`);
console.log(`\ntoday (${book.day}): spent ${book.spendEth.toFixed(4)} ETH, realized PnL ${book.realizedPnlEth.toFixed(5)} ETH`);
console.log(`blacklist: ${bl.tokens.length} tokens, ${bl.creators.length} creators`);

console.log(`\nopen positions (${open.length}):`);
for (const p of open) {
  const holdMin = ((Date.now() - p.openedAt) / 60_000).toFixed(0);
  const peak = ((p.peakPriceEthPerToken / p.entryPriceEthPerToken - 1) * 100).toFixed(1);
  console.log(`  ${p.symbol} [${p.strategy}] cost ${p.costEth} ETH, ${holdMin}m held, peak +${peak}%  ${p.token}`);
}

if (trades.length) {
  const s = statsFor(trades);
  console.log(`\nall-time: ${s.n} trades, win ${pct(s.winRate)}, net ${s.netPnlEth.toFixed(5)} ETH`);
  console.log("last 5:");
  for (const t of trades.slice(-5)) {
    console.log(`  ${new Date(t.closedAt).toISOString()} ${t.symbol} [${t.strategy}/${t.exitReason}] ${t.pnlEth >= 0 ? "+" : ""}${t.pnlEth.toFixed(5)} ETH (${t.pnlPct.toFixed(1)}%)${t.simulated ? " dry" : ""}`);
  }
} else {
  console.log("\nno closed trades yet");
}
