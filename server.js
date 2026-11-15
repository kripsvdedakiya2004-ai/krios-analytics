import express from "express";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(__dirname));

const WATCHLIST = [
  { symbol: "BTC/USD", type: "crypto" },
  { symbol: "ETH/USD", type: "crypto" },
  { symbol: "EUR/USD", type: "forex" },
  { symbol: "GBP/USD", type: "forex" },
  { symbol: "USD/JPY", type: "forex" },
  { symbol: "XAU/USD", type: "commodity" },
  { symbol: "XAG/USD", type: "commodity" }
];

// Small server-side cache avoids burning API credits on every visitor refresh.
let cache = { updated_at: null, items: [] };
let cacheUntil = 0;
let inFlight = null;
const CACHE_MS = Number(process.env.CACHE_SECONDS || 900) * 1000;

async function fetchQuote(symbol) {
  const url = new URL("https://api.twelvedata.com/quote");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", API_KEY);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok || payload.status === "error" || payload.code) {
    throw new Error(`${symbol}: ${payload.message || response.statusText || "Provider error"}`);
  }
  const price = Number(payload.close ?? payload.price ?? payload.last);
  if (!Number.isFinite(price)) {
    throw new Error(`${symbol}: no quote returned. Check symbol and plan permissions.`);
  }
  const pct = Number(payload.percent_change);
  return {
    symbol,
    price,
    percent_change: Number.isFinite(pct) ? pct : null,
    updated_at: payload.datetime || new Date().toISOString()
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ configured: Boolean(API_KEY), provider: "Twelve Data", cache_seconds: CACHE_MS / 1000 });
});

app.get("/api/markets", async (_req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      error: "Twelve Data API key is not configured",
      setup: "Create a .env file and set TWELVE_DATA_API_KEY"
    });
  }
  if (Date.now() < cacheUntil && cache.items.length) return res.json(cache);
  if (!inFlight) {
    inFlight = Promise.all(WATCHLIST.map(async item => {
      try { return await fetchQuote(item.symbol); }
      catch (error) { return { symbol: item.symbol, error: error.message }; }
    })).then(results => {
      const items = results.filter(x => Number.isFinite(x.price));
      const errors = results.filter(x => x.error);
      cache = { updated_at: new Date().toISOString(), items, errors };
      cacheUntil = Date.now() + CACHE_MS;
      return cache;
    }).finally(() => { inFlight = null; });
  }
  try {
    const result = await inFlight;
    if (!result.items.length) return res.status(502).json({
      error: result.errors?.map(x => x.error).join(" | ") || "No quotes returned",
      items: []
    });
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => {
  console.log(`KRIOS ANALYTICS running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn("Add TWELVE_DATA_API_KEY to .env to enable market quotes.");
});
