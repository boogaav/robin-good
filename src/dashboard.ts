import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { formatEther } from "viem";
import { ADDR, DATA_DIR, HARD, KILL_SWITCH_FILE, LIVE, liveModeExplanation } from "./config.js";
import { loadParams } from "./params.js";
import { positions, daily, blacklist, loadJson } from "./state.js";
import { readTrades } from "./journal.js";
import { currentPrice } from "./market.js";
import { utcDay } from "./util.js";
import { pub, account } from "./chain.js";
import { erc20Abi } from "./abi.js";

const PORT = Number(process.env.DASH_PORT ?? 5190);
const HTML = path.resolve(import.meta.dirname, "dashboard.html");
const LOG = path.join(DATA_DIR, "agent.log");
const LESSONS = path.join(DATA_DIR, "LESSONS.md");

/** Interesting log lines only, newest last. */
function tailLog(n: number): string[] {
  try {
    const lines = fs.readFileSync(LOG, "utf8").split("\n");
    const interesting = lines.filter((l) => /\[(trade|discovery|risk|safety|learn|agent|scanner)\]/.test(l));
    return interesting.slice(-n);
  } catch {
    return [];
  }
}

function scannerStats(): { trackedPools?: number; pendingNew?: number; block?: string; at?: string } {
  const line = tailLog(400).reverse().find((l) => l.includes("] tracking "));
  const m = line?.match(/^(\S+) .*tracking (\d+) pools, (\d+) fresh listings, block (\d+)/);
  return m ? { at: m[1], trackedPools: Number(m[2]), pendingNew: Number(m[3]), block: m[4] } : {};
}

async function enrichPositions() {
  const open = positions.load();
  return Promise.all(
    open.map(async (p) => {
      let mark: number | null = null;
      try {
        mark = await currentPrice({ pool: p.pool, token: p.token, tokenIsToken0: p.tokenIsToken0, fee: p.fee, symbol: p.symbol, decimals: p.decimals });
      } catch { /* pool unreadable — show unpriced */ }
      const qty = Number(formatEther(BigInt(p.tokenAmount))) * 10 ** (18 - p.decimals); // whole tokens
      const valueEth = mark !== null ? qty * mark : null;
      return {
        symbol: p.symbol,
        token: p.token,
        entryTxHash: p.entryTxHash,
        strategy: p.strategy,
        costEth: p.costEth,
        openedAt: p.openedAt,
        entryPrice: p.entryPriceEthPerToken,
        peakGainPct: p.entryPriceEthPerToken > 0 ? (p.peakPriceEthPerToken / p.entryPriceEthPerToken - 1) * 100 : 0,
        mark,
        valueEth,
        uPnlEth: valueEth !== null ? valueEth - p.costEth : null,
        uPnlPct: valueEth !== null && p.costEth > 0 ? ((valueEth - p.costEth) / p.costEth) * 100 : null,
      };
    }),
  );
}

async function walletState() {
  if (!account) return null;
  try {
    const [eth, weth] = await Promise.all([
      pub.getBalance({ address: account.address }),
      pub.readContract({ address: ADDR.WETH, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    ]);
    return { address: account.address, ethBalance: Number(formatEther(eth)), wethBalance: Number(formatEther(weth)) };
  } catch {
    return { address: account.address, ethBalance: null, wethBalance: null };
  }
}

type EnrichedPosition = Awaited<ReturnType<typeof enrichPositions>>[number];

/**
 * Per-token P&L, rebuilt from the journal after every buy/sell. Live trades
 * only, once any exist — falls back to paper history in pure dry-run so the
 * section still renders during testing.
 */
function buildPortfolio(trades: ReturnType<typeof readTrades>, open: EnrichedPosition[]) {
  const live = trades.filter((t) => !t.simulated);
  const src = live.length ? live : trades;
  type Row = { token: string; symbol: string; trades: number; wins: number; realizedEth: number; heldValueEth: number | null; uPnlEth: number | null };
  const byToken = new Map<string, Row>();
  const rowFor = (token: string, symbol: string): Row => {
    const k = token.toLowerCase();
    let r = byToken.get(k);
    if (!r) { r = { token, symbol, trades: 0, wins: 0, realizedEth: 0, heldValueEth: null, uPnlEth: null }; byToken.set(k, r); }
    return r;
  };
  for (const t of src) {
    const r = rowFor(t.token, t.symbol);
    r.trades++;
    r.realizedEth += t.pnlEth;
    if (t.pnlEth > 0) r.wins++;
  }
  for (const p of open) {
    const r = rowFor(p.token, p.symbol);
    r.heldValueEth = p.valueEth;
    r.uPnlEth = p.uPnlEth;
  }
  return [...byToken.values()]
    .map((r) => ({ ...r, totalEth: r.realizedEth + (r.uPnlEth ?? 0) }))
    .sort((a, b) => b.totalEth - a.totalEth);
}

async function state() {
  const trades = readTrades();
  let cum = 0;
  const equity = trades.map((t) => ({ ts: t.closedAt, symbol: t.symbol, pnlEth: t.pnlEth, cumEth: (cum += t.pnlEth) }));
  const bl = blacklist.load();
  const enriched = await enrichPositions();
  return {
    now: Date.now(),
    live: LIVE,
    mode: liveModeExplanation(),
    killSwitch: fs.existsSync(KILL_SWITCH_FILE),
    hard: HARD,
    params: loadParams(),
    daily: daily.load(utcDay()),
    scanner: scannerStats(),
    radar: loadJson<{ ts: number; stats: unknown; radar: unknown[] }>("scanner.json", { ts: 0, stats: {}, radar: [] }),
    wallet: await walletState(),
    positions: enriched,
    portfolio: buildPortfolio(trades, enriched),
    trades: trades.slice(-60).reverse(),
    equity,
    stats: {
      n: trades.length,
      wins: trades.filter((t) => t.pnlEth > 0).length,
      netEth: cum,
      blTokens: bl.tokens.length,
      blCreators: bl.creators.length,
    },
    lessons: fs.existsSync(LESSONS) ? fs.readFileSync(LESSONS, "utf8") : "",
    log: tailLog(35),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      const body = JSON.stringify(await state());
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body);
    } else if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(HTML));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`hood-agent dashboard on http://127.0.0.1:${PORT}`));
