// BackMarket source — BEST EFFORT, DISABLED BY DEFAULT.
//
// IMPORTANT: BackMarket does not publish a public buyer/price API. This source
// attempts to read publicly available search data from their site. That approach
// is fragile (it can break whenever their markup/endpoints change) and may
// conflict with BackMarket's Terms of Service. Enable it only if you understand
// and accept those constraints. Prefer an official partnership/API if you have one.

function isEnabled() {
  return (process.env.BACKMARKET_ENABLED || "false").toLowerCase() === "true";
}

// Attempts to extract product+price pairs from the public search page.
// Returns the same normalized shape as the other sources.
export async function search(query, { limit = 10 } = {}) {
  if (!isEnabled()) return { source: "backmarket", enabled: false, items: [] };

  const base = process.env.BACKMARKET_BASE || "https://www.backmarket.com";
  const url = `${base}/en-us/search?q=${encodeURIComponent(query)}`;

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; QuotingTool/1.0; +https://example.com)",
        Accept: "text/html",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    return { source: "backmarket", enabled: true, items: [], error: `fetch failed: ${e.message}` };
  }

  // Best-effort parse: BackMarket embeds product data in a JSON blob (__NEXT_DATA__).
  // We try that first, then fall back to a loose price regex. Either can break.
  const items = [];
  try {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      const json = JSON.parse(m[1]);
      const products = findProducts(json);
      for (const p of products.slice(0, limit)) {
        items.push({
          source: "backmarket",
          title: p.title || p.name || "(untitled)",
          price: typeof p.price === "number" ? p.price : parsePrice(p.price),
          currency: p.currency || "USD",
          condition: p.grade || p.condition || "Refurbished",
          url: p.link ? (p.link.startsWith("http") ? p.link : base + p.link) : null,
          image: p.image || null,
        });
      }
    }
  } catch (e) {
    return { source: "backmarket", enabled: true, items, error: `parse failed: ${e.message}` };
  }

  return { source: "backmarket", enabled: true, items, note: "best-effort; verify manually" };
}

function parsePrice(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : null;
}

// Walk the embedded JSON looking for objects that look like products with a price.
function findProducts(obj, out = [], depth = 0) {
  if (!obj || depth > 8) return out;
  if (Array.isArray(obj)) {
    for (const el of obj) findProducts(el, out, depth + 1);
    return out;
  }
  if (typeof obj === "object") {
    const hasTitle = obj.title || obj.name;
    const hasPrice = obj.price != null || (obj.priceWithCurrency && obj.priceWithCurrency.amount);
    if (hasTitle && hasPrice) {
      out.push({
        title: obj.title || obj.name,
        price: obj.price != null ? obj.price : obj.priceWithCurrency && obj.priceWithCurrency.amount,
        currency: obj.currency || (obj.priceWithCurrency && obj.priceWithCurrency.currency),
        grade: obj.grade || obj.condition,
        link: obj.link || obj.url,
        image: obj.image || obj.thumbnail,
      });
    }
    for (const k of Object.keys(obj)) findProducts(obj[k], out, depth + 1);
  }
  return out;
}

export const meta = { id: "backmarket", label: "BackMarket", isEnabled };
