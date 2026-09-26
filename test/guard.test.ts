import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetGuard, atomicToUsd, usdToAtomic, type GuardPolicy, type PaymentRequirement } from "../src/buyer/guard.js";

const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const SELLER = "0x1111111111111111111111111111111111111111";

const policy = (over: Partial<GuardPolicy> = {}): GuardPolicy => ({
  totalBudget: usdToAtomic("0.05"),
  perCallCap: usdToAtomic("0.05"),
  maxPurchases: 5,
  allowedOrigins: ["http://localhost:4021"],
  allowedNetworks: ["eip155:84532"],
  allowedAssets: [USDC],
  allowedPayTo: [SELLER],
  ...over,
});

const req = (path: string, usd: string, over: Partial<PaymentRequirement> = {}): PaymentRequirement => ({
  url: `http://localhost:4021${path}`,
  network: "eip155:84532",
  asset: USDC,
  payTo: SELLER,
  amount: usdToAtomic(usd),
  ...over,
});

test("usd <-> atomic conversion is exact", () => {
  assert.equal(usdToAtomic("$0.001"), 1000n);
  assert.equal(usdToAtomic("0.05"), 50000n);
  assert.equal(usdToAtomic("1"), 1_000_000n);
  assert.equal(usdToAtomic("0.1234567"), 123456n); // truncates beyond 6dp
  assert.equal(atomicToUsd(61000n), "$0.061");
  assert.equal(atomicToUsd(1500n), "$0.0015");
  assert.equal(atomicToUsd(50000n), "$0.050");
  assert.equal(atomicToUsd(1_000_000n), "$1.000");
});

test("never exceeds the total budget, whatever gets proposed", () => {
  const g = new BudgetGuard(policy({ totalBudget: usdToAtomic("0.02") }));
  assert.ok(g.authorize(req("/data/quote?symbol=ETH", "0.001")).ok);
  assert.ok(g.authorize(req("/data/metrics?symbol=ETH", "0.01")).ok);
  const d = g.authorize(req("/data/report?symbol=ETH", "0.05"));
  assert.equal(d.ok, false);
  assert.match((d as { reason: string }).reason, /per-call cap|remaining budget/);
  assert.equal(g.spent, usdToAtomic("0.011"));
  assert.ok(g.spent <= g.policy.totalBudget);
});

test("per-call cap applies even with budget left", () => {
  const g = new BudgetGuard(policy({ totalBudget: usdToAtomic("1"), perCallCap: usdToAtomic("0.01") }));
  const d = g.authorize(req("/data/report?symbol=ETH", "0.05"));
  assert.equal(d.ok, false);
  assert.match((d as { reason: string }).reason, /per-call cap/);
});

test("per-call cap above total is clamped to total", () => {
  const g = new BudgetGuard(policy({ totalBudget: usdToAtomic("0.01"), perCallCap: usdToAtomic("5") }));
  assert.equal(g.policy.perCallCap, usdToAtomic("0.01"));
});

test("refuses unknown origin, network, asset, recipient", () => {
  const g = new BudgetGuard(policy());
  assert.equal(g.authorize(req("/x", "0.001", { url: "https://evil.example/data/quote" })).ok, false);
  assert.equal(g.authorize(req("/a", "0.001", { network: "eip155:8453" })).ok, false);
  assert.equal(g.authorize(req("/b", "0.001", { asset: "0xdeadbeef00000000000000000000000000000000" })).ok, false);
  assert.equal(g.authorize(req("/c", "0.001", { payTo: "0x2222222222222222222222222222222222222222" })).ok, false);
  assert.equal(g.spent, 0n);
});

test("refuses to pay twice for the same resource", () => {
  const g = new BudgetGuard(policy());
  assert.ok(g.authorize(req("/data/quote?symbol=ETH", "0.001")).ok);
  assert.equal(g.authorize(req("/data/quote?symbol=ETH", "0.001")).ok, false);
  assert.ok(g.authorize(req("/data/quote?symbol=BTC", "0.001")).ok);
});

test("released reservations free budget; committed ones don't", () => {
  const g = new BudgetGuard(policy({ totalBudget: usdToAtomic("0.01") }));
  const a = g.authorize(req("/data/metrics?symbol=ETH", "0.01"));
  assert.ok(a.ok);
  assert.equal(g.remaining, 0n);
  g.release((a as { reservationId: string }).reservationId);
  assert.equal(g.remaining, usdToAtomic("0.01"));
  const b = g.authorize(req("/data/metrics?symbol=ETH", "0.01"));
  assert.ok(b.ok);
  g.commit((b as { reservationId: string }).reservationId);
  g.release((b as { reservationId: string }).reservationId); // no-op after commit
  assert.equal(g.remaining, 0n);
});

test("purchase count limit", () => {
  const g = new BudgetGuard(policy({ maxPurchases: 2 }));
  assert.ok(g.authorize(req("/1", "0.001")).ok);
  assert.ok(g.authorize(req("/2", "0.001")).ok);
  assert.equal(g.authorize(req("/3", "0.001")).ok, false);
});

test("zero or negative prices are refused", () => {
  const g = new BudgetGuard(policy());
  assert.equal(g.authorize(req("/z", "0")).ok, false);
});
