// eBay Browse API source.
// Docs: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
// Auth: OAuth 2.0 client-credentials grant (application token).

let cachedToken = null;
let tokenExpiresAt = 0;

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const ITEM_URL = "https://api.ebay.com/buy/browse/v1/item/";
const SCOPE = "https://api.ebay.com/oauth/api_scope";

function isEnabled() {
  return (process.env.EBAY_ENABLED || "true").toLowerCase() !== "false"
    && !!process.env.EBAY_CLIENT_ID
    && !!process.env.EBAY_CLIENT_SECRET;
}

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay OAuth failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 7200) * 1000;
  return cachedToken;
}

const HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
  "Content-Type": "application/json",
});

// Fetch quantity + richer grading for a single item via the getItem endpoint.
// item_summary/search does not include stock counts, so we enrich the top results.
async function enrich(itemId, token) {
  try {
    const res = await fetch(ITEM_URL + encodeURIComponent(itemId), { headers: HEADERS(token) });
    if (!res.ok) return {};
    const d = await res.json();
    // estimatedAvailabilities holds the quantity signal eBay exposes.
    const av = Array.isArray(d.estimatedAvailabilities) ? d.estimatedAvailabilities[0] : null;
    let quantity = null;
    if (av) {
      if (typeof av.estimatedAvailableQuantity === "number") quantity = av.estimatedAvailableQuantity;
      else if (av.availabilityThreshold && av.availabilityThresholdType === "MORE_THAN")
        quantity = `${av.availabilityThreshold}+`;
    }
    return {
      quantity,
      quantitySold: av && typeof av.estimatedSoldQuantity === "number" ? av.estimatedSoldQuantity : null,
      // Keep the seller's verbose text only for the cosmetic-damage filter — NOT for display.
      conditionDescription: d.conditionDescription || null,
    };
  } catch {
    return {};
  }
}

// Title-based exclusions for the main product search. Three buckets:
//  1) Accessories — not the device itself (cases, chargers, antennas, and
//     battery accessories like "Add-On Battery" / "Battery for <model>").
//  2) Non-working condition — for-parts / as-is / broken / doesn't power on.
//  3) Sold WITHOUT its battery — a mobile hotspot missing its battery is
//     incomplete, so drop listings that say "no battery" / "battery not
//     included". Home routers that simply never have a battery don't say this,
//     so they are NOT affected.
// Device phrases that merely mention a battery ("3000mAh battery", "all day
// battery", "with battery") are intentionally NOT treated as accessories.
const ACCESSORY_RE = /\b(case|cover|screen protector|tempered glass|glass protector|protector|charger|charging cable|usb cable|cable|adapter|otterbox|holster|skin|wallet|pouch|lanyard|strap|stylus|mount|holder|kickstand|stand|bumper|sleeve|folio|antennas?|cradle|docking station)\b/i;
const ACCESSORY_BATTERY_RE = /(add[- ]?on|replacement|spare|extra|backup|oem|genuine)\s+batter(y|ies)\b|\bbatter(y|ies)\s+(for|pack)\b|^\s*batter(y|ies)\b/i;
const NON_WORKING_RE = /\b(for parts|parts only|parts\/repair|parts or repair|not working|non[- ]?working|does\s?n[o']?t work|won'?t (turn on|power)|does not (turn on|power)|broken|defective|faulty|as[- ]?is|dead|for repair|bad esn)\b|no power(?!\s*(cord|adapter|supply|cable|brick))/i;
const NO_BATTERY_RE = /\bno batter|batter(y|ies)\s+not\s+incl|without\s+batter|missing\s+batter|no\s+batt\b|w\/o\s+batter/i;

// True if a listing title should be dropped from search results (accessory,
// non-working, or a device sold without its battery).
export function isExcludedListing(title) {
  const t = title || "";
  return ACCESSORY_RE.test(t) || ACCESSORY_BATTERY_RE.test(t) || NON_WORKING_RE.test(t) || NO_BATTERY_RE.test(t);
}

// Returns array of { source, title, price, currency, grade, quantity, quantitySold, url, image }
export async function search(query, { limit = 10, enrichCount = 30 } = {}) {
  if (!isEnabled()) return { source: "ebay", enabled: false, items: [] };

  const token = await getToken();
  // Over-fetch, then keep phones + tablets only. eBay's Browse API allows only ONE
  // category_ids value per request, so instead of a category filter we filter the
  // results in code (drop accessories + anything outside phone/tablet categories).
  const fetchLimit = Math.min(Math.max(Number(limit) || 10, 50), 100);
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${fetchLimit}`;
  const res = await fetch(url, { headers: HEADERS(token) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay search failed (${res.status}): ${text}`);
  }
  const data = await res.json();

  // Phones + tablets only:
  //   9355 = Cell Phones & Smartphones · 171485 = Tablets & eBook Readers
  // Drop obvious accessories by title, and (when eBay returns category info)
  // anything whose leaf category isn't in the allowed set.
  const ALLOWED_LEAF = new Set((process.env.EBAY_CATEGORY_IDS || "9355,171485,44995,175710").split(",").map((s) => s.trim()));
  const summaries = (data.itemSummaries || []).filter((it) => {
    if (isExcludedListing(it.title || "")) return false;
    const cats = (it.leafCategoryIds || []).map(String);
    if (cats.length && !cats.some((c) => ALLOWED_LEAF.has(c))) return false;
    return true;
  });

  const items = summaries.map((it) => ({
    source: "ebay",
    itemId: it.itemId,
    title: it.title,
    price: it.price ? Number(it.price.value) : null,
    currency: it.price ? it.price.currency : "USD",
    grade: it.condition || null,        // "New", "Used", "Excellent - Refurbished", etc.
    conditionId: it.conditionId || null,
    seller: it.seller && it.seller.username ? it.seller.username : null,
    quantity: null,                     // filled in by enrichment below
    quantitySold: null,
    url: it.itemWebUrl || null,
    image: it.image ? it.image.imageUrl : null,
  }));

  // Dynamically pull quantity + grade for the top N results (parallel).
  const toEnrich = items.slice(0, Math.min(enrichCount, items.length));
  await Promise.all(
    toEnrich.map(async (it) => {
      if (!it.itemId) return;
      const extra = await enrich(it.itemId, token);
      if (extra.quantity != null) it.quantity = extra.quantity;
      if (extra.quantitySold != null) it.quantitySold = extra.quantitySold;
      if (extra.conditionDescription) it.conditionDescription = extra.conditionDescription;
    })
  );

  // Anything whose eBay condition OR seller description references cosmetic damage.
  const COSMETIC_RE = /cosmetic damage|\bscratch|scuff|scrape|\bdents?\b|\bcrack(ed|s)?\b|chipped|\bchips?\b|blemish/i;

  const available = items
    // Drop listings that came back sold out (enriched quantity of exactly 0).
    // Items we didn't enrich keep quantity=null and stay in (availability unknown).
    .filter((it) => it.quantity !== 0)
    // Drop cosmetically damaged listings.
    .filter((it) => !COSMETIC_RE.test((it.grade || "") + " " + (it.conditionDescription || "")))
    // Collapse any "Excellent ..." condition to just "Excellent"; drop the verbose text.
    .map((it) => {
      if (/excellent/i.test(it.grade || "")) it.grade = "Excellent";
      delete it.conditionDescription;
      return it;
    });

  // data.total = number of active listings matching the query (market supply signal).
  const total = typeof data.total === "number" ? data.total : available.length;
  return { source: "ebay", enabled: true, items: available, total };
}

export const meta = { id: "ebay", label: "eBay", isEnabled };
