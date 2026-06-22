# Adding restaurants & places (the fast, low-cost way)

Adding a spot is **one line**. Everything else — coordinates, a Google photo,
distance, tab placement, Discover/Indecision/Planner/Picnic eligibility, nightly
audits, monthly photo refresh — happens automatically. You never look anything up
by hand and you never pay for more than one Places lookup per new spot, ever.

## 1. Where to add

Open `index.html`, find the `const RESTAURANTS = [` array (it lives between the
`EAT-PLACES-START` and `EAT-PLACES-END` markers). Add your object anywhere in the
list. A loose grouping by section comment exists, but order doesn't matter.

## 2. The format — copy this template

```js
{ name: 'Place Name', location: '123 Main St, Neighborhood', cuisine: 'Type', price: '$$', website: 'https://…', desc: 'One or two sentences on why it’s good.', tags: ['lunch', 'dinner'] },
```

- **Required:** `name`, `location` (street + neighborhood), `cuisine`, `desc`.
- **Optional:** `price` (`$`–`$$$$`), `website`, `reservation`, `tags`, `season`, `days`.
- **Do NOT add a `geo` field.** Leave it off. The `bake-geo` GitHub Action fills
  `geo: { lat, lon, ph }` (exact coordinates + a Google photo reference) on the
  next push to `main`. Until it runs, the app fetches the photo + coords live and
  caches them — so it looks right immediately either way.

You can paste **many lines at once**. One push bakes them all in `--fill` mode,
which only looks up the new ones, so a batch of 50 costs 50 one-time lookups and
then nothing.

## 3. Tags = where it shows up

Tags decide which **Places to Eat** tabs and which **Discover** tools feature the
spot. Use as many as apply:

| tag | puts it in |
|-----|-----------|
| `breakfast` / `lunch` / `dinner` / `dessert` | that Eat tab + the matching meal window in the Outing Builder & AI Planner |
| `neighborhood` | Neighborhood Spots tab |
| `unique` | Unique tab |
| `cheap-eats` | Cheap Eats tab |
| `picnic` | force-include in the **Picnic** tab + Picnic Planner (usually unneeded — see below) |
| `no-picnic` | force-EXCLUDE from the Picnic tab (escape hatch for a takeout-looking cuisine that's really sit-down) |
| `date-night` | favored by date-night planning |
| `outdoor` | adds it to the **Outdoor Dining** tab automatically (and outdoor-vibe planner picks) — no second entry needed |
| `byob` | surfaced where that vibe is requested |

Notes:
- **Every** spot also appears automatically in **All Restaurants**, grouped by
  cuisine, and is eligible for Discover’s Spin / Indecision / “Not in the mood”.
- **One entry, everywhere.** Add the spot once to `RESTAURANTS` (inside the
  EAT-PLACES markers) and the right tabs fill from its `tags`/`cuisine`. You never
  re-enter a place in a second list, and `bake-geo` looks it up exactly once.
  `OUTDOOR_DINING_SECTIONS` is reserved for the curated *non-restaurant* venues
  (rooftop bars, beer gardens, waterfront spots) that don't belong in the master
  list — a normal restaurant with a patio just gets the `outdoor` tag.
- **Drinks & Dessert** in the Outing Builder are detected from the `cuisine`/name
  (e.g. a `cuisine: 'Cocktail Bar'` shows up under Drinks) — no special tag needed,
  though adding `dessert` helps.
- **Trending** is driven separately by the Eater scraper (`update-trendy.js`), not
  by a tag.

### Picnic is auto-filtered by cuisine — usually no tag needed

The **Picnic** tab and Picnic Planner pull in any spot whose `cuisine` is
takeout-friendly automatically (bakery, deli, sandwich/hoagie, café, coffee,
pizza, salad/bowl, vegan/fast-casual, ice cream/dessert, cheese & specialty,
prepared foods, falafel/hummus/Mediterranean, taqueria/taco, banh mi, BBQ,
fried chicken, bagel, donut, pretzel, juice/smoothie, poke, empanada, arepa,
dumpling — see `PICNIC_CUISINE_RE` in `index.html`). So a new bakery or hoagie
shop shows up in Picnic with **no tag at all**.

- Add the **`picnic`** tag only to force-include a spot whose cuisine *doesn't*
  match the list (e.g. an Ethiopian fried-chicken spot labeled just "Ethiopian").
- Add the **`no-picnic`** tag to force-exclude a spot whose cuisine matches but
  isn't really grab-and-go (e.g. a Korean BBQ cook-at-your-table place, or an
  upscale wood-fired-pizza sit-down restaurant).

## 4. What you get automatically, per spot

- Coordinates + a Google Places photo (baked once, then free for every visitor)
- “X mi away” distance when the user shares location
- Map link, website link, reserve link
- Tab placement by tag + cuisine auto-grouping
- Candidacy in Outing Builder, AI Planner, Indecision, Spin, and (if tagged)
  the Picnic Planner
- A nightly **audit** (`audit-places.js`) that checks the address/website, fills a
  missing address, and removes permanently-closed spots
- A monthly rolling **photo refresh** that repairs any stale photo reference

## 5. Picnic spots (parks) are different

Scenic parks live in their own `PICNIC_PARKS` array, **outside** the EAT-PLACES
markers (so the business-oriented audit never tries to “close” a pier or garden).
Each park needs `name`, `neighborhood`, `location`, `lat`, `lon`, `desc`, and a
`bring` tip. Photos/distance for parks load live and cache per visitor.

## 6. Performing-arts discount venues

The **Performing Arts** page is a static guide to each venue's discount / rush /
pay-what-you-wish program — not a place list and not scraped per-show (the venue
sites block bots). To add or fix a venue, edit the `PA_VENUES` array between the
`// PA-START` and `// PA-END` markers in `index.html`. Keep it **valid JSON** (the
quarterly Action re-reads it): double-quoted keys, no trailing commas. Each venue:

```json
{ "id": "slug", "group": "stages|theater|classical|free", "name": "Venue",
  "kind": "short descriptor", "location": "address, neighborhood", "website": "https://…",
  "deals": [ { "name": "Program", "price": "$10", "who": "who qualifies", "how": "how to get it", "url": "https://…" } ],
  "note": "optional caveat" }
```

`group` picks the sub-tab (defined in `PA_GROUPS`, just above the markers). The
**`update-arts-discounts.js`** Action runs quarterly: it uses Claude's web-search
tool (which gets past the venue sites' bot-blocking, since the search runs on
Anthropic's side, not the runner) to re-verify each venue's rules and rewrite the
block — keeping the existing value whenever it can't confirm a change. Run it by
hand from the Actions tab anytime.

## 7. Events

Events are **not** in this file — the app reads them from the linked Google
Calendar (`CALENDAR_ID` in `index.html`). To add an event, add it to that
calendar; it shows up on the next load, with weather and (for the Picnic Planner)
nearby-park awareness handled automatically.

### Auto-scraped events (Visit Philly + Hidden City)

`scripts/scrape-events.js` (workflow `.github/workflows/scrape-events.yml`, runs
**Mondays**) finds upcoming events from Visit Philly and Hidden City
and **writes them into the Google Calendar**, so they flow into the app like any
other event. Those sites block direct scraping (HTTP 403 to datacenter IPs), so —
exactly like the discount-rules job — it uses Claude's server-side `web_search`
tool to read them. The run is idempotent and won't create duplicates: before
inserting, it indexes **every** event already on the calendar (hand-added,
previously auto-added, or from any source) and skips any candidate that shares a
day and a near-identical title (fuzzy match on a normalized title — punctuation,
filler words, and reordering don't fool it). It only ever **inserts** events it
marks itself; your hand-added events are never modified or removed.

Each auto-added event carries a marker the app detects — a `[goings-on:auto:<source>]`
token in the description **and** `extendedProperties.private.goingsOnSource` — so the
event card shows a small **🤖 auto-added** badge (the token is stripped from the
displayed text). Source ids live in `SOURCES` (script) and `AUTO_SOURCE_LABELS`
(`index.html`); keep them in sync.

**One-time setup (required before the job can write):** the script needs a Google
service account that the calendar trusts. No domain-wide delegation is needed —
you just share the calendar with the service account.

1. In Google Cloud, create a project, **enable the Google Calendar API**, create a
   **service account**, and download its **JSON key**.
2. Open the Goings-On calendar's settings → **Share with specific people** → add
   the service account's email (`…@…iam.gserviceaccount.com`) with permission
   **"Make changes to events."**
3. In the GitHub repo: **Settings → Secrets and variables → Actions** → add a
   secret named **`GCAL_SERVICE_ACCOUNT`** whose value is the full contents of the
   downloaded JSON key. (`ANTHROPIC_API_KEY` is already configured.)

Then run it by hand from the **Actions** tab ("Scrape Events into Calendar" →
*Run workflow*) to verify, or wait for the next Monday run. Until the
secret is set the job exits cleanly with a reminder and changes nothing.
