/**
 * Data behind the paywall.
 *
 * The spot price comes from CoinGecko's free API when it's reachable. Everything
 * else is a deterministic demo dataset seeded by (symbol, UTC day) and anchored
 * to that spot price, so all three tiers agree with each other and the same
 * question gets the same data all day. Every payload says which parts are live
 * and which are demo data.
 */
import type { SymbolId } from "./catalog.js";

const COINGECKO_IDS: Record<SymbolId, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  LINK: "chainlink",
  AERO: "aerodrome-finance",
};

const FALLBACK_PRICE: Record<SymbolId, number> = {
  BTC: 64000,
  ETH: 3100,
  SOL: 145,
  LINK: 14,
  AERO: 0.9,
};

// mulberry32: tiny seeded PRNG so the demo data is reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(symbol: string, salt = "") {
  const day = new Date().toISOString().slice(0, 10);
  let h = 2166136261;
  for (const c of `${symbol}|${day}|${salt}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

interface Spot {
  price: number;
  change24hPct: number;
  volume24hUsd: number;
  source: "coingecko" | "demo";
}

const spotCache = new Map<SymbolId, { at: number; spot: Spot }>();

async function getSpot(symbol: SymbolId): Promise<Spot> {
  const cached = spotCache.get(symbol);
  if (cached && Date.now() - cached.at < 60_000) return cached.spot;

  let spot: Spot;
  try {
    const id = COINGECKO_IDS[symbol];
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = (await res.json()) as Record<string, { usd: number; usd_24h_change: number; usd_24h_vol: number }>;
    const row = j[id];
    if (!row?.usd) throw new Error("no price");
    spot = {
      price: row.usd,
      change24hPct: round(row.usd_24h_change ?? 0),
      volume24hUsd: Math.round(row.usd_24h_vol ?? 0),
      source: "coingecko",
    };
  } catch {
    const r = rng(seedFor(symbol, "spot"));
    const base = FALLBACK_PRICE[symbol];
    spot = {
      price: round(base * (0.9 + r() * 0.2), base < 10 ? 4 : 2),
      change24hPct: round((r() - 0.5) * 8),
      volume24hUsd: Math.round(base * 1e6 * (5 + r() * 20)),
      source: "demo",
    };
  }
  spotCache.set(symbol, { at: Date.now(), spot });
  return spot;
}

/** 31 daily closes ending at today's spot. */
function history(symbol: SymbolId, spot: number): number[] {
  const r = rng(seedFor(symbol, "hist"));
  const drift = (r() - 0.45) * 0.01; // slight per-symbol bias, varies by day
  const vol = { BTC: 0.025, ETH: 0.032, SOL: 0.045, LINK: 0.04, AERO: 0.06 }[symbol];
  const rets: number[] = [];
  for (let i = 0; i < 30; i++) {
    // Box-Muller normal
    const z = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
    rets.push(drift + vol * z);
  }
  // Walk backwards from spot so the series ends exactly at the live price.
  const closes = [spot];
  for (let i = rets.length - 1; i >= 0; i--) closes.unshift(closes[0] / (1 + rets[i]));
  return closes;
}

export async function quote(symbol: SymbolId) {
  const s = await getSpot(symbol);
  return {
    symbol,
    priceUsd: s.price,
    change24hPct: s.change24hPct,
    volume24hUsd: s.volume24hUsd,
    asOf: new Date().toISOString(),
    provenance: s.source === "coingecko" ? "live (CoinGecko)" : "demo dataset (CoinGecko unreachable)",
  };
}

export async function metrics(symbol: SymbolId) {
  const s = await getSpot(symbol);
  const c = history(symbol, s.price);
  const last = c[c.length - 1];
  const rets = c.slice(1).map((v, i) => v / c[i] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  let peak = c[0];
  let mdd = 0;
  for (const v of c) {
    peak = Math.max(peak, v);
    mdd = Math.min(mdd, v / peak - 1);
  }
  const ma30 = c.reduce((a, b) => a + b, 0) / c.length;
  const r = rng(seedFor(symbol, "vol"));
  const volTrend = round((r() - 0.4) * 60, 1);
  return {
    symbol,
    priceUsd: s.price,
    return7dPct: round((last / c[c.length - 8] - 1) * 100),
    return30dPct: round((last / c[0] - 1) * 100),
    realizedVol30dAnnualizedPct: round(sd * Math.sqrt(365) * 100, 1),
    maxDrawdown30dPct: round(mdd * 100),
    ma30Usd: round(ma30, s.price < 10 ? 4 : 2),
    priceVsMa30Pct: round((last / ma30 - 1) * 100),
    volumeTrend30dPct: volTrend,
    trend: last > ma30 * 1.02 ? "uptrend" : last < ma30 * 0.98 ? "downtrend" : "range-bound",
    dailyCloses: c.map((v) => round(v, s.price < 10 ? 4 : 2)),
    provenance: `spot ${s.source === "coingecko" ? "live (CoinGecko)" : "demo"}; history = demo dataset anchored to spot`,
  };
}

export async function report(symbol: SymbolId) {
  const m = await metrics(symbol);
  const r = rng(seedFor(symbol, "report"));
  const netflow = round((r() - 0.5) * 400, 1); // $M; negative = outflows from exchanges
  const funding = round((r() - 0.45) * 0.06, 4); // % per 8h
  const oiChange = round((r() - 0.4) * 30, 1);
  const sentiment = Math.round(20 + r() * 60);

  let score = 0;
  score += m.trend === "uptrend" ? 1 : m.trend === "downtrend" ? -1 : 0;
  score += netflow < -50 ? 1 : netflow > 50 ? -1 : 0;
  score += funding > 0.03 ? -1 : funding < 0 ? 1 : 0; // crowded longs = contrarian negative
  score += sentiment > 70 ? -1 : sentiment < 35 ? 1 : 0;
  const stance = score >= 2 ? "accumulate" : score <= -2 ? "reduce" : "hold / wait for confirmation";

  const risks = [
    m.realizedVol30dAnnualizedPct > 70 && `high realized volatility (${m.realizedVol30dAnnualizedPct}% annualized)`,
    funding > 0.03 && `crowded long positioning (funding ${funding}%/8h), so liquidation cascades are possible`,
    netflow > 50 && `$${netflow}M net inflow to exchanges (potential sell pressure)`,
    m.maxDrawdown30dPct < -15 && `recent ${m.maxDrawdown30dPct}% drawdown shows fragile support`,
    oiChange > 15 && `open interest up ${oiChange}% in 30d; leverage building`,
    "macro/rates headlines remain the dominant cross-asset driver",
  ].filter(Boolean);

  const catalysts = [
    netflow < -50 && `$${Math.abs(netflow)}M net outflow from exchanges (coins moving to cold storage)`,
    m.trend === "uptrend" && `price ${m.priceVsMa30Pct}% above its 30d average`,
    sentiment < 35 && `sentiment washed out (${sentiment}/100): contrarian setup`,
    funding < 0 && "negative funding: shorts paying longs",
  ].filter(Boolean);

  return {
    symbol,
    metrics: { ...m, dailyCloses: undefined },
    flows: { exchangeNetflow30dUsdM: netflow },
    derivatives: { fundingRatePct8h: funding, openInterestChange30dPct: oiChange },
    sentiment: { score0to100: sentiment },
    risks,
    catalysts,
    analystStance: stance,
    rationale: `Composite score ${score} from trend (${m.trend}), exchange flows, funding and sentiment.`,
    provenance: "flows/derivatives/sentiment = demo dataset; metrics as in /data/metrics",
    disclaimer: "Demo data for a hackathon. Not investment advice.",
  };
}
