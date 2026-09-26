/**
 * The seller's product list. Served for free at GET /catalog so buyers can see
 * what's for sale before they pay for anything (and so the buyer never has to
 * import seller code: it learns prices over HTTP like any other client).
 */
export interface Product {
  id: "quote" | "metrics" | "report";
  path: string;
  price: string; // USD, e.g. "$0.001"
  title: string;
  contains: string[];
  goodFor: string;
}

export const SYMBOLS = ["BTC", "ETH", "SOL", "LINK", "AERO"] as const;
export type SymbolId = (typeof SYMBOLS)[number];

export const PRODUCTS: Product[] = [
  {
    id: "quote",
    path: "/data/quote",
    price: "$0.001",
    title: "Basic quote",
    contains: ["spot price (USD)", "24h change %", "24h volume"],
    goodFor: "What is X trading at right now? Is it up or down today?",
  },
  {
    id: "metrics",
    path: "/data/metrics",
    price: "$0.01",
    title: "30-day metrics",
    contains: [
      "7d and 30d return",
      "30d realized volatility",
      "max drawdown (30d)",
      "price vs 30d moving average",
      "volume trend",
    ],
    goodFor: "Trend, momentum, volatility and risk questions over weeks.",
  },
  {
    id: "report",
    path: "/data/report",
    price: "$0.05",
    title: "Deep research report",
    contains: [
      "exchange net flows",
      "perp funding rate & open interest",
      "social sentiment score",
      "key risks and upcoming catalysts",
      "analyst stance with rationale",
    ],
    goodFor: "Should-I-buy/sell, why-is-it-moving, and risk/catalyst questions.",
  },
];
