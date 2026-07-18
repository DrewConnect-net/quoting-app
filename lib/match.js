// Model-aware relevance matching for search results.
//
// WHY: eBay's Browse API `q=` is a fuzzy "best match" search. Ask it for
// "mifi 4000" and — if that exact model isn't listed — it will quietly relax
// the number and hand back a MiFi 8000, a MiFi X PRO, or a generic hotspot.
// Aggregating those into a price range tells a rep the MiFi 4000 exists when it
// doesn't. This module keeps only listings that actually match the requested
// model, and when none do, surfaces the closest real models instead.
//
// Matching policy (chosen for accuracy):
//   - MODEL tokens (contain a digit, e.g. "4000", "m2000", "m6", "8800l") are
//     decisive. EVERY model token in the query must match a token in the title.
//     "4000" NEVER matches "8000". Equality is on the alphanumeric string, with
//     ONE tolerance: an optional single leading letter — so "2000" == "m2000",
//     "mifi 2000" == "MiFi M2000". Trailing-letter differences are kept distinct
//     ("8800" != "8800L") because they are usually real SKU differences.
//   - WORD tokens (brand/series words like "mifi", "nighthawk", "inseego") must
//     all be present in the title too, which stops a "Netgear 4000" from
//     satisfying a "mifi 4000" query. Generic words (router, hotspot, unlocked,
//     gb, colors, carriers, …) are ignored so they never cause a false miss.

// Words that carry no model identity — ignored when matching.
const GENERIC = new Set([
  "the", "and", "for", "with", "a", "an", "of",
  "new", "used", "open", "box", "sealed", "unlocked", "locked",
  "refurbished", "refurb", "renewed", "excellent", "good", "very", "grade",
  "gsm", "cdma", "lte", "5g", "4g", "3g", "wifi", "wi", "fi", "wireless",
  "mobile", "cellular", "broadband", "internet", "modem", "hotspot", "hotspots",
  "router", "routers", "portable", "device", "devices", "gateway", "signal",
  "gb", "tb", "mb", "ram", "ssd", "gen", "generation",
  "black", "white", "blue", "red", "gray", "grey", "silver", "gold",
  "green", "purple", "pink", "color", "colour", "titanium", "space",
  // carriers: treated as non-decisive so an unlocked listing still matches
  "verizon", "att", "at&t", "tmobile", "sprint", "cricket", "boost",
  "straight", "talk", "prepaid", "carrier",
]);

// Reduce a token to a comparable form: lowercase, alphanumerics only.
function alnum(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Split a string into raw tokens on whitespace and separators.
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

// Digit-bearing tokens that are SPECS, not model identifiers: network
// generations (4G/5G), storage/memory (128GB, 1TB), battery (5000mAh). These
// must never act as the decisive model number, or "mifi 5g" would treat "5g"
// as a model and "iphone 13 128gb" would refuse a 256GB iPhone 13.
function isSpecToken(a) {
  return /^[2-6]g$/.test(a)              // 2G–6G network generation
    || /^\d+(gb|tb|mb|kb)$/.test(a)      // storage / memory
    || /^\d+mah$/.test(a);               // battery capacity
}

// A "model token" is digit-bearing and not a spec token.
function isModelToken(tok) {
  const a = alnum(tok);
  return /\d/.test(a) && !isSpecToken(a);
}

// Parse a query into decisive model tokens and required brand/series words.
export function parseQuery(query) {
  const raw = tokenize(query);
  const modelTokens = [];
  const wordTokens = [];
  for (const t of raw) {
    const a = alnum(t);
    if (!a) continue;
    if (isSpecToken(a)) continue;          // 5g / 128gb / 5000mah — ignore
    if (/\d/.test(a)) modelTokens.push(a); // decisive model identifier
    else if (a.length >= 2 && !GENERIC.has(a)) wordTokens.push(a);
  }
  return {
    modelTokens: [...new Set(modelTokens)],
    wordTokens: [...new Set(wordTokens)],
    isModelQuery: modelTokens.length > 0,
  };
}

// Do two normalized model tokens refer to the same model?
// Equal, or equal after allowing ONE optional leading letter on either side.
export function modelTokenMatch(qTok, tTok) {
  const q = alnum(qTok);
  const t = alnum(tTok);
  if (!q || !t) return false;
  if (q === t) return true;
  // one is the other prefixed with a single letter: "2000" vs "m2000"
  if (/^[a-z]\d/.test(t) && t.slice(1) === q) return true;
  if (/^[a-z]\d/.test(q) && q.slice(1) === t) return true;
  return false;
}

// Does a listing title match every part of the parsed query?
export function titleMatches(parsed, title) {
  const titleTokens = tokenize(title).map(alnum).filter(Boolean);
  const titleSet = new Set(titleTokens);

  // All brand/series words must be present.
  for (const w of parsed.wordTokens) {
    if (!titleSet.has(w)) return false;
  }
  // All model tokens must match some title token.
  for (const m of parsed.modelTokens) {
    if (!titleTokens.some((tt) => modelTokenMatch(m, tt))) return false;
  }
  return true;
}

// Pull the model-like tokens (digit-bearing) out of a title, normalized.
function titleModelTokens(title) {
  return tokenize(title).map(alnum).filter((t) => t && isModelToken(t));
}

// Build a compact list of the closest available models from the "family" of
// listings that share the query's brand/series words but not its exact model.
function summarizeAlternatives(family, parsed) {
  const groups = new Map(); // signature -> { title, count, prices:[], url }
  for (const it of family) {
    const mods = titleModelTokens(it.title);
    // Skip a listing whose model actually equals the queried one (shouldn't be
    // here, but guard anyway) — those aren't "alternatives".
    const isQueried =
      parsed.modelTokens.length > 0 &&
      parsed.modelTokens.every((qm) => mods.some((tm) => modelTokenMatch(qm, tm)));
    if (isQueried) continue;
    const sig = mods.length ? mods.join(" ") : "(no model in title)";
    if (!groups.has(sig)) groups.set(sig, { title: it.title, count: 0, prices: [], url: it.url || null });
    const g = groups.get(sig);
    g.count++;
    if (typeof it.price === "number") g.prices.push(it.price);
    // Prefer keeping a priced, linkable representative title.
    if (!g.url && it.url) g.url = it.url;
  }
  const alts = [...groups.values()]
    .map((g) => ({
      title: g.title,
      count: g.count,
      priceLow: g.prices.length ? Math.min(...g.prices) : null,
      priceHigh: g.prices.length ? Math.max(...g.prices) : null,
      url: g.url,
    }))
    // Named models first, then by how many listings back them.
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return alts;
}

// Main entry point. Given the raw query and the (already category/condition
// filtered) eBay items, return the model-matched subset plus, when a specific
// model was asked for and nothing matched, the closest available alternatives.
export function filterByModel(query, items) {
  const parsed = parseQuery(query);
  const list = Array.isArray(items) ? items : [];

  const matched = list.filter((it) => titleMatches(parsed, it.title));

  let alternatives = [];
  if (parsed.isModelQuery && matched.length === 0) {
    // Family = listings that share the brand/series words (same product line,
    // different model). If the query had no brand word to anchor on, fall back
    // to everything eBay returned for this query.
    const anchor = { modelTokens: [], wordTokens: parsed.wordTokens, isModelQuery: false };
    const family = parsed.wordTokens.length
      ? list.filter((it) => titleMatches(anchor, it.title))
      : list;
    alternatives = summarizeAlternatives(family, parsed);
  }

  return {
    matched,
    isModelQuery: parsed.isModelQuery,
    alternatives,
    parsed,
  };
}
