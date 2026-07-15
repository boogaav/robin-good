import { randomUUID } from "node:crypto";
import { FAST_POLL_MS, HARD, LIVE, liveModeExplanation } from "./config.js";
import { account } from "./chain.js";
import { Scanner, type Candidate } from "./scanner.js";
import { loadParams } from "./params.js";
import { buy, sell } from "./executor.js";
import { canEnter, killSwitchOn, recordPnl, recordSpend } from "./risk.js";
import { checkSafety, liquidityCollapsed, addRug } from "./safety.js";
import { currentPrice } from "./market.js";
import { archiveForeignModePositions, positions, saveJson, type Position } from "./state.js";
import { journalTrade, toClosedTrade, type ClosedTrade } from "./journal.js";
import { launchpadDistrusted, reflect, recordEventLesson } from "./learn.js";
import { log, sleep } from "./util.js";

const scanner = new Scanner();
const recentExits = new Map<string, number>(); // token -> ts, re-entry cooldown
const REENTRY_COOLDOWN_MS = 10 * 60_000;
const sellRevertCounts = new Map<string, number>(); // position id -> consecutive sell reverts
const SELL_REVERTS_TO_WRITE_OFF = 3;

async function managePositions() {
  const open = positions.load();
  if (!open.length) return;
  const p = loadParams();
  const keep: Position[] = [];

  for (const pos of open) {
    try {
      const info = { pool: pos.pool, token: pos.token, tokenIsToken0: pos.tokenIsToken0, fee: pos.fee, symbol: pos.symbol, decimals: pos.decimals };
      // slot0 direct (multicall-batched) — exit decisions never wait on the sweep
      const price = (await currentPrice(info).catch(() => undefined)) ?? scanner.latestPrice(pos.pool);
      if (price === undefined || price <= 0) {
        keep.push(pos);
        continue;
      }
      if (price > pos.peakPriceEthPerToken) pos.peakPriceEthPerToken = price;
      const gain = price / pos.entryPriceEthPerToken - 1;
      const fromPeak = price / pos.peakPriceEthPerToken - 1;
      const holdMin = (Date.now() - pos.openedAt) / 60_000;

      let exitReason: ClosedTrade["exitReason"] | null = null;
      if (killSwitchOn()) exitReason = "killSwitch";
      else if (await liquidityCollapsed(pos.pool, pos.poolWethAtEntry)) exitReason = "rug";
      else if (gain <= -p.hardStopPct / 100) exitReason = "hardStop";
      else if (gain >= p.takeProfitPct / 100) exitReason = "takeProfit";
      else if (fromPeak <= -p.trailingStopPct / 100 && pos.peakPriceEthPerToken > pos.entryPriceEthPerToken) exitReason = "trailingStop";
      else if (holdMin >= p.maxHoldMin) exitReason = "maxHold";

      if (!exitReason) {
        keep.push(pos);
        continue;
      }

      const fill = await sell(info, BigInt(pos.tokenAmount));
      const trade = toClosedTrade(pos, fill.ethAmount, exitReason, fill.simulated, fill.txHash);
      journalTrade(trade);
      recordPnl(trade.pnlEth);
      recentExits.set(pos.token.toLowerCase(), Date.now());
      log("trade", `CLOSED ${pos.symbol} [${exitReason}] pnl ${trade.pnlEth.toFixed(5)} ETH (${trade.pnlPct.toFixed(1)}%) after ${trade.holdMin.toFixed(0)}m`);

      if (exitReason === "rug") {
        await addRug(pos.token, `rugged while held, pnl ${trade.pnlPct.toFixed(0)}%`);
        recordEventLesson(`Rug on ${pos.symbol} (${pos.token}): liquidity pulled ${trade.pnlPct.toFixed(0)}% loss. Creator blacklisted.`);
      }
      reflect(); // learn after every trade
    } catch (e) {
      const msg = (e as Error).message;
      // A sell quote that keeps reverting means the token blocks sells (honeypot
      // armed after launch) or the pool is gone. Holding it forever would pin an
      // open-position slot, so write it off as a total loss and learn from it.
      if (msg.includes("reverted")) {
        const fails = (sellRevertCounts.get(pos.id) ?? 0) + 1;
        sellRevertCounts.set(pos.id, fails);
        if (fails >= SELL_REVERTS_TO_WRITE_OFF) {
          const trade = toClosedTrade(pos, 0, "rug", !LIVE);
          journalTrade(trade);
          recordPnl(trade.pnlEth);
          recentExits.set(pos.token.toLowerCase(), Date.now());
          sellRevertCounts.delete(pos.id);
          await addRug(pos.token, "sell quote reverts — honeypot armed after entry");
          recordEventLesson(
            `Honeypot write-off: ${pos.symbol} (${pos.token}) passed the entry round-trip check but sells revert now. ` +
            `Lost ${pos.costEth} ETH. Creator blacklisted; entry checks cannot catch delayed sell-blocks — position sizing is the defense.`,
          );
          log("trade", `WRITE-OFF ${pos.symbol}: sells revert ${fails}x — booked as rug, -${pos.costEth} ETH`);
          reflect();
          continue; // do not keep
        }
      }
      log("trade", `exit error on ${pos.symbol} (${sellRevertCounts.get(pos.id) ?? 0} reverts): ${msg.slice(0, 120)} — keeping position`);
      keep.push(pos);
    }
  }
  positions.save(keep);
}

async function tryEnter(c: Candidate) {
  const p = loadParams();
  const open = positions.load();
  const tokenKey = c.info.token.toLowerCase();
  if (open.some((o) => o.token.toLowerCase() === tokenKey)) return;
  const lastExit = recentExits.get(tokenKey);
  if (lastExit && Date.now() - lastExit < REENTRY_COOLDOWN_MS) return;

  if (c.kind === "newListing" && launchpadDistrusted(c.launchpad)) {
    scanner.consumeNewPool(c.info.pool);
    log("safety", `rejected ${c.info.symbol}: launchpad ${c.launchpad} has a rug record — distrusted`);
    return;
  }

  const sizeEth = c.kind === "momentum" ? p.tradeSizeEth : p.newListingSizeEth;
  const risk = await canEnter(sizeEth);
  if (!risk.allowed) {
    log("risk", `blocked ${c.info.symbol}: ${risk.reason}`);
    return;
  }

  const safety = await checkSafety(c.info.token, c.info.pool, c.info.fee, sizeEth, p.minPoolWethEth, p.maxRoundTripLossPct);
  if (c.kind === "newListing") scanner.consumeNewPool(c.info.pool);
  if (!safety.ok) {
    log("safety", `rejected ${c.info.symbol} (${c.kind}): ${safety.reason}`);
    return;
  }

  try {
    const fill = await buy(c.info, sizeEth);
    const pos: Position = {
      id: randomUUID(),
      live: LIVE,
      strategy: c.kind,
      token: c.info.token,
      symbol: c.info.symbol,
      pool: c.info.pool,
      fee: c.info.fee,
      tokenIsToken0: c.info.tokenIsToken0,
      decimals: c.info.decimals,
      costEth: fill.ethAmount,
      tokenAmount: fill.tokenAmount.toString(),
      entryPriceEthPerToken: c.price,
      peakPriceEthPerToken: c.price,
      poolWethAtEntry: safety.poolWethEth ?? p.minPoolWethEth,
      launchpad: c.launchpad,
      entryTxHash: fill.txHash,
      openedAt: Date.now(),
      entrySignal: { ...c.features, roundTripLossPct: safety.roundTripLossPct ?? 0, poolWethEth: safety.poolWethEth ?? 0 },
      paramsAtEntry: { ...p },
    };
    const all = positions.load();
    all.push(pos);
    positions.save(all);
    recordSpend(fill.ethAmount);
    log("trade", `OPENED ${c.kind} ${c.info.symbol} size ${sizeEth} ETH @ ${c.price.toExponential(4)} ETH/token ${fill.simulated ? "(dry)" : fill.txHash}`);
  } catch (e) {
    log("trade", `buy failed ${c.info.symbol}: ${(e as Error).message.slice(0, 150)}`);
  }
}

async function fastTick() {
  await Promise.all([scanner.pollDiscovery(), managePositions()]);
  const p = loadParams();
  saveJson("scanner.json", { ts: Date.now(), stats: scanner.stats(), radar: scanner.radar(p) });
  if (killSwitchOn()) return;
  // New listings first (time-sensitive), then strongest momentum.
  for (const c of scanner.newListingCandidates(p)) await tryEnter(c);
  for (const c of scanner.momentumCandidates(p).slice(0, 3)) await tryEnter(c);
}

/** Heavy chain-wide swap sweep — own loop so it never blocks exits/snipes. */
async function sweepLoop() {
  for (;;) {
    try {
      await scanner.pollSwaps();
    } catch (e) {
      log("scanner", `sweep error: ${(e as Error).message.slice(0, 120)}`);
    }
    await sleep(1000);
  }
}

async function main() {
  log("agent", `hood-agent starting — ${liveModeExplanation()}`);
  if (LIVE && account) log("agent", `wallet: ${account.address}`);
  log("agent", `hard caps: ${JSON.stringify(HARD)}`);
  log("agent", `params: ${JSON.stringify(loadParams())}`);
  const parked = archiveForeignModePositions();
  if (parked) log("agent", `parked ${parked} position(s) from the other mode into positions-archive.jsonl`);
  await scanner.init();
  void sweepLoop();
  let lastStats = 0;
  for (;;) {
    try {
      await fastTick();
    } catch (e) {
      log("agent", `tick error: ${(e as Error).message.slice(0, 200)}`);
    }
    if (Date.now() - lastStats > 60_000) {
      lastStats = Date.now();
      const s = scanner.stats();
      log("agent", `tracking ${s.trackedPools} pools, ${s.pendingNewPools} fresh listings, block ${s.lastBlock} (sweep lag ${s.swapLagBlocks}), open positions ${positions.load().length}`);
    }
    await sleep(FAST_POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
