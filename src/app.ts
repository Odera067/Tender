import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { createSellerApp } from "./seller/server.js";
import { createPayer, type Payer } from "./buyer/payer.js";
import { createPlanner, type Planner } from "./buyer/planner.js";
import { runShopper, type AgentEvent } from "./buyer/agent.js";
import { atomicToUsd, usdToAtomic } from "./buyer/guard.js";
import { getRun, listRuns, saveRun, spentToday, stats, storeKind } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
/** Below this the dashboard warns that the wallet needs topping up. */
const LOW_BALANCE_USD = 0.1;

function codeMatches(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

let payer: Payer | undefined;
let planner: Planner | undefined;
let setupError: string | undefined;
// Wallet setup (AgentKit load, CDP account) can take a while; serve pages meanwhile.
const ready = (async () => {
  try {
    planner = createPlanner();
    payer = await createPayer();
    console.log(`[app] ${payer.mode} payer ready: ${payer.address}`);
  } catch (e) {
    setupError = (e as Error).message;
    console.error(`[app] setup error: ${setupError}`);
  }
})();

const app = express();
app.disable("x-powered-by");

// Pages. On Vercel, public/ is served by the CDN before requests reach here.
app.get("/app", (_req, res) => res.sendFile(path.join(pub, "app.html")));
app.use(express.static(pub, { extensions: ["html"] }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ready: !!payer && !!planner, setupError: setupError ?? null, store: storeKind });
});

app.get("/api/info", async (_req, res) => {
  await ready;
  const balance = payer ? await payer.usdcBalance() : null;
  const cap = config.buyer.dailySpendCapUsd;
  res.json({
    setupError,
    planner: planner?.name,
    payments: payer?.mode,
    wallet: payer?.address,
    network: config.network,
    mainnet: config.isMainnet,
    usdcBalance: balance,
    lowBalance: balance !== null && Number(balance) < LOW_BALANCE_USD,
    defaultBudget: config.buyer.defaultBudgetUsd,
    sellerUrl: config.buyer.sellerUrl,
    accessRequired: !!config.buyer.accessCode,
    daily: cap ? { cap: `$${cap}`, spent: atomicToUsd(await spentToday()) } : null,
    policy: {
      maxBudget: config.buyer.maxBudgetUsd,
      perCallCap: config.buyer.perCallCapUsd,
      maxPurchases: config.buyer.maxPurchases,
      maxSteps: config.buyer.maxSteps,
    },
  });
});

app.get("/api/catalog", async (_req, res) => {
  try {
    const r = await fetch(`${config.buyer.sellerUrl}/catalog`, { signal: AbortSignal.timeout(8000) });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: `seller unreachable: ${(e as Error).message}` });
  }
});

app.get("/api/stats", async (_req, res) => void res.json(await stats()));
app.get("/api/runs", async (req, res) => void res.json(await listRuns(Math.min(100, Number(req.query.limit) || 20))));
app.get("/api/runs/:id", async (req, res) => {
  const r = await getRun(req.params.id);
  if (!r) return void res.status(404).json({ error: "no such run" });
  if (req.query.download !== undefined)
    res.set("Content-Disposition", `attachment; filename="tender-receipt-${r.id.slice(0, 8)}.json"`);
  res.json(r);
});

let busy = false;
app.get("/api/shop", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (e: AgentEvent | { type: "done" }) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  // Closing the page (or the Stop button) cancels the run between steps.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const question = String(req.query.q ?? "").trim().slice(0, 500);
  const budget = String(req.query.budget ?? config.buyer.defaultBudgetUsd);
  let acquired = false;
  try {
    const expected = config.buyer.accessCode;
    if (expected && !codeMatches(String(req.query.code ?? ""), expected))
      throw new Error("This demo needs an access code to spend from its wallet. Enter it above the Shop button.");
    await ready;
    if (!payer || !planner) throw new Error(setupError ?? "not configured");
    if (!question) throw new Error("ask a question");
    if (!/^\d+(\.\d{1,6})?$/.test(budget) || usdToAtomic(budget) <= 0n || usdToAtomic(budget) > usdToAtomic(config.buyer.maxBudgetUsd))
      throw new Error(`budget must be a USD amount above $0 and up to $${config.buyer.maxBudgetUsd}`);
    const cap = config.buyer.dailySpendCapUsd;
    if (cap && payer.mode === "x402") {
      const left = usdToAtomic(cap) - (await spentToday());
      if (usdToAtomic(budget) > left)
        throw new Error(`Today's spending cap ($${cap}) has ${atomicToUsd(left > 0n ? left : 0n)} left. Try a smaller budget or come back tomorrow (UTC).`);
    }
    if (busy) throw new Error("a run is already in progress; one wallet, one shopper at a time");
    busy = true;
    acquired = true;
    const receipt = await runShopper({ question, budgetUsd: budget, planner, payer, emit: send, signal: abort.signal });
    await saveRun(receipt);
  } catch (e) {
    send({ type: "error", message: (e as Error).message });
  } finally {
    if (acquired) busy = false;
    send({ type: "done" });
    res.end();
  }
});

// The x402 seller lives on the same server, after the app's own routes.
app.use(createSellerApp());

// Last-resort error handler: answer with JSON rather than leaving the function in a bad state.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[app] request error:", err);
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

export default app;

if (!config.onVercel) {
  // A demo server that quietly disappears is the worst kind of bug; always say why.
  process.on("uncaughtException", (e) => {
    console.error("[fatal] uncaught exception:", e);
    process.exit(1);
  });
  process.on("exit", (code) => console.log(`[app] stopped (exit code ${code})`));
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      console.log(`[app] received ${sig}, shutting down`);
      process.exit(0);
    });

  app.listen(config.buyer.port, () => {
    console.log(`[app] website  http://localhost:${config.buyer.port}`);
    console.log(`[app] dashboard http://localhost:${config.buyer.port}/app`);
    console.log(`[app] seller   ${config.buyer.sellerUrl}/catalog (paid to ${config.seller.payTo} on ${config.network})`);
  });
}
