import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ebay from "./lib/ebay.js";
import * as amazon from "./lib/amazon.js";
import * as backmarket from "./lib/backmarket.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const SOURCES = { ebay, amazon, backmarket };

// ---- Quote history store (JSON file) ----
// NOTE: On ephemeral hosts (Render free tier, etc.) the filesystem resets on
// redeploy/restart. Point QUOTES_FILE at a persistent disk, or swap for a DB,
// to keep history durable in production.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const QUOTES_FILE = path.join(DATA_DIR, "quotes.json");

function loadQuotes() {
  try {
    return JSON.parse(fs.readFileSync(QUOTES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveQuotes(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(QUOTES_FILE, JSON.stringify(list, null, 2));
}
function nextQuoteNumber(list) {
  const max = list.reduce((m, q) => {
    const n = parseInt(String(q.quoteNumber || "").replace(/\D/g, ""), 10);
    return isFinite(n) && n > m ? n : m;
  }, 0);
  return "Q-" + String(max + 1).padStart(4, "0");
}

// List all saved quotes (newest first).
app.get("/api/quotes", (req, res) => {
  res.json(loadQuotes().slice().reverse());
});

// Save a new quote. Body: { product, avgPrice, quantity }.
app.post("/api/quotes", (req, res) => {
  const { product, avgPrice, quantity } = req.body || {};
  if (!product) return res.status(400).json({ error: "Missing 'product'." });
  const list = loadQuotes();
  const record = {
    quoteNumber: nextQuoteNumber(list),
    product: String(product),
    avgPrice: avgPrice != null ? Number(avgPrice) : null,
    quantity: quantity != null ? quantity : null,
    dateQuoted: new Date().toISOString(),
  };
  list.push(record);
  saveQuotes(list);
  res.json(record);
});

// Which sources are live right now (have keys / are enabled)?
app.get("/api/sources", (req, res) => {
  res.json(
    Object.entries(SOURCES).map(([id, mod]) => ({
      id,
      label: mod.meta.label,
      enabled: mod.meta.isEnabled(),
    }))
  );
});

// GET /api/search?q=iphone%2013&sources=ebay,amazon&limit=10
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing query param 'q'." });

  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);
  const requested = (req.query.sources || "ebay,amazon,backmarket")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => SOURCES[s]);

  // If nothing is actually configured, return demo data so the UI is usable.
  const anyEnabled = requested.some((id) => SOURCES[id].meta.isEnabled());
  if (!anyEnabled) {
    const demo = demoResults(q, limit).filter((r) => requested.includes(r.source));
    return res.json({ query: q, demo: true, results: demo });
  }

  const settled = await Promise.allSettled(
    requested.map((id) => SOURCES[id].search(q, { limit }))
  );

  const results = [];
  const errors = [];
  settled.forEach((s, i) => {
    const id = requested[i];
    if (s.status === "fulfilled") {
      if (s.value.error) errors.push({ source: id, error: s.value.error });
      results.push(...(s.value.items || []));
    } else {
      errors.push({ source: id, error: s.reason.message });
    }
  });

  results.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  res.json({ query: q, demo: false, results, errors });
});

// GET /api/market?q=...  Lightweight lookup for the "Market database" tab.
// Runs exactly ONE eBay search with NO per-item enrichment (enrichCount:0), so a
// tab that checks ~40 models stays cheap on the free instance. Returns eBay's own
// active-listing total (market-supply signal) plus a sampled average price.
// A model with no matching listings comes back total:0 -> the UI shows it as 0.
app.get("/api/market", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing query param 'q'." });

  if (!ebay.meta.isEnabled()) {
    return res.json({ query: q, demo: true, ...demoMarket(q) });
  }

  try {
    const r = await ebay.search(q, { limit: 50, enrichCount: 0 });
    const priced = (r.items || []).filter((x) => x.price != null);
    const avgPrice = priced.length
      ? Math.round((priced.reduce((a, b) => a + b.price, 0) / priced.length) * 100) / 100
      : null;
    const total = typeof r.total === "number" ? r.total : priced.length;
    res.json({ query: q, demo: false, total, count: priced.length, avgPrice });
  } catch (e) {
    // Never fail the whole tab because one model errored — report it as unknown.
    res.json({ query: q, demo: false, total: null, count: 0, avgPrice: null, error: e.message });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Quoting app running at http://localhost:${PORT}`);
  const live = Object.entries(SOURCES)
    .filter(([, m]) => m.meta.isEnabled())
    .map(([id]) => id);
  console.log(live.length ? `Live sources: ${live.join(", ")}` : "No live sources — serving DEMO data. Add API keys in .env.");
});

// Deterministic placeholder data so the app works before keys are configured.
function demoResults(q, limit) {
  const base = 100 + (hash(q) % 400);
  const rows = [
    { source: "ebay", grade: "Used", mult: 0.82, qty: 12, seller: "techdeals_us" },
    { source: "ebay", grade: "Excellent - Refurbished", mult: 0.9, qty: 8, seller: "renewedtech" },
    { source: "ebay", grade: "Good - Refurbished", mult: 0.85, qty: 5, seller: "mobilehub" },
    { source: "ebay", grade: "Very Good - Refurbished", mult: 0.95, qty: 3, seller: "phonesplus" },
    { source: "ebay", grade: "New", mult: 1.12, qty: 2, seller: "bestgadgets" },
  ];
  return rows.slice(0, limit).map((r, i) => ({
    source: r.source,
    title: `${q} (${r.grade}) — sample #${i + 1}`,
    price: Math.round(base * r.mult * 100) / 100,
    currency: "USD",
    grade: r.grade,
    quantity: r.qty,
    seller: r.seller,
    url: `https://www.ebay.com/itm/sample-${i + 1}`,
    image: null,
  })).sort((a, b) => a.price - b.price);
}

// Deterministic sample market numbers so the Market tab is usable without keys.
function demoMarket(q) {
  const h = hash(q);
  const total = 50 + (h % 3000);
  const avgPrice = Math.round((80 + (h % 900)) * 100) / 100;
  return { total, count: Math.min(50, total), avgPrice };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
