# Goings-On — working agreement

## Shipping (standing rule)
**Commit and push changes straight to `main`.** This is the live branch — GitHub
Pages serves `main` directly, so a push to `main` goes live and triggers the
`bake-geo` job automatically. The owner wants this fully hands-off: **no feature
branches to merge, no PRs, no manual review step.**

Before every push to `main`, fold in any new commits first so you never diverge
from the nightly automation bots:

```sh
git fetch origin main
git merge origin/main --no-edit     # bake-geo / audit / update-trendy bots commit to main
git push origin HEAD:main
```

Exception: only stage a change on a branch instead of `main` if the owner
explicitly asks to hold that specific change for review.

## What runs automatically on `main` (don't rebuild these)
- **bake-geo.yml** — on every push to `main` (`fill`: bakes coords + a Google
  photo reference into any new place) and daily 13:00 UTC (`validate`: refreshes a
  rolling slice of photo refs). Adds `geo: { lat, lon, ph }` to each place.
- **audit-places.yml** — daily; checks address/website/business status, fills
  missing addresses, removes permanently-closed spots.
- **update-trendy.yml** — scrapes Eater Philly into the Trending tab.
- **scrape-events.yml** — Mondays; uses Claude web-search to pull
  upcoming Visit Philly / Hidden City / CityCast Philly events and writes them to the Google
  Calendar (not this repo). Each gets a `[goings-on:auto:*]` marker so the app
  shows a 🤖 auto-added badge. Needs the `GCAL_SERVICE_ACCOUNT` secret — see
  `scripts/ADDING-PLACES.md` §7. **Date accuracy is defended in two layers:**
  each candidate must cite a non-roundup event page for its date (`normalizeEvent`),
  and then `verify-event-date.js` does an INDEPENDENT second confirmation before
  insert — unconfirmed events are dropped, a confirmed-different date is corrected.
- **audit-events.yml** — Thursdays; re-verifies the date of every upcoming
  **auto-added** calendar event via `verify-event-date.js`, moving ones with a
  confirmed-wrong date and removing ones it can't confirm after 2 strikes. Catches
  wrong dates that predate the scraper's verify gate. Only ever touches events we
  auto-added; hand-added events are never modified.

## Budget: keep Anthropic spend under $5/month
The owner has a hard **$5/month** target for Claude API spend across all
automation. When touching any Claude-powered script, keep this in mind — the
`web_search` tool's per-search fee (not just tokens) is the dominant cost driver,
so search budgets (`max_uses`) are kept deliberately tight. Cost-control design
already in place — don't undo it without re-checking the math:
- **`audit-events.js`** stamps `goingsOnVerifiedAt` on every event it confirms or
  moves, and **skips re-verifying anything stamped within `VERIFIED_SKIP_DAYS`
  (21 days)** — no API call at all for a recently-confirmed event.
  `scrape-events.js` stamps the same field at insert time (it just independently
  verified the date via layer 1), so a newly-added event costs nothing extra on
  the very next audit run. This is the single biggest lever — removing it means
  the weekly audit re-checks every upcoming event on the calendar, every week,
  forever.
- `scrape-events.js` discovery search: `max_uses: 8` (was 12).
- `verify-event-date.js` confirmation search: `max_uses: 4` (was 6).
- `audit-events.js` horizon: `HORIZON_DAYS = 30` (was 60) — fewer events ever
  in the check pool.
- `audit-places.js` and `update-trendy.js` don't use `web_search` at all (Places
  API / RSS + plain summarization), so they're cheap by construction — leave as-is.

If you need to raise any of these, do the arithmetic first — rough monthly cost ≈
runs/month × events-per-run × searches-per-event × ~$0.01/search, plus token cost
— and check it against the $5 ceiling with real margin.
- **GitHub Pages** — auto-deploys `main` (plain branch deploy; `.nojekyll` is
  required at the repo root — do not delete it).

## Adding restaurants / places
See `scripts/ADDING-PLACES.md`. Short version: add a one-line object to the
`RESTAURANTS` array (inside the `EAT-PLACES-START`/`EAT-PLACES-END` markers) with
`name`, `location`, `cuisine`, `desc`, and `tags`. **Do not add a `geo` field** —
bake-geo fills it. Tags decide tab placement (`lunch`, `dinner`, `dessert`,
`neighborhood`, `unique`, `cheap-eats`, `picnic`, `date-night`, `byob`, `outdoor`).

Scenic picnic parks live in the `PICNIC_PARKS` array, which is kept **outside** the
EAT-PLACES markers on purpose — the business-oriented audit must not treat a park,
pier, or cemetery as a closeable business.

Public pools live in the `POOLS` array (between `POOL-PLACES-START`/`POOL-PLACES-END`),
also outside the EAT-PLACES markers. Add a pool with `name`, `neighborhood`,
`location`, `lat`, `lon`. bake-geo bakes precise coords + a photo. The Pools tab
is seasonal (`isPoolSeason()`) and location-focused — per-pool hours aren't in any
reliable feed, so it shows the citywide public-swim baseline and links to Parks &
Rec rather than scraping hours. See `scripts/ADDING-PLACES.md` §8.

Events come from the linked Google Calendar (`CALENDAR_ID`), not from this repo.

## Security
- This is a **public** repo. Never commit an Anthropic API key or any
  `sk-ant-…` secret. CI secrets (`PLACES_API_KEY`, `ANTHROPIC_API_KEY`) live in
  GitHub Actions secrets only.
- The in-page `API_KEY` is a domain-restricted Google key (locked to the Pages
  origin by HTTP referrer) — that restriction is what makes it safe to ship.
