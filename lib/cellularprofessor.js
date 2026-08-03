// Cellular Professor wholesale catalog source.
//
// Unlike eBay (live secondary-market *resale* prices), this is a wholesale
// supplier feed: the `price` on each item is YOUR BUY COST. One endpoint returns
// the whole in-stock catalog, so we fetch it once, cache it, and match locally
// against the rep's query using the same model-aware matcher as everything else.
//
// SECURITY: the API token MUST come from the CELLPROF_TOKEN environment variable.
// It is never hard-coded -- this repo is public, and a committed token would let
// anyone hit the wholesale feed. Set CELLPROF_TOKEN in the Render dashboard.

import { filterByModel } from "./match.js";

const CATALOG_URL = "https://wholesale.cellularprofessor.com/api/products";
const CACHE_TTL_MS = parseInt(process.env.CELLPROF_CACHE_TTL_MS, 10) || 30 * 60 * 1000;

let cache = { data: null, ts: 0 };

function isEnabled() {
  return (process.env.CELLPROF_ENABLED || "true").toLowerCase() !== "false"
    && !!process.env.CELLPROF_TOKEN;
}

// Fetch (and cache) the full wholesale catalog. On error, serve the last-known
// catalog if we have one, so a transient supplier outage doesn't blank the tab.
async function getCatalog() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) return cache.data;
  try {
    const url = `${CATALOG_URL}?token=${encodeURIComponent(process.env.CELLPROF_TOKEN)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wholesale API failed (${res.status})`);
    const data = await res.json();
    const products = Array.isArray(data) ? data : (data.products || []);
    cache = { data: products, ts: now };
    return products;
  } catch (e) {
    if (cache.data) return cache.data; // stale-but-usable
    throw e;
  }
}

// Returns { source, enabled, items: [{ source, title, price(=wholesale cost),
// currency, grade, quantity, seller, sku, url, image, wholesale:true }] }
export async function search(query, { limit = 10 } = {}) {
  if (!isEnabled()) return { source: "wholesale", enabled: false, items: [] };

  const catalog = await getCatalog();
  // In-stock, titled products only, then keep the ones matching the exact model.
  const inStock = catalog.filter((p) => p && p.title && (p.stock == null || Number(p.stock) > 0));
  const matched = filterByModel(query, inStock).matched;

  const items = matched.slice(0, Math.max(Number(limit) || 10, 60)).map((p) => ({
    source: "wholesale",
    title: p.title,
    price: p.price != null ? Number(p.price) : null,
    currency: "USD",
    grade: p.condition || null,                         // supplier grade, e.g. "8 Cellular"
    quantity: typeof p.stock === "number" ? p.stock : null,
    seller: "Wholesale",
    sku: p.id || null,
    url: null,                                          // catalog API exposes no per-product page
    image: null, // supplier image host omitted to keep the vendor anonymous
    wholesale: true,                                    // flag: this is a COST, not a market price
  }));

  return { source: "wholesale", enabled: true, items };
}

export const meta = { id: "wholesale", label: "Wholesale", isEnabled };
