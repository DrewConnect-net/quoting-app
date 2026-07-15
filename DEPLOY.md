# Get a LIVE, team-shareable quoting tool online

Goal: a URL your sales team opens, types a product, and sees **live** eBay
pricing + availability, with the quote calculator built in. ~15 minutes.

Amazon and BackMarket stay off for now (Amazon needs Associate approval;
BackMarket has no public API). eBay alone gives you real live search today.

## Step 1 — Get a free eBay API key (only you can do this)

1. Go to <https://developer.ebay.com/> and sign up (free).
2. Open **My Account → Application Keysets**.
3. Copy your **Production** keyset:
   - **App ID (Client ID)** → `EBAY_CLIENT_ID`
   - **Cert ID (Client Secret)** → `EBAY_CLIENT_SECRET`

No business review or sales history required — unlike Amazon.

## Step 2 — Put the code on GitHub

Create a new GitHub repo and push the contents of this `quoting-app` folder to it.
(If you don't use git, GitHub's "upload files" button works for the whole folder.)

## Step 3 — Deploy (pick one)

**Render (free tier, easiest):**
1. <https://render.com> → New → **Blueprint** → select your repo. The included
   `render.yaml` configures everything.
2. When it asks, paste `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` (Environment tab).
3. Deploy. You get a URL like `https://marketplace-quoting-app.onrender.com`.

**Railway / Fly.io / any Docker host:** the included `Dockerfile` works anywhere.
Set the same two env vars and run it.

## Step 4 — Share

Send your team the URL. They type a product, get live eBay comps, click one to
load its price, and the calculator shows margin + a copy-ready quote.

## Notes

- Keys live only in the host's environment variables — never in the browser or repo.
- Free tiers may "sleep" when idle; first request after idle takes a few seconds.
- To add Amazon later: get approved for the Product Advertising API, then set
  `AMAZON_ENABLED=true` and the three `AMAZON_*` vars. The code is already there.
