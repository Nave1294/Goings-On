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
| `byob`, `outdoor` | surfaced where those vibes are requested |

Notes:
- **Every** spot also appears automatically in **All Restaurants**, grouped by
  cuisine, and is eligible for Discover’s Spin / Indecision / “Not in the mood”.
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

## 6. Events

Events are **not** in this file — the app reads them from the linked Google
Calendar (`CALENDAR_ID` in `index.html`). To add an event, add it to that
calendar; it shows up on the next load, with weather and (for the Picnic Planner)
nearby-park awareness handled automatically.
