/**
 * Agent-loop tests with a fake seller catalog and a fake payer, so no network
 * or wallet is needed. The payer runs the real BudgetGuard, as the x402 hook does.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runShopper, type AgentEvent } from "../src/buyer/agent.js";
import { usdToAtomic, type BudgetGuard } from "../src/buyer/guard.js";
import type { Payer } from "../src/buyer/payer.js";
import type { Planner, PlannerInput, Proposal } from "../src/buyer/planner.js";
import { PRODUCTS, SYMBOLS } from "../src/seller/catalog.js";
import { USDC, config } from "../src/config.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
let server: http.Server;
let sellerUrl: string;

before(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ products: PRODUCTS, symbols: SYMBOLS, payTo: PAY_TO, network: config.network }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  sellerUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** Charges the real listed price through the guard, the way the x402 hook would. */
function fakePayer(overcharge = 1n): Payer & { paid: string[] } {
  const paid: string[] = [];
  return {
    mode: "mock",
    address: "0xtest",
    network: config.network,
    paid,
    async usdcBalance() {
      return null;
    },
    async buy(url: string, guard: BudgetGuard) {
      const path = new URL(url).pathname;
      const product = PRODUCTS.find((p) => p.path === path)!;
      const amount = usdToAtomic(product.price) * overcharge;
      const d = guard.authorize({ url, network: config.network, asset: USDC[config.network], payTo: PAY_TO, amount });
      if (!d.ok) return { ok: false, url, status: 402, blocked: d.reason, amount };
      guard.commit(d.reservationId);
      paid.push(product.id);
      return { ok: true, url, status: 200, data: { product: product.id }, amount, mock: true };
    },
  };
}

function scriptPlanner(script: (i: PlannerInput, n: number) => Proposal): Planner & { calls: PlannerInput[] } {
  const calls: PlannerInput[] = [];
  return {
    name: "test",
    calls,
    async propose(i) {
      calls.push(structuredClone(i));
      return { proposal: script(i, calls.length), model: "test" };
    },
  };
}

const answer = (text = "done"): Proposal => ({ action: "answer", answer: text, reason: "enough", confidence: 0.9, notBought: [] });
const buy = (product: string, symbol = "ETH"): Proposal => ({ action: "buy", product, symbol, reason: "need it", confidence: 0.3 });

test("stops as soon as the planner is confident, buying only the cheap source", async () => {
  const payer = fakePayer();
  const planner = scriptPlanner((i) => (i.evidence.length === 0 ? buy("quote") : answer("ETH is $3k")));
  const r = await runShopper({ question: "ETH price?", budgetUsd: "0.05", planner, payer, sellerUrl });
  assert.deepEqual(payer.paid, ["quote"]);
  assert.equal(r.spent, "$0.001");
  assert.equal(r.unspent, "$0.049");
  assert.equal(r.answer, "ETH is $3k");
});

test("escalates cheap -> expensive only when asked, and the receipt records it", async () => {
  const payer = fakePayer();
  const ladder = ["quote", "metrics", "report"];
  const planner = scriptPlanner((i) => (i.evidence.length < 3 ? buy(ladder[i.evidence.length]) : answer()));
  const r = await runShopper({ question: "should I buy ETH?", budgetUsd: "0.1", planner, payer, sellerUrl });
  assert.deepEqual(payer.paid, ["quote", "metrics", "report"]);
  assert.equal(r.spent, "$0.061");
  assert.equal(r.bought.length, 3);
});

test("a greedy model can't overspend: the guard blocks it and the loop forces an answer", async () => {
  const payer = fakePayer();
  // Keeps proposing the $0.05 report on a $0.02 budget.
  const planner = scriptPlanner((i) => (i.mustAnswer ? answer("partial") : buy("report")));
  const events: AgentEvent[] = [];
  const r = await runShopper({ question: "q", budgetUsd: "0.02", planner, payer, sellerUrl, emit: (e) => events.push(e) });
  assert.deepEqual(payer.paid, []);
  assert.equal(r.spent, "$0.000");
  assert.ok(r.blocked.length >= 2);
  assert.ok(planner.calls.at(-1)!.mustAnswer);
  assert.ok(planner.calls.at(-1)!.notes.some((n) => n.includes("BLOCKED")), "planner is told about blocks");
  assert.ok(events.some((e) => e.type === "guard" && !e.approved));
});

test("guard uses the seller's real price, not the catalog's", async () => {
  const payer = fakePayer(10n); // seller charges 10x the listed price at 402 time
  const planner = scriptPlanner((i) => (i.mustAnswer ? answer() : buy("metrics"))); // listed $0.01, really $0.10
  const r = await runShopper({ question: "q", budgetUsd: "0.05", planner, payer, sellerUrl });
  assert.deepEqual(payer.paid, []);
  assert.match(r.blocked[0].reason, /exceeds/);
});

test("a planner that ignores 'must answer' gets stopped by code", async () => {
  const payer = fakePayer();
  const planner = scriptPlanner(() => buy("report"));
  const r = await runShopper({ question: "q", budgetUsd: "0.01", planner, payer, sellerUrl });
  assert.equal(r.confidence, 0);
  assert.match(r.answer, /Stopped/);
  assert.equal(r.spent, "$0.000");
});

test("unknown products and symbols are rejected before any payment", async () => {
  const payer = fakePayer();
  let n = 0;
  const planner = scriptPlanner((i) => {
    n++;
    if (i.mustAnswer) return answer();
    return n === 1 ? buy("premium-alpha") : buy("quote", "DOGE");
  });
  const r = await runShopper({ question: "q", budgetUsd: "0.05", planner, payer, sellerUrl });
  assert.deepEqual(payer.paid, []);
  assert.match(r.blocked[0].reason, /not in the catalog/);
  assert.match(r.blocked[1].reason, /not sold here/);
});
