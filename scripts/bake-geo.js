#!/usr/bin/env node
'use strict';

/**
 * Bakes coordinates + a photo reference into every restaurant / bookstore /
 * market entry in index.html, so the live site never spends a paid Places
 * Text Search call to geocode or find a photo for a known place.
 *
 * Each place line gets a `geo` field:
 *   geo: { lat: 39.95, lon: -75.16, ph: 'places/…/photos/…' }
 *
 * Modes:
 *   --fill      (default) Only look up places that have NO geo yet. Cheap —
 *               this is what runs on every push, so newly-added places get
 *               baked automatically and existing ones cost nothing.
 *   --validate  Fill missing, then re-check a ROLLING DAILY SLICE of existing
 *               photo references and re-fetch any that no longer load. Runs
 *               daily; the slice auto-sizes so every photo is checked about
 *               once a month with no single big burst, and keeps sweeping
 *               within a month no matter how large the list grows.
 *
 * Coordinates never expire, so they're only ever fetched once per place.
 * Only photo references can go stale, which is what --validate repairs.
 *
 * Run manually:  node scripts/bake-geo.js --validate
 * Secret:  PLACES_API_KEY
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const INDEX_PATH     = path.join(__dirname, '..', 'index.html');
const PLACES_API_KEY = process.env.PLACES_API_KEY;

if (!PLACES_API_KEY) { console.error('Missing PLACES_API_KEY'); process.exit(1); }

const MODE = process.argv.includes('--validate') ? 'validate' : 'fill';

// ─── Places API (New) Text Search ────────────────────────────────────────────

function placesSearch(query) {
  const body = JSON.stringify({ textQuery: query + ' Philadelphia', languageCode: 'en' });
  const fieldMask = 'places.displayName,places.location,places.photos';
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
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(s); } catch { parsed = {}; }
        // Surface HTTP errors that didn't come back as a JSON {error} body.
        if (res.statusCode >= 400 && !parsed.error) {
          parsed.error = { code: res.statusCode, status: `HTTP_${res.statusCode}`, message: s.slice(0, 200) };
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// HEAD-style check that a photo media reference still resolves. The endpoint
// 302-redirects to the real image when valid, or returns 4xx when stale.
function photoIsLive(ph) {
  return new Promise(resolve => {
    const url = `https://places.googleapis.com/v1/${ph}/media?maxHeightPx=200&key=${PLACES_API_KEY}`;
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, res => {
      res.resume(); // drain
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Word-level name match so we never bake the wrong venue's coordinates.
function nameMatches(a, b) {
  const toks = s => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  const words = new Set(long);
  return short.every(t => words.has(t));
}

async function lookupGeo(name, location) {
  const query = location ? `${name}, ${location}` : name;
  const data = await placesSearch(query);
  // A rejected request (bad key, missing API enablement, or — most commonly —
  // an HTTP-referrer-restricted key called from CI) must fail loudly rather
  // than masquerade as "not found" for every place.
  if (data.error) {
    throw new Error(
      `Places API rejected the request (${data.error.status || data.error.code || 'error'}): ${data.error.message || ''}\n` +
      `Hint: a browser key restricted to HTTP referrers will NOT work from GitHub Actions — ` +
      `server-side calls send no referrer. Set the PLACES_API_KEY secret to a key with no ` +
      `HTTP-referrer restriction (restrict it to the Places API instead).`
    );
  }
  const place = data.places?.[0];
  if (!place || !place.location) return null;
  // Guard against a mis-match returning a far-off or wrong venue.
  if (place.displayName?.text && !nameMatches(name, place.displayName.text)) return null;
  // A malformed location (missing/non-numeric lat or lon) must not crash the
  // whole run — skip the entry instead.
  const lat = Number(place.location.latitude);
  const lon = Number(place.location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    ph:  place.photos?.[0]?.name || '',
  };
}

// ─── Line parsing / rewriting ─────────────────────────────────────────────────

// Pull { lineIndex, raw, name, location, geo } from inside a marker block.
function extractPlaceLines(html, startMarker, endMarker) {
  const lines = html.split('\n');
  let inside = false;
  const results = [];
  const placeRe = /^\s*\{\s*name:\s*(['"])(.*?)\1/;
  lines.forEach((line, i) => {
    if (line.includes(startMarker)) { inside = true;  return; }
    if (line.includes(endMarker))   { inside = false; return; }
    if (!inside) return;
    if (!placeRe.test(line)) return;
    const nameMatch = line.match(/name:\s*(['"])(.*?)\1/);
    const locMatch  = line.match(/location:\s*(['"])(.*?)\1/);
    const geoMatch  = line.match(/geo:\s*\{\s*lat:\s*([-\d.]+),\s*lon:\s*([-\d.]+),\s*ph:\s*'([^']*)'\s*\}/);
    results.push({
      lineIndex: i,
      raw: line,
      name:     nameMatch?.[2] || '',
      location: locMatch?.[2]  || '',
      geo: geoMatch ? { lat: +geoMatch[1], lon: +geoMatch[2], ph: geoMatch[3] } : null,
    });
  });
  return results;
}

function withGeo(raw, geo) {
  const geoStr = `geo: { lat: ${geo.lat}, lon: ${geo.lon}, ph: '${geo.ph}' }`;
  if (/geo:\s*\{[^}]*\}/.test(raw)) return raw.replace(/geo:\s*\{[^}]*\}/, geoStr);
  const lastBrace = raw.lastIndexOf('}');
  const before = raw.slice(0, lastBrace).replace(/\s*$/, '');
  const after  = raw.slice(lastBrace);
  const sep = before.endsWith(',') ? ' ' : ', ';
  return before + sep + geoStr + ' ' + after;
}

// Day of the month in UTC (1–31). Picks which slice of photos to validate so
// the monthly photo scan is spread evenly across days instead of one burst.
function dayOfMonth(d = new Date()) { return d.getUTCDate(); }

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  // Edit by line index into one split, never by substring match — two
  // byte-identical place lines would otherwise collide under String.replace.
  const lines = html.split('\n');

  const sections = [
    { start: 'EAT-PLACES-START',  end: 'EAT-PLACES-END',  label: 'Restaurants' },
    { start: 'BOOK-PLACES-START', end: 'BOOK-PLACES-END', label: 'Bookstores'  },
    { start: 'FM-PLACES-START',   end: 'FM-PLACES-END',   label: 'Farmers Markets' },
    { start: 'PARK-PLACES-START', end: 'PARK-PLACES-END', label: 'Picnic Parks' },
  ];

  // Gather every place across all marked sections in stable file order, so a
  // rolling validate slice can span restaurants, bookstores, and markets uniformly.
  const allPlaces = [];
  for (const section of sections) {
    for (const p of extractPlaceLines(html, section.start, section.end)) allPlaces.push(p);
  }

  const log = { filled: [], refreshed: [], stillLive: 0, notFound: [], unchanged: 0 };
  log.unchanged = allPlaces.filter(p => p.geo).length;
  let quotaReached = false;

  // ── 1. FILL — bake coords + photo for any place that has no geo yet. Runs in
  //    both modes; it's free for already-baked places (skipped), so this is what
  //    catches newly-added places.
  for (const place of allPlaces) {
    if (place.geo) continue;
    process.stdout.write(`  Baking: ${place.name} … `);
    let geo;
    try { geo = await lookupGeo(place.name, place.location); }
    catch (e) {
      if (/RESOURCE_EXHAUSTED/.test(e.message)) { console.log('quota reached'); quotaReached = true; break; }
      throw e;
    }
    if (!geo) { console.log('not found'); log.notFound.push(place.name); }
    else {
      lines[place.lineIndex] = withGeo(place.raw, geo);
      place.geo = geo;                       // visible to the validate pass below
      log.filled.push(place.name);
      console.log(`baked (${geo.lat}, ${geo.lon}${geo.ph ? ', +photo' : ', no photo'})`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // ── 2. VALIDATE (rolling) — re-check one daily slice of existing photo refs,
  //    re-fetching any that have gone stale. The slice auto-sizes to the list so
  //    every photo is verified about once a month with no single big burst, and
  //    it keeps sweeping within a month no matter how large the list grows.
  if (MODE === 'validate' && !quotaReached) {
    const withPhotos = allPlaces.filter(p => p.geo && p.geo.ph);
    const SWEEP_DAYS = 28;                                  // always finish within a month
    const batch = Math.max(1, Math.ceil(withPhotos.length / SWEEP_DAYS));
    const start = (dayOfMonth() - 1) * batch;
    const slice = withPhotos.slice(start, start + batch);
    const range = slice.length ? `${start}–${start + slice.length - 1}` : 'none today';
    console.log(`\n── Validating photos — day ${dayOfMonth()}: ${slice.length} of ${withPhotos.length} [${range}] ──`);
    for (const place of slice) {
      const live = await photoIsLive(place.geo.ph);
      if (live) { log.stillLive++; continue; }
      process.stdout.write(`  Stale photo: ${place.name} … `);
      let fresh;
      try { fresh = await lookupGeo(place.name, place.location); }
      catch (e) {
        if (/RESOURCE_EXHAUSTED/.test(e.message)) { console.log('quota reached'); quotaReached = true; break; }
        throw e;
      }
      if (fresh && fresh.ph) {
        lines[place.lineIndex] = withGeo(place.raw, { ...place.geo, ph: fresh.ph });
        log.refreshed.push(place.name);
        console.log('refreshed');
      } else {
        console.log('could not refetch — kept');
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Always write progress — even a partial run saves whatever was baked so the
  // next run skips those places and picks up where this one left off.
  fs.writeFileSync(INDEX_PATH, lines.join('\n'), 'utf8');

  const today = new Date().toISOString().slice(0, 10);
  const status = quotaReached ? 'partial (quota reached)' : 'complete';
  console.log(`\n══ bake-geo ${MODE} ${status} (${today}) ══`);
  console.log(`  Filled:     ${log.filled.length}  — ${log.filled.join(', ') || 'none'}`);
  console.log(`  Refreshed:  ${log.refreshed.length} — ${log.refreshed.join(', ') || 'none'}`);
  console.log(`  Still live: ${log.stillLive}`);
  console.log(`  Not found:  ${log.notFound.length} — ${log.notFound.join(', ') || 'none'}`);
  console.log(`  Unchanged:  ${log.unchanged}`);
  if (quotaReached) console.log('  ⚠ Daily quota reached — partial progress saved. Re-run to continue.');

  fs.writeFileSync(path.join(__dirname, '..', '.bake-summary.json'), JSON.stringify({
    date: today, mode: MODE,
    filled: log.filled, refreshed: log.refreshed, notFound: log.notFound,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
