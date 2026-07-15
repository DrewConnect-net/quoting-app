// Amazon Product Advertising API (PA-API 5.0) source.
// Docs: https://webservices.amazon.com/paapi5/documentation/
// Requires an APPROVED Amazon Associates account with qualifying sales.
// Uses the official paapi5-nodejs-sdk (handles AWS SigV4 signing).

import pkg from "paapi5-nodejs-sdk";

function isEnabled() {
  return (process.env.AMAZON_ENABLED || "false").toLowerCase() === "true"
    && !!process.env.AMAZON_ACCESS_KEY
    && !!process.env.AMAZON_SECRET_KEY
    && !!process.env.AMAZON_PARTNER_TAG;
}

// Returns { source, enabled, items: [{ source, title, price, currency, condition, url, image }] }
export async function search(query, { limit = 10 } = {}) {
  if (!isEnabled()) return { source: "amazon", enabled: false, items: [] };

  const client = pkg.ApiClient.instance;
  client.accessKey = process.env.AMAZON_ACCESS_KEY;
  client.secretKey = process.env.AMAZON_SECRET_KEY;
  client.host = process.env.AMAZON_HOST || "webservices.amazon.com";
  client.region = process.env.AMAZON_REGION || "us-east-1";

  const api = new pkg.DefaultApi();
  const req = new pkg.SearchItemsRequest();
  req.PartnerTag = process.env.AMAZON_PARTNER_TAG;
  req.PartnerType = "Associates";
  req.Keywords = query;
  req.ItemCount = Math.min(limit, 10); // PA-API max is 10 per page
  req.Resources = [
    "ItemInfo.Title",
    "Offers.Listings.Price",
    "Offers.Listings.Condition",
    "Offers.Listings.Availability.Message",
    "Images.Primary.Medium",
  ];

  const data = await new Promise((resolve, reject) => {
    api.searchItems(req, (error, result) => {
      if (error) return reject(new Error(`Amazon PA-API error: ${error}`));
      resolve(result);
    });
  });

  const results = data && data.SearchResult && data.SearchResult.Items ? data.SearchResult.Items : [];
  const items = results.map((it) => {
    const listing = it.Offers && it.Offers.Listings && it.Offers.Listings[0];
    const price = listing && listing.Price ? listing.Price.Amount : null;
    const currency = listing && listing.Price ? listing.Price.Currency : "USD";
    const availMsg = listing && listing.Availability ? listing.Availability.Message : null;
    return {
      source: "amazon",
      title: it.ItemInfo && it.ItemInfo.Title ? it.ItemInfo.Title.DisplayValue : "(untitled)",
      price: price != null ? Number(price) : null,
      currency,
      grade: listing && listing.Condition ? listing.Condition.Value : null,
      quantity: availMsg,   // Amazon exposes a message (e.g. "In Stock"), rarely a count
      url: it.DetailPageURL || null,
      image: it.Images && it.Images.Primary && it.Images.Primary.Medium ? it.Images.Primary.Medium.URL : null,
    };
  });

  return { source: "amazon", enabled: true, items };
}

export const meta = { id: "amazon", label: "Amazon", isEnabled };
