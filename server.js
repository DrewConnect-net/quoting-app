import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ebay from "./lib/ebay.js";
import * as amazon from "./lib/amazon.js";
import * as backmarket from "./lib/backmarket.js";
import { filterByModel, parseQuery, titleMatches } from "./lib/match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const SOURCES = { ebay, amazon, backmarket };

// ---- Market lookup cache ----
// The "Market database" tab checks ~40 models per tab (117 across all tabs). Each
// is a live eBay call, so without caching a few users browsing every tab can burn
// through eBay's daily Browse-API quota and start getting 429s. We cache each
// model's result for MARKET_CACHE_TTL_MS (default 45 min). On an eBay error (e.g.
// 429) we serve the last-known value even if stale, so the tab stays usable while
// eBay is rate-limited. Cache is in-memory; it resets on redeploy/restart, which
// is fine — it just repopulates lazily.
const MARKET_CACHE_TTL_MS = parseInt(process.env.MARKET_CACHE_TTL_MS, 10) || 45 * 60 * 1000;
const marketCache = new Map(); // key -> { data, ts }

function marketCacheGet(key) {
  return marketCache.get(key) || null;
}
function marketCacheSet(key, data) {
  marketCache.set(key, { data, ts: Date.now() });
  // Light pruning so the map can't grow without bound if queries vary a lot.
  if (marketCache.size > 500) {
    const cutoff = Date.now() - MARKET_CACHE_TTL_MS * 4;
    for (const [k, v] of marketCache) if (v.ts < cutoff) marketCache.delete(k);
  }
}

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

  // Model-aware relevance pass. eBay's fuzzy search returns near-misses when the
  // exact model isn't listed; keep only listings that actually match the model
  // the rep typed. When a specific model was asked for and nothing matches,
  // return an empty result set plus the closest available models so the UI can
  // say "no current eBay listings for that model" instead of inventing a price.
  const rel = filterByModel(q, results);
  res.json({
    query: q,
    demo: false,
    results: rel.matched,
    isModelQuery: rel.isModelQuery,
    matchedCount: rel.matched.length,
    rawCount: results.length,
    alternatives: rel.alternatives,
    errors,
  });
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

  const key = q.toLowerCase();
  const cached = marketCacheGet(key);

  // Fresh cache hit — skip eBay entirely.
  if (cached && Date.now() - cached.ts < MARKET_CACHE_TTL_MS) {
    return res.json({ query: q, demo: false, ...cached.data, cached: true });
  }

  try {
    // Aspects are category-specific, so tell eBay which category to break down.
    // The Market catalog is phones + tablets; infer from the model name.
    const categoryId = /\bipad\b|\btab\b/i.test(q) ? "171485" : "9355";
    const r = await ebay.marketAspectCount(q, { categoryId });

    // TRUE exact-model count: sum eBay's own Model-aspect matchCounts for every
    // model value that matches the exact model queried. eBay's fuzzy search lumps
    // S25 / S25+ / S25 Ultra together, but its per-model aspect distribution keeps
    // them separate — so "Galaxy S25" sums only the base-S25 value(s), "Galaxy
    // S25+" sums only the Plus value(s), and so on. No pagination, no estimate.
    // Identify eBay's own Model aspect value(s) that match the EXACT model queried.
    // (We use these value strings to get filter-sensitive counts below.)
    const parsed = parseQuery(q);
    const matchedValues = r.modelValues.filter((mv) => titleMatches(parsed, mv.value));

    // Live average price from the sampled page, restricted to exact-model listings.
    const priced = filterByModel(q, r.items).matched.filter((x) => x.price != null);
    const avgPrice = priced.length
      ? Math.round((priced.reduce((a, b) => a + b.price, 0) / priced.length) * 100) / 100
      : null;

    const haveDist = r.hasModelAspect && r.modelValues.length > 0;
    let total = 0;
    let matchedModelValues = 0;
    let source = "model-aspect-filtered";
    let fallbackUsed = false;
    let unknown = false; // eBay has no structured per-model count for this model

    if (matchedValues.length) {
      // For each matching eBay Model value, get the SELLABLE count via an
      // aspect_filter result total (the refinement matchCount ignores the
      // sellable filter, so we can't use it). Distinct Model values don't overlap,
      // so summing is correct. One extra eBay call per matched value (usually 1).
      for (const mv of matchedValues) {
        const t = await ebay.aspectFilterTotal(q, { categoryId, modelValue: mv.value });
        // Fall back to the (unfiltered) refinement count only if the call failed.
        total += typeof t === "number" ? t : mv.matchCount;
        matchedModelValues++;
      }
    } else {
      // Model absent from eBay's (truncated) distribution. Try candidate spellings
      // via aspect_filter (already sellable-filtered) to confirm a real count.
      try {
        const fb = await ebay.aspectFilterCount(q, { categoryId });
        // GUARD: if eBay doesn't recognize the Model value, it silently IGNORES the
        // aspect_filter and returns the plain keyword total — not a real per-model
        // count, and (because eBay drops "+") identical for "+/non-+" siblings
        // (e.g. Tab A9 vs Tab A9+, Tab S9 FE vs FE+). eBay simply has no structured
        // Model data for those. Detect it by comparing to the unfiltered fuzzy total
        // (r.ebayTotal): if the "filtered" count is ~the same, the filter did nothing
        // and we can't produce a trustworthy exact count -> leave it unknown ("—").
        const fuzzy = r.ebayTotal;
        const filterIgnored = fuzzy != null && fb.total > 0 && fb.total >= 0.95 * fuzzy;
        if (fb.total > 0 && !filterIgnored) {
          total = fb.total;
          matchedModelValues = 1;
          fallbackUsed = true;
        } else if (filterIgnored) {
          unknown = true;
        }
      } catch { /* keep total = 0 if the fallback also comes up empty */ }
    }

    // "—" (null) when eBay can't give a trustworthy exact count: either no Model
    // distribution at all, or the fallback's filter was ignored (no structured data).
    // With a real distribution present, a genuine 0 means "no sellable listings now".
    const haveCount = !unknown && (haveDist || total > 0);
    const data = haveCount
      ? { total, count: priced.length, avgPrice, matchedModelValues, source, fallbackUsed }
      : {
          total: null,
          count: null,
          avgPrice,
          matchedModelValues: 0,
          source,
          reason: unknown ? "no-structured-model-data" : "no-model-aspect",
        };
    marketCacheSet(key, data);
    res.json({ query: q, demo: false, ...data });
  } catch (e) {
    // eBay errored (e.g. 429 rate limit). If we have any prior value, serve it
    // stale rather than a blank — keeps the tab useful during rate-limit windows.
    if (cached) {
      return res.json({ query: q, demo: false, ...cached.data, cached: true, stale: true });
    }
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
