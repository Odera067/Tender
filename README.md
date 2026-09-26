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
