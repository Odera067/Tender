/**
 * Run history: every finished run's receipt, appended to data/runs.jsonl.
 * Small and local on purpose. It powers the dashboard's history panel and
 * the landing page's live stats, and doubles as an audit log.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Receipt } from "./buyer/agent.js";
import { usdToAtomic, atomicToUsd } from "./buyer/guard.js";

const dir = process.env.TENDER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const file = path.join(dir, "runs.jsonl");

let runs: Receipt[] | null = null;

function load(): Receipt[] {
  if (runs) return runs;
  runs = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        runs.push(JSON.parse(line));
      } catch {
        // skip a corrupt line rather than lose the whole history
      }
    }
  } catch {
    // no history yet
  }
  return runs;
}

export function saveRun(r: Receipt) {
  load().push(r);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(r) + "\n");
}

export function getRun(id: string): Receipt | undefined {
  return load().find((r) => r.id === id);
}

export interface RunSummary {
  id: string;
  question: string;
  spent: string;
  budget: string;
  items: number;
  blocked: number;
  confidence: number;
  payer: Receipt["payer"];
  network: string;
  cancelled: boolean;
  finishedAt: string;
}

export function listRuns(limit = 20): RunSummary[] {
  return load()
    .slice(-limit)
    .reverse()
    .map((r) => ({
      id: r.id,
      question: r.question,
      spent: r.spent,
      budget: r.budget,
      items: r.bought.length,
      blocked: r.blocked.length,
      confidence: r.confidence,
      payer: r.payer,
      network: r.network,
      cancelled: !!r.cancelled,
      finishedAt: r.finishedAt,
    }));
}

/** Totals over real (non-mock) runs, for the landing page. */
export function stats() {
  const real = load().filter((r) => r.payer === "x402");
  let spent = 0n;
  let budget = 0n;
  let payments = 0;
  let blocked = 0;
  const byProduct: Record<string, number> = {};
  for (const r of real) {
    spent += usdToAtomic(r.spent);
    budget += usdToAtomic(r.budget);
    payments += r.bought.length;
    blocked += r.blocked.length;
    for (const b of r.bought) byProduct[b.product] = (byProduct[b.product] ?? 0) + 1;
  }
  const lastTx = [...real].reverse().flatMap((r) => r.bought).find((b) => b.explorerUrl);
  return {
    runs: real.length,
    payments,
    blocked,
    spent: atomicToUsd(spent),
    unspent: atomicToUsd(budget - spent),
    avgSpent: real.length ? atomicToUsd(spent / BigInt(real.length)) : "$0.000",
    byProduct,
    lastTx: lastTx ? { url: lastTx.explorerUrl, hash: lastTx.txHash, product: lastTx.product, price: lastTx.price } : null,
  };
}
