# Marketplace Quoting Tool

A web-based sales quoting tool. Search **eBay**, **Amazon**, and **BackMarket** for
comparable prices, pick a reference listing, and generate a customer quote with
marketplace fees, shipping, and target margin baked in.

It runs as a small Node/Express app: a backend holds your API keys and calls the
marketplaces (browsers can't do this directly — CORS blocks it and your secrets
would be exposed), and a single-page frontend does the search + quoting UI.

> Works out of the box in **demo mode** with realistic sample data, so you can try
> the whole flow before wiring up any keys.

## Quick start

```bash
cd quoting-app
npm install
cp .env.example .env      # then fill in keys (optional — demo mode works without them)
npm start
# open http://localhost:3000
```

Node 18+ required (uses the built-in `fetch`).

## Data sources

| Source | Access | Status |
| --- | --- | --- |
| **eBay** | Official [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html). Free developer account. | Fully implemented — add Client ID/Secret. |
| **Amazon** | [Product Advertising API 5.0](https://webservices.amazon.com/paapi5/documentation/). Needs an **approved Amazon Associates account with qualifying sales**. | Implemented — off until you add keys. |
| **BackMarket** | No public buyer/price API. Best-effort read of public search data. | Implemented but **disabled by default**. Fragile and may conflict with their ToS — enable at your own discretion. |

If no source has valid keys, the app serves deterministic sample data and shows a
"sample data" banner so the UI is fully usable.

## Getting keys

**eBay** — Sign up at <https://developer.ebay.com/>, create a keyset, and copy the
**production** Client ID (App ID) and Client Secret (Cert ID) into `.env`
(`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`). No user login needed — the app uses the
client-credentials grant.

**Amazon** — Join [Amazon Associates](https://affiliate-program.amazon.com/), get
approved, and once you've made the required qualifying sales, request PA-API access.
Put `AMAZON_ACCESS_KEY`, `AMAZON_SECRET_KEY`, and `AMAZON_PARTNER_TAG` in `.env` and
set `AMAZON_ENABLED=true`.

**BackMarket** — No official price API. If you have a partner/reseller agreement with
an API, prefer that. Otherwise `BACKMARKET_ENABLED=true` turns on the best-effort
scrape; understand it may break at any time and review their Terms of Service first.

## How the quote math works

- **Target margin → price:** solves `sell = (cost + shipping + other + fixedFee) / (1 − feePct − targetMargin)`.
- **Set price → margin:** `profit = sell − (feePct·sell + fixedFee) − (cost + shipping + other)`, `margin = profit / sell`.
- Fee presets: eBay ~13.25% + $0.40, Amazon ~15%. Editable per category.

Clicking a search result loads its title and price into the quote (as a "set price"
comp) so you can see your margin at that market price instantly.

## API

- `GET /api/sources` → which sources are live vs. sample.
- `GET /api/search?q=...&sources=ebay,amazon&limit=10` → normalized results, sorted by price.
- `GET /healthz` → `{ ok: true }`.

## Deploy

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Set the same `.env`
variables in the host's environment and run `npm start`. Keep your keys server-side
— never ship them to the browser.

## Project layout

```
quoting-app/
  server.js            Express app + source aggregation + demo fallback
  lib/ebay.js          eBay Browse API (OAuth + search)
  lib/amazon.js        Amazon PA-API 5.0 (SDK)
  lib/backmarket.js    BackMarket best-effort (disabled by default)
  public/index.html    Frontend: search + quoting calculator
  .env.example         Config template
```
