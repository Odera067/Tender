/**
 * Run history: every finished run's receipt. It powers the dashboard's history
 * panel and the website's live stats, and doubles as an audit log.
 *
 * Two backends, picked automatically:
 *  - Upstash Redis (REST) when KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN
 *    are set. Use this on Vercel, where the filesystem doesn't persist.
 *  - A local file, data/runs.jsonl (TENDER_DATA_DIR to move it). /tmp on Vercel
 *    without Redis, so history there lasts only as long as the instance.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Receipt } from "./buyer/agent.js";
import { usdToAtomic, atomicToUsd } from "./buyer/guard.js";

const KEEP = 1000;
const KEY = "tender:runs";

// ------------------------------------------------------------ backends --
interface Backend {
  add(r: Receipt): Promise<void>;
  /** Newest first. */
  all(): Promise<Receipt[]>;
}

function redisBackend(url: string, token: string): Backend {
  const call = async (cmd: (string | number)[]) => {
    const res = await fetch(url.replace(/\/$/, ""), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json()) as { result?: unknown; error?: string };
    if (!res.ok || j.error) throw new Error(`redis: ${j.error ?? res.status}`);
    return j.result;
  };
  return {
    async add(r) {
      await call(["LPUSH", KEY, JSON.stringify(r)]);
      await call(["LTRIM", KEY, 0, KEEP - 1]);
    },
    async all() {
      const rows = ((await call(["LRANGE", KEY, 0, KEEP - 1])) as string[]) ?? [];
      return rows.flatMap((s) => {
        try {
          return [JSON.parse(s) as Receipt];
        } catch {
          return [];
        }
      });
    },
  };
}

function fileBackend(dir: string): Backend {
  const file = path.join(dir, "runs.jsonl");
  let cache: Receipt[] | null = null;
  const load = () => {
    if (cache) return cache;
    cache = [];
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          cache.push(JSON.parse(line));
        } catch {
          // skip a corrupt line rather than lose the whole history
        }
      }
    } catch {
      // no history yet
    }
    return cache;
  };
  return {
    async add(r) {
      load().push(r);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(r) + "\n");
    },
    async all() {
      return [...load()].reverse().slice(0, KEEP);
    },
  };
}

const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const defaultDir = process.env.VERCEL
  ? "/tmp/tender-data"
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

const backend: Backend =
  redisUrl && redisToken ? redisBackend(redisUrl, redisToken) : fileBackend(process.env.TENDER_DATA_DIR || defaultDir);

export const storeKind = redisUrl && redisToken ? "redis" : "file";

// ------------------------------------------------------------------ api --
export async function saveRun(r: Receipt) {
  try {
    await backend.add(r);
  } catch (e) {
    // Losing a history entry must never fail the run itself.
    console.error(`[store] couldn't save run ${r.id}: ${(e as Error).message}`);
  }
}

async function allRuns(): Promise<Receipt[]> {
  try {
    return await backend.all();
  } catch (e) {
    console.error(`[store] couldn't read history: ${(e as Error).message}`);
    return [];
  }
}

export async function getRun(id: string): Promise<Receipt | undefined> {
  return (await allRuns()).find((r) => r.id === id);
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

export async function listRuns(limit = 20): Promise<RunSummary[]> {
  return (await allRuns()).slice(0, limit).map((r) => ({
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

/** Real (non-mock) spend so far in the current UTC day, for the daily cap. */
export async function spentToday(): Promise<bigint> {
  const day = new Date().toISOString().slice(0, 10);
  return (await allRuns())
    .filter((r) => r.payer === "x402" && r.finishedAt.startsWith(day))
    .reduce((s, r) => s + usdToAtomic(r.spent), 0n);
}

/** Totals over real (non-mock) runs, for the website. */
export async function stats() {
  const real = (await allRuns()).filter((r) => r.payer === "x402");
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
  const lastTx = real.flatMap((r) => r.bought).find((b) => b.explorerUrl);
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
