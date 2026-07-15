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
      // Prefer the human "conditionDescription" refurb grade if present.
      grade: d.conditionDescription || d.condition || null,
    };
  } catch {
    return {};
  }
}

// Returns array of { source, title, price, currency, grade, quantity, quantitySold, url, image }
export async function search(query, { limit = 10, enrichCount = 10 } = {}) {
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
  const ALLOWED_LEAF = new Set((process.env.EBAY_CATEGORY_IDS || "9355,171485").split(",").map((s) => s.trim()));
  const ACCESSORY_RE = /\b(case|cover|screen protector|tempered glass|glass protector|protector|charger|charging cable|usb cable|cable|adapter|otterbox|holster|skin|wallet|pouch|lanyard|strap|stylus|mount|holder|kickstand|stand|bumper|sleeve|folio)\b/i;
  const summaries = (data.itemSummaries || []).filter((it) => {
    if (ACCESSORY_RE.test(it.title || "")) return false;
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
      if (extra.grade) it.grade = extra.grade;
    })
  );

  // data.total = number of active listings matching the query (market supply signal).
  const total = typeof data.total === "number" ? data.total : items.length;
  return { source: "ebay", enabled: true, items, total };
}

export const meta = { id: "ebay", label: "eBay", isEnabled };
