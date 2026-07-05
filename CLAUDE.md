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
  `scripts/ADDING-PLACES.md` §7.
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
