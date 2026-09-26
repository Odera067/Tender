/**
 * Demo app: starts the seller (unless START_SELLER=false) and serves
 *   /      the website (what Tender is, live stats)
 *   /app   the dashboard (ask a question, watch it shop, get a receipt)
 * Each run streams agent events to the browser over SSE and is saved to
 * data/runs.jsonl.
 *
 *   npm run demo  →  http://localhost:3000
 */
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.js";
import { startSeller } from "./seller/server.js";
import { createPayer, type Payer } from "./buyer/payer.js";
import { createPlanner, type Planner } from "./buyer/planner.js";
import { runShopper, type AgentEvent } from "./buyer/agent.js";
import { usdToAtomic } from "./buyer/guard.js";
import { getRun, listRuns, saveRun, stats } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
/** Below this the dashboard warns that the wallet needs topping up. */
const LOW_BALANCE_USD = 0.1;

async function main() {
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

  if (process.env.START_SELLER !== "false") startSeller();

  let payer: Payer | undefined;
  let planner: Planner | undefined;
  let setupError: string | undefined;
  // Wallet setup (AgentKit load, CDP account) can take a while; serve the pages meanwhile.
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
  app.get("/app", (_req, res) => res.sendFile(path.join(pub, "app.html")));
  app.use(express.static(pub, { extensions: ["html"] }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ready: !!payer && !!planner, setupError: setupError ?? null });
  });

  app.get("/api/info", async (_req, res) => {
    await ready;
    const balance = payer ? await payer.usdcBalance() : null;
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
      const r = await fetch(`${config.buyer.sellerUrl}/catalog`, { signal: AbortSignal.timeout(5000) });
      res.status(r.status).json(await r.json());
    } catch (e) {
      res.status(502).json({ error: `seller unreachable: ${(e as Error).message}` });
    }
  });

  app.get("/api/stats", (_req, res) => res.json(stats()));
  app.get("/api/runs", (req, res) => res.json(listRuns(Math.min(100, Number(req.query.limit) || 20))));
  app.get("/api/runs/:id", (req, res) => {
    const r = getRun(req.params.id);
    if (!r) return void res.status(404).json({ error: "no such run" });
    if (req.query.download !== undefined)
      res.set("Content-Disposition", `attachment; filename="tender-receipt-${r.id.slice(0, 8)}.json"`);
    res.json(r);
  });

  let busy = false;
  app.get("/api/shop", async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
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
      await ready;
      if (!payer || !planner) throw new Error(setupError ?? "not configured");
      if (!question) throw new Error("ask a question");
      if (!/^\d+(\.\d{1,6})?$/.test(budget) || usdToAtomic(budget) <= 0n || usdToAtomic(budget) > usdToAtomic(config.buyer.maxBudgetUsd))
        throw new Error(`budget must be a USD amount above $0 and up to $${config.buyer.maxBudgetUsd}`);
      if (busy) throw new Error("a run is already in progress; one wallet, one shopper at a time");
      busy = true;
      acquired = true;
      const receipt = await runShopper({ question, budgetUsd: budget, planner, payer, emit: send, signal: abort.signal });
      saveRun(receipt);
    } catch (e) {
      send({ type: "error", message: (e as Error).message });
    } finally {
      if (acquired) busy = false;
      send({ type: "done" });
      res.end();
    }
  });

  app.listen(config.buyer.port, () => console.log(`[app] open http://localhost:${config.buyer.port}`));
}

main();
