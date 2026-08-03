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

// Model-variant qualifiers. These words denote a DISTINCT model within a series
// (a base model vs. its Plus/Ultra/Pro/etc. sibling). They are matched in BOTH
// directions in titleMatches: a base-model query must not match a variant
// listing, and a variant query must not match the base. Without this, "Galaxy
// S25" and "Galaxy S25+" collapse together — eBay drops the "+", so both queries
// return the same listings and the only thing separating the two models is the
// presence/absence of this qualifier. NOTE: only include words that appear as a
// standalone token (spaced or "+"-rewritten) and never as part of a glued
// model token like "fold6"/"flip6" — otherwise a spaced "Fold 6" title would be
// wrongly rejected for a "Fold6" query.
const VARIANT_QUALIFIERS = new Set([
  "plus", "ultra", "pro", "max", "mini", "fe", "edge", "lite", "se", "air", "xl",
]);

// Reduce a token to a comparable form: lowercase, alphanumerics only.
function alnum(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Split a string into raw tokens on whitespace and separators.
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    // A "+" glued to a token (e.g. "S25+", "Tab S10+", "S9 FE+") carries model
    // identity, but "+" is otherwise stripped as a separator — which makes an
    // "S25+" listing look identical to a plain "S25". Rewrite the glued form to
    // the word "plus" so the variant survives tokenization. A spaced "+"
    // (bundle like "phone + case") is left alone and dropped as a separator.
    .replace(/([a-z0-9])\+/g, "$1 plus ")
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
    // Keep single-letter, non-generic tokens too: they are decisive model
    // designators like the "X" in "iPhone X" or the "Z" in "Galaxy Z Fold".
    // Dropping them left "iPhone X" with only the word "iphone", which then
    // matched every iPhone model. (Two-letter ids like XS/XR were never dropped.)
    else if (a.length >= 1 && !GENERIC.has(a)) wordTokens.push(a);
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
  const queryWordSet = new Set(parsed.wordTokens);

  // All brand/series words must be present.
  for (const w of parsed.wordTokens) {
    if (!titleSet.has(w)) return false;
  }
  // All model tokens must match some title token.
  for (const m of parsed.modelTokens) {
    if (!titleTokens.some((tt) => modelTokenMatch(m, tt))) return false;
  }
  // Variant qualifiers are decisive in BOTH directions. If a qualifier appears
  // in the title it must also be in the query, and vice versa — so "Galaxy S25"
  // rejects "Galaxy S25+ / S25 Ultra / S25 FE / S25 Edge", and "Galaxy S25 Ultra"
  // rejects the plain "Galaxy S25". This is what keeps each Market-tab row scoped
  // to one exact model.
  for (const v of VARIANT_QUALIFIERS) {
    if (titleSet.has(v) !== queryWordSet.has(v)) return false;
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
