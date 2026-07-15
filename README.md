# Robin Good — Your Memecoin Trader

Self-learning memecoin trading agent for **Robinhood Chain** (chain ID 4663)
with a real-time dashboard. Catches new Uniswap v3 listings and momentum
breakouts, trades them with hard risk caps, and **learns from every closed
trade** by adapting its own strategy parameters and writing the reasoning to
`data/LESSONS.md`.

**Dashboard** (`npm run dash`, port 5190): live radar of what the scanner is
watching, wallet balance & equity, per-token portfolio P&L, equity curve,
open positions with live marks, trade history with block-explorer proof links
for every fill, the agent's lessons feed, and a colorized activity log.

> ⚠️ Memecoins on a 11-day-old chain are about as risky as trading gets. Most
> new tokens go to zero; honeypots and rugs are common and not all of them are
> detectable up front. Run only with a burner wallet and money you can afford
> to lose entirely. Nothing here is investment advice.

## How it works

Every ~5s tick:

1. **Scan** — one `eth_getLogs` sweep pulls all Uniswap `Swap` events (price +
   volume per pool) and factory `PoolCreated` events (new listings). Only WETH
   pairs from the canonical Uniswap v3 factory are considered.
2. **Manage exits** — open positions are checked against take-profit, trailing
   stop, hard stop, max hold time, kill switch, and a rug detector (WETH-side
   liquidity collapse → immediate exit + creator blacklist).
3. **Enter** — new-listing candidates (young pools) and momentum candidates
   (price gain over lookback + volume spike vs baseline) pass through:
   - **risk manager** (hard caps: per-trade size, open positions, daily spend,
     daily loss, wallet gas reserve, kill switch), then
   - **safety gate** (blacklists, min pool liquidity, round-trip honeypot
     quote through QuoterV2), then execution via SwapRouter02.
4. **Learn** — every closed trade is journaled with its entry features, exit
   reason, and max-favorable-excursion. After each close the reflection pass
   re-analyzes the recent record and nudges parameters within bounds:
   low win rate → stricter entries; winners round-tripping to stops → earlier
   profit taking; exits leaving money on the table → let winners run; rugs →
   deeper liquidity requirement + smaller size; net negative → size down.
   Every change is appended to `data/LESSONS.md` with the evidence.

**The learner can never raise risk beyond your `.env` hard caps** — bounds in
`src/params.ts` are clamped to them.

## Quickstart

```bash
git clone https://github.com/boogaav/robin-good && cd robin-good
npm install && npm run setup   # scaffolds .env with safe dry-run defaults
npm run dev                    # starts in DRY_RUN: real market data, simulated fills
npm run dash                   # dashboard at http://localhost:5190
```

Optional: Telegram notifications for every fill (with explorer proof links) —
create a bot via @BotFather and set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
in `.env`. Recommended for live mode: a free Alchemy RPC endpoint (see
`.env.example`) — the public RPC is rate-limited.

Other commands:

```bash
npm run status         # positions, daily book, params, last trades
npm run reflect        # per-strategy performance report
touch data/KILL        # kill switch: stop entries, exit all positions
rm data/KILL           # re-arm
```

## Going live (deliberately manual)

1. `npm run wallet` — generates a fresh burner keypair, appends the key to
   `.env` (0600), and prints only the address. Run it yourself.
2. Fund the printed address with ETH **on Robinhood Chain** (Robinhood Wallet
   app supports the chain natively; or bridge via Across/Relay to chain 4663).
3. In `.env` uncomment:
   ```
   LIVE=1
   ARM_LIVE=I-UNDERSTAND-THE-RISKS
   ```
4. Start it yourself: `npm run dev`. All three settings (including the key)
   are required; anything less and it stays in DRY_RUN.

Let it run in DRY_RUN for at least a day first — the learning loop trains on
paper trades too, so it goes live with tuned parameters and a populated
blacklist rather than defaults.

## Verified chain constants (2026-07-12)

| What | Address |
|---|---|
| Uniswap v3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

Cross-checked on-chain: `router.factory() == quoter.factory() == factory`,
`router.WETH9() == quoter.WETH9() == WETH`, and CASHCAT/WETH pools exist on
that factory at all fee tiers.

## Data files (`data/`)

- `journal.jsonl` — every closed trade with full context
- `params.json` / `params-history.jsonl` — current + historical strategy params
- `LESSONS.md` — human-readable log of what the agent learned and why
- `positions.json`, `daily.json`, `blacklist.json` — live state
- `KILL` — create to halt (checked every tick)
