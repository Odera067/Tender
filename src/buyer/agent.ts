/**
 * The shopping loop: model proposes, code decides.
 *
 *   planner.propose() → sanity checks in code → payer.buy()
 *                                                 └ BudgetGuard in the x402 pre-sign hook
 *
 * Every step is emitted as an event (the live UI streams them) and recorded
 * for the receipt.
 */
import { randomUUID } from "node:crypto";
import { USDC, config } from "../config.js";
import { BudgetGuard, atomicToUsd, usdToAtomic } from "./guard.js";
import type { Payer } from "./payer.js";
import type { CatalogProduct, Evidence, Planner, Proposal } from "./planner.js";

export type AgentEvent =
  | { type: "start"; id: string; question: string; budget: string; perCallCap: string; planner: string; payer: Payer["mode"]; wallet: string; network: string }
  | { type: "catalog"; products: CatalogProduct[]; symbols: string[] }
  | { type: "thinking"; step: number }
  | { type: "proposal"; step: number; proposal: Proposal; model: string }
  | { type: "guard"; step: number; approved: boolean; reason: string; price?: string }
  | { type: "purchase"; step: number; item: ReceiptLine }
  | { type: "purchase_failed"; step: number; product: string; error: string }
  | { type: "answer"; answer: string; confidence: number; reason: string }
  | { type: "receipt"; receipt: Receipt }
  | { type: "error"; message: string };

export interface ReceiptLine {
  product: string;
  symbol: string;
  url: string;
  price: string;
  reason: string;
  confidenceBefore: number;
  txHash?: string;
  explorerUrl?: string;
  mock?: boolean;
}

export interface Receipt {
  id: string;
  question: string;
  answer: string;
  confidence: number;
  bought: ReceiptLine[];
  blocked: { product: string; symbol: string; reason: string; modelReason: string }[];
  notBought: { product: string; why: string }[];
  budget: string;
  spent: string;
  unspent: string;
  planner: string;
  payer: Payer["mode"];
  wallet: string;
  network: string;
  servTokens: { prompt: number; completion: number };
  steps: number;
  /** Stopped early because the user cancelled. */
  cancelled: boolean;
  /** What was bought, verbatim, so a receipt can be audited later. */
  evidence: Evidence[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface RunOptions {
  question: string;
  budgetUsd: string;
  planner: Planner;
  payer: Payer;
  sellerUrl?: string;
  emit?: (e: AgentEvent) => void;
  /** Abort between steps (e.g. the viewer closed the page). Purchases already made stay on the receipt. */
  signal?: AbortSignal;
}

export async function runShopper(opts: RunOptions): Promise<Receipt> {
  const emit = opts.emit ?? (() => {});
  const sellerUrl = (opts.sellerUrl ?? config.buyer.sellerUrl).replace(/\/$/, "");
  const { planner, payer } = opts;
  const id = randomUUID();
  const started = Date.now();

  // Discover the catalog for free. The seller's recipient comes from it and is
  // pinned in the guard, so a 402 asking us to pay someone else gets refused.
  const catRes = await fetch(`${sellerUrl}/catalog`);
  if (!catRes.ok) throw new Error(`catalog unavailable: HTTP ${catRes.status}`);
  const catalog = (await catRes.json()) as { products: CatalogProduct[]; symbols: string[]; payTo: string; network: string };
  if (catalog.network !== config.network)
    throw new Error(`seller is on ${catalog.network} but this buyer is configured for ${config.network}; refusing to shop`);
  if (usdToAtomic(opts.budgetUsd) > usdToAtomic(config.buyer.maxBudgetUsd))
    throw new Error(`budget $${opts.budgetUsd} is above the $${config.buyer.maxBudgetUsd} ceiling (MAX_BUDGET_USD)`);

  const usdc = USDC[config.network];
  const guard = new BudgetGuard({
    totalBudget: usdToAtomic(opts.budgetUsd),
    perCallCap: usdToAtomic(config.buyer.perCallCapUsd),
    maxPurchases: config.buyer.maxPurchases,
    allowedOrigins: [new URL(sellerUrl).origin],
    allowedNetworks: [config.network],
    allowedAssets: usdc ? [usdc.toLowerCase()] : [],
    allowedPayTo: [catalog.payTo.toLowerCase()],
  });

  emit({
    type: "start",
    id,
    question: opts.question,
    budget: atomicToUsd(guard.policy.totalBudget),
    perCallCap: atomicToUsd(guard.policy.perCallCap),
    planner: planner.name,
    payer: payer.mode,
    wallet: payer.address,
    network: payer.network,
  });
  emit({ type: "catalog", products: catalog.products, symbols: catalog.symbols });

  const evidence: Evidence[] = [];
  const notes: string[] = [];
  const bought: ReceiptLine[] = [];
  const blocked: Receipt["blocked"] = [];
  const tokens = { prompt: 0, completion: 0 };
  let final: Extract<Proposal, { action: "answer" }> | null = null;
  let consecutiveRejections = 0;
  let step = 0;

  const budgetView = () => ({
    total: atomicToUsd(guard.policy.totalBudget),
    spent: atomicToUsd(guard.spent),
    remaining: atomicToUsd(guard.remaining),
    perCallCap: atomicToUsd(guard.policy.perCallCap),
  });

  while (!final) {
    if (opts.signal?.aborted) {
      final = {
        action: "answer",
        answer: "Cancelled before an answer. Anything already bought is on the receipt.",
        reason: "cancelled by user",
        confidence: 0,
        notBought: [],
      };
      break;
    }
    step++;
    const cheapest = catalog.products.reduce((m, p) => (usdToAtomic(p.price) < m ? usdToAtomic(p.price) : m), guard.policy.totalBudget + 1n);
    const mustAnswer =
      step > config.buyer.maxSteps || consecutiveRejections >= 2 || !guard.canAfford(cheapest) || guard.purchaseCount >= config.buyer.maxPurchases;

    emit({ type: "thinking", step });
    const out = await planner.propose({
      question: opts.question,
      symbols: catalog.symbols,
      catalog: catalog.products,
      budget: budgetView(),
      evidence,
      notes,
      mustAnswer,
    });
    if (out.usage) {
      tokens.prompt += out.usage.prompt;
      tokens.completion += out.usage.completion;
    }
    const p = out.proposal;
    emit({ type: "proposal", step, proposal: p, model: out.model });

    if (p.action === "answer") {
      final = p;
      break;
    }
    if (mustAnswer) {
      // Planner ignored the instruction. Code ends the run.
      final = {
        action: "answer",
        answer: "Stopped: the planner kept proposing purchases after being told to answer. See the evidence bought so far.",
        reason: "forced stop by agent loop",
        confidence: 0,
        notBought: [],
      };
      break;
    }

    // Code-side checks on the proposal (cheap, before any network call).
    const product = catalog.products.find((x) => x.id === p.product);
    const symbol = p.symbol.toUpperCase();
    const reject = (reason: string) => {
      emit({ type: "guard", step, approved: false, reason, price: product?.price });
      blocked.push({ product: p.product, symbol, reason, modelReason: p.reason });
      notes.push(`Step ${step}: proposal to buy ${p.product} for ${symbol} was BLOCKED: ${reason}`);
      consecutiveRejections++;
    };
    if (!product) {
      reject(`"${p.product}" is not in the catalog`);
      continue;
    }
    if (!catalog.symbols.includes(symbol)) {
      reject(`symbol ${symbol} is not sold here`);
      continue;
    }

    // The authoritative check happens in the x402 hook against the seller's
    // real 402 price. This is just the early, visible version of it.
    const listed = usdToAtomic(product.price);
    if (!guard.canAfford(listed)) {
      reject(`${product.price} exceeds remaining budget ${atomicToUsd(guard.remaining)} or per-call cap`);
      continue;
    }

    const url = `${sellerUrl}${product.path}?symbol=${symbol}`;
    const res = await payer.buy(url, guard);

    if (res.blocked) {
      reject(`/data/${product.id}: ${res.blocked}`);
      continue;
    }
    if (!res.ok) {
      consecutiveRejections++;
      emit({ type: "purchase_failed", step, product: product.id, error: res.error ?? `HTTP ${res.status}` });
      notes.push(`Step ${step}: purchase of ${product.id} for ${symbol} FAILED: ${res.error}`);
      continue;
    }

    consecutiveRejections = 0;
    const price = atomicToUsd(res.amount ?? listed);
    emit({ type: "guard", step, approved: true, reason: "within budget, allowlisted seller", price });
    const line: ReceiptLine = {
      product: product.id,
      symbol,
      url,
      price,
      reason: p.reason,
      confidenceBefore: p.confidence,
      txHash: res.txHash,
      explorerUrl: res.explorerUrl,
      mock: res.mock,
    };
    bought.push(line);
    evidence.push({ product: product.id, symbol, pricePaid: price, data: res.data });
    emit({ type: "purchase", step, item: line });
  }

  emit({ type: "answer", answer: final.answer, confidence: final.confidence, reason: final.reason });

  const receipt: Receipt = {
    id,
    question: opts.question,
    answer: final.answer,
    confidence: final.confidence,
    bought,
    blocked,
    notBought: final.notBought ?? [],
    budget: atomicToUsd(guard.policy.totalBudget),
    spent: atomicToUsd(guard.spent),
    unspent: atomicToUsd(guard.remaining),
    planner: planner.name,
    payer: payer.mode,
    wallet: payer.address,
    network: payer.network,
    servTokens: tokens,
    steps: step,
    cancelled: !!opts.signal?.aborted,
    evidence,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
  emit({ type: "receipt", receipt });
  return receipt;
}
