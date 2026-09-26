/**
 * Seller: a small market-data API where each tier sits behind an x402 paywall.
 *
 *   GET /catalog                    free: products, prices, what each contains
 *   GET /data/quote?symbol=ETH      $0.001
 *   GET /data/metrics?symbol=ETH    $0.01
 *   GET /data/report?symbol=ETH     $0.05
 *
 * No accounts or API keys. A request without payment gets HTTP 402 with the
 * payment requirements; a request with a valid signed USDC authorization gets
 * the data, and the facilitator settles the payment on-chain.
 */
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorConfig } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { isAddress } from "viem";
import { PRODUCTS, SYMBOLS, type SymbolId } from "./catalog.js";
import * as data from "./data.js";
import { config } from "../config.js";

const PUBLIC_TESTNET_FACILITATOR = "https://x402.org/facilitator";

/** Which facilitator verifies and settles payments, and a label for logs. */
export function facilitatorFor(): { config: FacilitatorConfig; label: string } {
  const s = config.seller;
  if (s.facilitatorUrl) return { config: { url: s.facilitatorUrl }, label: s.facilitatorUrl };
  if (config.isMainnet) {
    if (!s.cdpApiKeyId || !s.cdpApiKeySecret)
      throw new Error(
        "Base mainnet settles through Coinbase's CDP facilitator: set CDP_API_KEY_ID and CDP_API_KEY_SECRET " +
          "(or SELLER_CDP_API_KEY_ID/SECRET, or FACILITATOR_URL for another mainnet facilitator).",
      );
    return { config: createFacilitatorConfig(s.cdpApiKeyId, s.cdpApiKeySecret), label: "CDP facilitator (mainnet)" };
  }
  return { config: { url: PUBLIC_TESTNET_FACILITATOR }, label: PUBLIC_TESTNET_FACILITATOR };
}

export function createSellerApp() {
  const { network } = config.seller;
  const payTo = config.seller.payTo;
  if (!payTo || !isAddress(payTo) || /^0x0{40}$/i.test(payTo))
    throw new Error("SELLER_PAY_TO must be a real address you control (it receives the USDC).");
  const facilitator = facilitatorFor();
  const app = express();

  // CORS for the free catalog, so anyone can browse it.
  app.get("/catalog", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json({
      seller: "x402 Market Data Desk",
      network,
      payTo,
      currency: "USDC",
      symbols: SYMBOLS,
      products: PRODUCTS.map((p) => ({ ...p, url: `${config.seller.publicUrl}${p.path}?symbol={SYMBOL}` })),
    });
  });

  const routes = Object.fromEntries(
    PRODUCTS.map((p) => [
      `GET ${p.path}`,
      {
        accepts: { scheme: "exact", price: p.price, network, payTo },
        description: `${p.title}: ${p.contains.join(", ")}`,
        mimeType: "application/json",
      },
    ]),
  );

  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient(facilitator.config)).register(
    network,
    new ExactEvmScheme(),
  );

  // Validate the symbol *before* the paywall, so nobody pays for a 400.
  app.use("/data", (req, res, next) => {
    const symbol = String(req.query.symbol ?? "").toUpperCase();
    if (!SYMBOLS.includes(symbol as SymbolId)) {
      res.status(400).json({ error: `unknown symbol; try one of ${SYMBOLS.join(", ")}` });
      return;
    }
    next();
  });

  const paywall = paymentMiddleware(routes as never, resourceServer);
  app.use((req, res, next) => {
    // Dev-only bypass for PAYMENTS=mock buyers. Off unless explicitly enabled.
    if (config.seller.allowMock && req.headers["x-mock-payment"]) return next();
    return paywall(req, res, next);
  });

  const sym = (req: express.Request) => String(req.query.symbol).toUpperCase() as SymbolId;
  app.get("/data/quote", async (req, res) => void res.json(await data.quote(sym(req))));
  app.get("/data/metrics", async (req, res) => void res.json(await data.metrics(sym(req))));
  app.get("/data/report", async (req, res) => void res.json(await data.report(sym(req))));

  return app;
}

export function startSeller() {
  const { port, payTo, network } = config.seller;
  const app = createSellerApp();
  return app.listen(port, () => {
    console.log(`[seller] listening on :${port}, paid to ${payTo} on ${network} via ${facilitatorFor().label}`);
    if (config.isMainnet) console.log("[seller] MAINNET: buyers pay real USDC");
  });
}
