/**
 * Payer: turns "buy this URL" into an x402 payment, with the BudgetGuard wired
 * into the x402 client's pre-signing hook.
 *
 * Wallet: Coinbase AgentKit. With CDP keys, a CdpEvmWalletProvider (server
 * wallet, keys held by CDP); otherwise a ViemWalletProvider from a local
 * private key. Either way AgentKit's wallet is the signer for the x402 "exact"
 * scheme (an EIP-3009 USDC transferWithAuthorization), which is the same wiring
 * AgentKit's own x402ActionProvider uses internally. We build the client
 * directly so we can attach our own guard hook.
 */
import type { EvmWalletProvider } from "@coinbase/agentkit";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createWalletClient, http, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { AGENTKIT_NETWORK, EXPLORER, USDC, config } from "../config.js";
import { BudgetGuard, type PaymentRequirement } from "./guard.js";

export interface PurchaseResult {
  ok: boolean;
  url: string;
  status: number;
  data?: unknown;
  amount?: bigint;
  /** On-chain settlement tx (x402 mode) */
  txHash?: string;
  explorerUrl?: string;
  payer?: string;
  mock?: boolean;
  /** Guard said no, so nothing was signed. */
  blocked?: string;
  error?: string;
}

export interface Payer {
  mode: "x402" | "mock";
  address: string;
  network: string;
  usdcBalance(): Promise<string | null>;
  buy(url: string, guard: BudgetGuard): Promise<PurchaseResult>;
}

/**
 * AgentKit's wallet providers fire an analytics ping on startup without
 * catching its errors (walletProvider.trackInitialization), so a failed ping
 * becomes an unhandled rejection that kills the process. Swallow exactly that
 * error; anything else still crashes as usual.
 */
let analyticsGuardInstalled = false;
function ignoreAgentKitAnalyticsFailures() {
  if (analyticsGuardInstalled) return;
  analyticsGuardInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const stack = reason instanceof Error ? (reason.stack ?? "") : "";
    if (stack.includes("sendAnalyticsEvent")) {
      console.warn(`[wallet] AgentKit analytics ping failed (${(reason as Error).message}); ignoring`);
      return;
    }
    // Same outcome as Node's default (crash), but always with a visible reason.
    console.error("[fatal] unhandled promise rejection:", reason);
    process.exit(1);
  });
}

async function makeWallet(): Promise<EvmWalletProvider> {
  ignoreAgentKitAnalyticsFailures();
  // AgentKit is a large package, so load it only when real payments are on.
  const { CdpEvmWalletProvider, ViemWalletProvider } = await import("@coinbase/agentkit");
  const w = config.wallet;
  if (w.cdpApiKeyId && w.cdpApiKeySecret && w.cdpWalletSecret) {
    return CdpEvmWalletProvider.configureWithWallet({
      apiKeyId: w.cdpApiKeyId,
      apiKeySecret: w.cdpApiKeySecret,
      walletSecret: w.cdpWalletSecret,
      address: w.cdpAddress as `0x${string}` | undefined,
      networkId: AGENTKIT_NETWORK[config.network],
      rpcUrl: w.rpcUrl,
    });
  }
  if (w.privateKey) {
    const chain = config.network === "eip155:8453" ? base : baseSepolia;
    const client = createWalletClient({
      account: privateKeyToAccount(w.privateKey as `0x${string}`),
      chain,
      transport: http(w.rpcUrl),
    });
    // AgentKit bundles its own viem; the runtime shapes match, only the nominal types differ.
    return new ViemWalletProvider(client as never);
  }
  throw new Error(
    "No buyer wallet configured. Set CDP_API_KEY_ID/CDP_API_KEY_SECRET/CDP_WALLET_SECRET (AgentKit CDP wallet) " +
      "or BUYER_PRIVATE_KEY, or run with PAYMENTS=mock.",
  );
}

/**
 * The guard needs to know which purchase a hook call belongs to. Purchases
 * run one at a time (a simple mutex), so a single "current" slot is enough.
 */
interface InFlight {
  url: string;
  guard: BudgetGuard;
  reservationId?: string;
  blocked?: string;
  requirement?: PaymentRequirement;
}

export async function createX402Payer(): Promise<Payer> {
  const wallet = await makeWallet();
  let current: InFlight | null = null;
  let lock: Promise<unknown> = Promise.resolve();

  const signer = {
    ...wallet.toSigner(),
    readContract: (args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) =>
      wallet.readContract(args as never),
  };

  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  // model proposes, code decides: the last check before a signature exists.
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (!current) return { abort: true, reason: "payment attempted outside a guarded purchase" };
    const requirement: PaymentRequirement = {
      url: current.url,
      network: r.network,
      asset: r.asset,
      payTo: r.payTo,
      amount: BigInt(r.amount),
    };
    current.requirement = requirement;
    const d = current.guard.authorize(requirement);
    if (!d.ok) {
      current.blocked = d.reason;
      return { abort: true, reason: d.reason };
    }
    current.reservationId = d.reservationId;
  });

  const payFetch = wrapFetchWithPayment(fetch, client);

  const buyOnce = async (url: string, guard: BudgetGuard): Promise<PurchaseResult> => {
    current = { url, guard };
    const ctx = current;
    try {
      const res = await payFetch(url, { method: "GET" });
      const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      const settle = header ? decodePaymentResponseHeader(header) : undefined;
      const body = await res.json().catch(() => undefined);

      if (res.ok && settle?.success) {
        if (ctx.reservationId) guard.commit(ctx.reservationId);
        return {
          ok: true,
          url,
          status: res.status,
          data: body,
          amount: ctx.requirement?.amount,
          txHash: settle.transaction,
          explorerUrl: settle.transaction ? `${EXPLORER[settle.network] ?? ""}/tx/${settle.transaction}` : undefined,
          payer: settle.payer,
        };
      }
      // Server refused the payment (verify/settle failed), so nothing moved.
      if (ctx.reservationId && res.status === 402) guard.release(ctx.reservationId);
      return {
        ok: false,
        url,
        status: res.status,
        amount: ctx.requirement?.amount,
        error: settle?.errorReason ?? (body as { error?: string })?.error ?? `HTTP ${res.status}`,
      };
    } catch (e) {
      if (ctx.blocked) return { ok: false, url, status: 0, blocked: ctx.blocked, amount: ctx.requirement?.amount };
      // Unknown outcome (e.g. network error after signing): keep the reservation.
      return { ok: false, url, status: 0, amount: ctx.requirement?.amount, error: (e as Error).message };
    } finally {
      current = null;
    }
  };

  const usdc = USDC[config.network] as `0x${string}`;
  return {
    mode: "x402",
    address: wallet.getAddress(),
    network: config.network,
    async usdcBalance() {
      try {
        const bal = (await wallet.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet.getAddress() as `0x${string}`],
        })) as bigint;
        return formatUnits(bal, 6);
      } catch {
        return null;
      }
    },
    buy(url, guard) {
      const run = lock.then(() => buyOnce(url, guard));
      lock = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Mock payer for UI work and offline tests: it still reads the seller's
 * real 402 challenge and runs the same guard, but instead of signing it
 * sends a dev-only bypass header (the seller honours it only when
 * SELLER_ALLOW_MOCK=true). No money moves, and receipts are labelled MOCK.
 */
export function createMockPayer(): Payer {
  return {
    mode: "mock",
    address: "0xM0CK000000000000000000000000000000000000",
    network: config.network,
    async usdcBalance() {
      return null;
    },
    async buy(url, guard) {
      const challenge = await fetch(url);
      if (challenge.status !== 402) {
        return { ok: challenge.ok, url, status: challenge.status, data: await challenge.json().catch(() => undefined) };
      }
      const header = challenge.headers.get("PAYMENT-REQUIRED");
      if (!header) return { ok: false, url, status: 402, error: "402 without PAYMENT-REQUIRED header" };
      const r = decodePaymentRequiredHeader(header).accepts[0];
      const requirement: PaymentRequirement = {
        url,
        network: r.network,
        asset: r.asset,
        payTo: r.payTo,
        amount: BigInt(r.amount),
      };
      const d = guard.authorize(requirement);
      if (!d.ok) return { ok: false, url, status: 402, blocked: d.reason, amount: requirement.amount };
      const res = await fetch(url, { headers: { "x-mock-payment": "1" } });
      if (!res.ok) {
        guard.release(d.reservationId);
        return { ok: false, url, status: res.status, error: `mock bypass refused (HTTP ${res.status}); set SELLER_ALLOW_MOCK=true` };
      }
      guard.commit(d.reservationId);
      return { ok: true, url, status: res.status, data: await res.json(), amount: requirement.amount, mock: true };
    },
  };
}

export async function createPayer(): Promise<Payer> {
  return config.buyer.payments === "mock" ? createMockPayer() : createX402Payer();
}
