#!/usr/bin/env node
'use strict';

/**
 * Rolling audit of all restaurant and bookstore entries in index.html.
 *
 * Runs daily but checks only a small slice each day (AUDIT_BATCH places, keyed
 * off the day-of-quarter), so over the first days of each quarter the slices
 * sweep the entire list and then idle. This keeps the daily Places API quota
 * bounded no matter how many places the list grows to — a longer list simply
 * takes more days of the quarter to finish sweeping. Pass --all to audit the
 * whole list in one run (manual backfills).
 *
 * For each place it:
 *   1. Calls Google Places API to check current businessStatus & details
 *   2. Permanently-closed places are removed automatically
 *   3. Places whose address, website, or description differ noticeably
 *      are updated via Claude
 *   4. Places not found at all are flagged in the commit message but kept
 *
 * Standing rule — missing locations:
 *   Any place with a missing or generic location (empty or just
 *   "Philadelphia") gets its real street address + neighborhood looked up.
 *   Google Places supplies the authoritative address and Claude resolves
 *   the neighborhood with a self-reported confidence; the location is only
 *   filled in when that confidence is over 80%. Otherwise it's left as-is.
 *
 * Run manually:  node scripts/audit-places.js
 * Secrets:  PLACES_API_KEY, ANTHROPIC_API_KEY
 */

const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const Anthropic  = require('@anthropic-ai/sdk');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const PLACES_API_KEY = process.env.PLACES_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!PLACES_API_KEY)  { console.error('Missing PLACES_API_KEY'); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ─── Google Places lookup ────────────────────────────────────────────────────

// The Places API (New) requires X-Goog-Api-Key and X-Goog-FieldMask headers.
function placesSearch(query) {
  const body = JSON.stringify({ textQuery: query, languageCode: 'en' });
  const fieldMask = 'places.displayName,places.formattedAddress,places.websiteUri,places.businessStatus';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'places.googleapis.com',
      path: '/v1/places:searchText',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Goog-Api-Key': PLACES_API_KEY,
        'X-Goog-FieldMask': fieldMask,
      },
    }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function lookupPlace(name, location) {
  const query = location ? `${name} ${location}` : `${name} Philadelphia`;
  try {
    const data = await placesSearch(query);
    const place = data.places?.[0];
    if (!place) return null;
    return {
      name:    place.displayName?.text || '',
      address: place.formattedAddress  || '',
      website: place.websiteUri        || '',
      status:  place.businessStatus    || 'OPERATIONAL',
    };
  } catch (e) {
    console.warn(`  Places API error for "${name}": ${e.message}`);
    return null;
  }
}

// ─── Missing-location backfill ───────────────────────────────────────────────

// Locations we treat as "missing" and worth backfilling.
const GENERIC_LOCATIONS = new Set(['', 'philadelphia', 'philly', 'phila', 'pa']);
function needsLocationBackfill(loc) {
  return GENERIC_LOCATIONS.has((loc || '').trim().toLowerCase());
}

// Word-level name match, so we never attach the wrong address to a place.
// Every token of the shorter name must appear as a whole word in the longer
// one (e.g. "Char" must NOT match "Charlie was a sinner").
function nameMatches(a, b) {
  const toks = s => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  const words = new Set(long);
  return short.every(t => words.has(t));
}

// Ask Claude to fill in "<street address>, <Neighborhood>" from the verified
// Google address, and to self-report confidence. Caller applies only if >0.8.
async function getBackfilledLocation(client, original, apiData) {
  const prompt = `You are filling in a missing location for a Philadelphia restaurant in a JavaScript object literal.

CURRENT LINE (one-line JS object literal; the location is missing or generic):
${original.raw.trim()}

GOOGLE PLACES API SAYS (authoritative):
- Name: ${apiData.name}
- Address: ${apiData.address}
- Status: ${apiData.status}

Task: Produce a "location" string formatted as "<street address>, <Neighborhood>", using a real Philadelphia neighborhood (e.g. Rittenhouse, Fishtown, Bella Vista, East Passyunk, Queen Village, Old City, Northern Liberties, Center City, University City, Chinatown, Fairmount, Graduate Hospital, South Philadelphia, West Philadelphia, Germantown). Base it ONLY on the Google address above plus your own knowledge — do not invent anything.

Return ONLY minified JSON, no markdown:
{"line":"<the full updated single-line JS object literal, identical to the current line except the location field>","confidence":<number 0..1 that this is the correct restaurant AND the right neighborhood>}

Rules:
- Change ONLY the location field. Keep every other field, the field order, and the quoting style identical.
- If the Google name does not clearly match this restaurant, or you are unsure of the neighborhood, return a low confidence.`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (msg.content[0]?.text || '').trim()
    .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { line: (obj.line || '').trim(), confidence: Number(obj.confidence) || 0 };
  } catch {
    return { line: '', confidence: 0 };
  }
}

// ─── Parse places from a marked block ───────────────────────────────────────

// Returns array of { lineIndex, raw, parsed } from lines inside a marker block.
function extractPlaceLines(html, startMarker, endMarker) {
  const lines = html.split('\n');
  let inside = false;
  const results = [];
  // Regex: a JS object literal line that starts with `{ name: '...'` or `{ name: "..."`
  const placeRe = /^\s*\{\s*name:\s*(['"])(.*?)\1/;
  lines.forEach((line, i) => {
    if (line.includes(startMarker))  { inside = true;  return; }
    if (line.includes(endMarker))    { inside = false; return; }
    if (!inside) return;
    const m = line.match(placeRe);
    if (!m) return;
    // Extract name and location from raw JS line
    const nameMatch     = line.match(/name:\s*(['"])(.*?)\1/);
    const locationMatch = line.match(/location:\s*(['"])(.*?)\1/);
    const websiteMatch  = line.match(/website:\s*(['"])(.*?)\1/);
    const descMatch     = line.match(/desc:\s*(['"])(.*?)\1/);
    results.push({
      lineIndex: i,
      raw: line,
      name:     nameMatch?.[2]     || '',
      location: locationMatch?.[2] || '',
      website:  websiteMatch?.[2]  || '',
      desc:     descMatch?.[2]     || '',
    });
  });
  return results;
}

// ─── Claude update ───────────────────────────────────────────────────────────

async function getUpdatedLine(client, original, apiData) {
  const prompt = `You are updating a JavaScript object literal inside a single HTML file.

CURRENT LINE (JS object literal, one line):
${original.raw.trim()}

GOOGLE PLACES API SAYS (current real-world data):
- Name: ${apiData.name}
- Address: ${apiData.address}
- Website: ${apiData.website || '(none)'}
- Status: ${apiData.status}

The place is still open. Update the JS object literal if the address or website has changed enough to be worth correcting (e.g. wrong street number, wrong neighborhood, outdated domain). Keep the existing description (desc field) unless it's factually wrong.

Rules:
- Return ONLY the updated single-line JS object literal, no explanation, no markdown.
- Keep exactly the same field order and quoting style as the original.
- If nothing needs changing, return the original line EXACTLY as-is.`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  // Empty/non-text reply → return the original so the caller treats it as "no change".
  return (msg.content[0]?.text || '').trim() || original.raw.trim();
}

// ─── Daily slice scheduling ──────────────────────────────────────────────────

// Days elapsed since the start of the current calendar quarter (UTC, 0-based).
// Used to pick which slice of the place list to audit on a given day.
function dayOfQuarter(d = new Date()) {
  const qStartMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  const qStart = Date.UTC(d.getUTCFullYear(), qStartMonth, 1);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((today - qStart) / 86400000);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic();
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  // Edit by line index into one split (never by substring) so duplicate or
  // substring-overlapping lines can't be corrupted. Removals are deferred to
  // the end so indices stay stable while both sections are processed.
  const lines = html.split('\n');
  const removeIdx = new Set();

  const sections = [
    { start: 'EAT-PLACES-START',  end: 'EAT-PLACES-END',  label: 'Restaurants' },
    { start: 'BOOK-PLACES-START', end: 'BOOK-PLACES-END',  label: 'Bookstores'  },
  ];

  const log = {
    removed:  [],
    updated:  [],
    located:  [],
    unlocated: [],
    notFound: [],
    unchanged: 0,
  };

  // Gather every place across both marked sections, in stable file order.
  const allPlaces = [];
  for (const section of sections) {
    for (const p of extractPlaceLines(html, section.start, section.end)) allPlaces.push(p);
  }

  // Audit only today's slice. Each run checks at most AUDIT_BATCH places no
  // matter how long the list grows, so the daily Places quota stays bounded —
  // and there's no cap on how many places you can add; a longer list just takes
  // more days of the quarter to sweep. `--all` audits everything at once.
  const BATCH = Number(process.env.AUDIT_BATCH) || 25;
  const auditAll = process.argv.includes('--all');
  const dq = dayOfQuarter();
  const sliceStart = auditAll ? 0 : dq * BATCH;
  const slice = auditAll ? allPlaces : allPlaces.slice(sliceStart, sliceStart + BATCH);

  if (!slice.length) {
    const lastDay = Math.max(0, Math.ceil(allPlaces.length / BATCH) - 1);
    console.log(`Day ${dq} of the quarter — idle (all ${allPlaces.length} places are swept by day ${lastDay}).`);
    return;
  }
  console.log(`Day ${dq} of the quarter — auditing ${slice.length} of ${allPlaces.length} [${sliceStart}–${sliceStart + slice.length - 1}]`);

    // Rate-limit: check in serial to avoid hammering the API
    for (const place of slice) {
      process.stdout.write(`  Checking: ${place.name} ... `);
      const apiData = await lookupPlace(place.name, place.location);

      if (!apiData) {
        console.log('not found');
        log.notFound.push(place.name);
        continue;
      }

      if (apiData.status === 'CLOSED_PERMANENTLY') {
        console.log('PERMANENTLY CLOSED — removing');
        log.removed.push(place.name);
        removeIdx.add(place.lineIndex);
        continue;
      }

      // RULE: backfill a missing/generic location, but only when we're
      // over 80% confident (verified name match + Claude's confidence).
      if (needsLocationBackfill(place.location)) {
        if (apiData.address && nameMatches(place.name, apiData.name)) {
          const { line, confidence } = await getBackfilledLocation(client, place, apiData);
          if (confidence > 0.8 && line && line !== place.raw.trim()) {
            const indent = place.raw.match(/^(\s*)/)[1];
            lines[place.lineIndex] = indent + line;
            log.located.push(place.name);
            console.log(`located (confidence ${confidence.toFixed(2)})`);
          } else {
            log.unlocated.push(place.name);
            console.log(`location uncertain (confidence ${confidence.toFixed(2)}) — kept as-is`);
          }
        } else {
          log.unlocated.push(place.name);
          console.log('no confident match — location kept as-is');
        }
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      // Check if address or website have changed noticeably
      const addrDiffers = place.location &&
        apiData.address &&
        !apiData.address.toLowerCase().includes(place.location.split(',')[0].toLowerCase().replace(/[^a-z0-9]/g, ''));
      const webDiffers  = place.website &&
        apiData.website &&
        !apiData.website.toLowerCase().includes(place.website.replace(/^https?:\/\//, '').split('/')[0].toLowerCase());

      if (addrDiffers || webDiffers) {
        console.log('details may have changed — updating');
        const updatedLine = await getUpdatedLine(client, place, apiData);
        if (updatedLine !== place.raw.trim()) {
          // Replace in html — match the leading whitespace too
          const indent = place.raw.match(/^(\s*)/)[1];
          lines[place.lineIndex] = indent + updatedLine;
          log.updated.push(place.name);
        } else {
          log.unchanged++;
          console.log('  → no change needed');
        }
      } else {
        console.log('OK');
        log.unchanged++;
      }

      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 200));
    }

  fs.writeFileSync(INDEX_PATH, lines.filter((_, i) => !removeIdx.has(i)).join('\n'), 'utf8');

  // Print summary
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n══ Audit complete (${today}) ══`);
  console.log(`  Removed (closed):   ${log.removed.length}  — ${log.removed.join(', ') || 'none'}`);
  console.log(`  Updated (changed):  ${log.updated.length}  — ${log.updated.join(', ') || 'none'}`);
  console.log(`  Located (filled):   ${log.located.length}  — ${log.located.join(', ') || 'none'}`);
  console.log(`  Still unlocated:    ${log.unlocated.length} — ${log.unlocated.join(', ') || 'none'}`);
  console.log(`  Not found:          ${log.notFound.length} — ${log.notFound.join(', ') || 'none'}`);
  console.log(`  Unchanged:          ${log.unchanged}`);

  // Write a machine-readable summary for the commit message
  const summary = {
    date: today,
    removed:  log.removed,
    updated:  log.updated,
    located:  log.located,
    unlocated: log.unlocated,
    notFound: log.notFound,
    unchanged: log.unchanged,
  };
  fs.writeFileSync(
    path.join(__dirname, '..', '.audit-summary.json'),
    JSON.stringify(summary, null, 2),
  );
}

main().catch(e => { console.error(e); process.exit(1); });
