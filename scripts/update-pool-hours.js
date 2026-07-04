#!/usr/bin/env node
'use strict';

/**
 * Keeps the seasonal Pools tab's open-hours current from the official
 * Philadelphia Parks & Recreation pool schedule (phila.gov).
 *
 * Why web-search and not a data feed: the City publishes a structured
 * *location* dataset for pools (ArcGIS/Carto `ppr_swimming_pools`), but there
 * is NO machine-readable feed of pool HOURS anywhere — hours are seasonal,
 * vary by site, and live only on a weekly phila.gov HTML announcement, which
 * returns HTTP 403 to datacenter IPs (GitHub Actions runners included). So a
 * plain fetch can't read it. Instead — like the performing-arts and events
 * jobs — we let Claude run its server-side `web_search` tool, which executes
 * on Anthropic's infrastructure (search-engine index, not a direct fetch of
 * the blocked page) and gets through. Claude reads the current schedule and
 * returns each pool's status/hours; we splice them into the POOL-PLACES block.
 *
 * What "hours" realistically means here: the City's schedule gives each pool's
 * SEASON-OPENING DATE (rolling mid-June → early July) plus a city-wide baseline
 * of public swim ~1–4pm daily, with extended hours that "vary by site." So the
 * best confirmable per-pool value is an opening/status string — e.g.
 * "Opens July 7", "Open — public swim 1–4pm daily (extended hours vary)", or
 * "Closed for the season". We ask for exactly that, and take '' when unsure.
 *
 * SAFETY: this only ever rewrites the `hours:` field of a pool line. It never
 * touches name/location/coords/geo, and it validates that each edited line
 * still parses as a JS object before keeping it — so a bad model response can
 * never corrupt the file (a single dropped comma once took the whole site
 * down; that class of bug is designed out here).
 *
 * Conservative by design: if Claude can't confirm a pool's status it returns an
 * empty string and we leave that pool's existing value untouched.
 *
 * Run manually:  node scripts/update-pool-hours.js
 * Secret needed: ANTHROPIC_API_KEY
 */

const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const INDEX_PATH   = path.join(__dirname, '..', 'index.html');
const START_MARKER = 'POOL-PLACES-START';
const END_MARKER   = 'POOL-PLACES-END';
// The whole schedule lives on one announcement page, so a big batch means the
// model reads that page once and maps many pools from it in a single call.
const BATCH_SIZE   = 25;
const MODEL        = 'claude-sonnet-4-6';   // stronger reader than Haiku for a dense schedule page
// Stable landing pages; the model follows these to the current-year schedule
// announcement (its dated URL changes each season, so we don't hard-code it).
const SCHEDULE_URLS = [
  'https://www.phila.gov/programs/summer/pools/',
  'https://www.phila.gov/services/culture-recreation/find-a-swimming-pool/',
];

// ─── read the marked pool lines ──────────────────────────────────────────────

// Returns [{ lineIndex, raw, name, location, hours }] for each pool object line.
function extractPoolLines(lines) {
  const out = [];
  let inside = false;
  const nameRe  = /name:\s*(['"])(.*?)\1/;
  const locRe   = /location:\s*(['"])(.*?)\1/;
  const hoursRe = /hours:\s*(['"])((?:[^'"\\]|\\.)*)\1/;
  lines.forEach((line, i) => {
    if (line.includes(START_MARKER)) { inside = true;  return; }
    if (line.includes(END_MARKER))   { inside = false; return; }
    if (!inside) return;
    const nm = line.match(nameRe);
    if (!nm) return;                                   // comment or blank line
    out.push({
      lineIndex: i,
      raw: line,
      name:     nm[2],
      location: (line.match(locRe)   || [])[2] || '',
      hours:    (line.match(hoursRe) || [])[2] || '',
    });
  });
  return out;
}

// Replace ONLY the hours field on a pool line, then confirm the line still
// parses. Returns the rewritten line, or null if anything looks off (caller
// then keeps the original). Preserves the trailing comma and every other field.
function spliceHours(raw, hours) {
  const safe = String(hours).replace(/\\/g, '\\\\').replace(/'/g, "\\'").trim();
  let next;
  if (/hours:\s*(['"])(?:[^'"\\]|\\.)*\1/.test(raw)) {
    next = raw.replace(/hours:\s*(['"])(?:[^'"\\]|\\.)*\1/, `hours: '${safe}'`);
  } else {
    // No hours field yet — insert one before the closing brace.
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace < 0) return null;
    const before = raw.slice(0, lastBrace).replace(/\s*$/, '');
    const after  = raw.slice(lastBrace);
    const sep = before.endsWith(',') ? ' ' : ', ';
    next = `${before}${sep}hours: '${safe}' ${after}`;
  }
  const bare = next.trim().replace(/,\s*$/, '');
  try { new Function('return (' + bare + ')')(); } catch { return null; }
  return next;
}

// ─── Claude: current hours for a batch of pools (server-side web search) ──────

async function fetchHoursForBatch(client, pools) {
  const list = pools.map(p => `- ${p.name}${p.location ? ` (${p.location})` : ''}`).join('\n');
  const year = new Date().getUTCFullYear();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
    messages: [{
      role: 'user',
      content: `You maintain a Philadelphia summer guide. Determine the CURRENT (${year} season) open status and hours for these free Philadelphia Parks & Recreation public swimming pools, using ONLY the official City of Philadelphia source.

Authoritative sources (search these — the City blocks direct scraping, but the pages are indexed):
${SCHEDULE_URLS.map(u => `- ${u}`).join('\n')}
- the City's "${year} public pool opening schedule" announcement on phila.gov (find the current one; its URL changes each year).

How Philadelphia actually publishes this (important):
- Each pool has a SEASON-OPENING DATE; pools open on a rolling basis from about mid-June into early July, and close around Labor Day.
- Once open, the city-wide baseline is public swim roughly 1–4pm daily; some pools add extended/evening hours that "vary by site."
- There is no precise per-pool hours table, so do NOT fabricate exact daily hours.

For EACH pool below, return the most accurate SHORT status string you can CONFIRM from the official source, choosing the pattern that fits:
- Not yet open:        "Opens July 7"
- Open, baseline only: "Open — public swim 1–4pm daily (extended hours vary)"
- Open with confirmed extra hours: "Open — public swim 1–4pm daily; also 5–7pm Mon–Fri"
- Closed/not operating this season: "Closed for the season"
If you cannot CONFIRM a pool's status from the official source, return an empty string "" for it. Never guess a date or "closed"; empty is correct when unsure. Today's date is ${new Date().toISOString().slice(0, 10)}.

POOLS:
${list}

Return ONLY minified JSON: an object mapping each pool name EXACTLY as written above to its status string. No markdown, no commentary. Example: {"Cruz Pool":"Open — public swim 1–4pm daily (extended hours vary)","Lee Pool":"Opens July 7","Tustin Pool":""}`,
    }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  // Grab the LAST JSON object in the text (web-search turns can emit earlier braces).
  const matches = text.match(/\{[\s\S]*\}/g);
  if (!matches) return {};
  for (let i = matches.length - 1; i >= 0; i--) {
    try { return JSON.parse(matches[i]); } catch { /* try the previous one */ }
  }
  console.warn('  batch JSON parse failed for all candidates');
  return {};
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const html  = fs.readFileSync(INDEX_PATH, 'utf8');
  const lines = html.split('\n');
  const pools = extractPoolLines(lines);

  if (!pools.length) {
    console.log('No pools found between POOL-PLACES markers — nothing to do.');
    return;
  }
  console.log(`Refreshing hours for ${pools.length} pool(s) in batches of ${BATCH_SIZE}…`);

  const client = new Anthropic();
  let changed = 0;

  for (let i = 0; i < pools.length; i += BATCH_SIZE) {
    const batch = pools.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${i / BATCH_SIZE + 1}: ${batch.map(p => p.name).join(', ')}`);
    let hoursMap = {};
    try { hoursMap = await fetchHoursForBatch(client, batch); }
    catch (e) { console.warn(`  batch error (${e.message}) — keeping existing`); }

    for (const pool of batch) {
      const fresh = (hoursMap[pool.name] || '').trim();
      if (!fresh || fresh === pool.hours) continue;          // unknown or unchanged
      const rewritten = spliceHours(pool.raw, fresh);
      if (!rewritten) { console.warn(`  ${pool.name}: unsafe rewrite skipped`); continue; }
      lines[pool.lineIndex] = rewritten;
      pool.raw = rewritten;
      changed++;
      console.log(`    ${pool.name} → ${fresh}`);
    }
    await new Promise(r => setTimeout(r, 300));              // be gentle on the API
  }

  const today = new Date().toISOString().slice(0, 10);
  // Stamp the "hours updated" date shown in the app (only when we actually
  // changed something, so an all-unconfirmed run doesn't imply a fresh check).
  let outLines = lines;
  if (changed) {
    outLines = lines.map(l =>
      /const POOLS_UPDATED\s*=/.test(l) ? l.replace(/const POOLS_UPDATED\s*=\s*'[^']*';/, `const POOLS_UPDATED = '${today}';`) : l
    );
  }

  // Final gate: never write a file whose app script no longer parses.
  const nextHtml = outLines.join('\n');
  assertScriptParses(nextHtml);
  fs.writeFileSync(INDEX_PATH, nextHtml, 'utf8');

  console.log(`\n══ pool hours ${changed ? 'updated' : 'unchanged'} (${today}) ══`);
  console.log(`  Pools: ${pools.length}  Changed: ${changed}`);
}

// Whole-file safety net (same idea as audit-places.js): confirm every inline
// <script> still parses before writing.
function assertScriptParses(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    try { new Function(m[1]); }
    catch (e) {
      const lineNo = html.slice(0, m.index).split('\n').length;
      throw new Error(`Refusing to write index.html: inline script #${n} (near line ${lineNo}) no longer parses — ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
