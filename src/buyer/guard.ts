/**
 * BudgetGuard: the "code decides" half of "model proposes, code decides".
 *
 * SERV Reasoning can propose any purchase it likes. Nothing is signed unless
 * this guard approves it, and the guard looks only at the *seller's actual
 * payment requirements* (from the 402 challenge), never at what the model
 * claims the price is.
 *
 * All amounts are USDC atomic units (6 decimals) as bigint, so there's no
 * float drift. Spending uses reserve → commit / release, so a payment that's
 * in flight counts against the budget before it settles.
 */

export const USDC_DECIMALS = 6;

export function usdToAtomic(usd: number | string): bigint {
  const [whole, frac = ""] = String(usd).replace(/^\$/, "").split(".");
  const fracPadded = (frac + "000000").slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || "0");
}

export function atomicToUsd(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const whole = a / 10n ** BigInt(USDC_DECIMALS);
  // Trim trailing zeros but keep at least 3 decimals: $0.011, $0.050, $0.0015
  const frac = (a % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0").replace(/^(\d{3}\d*?)0+$/, "$1");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

export interface GuardPolicy {
  /** Hard cap for the whole task. */
  totalBudget: bigint;
  /** Max for any single purchase. */
  perCallCap: bigint;
  /** Max number of paid calls for the task. */
  maxPurchases: number;
  /** Origins the agent may pay (e.g. "http://localhost:4021"). */
  allowedOrigins: string[];
  /** CAIP-2 networks the agent may pay on (e.g. "eip155:84532"). */
  allowedNetworks: string[];
  /** Token contract addresses the agent may pay with (lowercased). Empty = any. */
  allowedAssets: string[];
  /** Recipients the agent may pay (lowercased). Empty = any. */
  allowedPayTo: string[];
}

/** What the seller actually demanded in its 402 challenge. */
export interface PaymentRequirement {
  url: string;
  network: string;
  asset: string;
  payTo: string;
  amount: bigint;
}

export type GuardDecision =
  | { ok: true; reservationId: string }
  | { ok: false; reason: string };

interface Reservation {
  id: string;
  req: PaymentRequirement;
  state: "reserved" | "committed" | "released";
}

export class BudgetGuard {
  private reservations: Reservation[] = [];
  private seq = 0;
  private purchasedUrls = new Set<string>();

  constructor(readonly policy: GuardPolicy) {
    if (policy.perCallCap > policy.totalBudget) {
      // A per-call cap above the total is meaningless; clamp it.
      this.policy = { ...policy, perCallCap: policy.totalBudget };
    }
  }

  /** Committed + in-flight spend. */
  get spent(): bigint {
    return this.reservations
      .filter((r) => r.state !== "released")
      .reduce((sum, r) => sum + r.req.amount, 0n);
  }

  get committed(): bigint {
    return this.reservations
      .filter((r) => r.state === "committed")
      .reduce((sum, r) => sum + r.req.amount, 0n);
  }

  get remaining(): bigint {
    return this.policy.totalBudget - this.spent;
  }

  get purchaseCount(): number {
    return this.reservations.filter((r) => r.state !== "released").length;
  }

  /** Pre-flight check with no side effects, used to tell the model what's affordable. */
  canAfford(amount: bigint): boolean {
    return amount <= this.policy.perCallCap && amount <= this.remaining;
  }

  /**
   * Called right before a payment payload is signed. On approval the
   * amount is reserved immediately.
   */
  authorize(req: PaymentRequirement): GuardDecision {
    const p = this.policy;
    let origin: string;
    try {
      origin = new URL(req.url).origin;
    } catch {
      return { ok: false, reason: `invalid url: ${req.url}` };
    }

    if (!p.allowedOrigins.includes(origin))
      return { ok: false, reason: `origin ${origin} is not on the allowlist` };
    if (!p.allowedNetworks.includes(req.network))
      return { ok: false, reason: `network ${req.network} is not allowed` };
    if (p.allowedAssets.length && !p.allowedAssets.includes(req.asset.toLowerCase()))
      return { ok: false, reason: `asset ${req.asset} is not an allowed payment token` };
    if (p.allowedPayTo.length && !p.allowedPayTo.includes(req.payTo.toLowerCase()))
      return { ok: false, reason: `recipient ${req.payTo} is not an allowed seller` };
    if (req.amount <= 0n) return { ok: false, reason: "non-positive amount" };
    if (req.amount > p.perCallCap)
      return {
        ok: false,
        reason: `price ${atomicToUsd(req.amount)} exceeds per-call cap ${atomicToUsd(p.perCallCap)}`,
      };
    if (req.amount > this.remaining)
      return {
        ok: false,
        reason: `price ${atomicToUsd(req.amount)} exceeds remaining budget ${atomicToUsd(this.remaining)}`,
      };
    if (this.purchaseCount >= p.maxPurchases)
      return { ok: false, reason: `purchase limit (${p.maxPurchases}) reached` };
    if (this.purchasedUrls.has(req.url))
      return { ok: false, reason: `already bought ${req.url}; refusing to pay twice` };

    const id = `r${++this.seq}`;
    this.reservations.push({ id, req, state: "reserved" });
    this.purchasedUrls.add(req.url);
    return { ok: true, reservationId: id };
  }

  /** Settlement confirmed. */
  commit(id: string) {
    const r = this.find(id);
    if (r.state === "reserved") r.state = "committed";
  }

  /**
   * Payment definitely didn't settle (e.g. the signed payload was never sent,
   * or the seller rejected it). If the outcome is unknown, keep the reservation:
   * counting it as spent is the safe side to err on.
   */
  release(id: string) {
    const r = this.find(id);
    if (r.state === "reserved") {
      r.state = "released";
      this.purchasedUrls.delete(r.req.url);
    }
  }

  private find(id: string): Reservation {
    const r = this.reservations.find((x) => x.id === id);
    if (!r) throw new Error(`unknown reservation ${id}`);
    return r;
  }
}
