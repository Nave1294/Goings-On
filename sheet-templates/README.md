# Powering Goings On from a Google Sheet

The **Places to Eat** and **Bookstores** windows can be driven entirely by a
Google Sheet. Add a row in the sheet → it shows up on the site (on next page
load). No code changes needed.

## One-time setup

1. **Create a Google Sheet.** Make two worksheet tabs (the names must match
   exactly):
   - `Places to Eat`
   - `Bookstores`

2. **Import the starter data.** For each tab, use **File → Import →
   Upload** and pick the matching CSV in this folder
   (`Places to Eat.csv`, `Bookstores.csv`). Choose **"Replace current sheet"**
   and **"Detect automatically"** for the separator. This fills the tab with
   everything that's currently hard-coded on the site, including the header row.

3. **Share it.** Click **Share → General access → "Anyone with the link" →
   Viewer**. (The site only ever reads the sheet; it can't change it.)

4. **Connect it to the site.** Copy the Sheet ID from the URL —
   `docs.google.com/spreadsheets/d/`**`THIS_LONG_STRING`**`/edit` — and paste it
   into `index.html`:

   ```js
   const SHEET_ID = 'THIS_LONG_STRING';
   ```

   Commit and push. Done. Until an ID is set, the site uses its built-in lists.

## Adding / editing places

Just edit the rows in the sheet. The columns are:

### `Places to Eat` tab
| Column | Required | Notes |
| --- | --- | --- |
| **Category** | ✅ | Which tab it appears under. Must match one of: `Neighborhood Spots`, `Breakfast`, `Lunch`, `Dinner`, `Outdoor Dining`, `Date Night`, `Unique`, `Cheap Eats`, `BYOB`. |
| **Section** | optional | Group heading within the tab (e.g. `🏙️ Rooftop Bars`). Rows with the same Section are grouped together. Leave blank for no heading. |
| **Name** | ✅ | The place's name. Rows with a blank Name are ignored. |
| **Location** | optional | Street address / neighborhood. Powers the "View on map" button, the photo lookup, and the distance bubble. |
| **Cuisine** | optional | e.g. `Italian`, `Beer Garden`. |
| **Price** | optional | `$`, `$$`, or `$$$`. |
| **Season** | optional | Shows a badge, e.g. `Seasonal · Apr–Oct`, `Thu–Sat only`. |
| **Website** | optional | Full `https://` link. |
| **Reserve** | optional | Full `https://` reservation link. |
| **Description** | optional | The blurb shown when a tile is expanded. |

### `Bookstores` tab
Same idea, with a `Specialty` column instead of Cuisine/Price/Reserve.

| Column | Required | Notes |
| --- | --- | --- |
| **Category** | ✅ | Must match: `By Neighborhood`, `Community & Mission`, or `Specialty Picks`. |
| **Section** | optional | Group heading (e.g. `🐟 Fishtown`). |
| **Name** | ✅ | |
| **Location** | optional | |
| **Specialty** | optional | e.g. `Cookbooks`, `LGBTQ+ & Feminist`. |
| **Season** | optional | |
| **Website** | optional | |
| **Description** | optional | |

## Notes
- Changes appear on the next page refresh (Google caches for a short bit, so
  give it a minute).
- A place can appear in more than one Category — just add it as a row under each.
- Photos and the "X miles away" distance are looked up automatically from the
  Name + Location; you don't add those.
