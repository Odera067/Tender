import dotenv from "dotenv";

dotenv.config({ quiet: true });

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};

/** USDC contract per network (Circle's official deployments). */
export const USDC: Record<string, string> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
};

export const EXPLORER: Record<string, string> = {
  "eip155:84532": "https://sepolia.basescan.org",
  "eip155:8453": "https://basescan.org",
};

/** AgentKit network ids for each CAIP-2 network. */
export const AGENTKIT_NETWORK: Record<string, string> = {
  "eip155:84532": "base-sepolia",
  "eip155:8453": "base-mainnet",
};

const network = env("X402_NETWORK", "eip155:84532")! as `${string}:${string}`;
if (!USDC[network]) throw new Error(`unsupported X402_NETWORK ${network}; use eip155:84532 (Base Sepolia) or eip155:8453 (Base)`);
/** Real money. Several safety defaults tighten when this is true. */
const isMainnet = network === "eip155:8453";
const sellerPort = Number(env("SELLER_PORT", "4021"));
const appPort = Number(env("APP_PORT", env("PORT", "3000")));
/** True when running as a Vercel Function. */
const onVercel = !!process.env.VERCEL;
/**
 * Where this app is reachable. The dashboard and the seller share one server,
 * so this is also the seller's URL unless SELLER_URL points somewhere else.
 */
const selfUrl = env("SELLER_URL")
  ?? (onVercel ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL}` : `http://localhost:${appPort}`);

export const config = {
  network,
  isMainnet,
  onVercel,
  seller: {
    /** Only used when the seller runs on its own (npm run seller). */
    port: sellerPort,
    publicUrl: selfUrl,
    payTo: env("SELLER_PAY_TO"),
    network,
    /**
     * Unset = pick by network: the public x402.org facilitator on Base Sepolia,
     * Coinbase's CDP facilitator (needs CDP API keys) on Base mainnet.
     */
    facilitatorUrl: env("FACILITATOR_URL"),
    cdpApiKeyId: env("SELLER_CDP_API_KEY_ID", env("CDP_API_KEY_ID")),
    cdpApiKeySecret: env("SELLER_CDP_API_KEY_SECRET", env("CDP_API_KEY_SECRET")),
    // The dev bypass can never be switched on for real money.
    allowMock: !isMainnet && env("SELLER_ALLOW_MOCK") === "true",
  },
  buyer: {
    port: appPort,
    sellerUrl: selfUrl,
    /** When set, starting a run needs this code. Set it on any public deployment. */
    accessCode: env("DEMO_ACCESS_CODE"),
    /** When set, total real spend per UTC day across all runs can't exceed this. */
    dailySpendCapUsd: env("DAILY_SPEND_CAP_USD"),
    /** "x402" = real payments via AgentKit wallet; "mock" = no money moves (UI/dev only). */
    payments: env("PAYMENTS", "x402") as "x402" | "mock",
    defaultBudgetUsd: env("DEFAULT_BUDGET_USD", "0.05")!,
    perCallCapUsd: env("PER_CALL_CAP_USD", "0.05")!,
    /** Ceiling on any single task's budget, whatever the UI or CLI asks for. */
    maxBudgetUsd: env("MAX_BUDGET_USD", isMainnet ? "0.25" : "1")!,
    maxPurchases: Number(env("MAX_PURCHASES", "5")),
    maxSteps: Number(env("MAX_STEPS", "6")),
  },
  serv: {
    apiKey: env("SERV_API_KEY"),
    baseUrl: env("SERV_BASE_URL", "https://inference-api.openserv.ai/v1")!,
    model: env("SERV_MODEL", "gpt-5.4-mini")!,
    /** "serv" (default) or "scripted" (deterministic planner for offline tests/UI dev). */
    planner: env("PLANNER", "serv") as "serv" | "scripted",
  },
  wallet: {
    cdpApiKeyId: env("CDP_API_KEY_ID"),
    cdpApiKeySecret: env("CDP_API_KEY_SECRET"),
    cdpWalletSecret: env("CDP_WALLET_SECRET"),
    cdpAddress: env("CDP_WALLET_ADDRESS"),
    privateKey: env("BUYER_PRIVATE_KEY"),
    rpcUrl: env("RPC_URL"),
  },
};
