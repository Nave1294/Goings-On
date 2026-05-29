#!/usr/bin/env node
'use strict';

/**
 * Quarterly audit of all restaurant and bookstore entries in index.html.
 *
 * For each place it:
 *   1. Calls Google Places API to check current businessStatus & details
 *   2. Permanently-closed places are removed automatically
 *   3. Places whose address, website, or description differ noticeably
 *      are updated via Claude
 *   4. Places not found at all are flagged in the commit message but kept
 *
 * Run manually:  node scripts/audit-places.js
 * Secrets:  PLACES_API_KEY, ANTHROPIC_API_KEY
 */

const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const vm        = require('vm');
const Anthropic  = require('@anthropic-ai/sdk');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const PLACES_API_KEY = process.env.PLACES_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!PLACES_API_KEY)  { console.error('Missing PLACES_API_KEY'); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ─── helpers ────────────────────────────────────────────────────────────────

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        try { resolve(JSON.parse(s)); }
        catch { resolve({ error: s }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Google Places lookup ────────────────────────────────────────────────────

async function checkPlace(name, location) {
  const query = location ? `${name}, ${location}, Philadelphia` : `${name}, Philadelphia`;
  try {
    const res = await post(
      `https://places.googleapis.com/v1/places:searchText`,
      { textQuery: query, languageCode: 'en' },
    );
    // Need headers — use fetch-style via a small wrapper
    // (The Places API (New) uses an HTTP header for the API key and field mask)
    // Re-do with proper headers below
    return null;
  } catch { return null; }
}

// The Places API (New) requires X-Goog-Api-Key and X-Goog-FieldMask headers,
// which the basic https.request above doesn't set. Use this wrapper instead.
function placesSearch(query) {
  const body = JSON.stringify({ textQuery: query, languageCode: 'en' });
  const fieldMask = 'places.displayName,places.formattedAddress,places.websiteUri,places.businessStatus,places.regularOpeningHours';
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

  return msg.content[0].text.trim();
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic();
  let html = fs.readFileSync(INDEX_PATH, 'utf8');

  const sections = [
    { start: 'EAT-PLACES-START',  end: 'EAT-PLACES-END',  label: 'Restaurants' },
    { start: 'BOOK-PLACES-START', end: 'BOOK-PLACES-END',  label: 'Bookstores'  },
  ];

  const log = {
    removed:  [],
    updated:  [],
    notFound: [],
    unchanged: 0,
  };

  for (const section of sections) {
    console.log(`\n── Auditing ${section.label} ──`);
    const places = extractPlaceLines(html, section.start, section.end);
    console.log(`   Found ${places.length} place entries`);

    // Rate-limit: check in serial to avoid hammering the API
    for (const place of places) {
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
        // Remove the line from html
        const lines = html.split('\n');
        lines.splice(
          // Re-find the line index since html may have changed
          lines.findIndex(l => l === place.raw),
          1,
        );
        html = lines.join('\n');
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
          html = html.replace(place.raw, indent + updatedLine);
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
  }

  fs.writeFileSync(INDEX_PATH, html, 'utf8');

  // Print summary
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n══ Audit complete (${today}) ══`);
  console.log(`  Removed (closed):   ${log.removed.length}  — ${log.removed.join(', ') || 'none'}`);
  console.log(`  Updated (changed):  ${log.updated.length}  — ${log.updated.join(', ') || 'none'}`);
  console.log(`  Not found:          ${log.notFound.length} — ${log.notFound.join(', ') || 'none'}`);
  console.log(`  Unchanged:          ${log.unchanged}`);

  // Write a machine-readable summary for the commit message
  const summary = {
    date: today,
    removed:  log.removed,
    updated:  log.updated,
    notFound: log.notFound,
    unchanged: log.unchanged,
  };
  fs.writeFileSync(
    path.join(__dirname, '..', '.audit-summary.json'),
    JSON.stringify(summary, null, 2),
  );
}

main().catch(e => { console.error(e); process.exit(1); });
