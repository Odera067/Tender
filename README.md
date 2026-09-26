# Tender

**An agent that pays for exactly the data it needs, and no more.**

Ask one question. The agent looks at a seller's price list, buys the cheapest data that could answer it, and only pays for something more expensive if that wasn't enough. Every purchase is a real USDC payment over [x402](https://docs.cdp.coinbase.com/x402): no subscriptions, no API keys, no accounts. You get an answer and a receipt showing what was bought, why, and the on-chain transaction for each item.

Built for **OpenServ SERV Hackathon Edition 01, AgentKit track**.

| | |
|---|---|
| **Reasoning** | [SERV Reasoning](https://docs.openserv.ai/serv-reasoning/api/chat-completions) decides what's worth buying |
| **Guardrail** | `BudgetGuard`: plain code, runs inside the x402 client's pre-signing hook |
| **Wallet** | [Coinbase AgentKit](https://github.com/coinbase/agentkit) (`CdpEvmWalletProvider`, or `ViemWalletProvider` with a local key) |
| **Payments** | x402 v2 `exact` scheme: signed USDC `transferWithAuthorization`, settled on Base by the facilitator |

## Model proposes, code decides

```
 question ─► SERV Reasoning ──proposes──► agent loop ──► x402 client ──► seller
              "buy metrics(SOL):           (catalog,       │
               quote had no trend data"     symbol checks)  ▼
                                                     onBeforePaymentCreation
                                                     └─ BudgetGuard.authorize(real 402 price)
                                                         ✓ reserve → sign → settle → commit
                                                         ✗ abort: nothing is signed
```

The model never touches the wallet. Nothing is signed unless `BudgetGuard` approves it, and the guard checks the **price the seller actually demands in its HTTP 402 challenge**, not the price the model thinks it's paying. The guard enforces:

- a hard **total budget** for the task, with in-flight payments reserved before signing
- a **per-call cap**
- a **max number of purchases**
- **allowlists** for seller origin, network, token (USDC) and recipient address (pinned from the seller's catalog)
- **no double-buying** of the same resource

If the model keeps proposing things it can't afford, the loop tells it what was blocked, then forces it to answer with the evidence it has. If it still won't answer, code ends the run. There are tests for each of these cases (`test/agent.test.ts`).

## The seller

A small market-data API ([`src/seller`](src/seller)) with three paid tiers and a free catalog:

| Endpoint | Price | Contains |
|---|---|---|
| `GET /catalog` | free | products, prices, payTo, network |
| `GET /data/quote?symbol=ETH` | $0.001 | spot price, 24h change, volume |
| `GET /data/metrics?symbol=ETH` | $0.01 | 7d/30d return, realized vol, drawdown, vs 30d MA |
| `GET /data/report?symbol=ETH` | $0.05 | exchange flows, funding/OI, sentiment, risks, catalysts, stance |

Symbols: BTC, ETH, SOL, LINK, AERO. Spot prices come live from CoinGecko when it's reachable; history, flows and sentiment come from a deterministic demo dataset anchored to that spot price. Every payload says which parts are which.

Different questions stop at different depths:

| Question | Typically buys | Spend |
|---|---|---|
| "What's ETH trading at?" | quote | $0.001 |
| "Has SOL trended up this month? How volatile?" | quote → metrics | $0.011 |
| "Should a cautious holder add LINK? Risks?" | quote → metrics → report | $0.061 |

With a $0.05 budget, the third question shows the guard at work: the report doesn't fit after the first two purchases, so the model is told and answers with what it has, saying what it couldn't check.

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

1. **`SERV_API_KEY`**, from [console.openserv.ai](https://console.openserv.ai).
2. **Buyer wallet** (AgentKit). Either CDP keys (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`) from [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com), or a local key: `npm run wallet -- new`, then set `BUYER_PRIVATE_KEY`.
3. **`SELLER_PAY_TO`**: any address you control that isn't the buyer's.
4. Fund the buyer with Base Sepolia USDC: `npm run wallet -- faucet` (CDP keys) or [faucet.circle.com](https://faucet.circle.com). A few cents covers dozens of runs. With CDP keys, the first run creates the wallet; put the printed address in `CDP_WALLET_ADDRESS` so later runs reuse it.

Then:

```bash
npm run demo          # website http://localhost:3000, dashboard /app, seller /catalog (one server)
```

or from a second terminal, while `npm run demo` is running:

```bash
npm run shop -- "Has SOL been in an uptrend this month?" --budget 0.02
```

Other scripts:

```bash
npm test              # guard + agent-loop tests (offline, no wallet or model needed)
npm run typecheck
npm run wallet        # buyer address + USDC balance
```

**Offline/dev modes** (clearly labelled in the UI and receipt, never used for the demo):
`PLANNER=scripted` swaps SERV for a keyword planner. `PAYMENTS=mock` plus `SELLER_ALLOW_MOCK=true` still reads the real 402 challenge and runs the guard, but skips signing, so no money moves.

### Mainnet

Real USDC on Base. Payments settle through Coinbase's CDP facilitator (the first 1,000 settlements a month are free), authenticated with the same `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`.

1. In `.env`, set `X402_NETWORK=eip155:8453`.
2. Check the buyer address with `npm run wallet` and send it a little USDC on **Base** (a dollar covers dozens of questions). The buyer needs no ETH, because the facilitator pays gas.
3. `npm run demo`. The page shows a red **MAINNET** chip.

Extra safety on mainnet:
- Each question's budget is capped at **$0.25** unless you raise `MAX_BUDGET_USD`.
- The mock payment bypass can't be turned on.
- The seller won't start without a real `SELLER_PAY_TO` address.
- The buyer won't shop from a seller on a different network.

The guard's own limits (per-call cap, purchase count, allowlists) apply exactly as on testnet.

## The app

- **Website** (`/`): what Tender is, how the guard works, the seller's live price list, and live totals from real runs.
- **Dashboard** (`/app`):
  - wallet balance, with a low-balance warning
  - the guard's policy
  - a question box with budget presets
  - a live timeline of every proposal, guard decision and payment
  - a budget meter showing paid vs blocked
  - the answer, a paper receipt with BaseScan links, and the raw evidence bought
  - run history
- **Receipts:** every run is saved to `data/runs.jsonl` (git-ignored). Each one can be downloaded as JSON, copied as a summary, or linked to (`/app#run=<id>`).
- **Stop:** the Stop button or Esc cancels a run between steps. Anything already bought stays on the receipt.
- **API:** `GET /api/health`, `/api/info`, `/api/catalog`, `/api/stats`, `/api/runs`, `/api/runs/:id`, and `/api/shop` (SSE).

## Layout

```
src/
  config.ts             env, USDC addresses, explorers
  seller/
    catalog.ts          products + prices
    data.ts             the data behind the paywall
    server.ts           Express + @x402/express paymentMiddleware
  buyer/
    guard.ts            BudgetGuard: the code that decides
    planner.ts          SERV Reasoning planner (+ offline scripted planner)
    payer.ts            AgentKit wallet → x402 client, guard in onBeforePaymentCreation
    agent.ts            the propose → check → pay → evaluate loop, receipt
  app.ts                demo server: pages, API, live runs over SSE (+ starts the seller)
  store.ts              run history (data/runs.jsonl): dashboard history + website stats
  cli.ts                terminal demo
public/
  index.html            website: what Tender is, live stats, price list
  app.html, app.js      dashboard: ask, watch it shop, receipt, evidence, history
  styles.css, theme.js  shared design system, light/dark theme
test/                   guard + agent-loop tests
```

## Deploy to Vercel

The whole app is one Express server (`src/app.ts`): the website, the dashboard, the API and the x402 seller. Vercel runs it as a single function and serves `public/` from its CDN.

1. On vercel.com, click **Add New → Project** and import the GitHub repo. Leave the defaults; there's no build step.
2. Under **Environment Variables**, add everything from your `.env`, including `CDP_WALLET_ADDRESS`. Without it, every cold start creates a new, empty wallet. Leave out `APP_PORT` and `SELLER_PORT`. Then add:
   - `SELLER_URL`: your production URL, e.g. `https://tender.vercel.app` (no trailing slash).
   - `DEMO_ACCESS_CODE`: the site is public, and without a code anyone could spend your wallet's USDC and your SERV credits.
   - `DAILY_SPEND_CAP_USD`, e.g. `1`: a hard limit on real spend per UTC day, across all visitors.
3. Optional, for history and stats that survive restarts: in the project, go to **Storage → Marketplace → Upstash Redis** and connect it. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, and Tender uses them automatically. Without it, history lives only as long as a function instance.
4. **Deploy**, then open `/api/health`. `"ready": true` means the wallet and SERV are set up.

Notes:
- The first request after a quiet spell is a cold start: the AgentKit wallet loads and the seller connects to the facilitator. Give it a few seconds.
- Runs stream over SSE and normally finish in well under a minute, inside Vercel's default function time limit.

## Hackathon submission checklist

- [ ] Enable data collection in the OpenServ console (organisation settings)
- [ ] Public X post about the project
- [ ] Submission form, before **28 Sept 2026 00:00 UTC**
- [ ] Demo video: one question in, live purchases with BaseScan links, answer, receipt

*Demo data, not investment advice.*
