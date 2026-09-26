/**
 * Planners: the "model proposes" half. A planner sees the question, the
 * seller's catalog, the budget and the evidence bought so far, and proposes one
 * next step: buy one product, or answer. It has no wallet and can't spend
 * anything itself; the agent loop and BudgetGuard decide whether a proposal
 * runs.
 */
import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";

export interface CatalogProduct {
  id: string;
  path: string;
  price: string;
  title: string;
  contains: string[];
  goodFor: string;
}

export interface Evidence {
  product: string;
  symbol: string;
  pricePaid: string;
  data: unknown;
}

export interface PlannerInput {
  question: string;
  symbols: string[];
  catalog: CatalogProduct[];
  budget: { total: string; spent: string; remaining: string; perCallCap: string };
  evidence: Evidence[];
  /** Things that happened that the planner should know about (guard blocks, failures). */
  notes: string[];
  /** Set when the loop is out of steps or budget: planner must answer now. */
  mustAnswer: boolean;
}

export const ProposalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("buy"),
    product: z.string(),
    symbol: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    action: z.literal("answer"),
    answer: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
    notBought: z
      .array(z.object({ product: z.string(), why: z.string() }))
      .optional()
      .default([]),
  }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

export interface PlannerOutput {
  proposal: Proposal;
  usage?: { prompt: number; completion: number };
  model: string;
}

export interface Planner {
  name: string;
  propose(input: PlannerInput): Promise<PlannerOutput>;
}

// ---------------------------------------------------------------- SERV ----

const SYSTEM = `You are a frugal research-buying agent. You answer a user's question by purchasing data from a paid API, one item at a time, paying per request in USDC over x402.

Shopping rules:
- Buy the CHEAPEST product that could plausibly answer the question first.
- Only buy a more expensive product if the evidence you already have is genuinely insufficient to answer with confidence. Say exactly what's missing.
- Never buy the same product for the same symbol twice. Never buy things unrelated to the question.
- Stop as soon as you can answer confidently. Unspent budget is a success, not a waste.
- "confidence" is your confidence (0-1) that you could answer correctly right now with the evidence you already have.
- Budget limits are enforced by code outside your control; if a purchase is blocked, adapt and don't retry it.
- Base answers only on purchased evidence. Cite concrete numbers. Mention data provenance if it's demo data. Don't give personalised financial advice; frame it as what the data shows.

Reply with the decision object. Fill every field; use "" or [] for fields that don't apply:
- To buy: action "buy", product = a catalog id, symbol, reason = why this is worth its price now. answer "", notBought [].
- To answer: action "answer", answer = your answer to the user (2-6 sentences), reason = why the evidence is sufficient, notBought = catalog items you didn't buy and why. product "", symbol "".`;

/** Enforced by the API (strict structured output), so every reply has every field. */
const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "product", "symbol", "answer", "reason", "confidence", "notBought"],
  properties: {
    action: { type: "string", enum: ["buy", "answer"] },
    product: { type: "string" },
    symbol: { type: "string" },
    answer: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number" },
    notBought: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["product", "why"],
        properties: { product: { type: "string" }, why: { type: "string" } },
      },
    },
  },
} as const;

/** Map the flat decision onto the Proposal union (and validate it). */
function toProposal(d: Record<string, unknown>): Proposal {
  const confidence = Math.min(1, Math.max(0, Number(d.confidence) || 0));
  if (d.action === "buy")
    return ProposalSchema.parse({ action: "buy", product: d.product, symbol: d.symbol, reason: d.reason, confidence });
  return ProposalSchema.parse({ action: "answer", answer: d.answer, reason: d.reason, confidence, notBought: d.notBought ?? [] });
}

function renderInput(i: PlannerInput): string {
  return JSON.stringify(
    {
      question: i.question,
      availableSymbols: i.symbols,
      catalog: i.catalog.map(({ id, price, title, contains, goodFor }) => ({ id, price, title, contains, goodFor })),
      budgetUsd: i.budget,
      evidenceSoFar: i.evidence,
      notes: i.notes,
      instruction: i.mustAnswer
        ? "You must answer NOW with action \"answer\" using only the evidence you have. Be explicit about any uncertainty."
        : "Decide the single next step.",
    },
    null,
    1,
  );
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in model output");
  return JSON.parse(text.slice(start, end + 1));
}

export function createServPlanner(): Planner {
  if (!config.serv.apiKey) throw new Error("SERV_API_KEY is not set (or use PLANNER=scripted for offline runs).");
  const client = new OpenAI({ baseURL: config.serv.baseUrl, apiKey: config.serv.apiKey });
  const model = config.serv.model;

  return {
    name: `SERV Reasoning (${model})`,
    async propose(input) {
      // SERV requires a system message and max_completion_tokens (not max_tokens), and no temperature.
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: renderInput(input) },
      ];
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await client.chat.completions.create({
          model,
          messages,
          max_completion_tokens: 1200,
          response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: DECISION_SCHEMA } },
        });
        const text = res.choices[0]?.message?.content ?? "";
        try {
          const parsed = toProposal(extractJson(text) as Record<string, unknown>);
          if (parsed.action === "answer" && !parsed.answer.trim()) throw new Error("empty answer");
          if (input.mustAnswer && parsed.action !== "answer") throw new Error("must answer now");
          return {
            proposal: parsed,
            model: res.model ?? model,
            usage: res.usage ? { prompt: res.usage.prompt_tokens, completion: res.usage.completion_tokens } : undefined,
          };
        } catch (e) {
          lastErr = e;
          messages.push(
            { role: "assistant", content: text },
            { role: "user", content: `That was invalid (${(e as Error).message}). Reply with exactly one JSON object in the required shape.` },
          );
        }
      }
      const raw = (messages.at(-2)?.content as string | undefined)?.slice(0, 400);
      throw new Error(`SERV returned no valid proposal: ${(lastErr as Error)?.message}\nlast reply: ${raw}`);
    },
  };
}

// ------------------------------------------------------------ scripted ----

/**
 * Deterministic keyword planner for offline tests and UI work (PLANNER=scripted).
 * Not used in the real demo: SERV Reasoning is.
 */
export function createScriptedPlanner(): Planner {
  return {
    name: "scripted (offline test planner)",
    async propose(i) {
      const q = i.question.toLowerCase();
      const symbol = i.symbols.find((s) => q.includes(s.toLowerCase())) ?? i.symbols[1] ?? i.symbols[0];
      const need = /should|buy|sell|risk|why|catalyst|outlook/.test(q)
        ? "report"
        : /trend|month|volatil|drawdown|momentum|week/.test(q)
          ? "metrics"
          : "quote";
      const ladder = ["quote", "metrics", "report"];
      const have = new Set(i.evidence.map((e) => e.product));
      const notes = i.notes.join(" ");
      const wasBlocked = (p: string) => notes.includes(`buy ${p} for`);
      const next = ladder.slice(0, ladder.indexOf(need) + 1).find((p) => !have.has(p) && !wasBlocked(p));

      if (next && !i.mustAnswer) {
        return {
          model: "scripted",
          proposal: {
            action: "buy",
            product: next,
            symbol,
            reason: next === "quote" ? "Cheapest source first." : `Question needs ${need}-level data; ${[...have].join("+")} isn't enough.`,
            confidence: have.size / (ladder.indexOf(need) + 1),
          },
        };
      }
      return {
        model: "scripted",
        proposal: {
          action: "answer",
          answer: `Based on ${[...have].join(", ") || "no purchased data"} for ${symbol}: ${JSON.stringify(i.evidence.at(-1)?.data ?? {}).slice(0, 240)}…`,
          reason: have.has(need) ? `Had the ${need}-level data the question needed.` : `Wanted ${need}-level data but couldn't buy it; answering with less.`,
          confidence: have.has(need) ? 0.85 : 0.4,
          notBought: ladder
            .filter((p) => !have.has(p))
            .map((p) => ({ product: p, why: wasBlocked(p) ? "blocked by the budget guard" : "not needed for this question" })),
        },
      };
    },
  };
}

export function createPlanner(): Planner {
  return config.serv.planner === "scripted" ? createScriptedPlanner() : createServPlanner();
}
