#!/usr/bin/env node
'use strict';

/**
 * Re-verifies the discount / rush / cheap-ticket rules for each performing-arts
 * venue and keeps the Performing Arts page current.
 *
 * Why a script instead of a plain scraper: the venue sites (Kimmel, Mann, …) sit
 * behind bot protection and return HTTP 403 to datacenter IPs like GitHub
 * Actions runners, so a direct fetch can't read them. Instead we let Claude run
 * its server-side `web_search` tool — those searches execute on Anthropic's
 * infrastructure, not the runner, so they get through. Claude returns the
 * current rules as JSON and we fold them back into the PA-START/PA-END block.
 *
 * Conservative by design: if Claude can't confirm a change for a venue it
 * returns that venue unchanged, so curated copy never gets clobbered by a
 * low-confidence guess. Runs quarterly (the rules rarely move).
 *
 * Run manually:  node scripts/update-arts-discounts.js
 * Secrets needed: ANTHROPIC_API_KEY
 */

const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const BLOCK_RE   = /\/\/ PA-START[\s\S]*?\/\/ PA-END/;

// ─── read / write the marker block ───────────────────────────────────────────

function extractVenues(html) {
  const block = html.match(BLOCK_RE);
  if (!block) return null;
  const m = block[0].match(/PA_VENUES\s*=\s*(\[[\s\S]*\]);/);
  if (!m) return null;
  try { return JSON.parse(m[1]); }
  catch (e) { console.warn('Could not parse existing PA_VENUES:', e.message); return null; }
}

function buildBlock(venues, updated) {
  const json = JSON.stringify(venues, null, 4)
    .split('\n')
    .map((line, i) => i === 0 ? line : '  ' + line)
    .join('\n');
  return `// PA-START — discount-ticket rules; re-verified quarterly by GitHub Action, safe to hand-edit
  const PA_UPDATED = '${updated}';
  const PA_VENUES = ${json};
  // PA-END`;
}

// ─── Claude re-verification (with server-side web search) ─────────────────────

// Ask Claude to re-check one venue's discount programs against the live web and
// return the corrected venue object. Returns the original venue on any doubt.
async function reverifyVenue(client, venue) {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
    messages: [{
      role: 'user',
      content: `You maintain a Philadelphia performing-arts discount-ticket guide. Re-verify the discount / rush / cheap-ticket rules for ONE venue against the current web, then return the corrected record.

Search the venue's official site and reputable sources for its current discount programs (rush, student, lottery, pay-what-you-wish, flat-price, etc.). Update the "deals" only where you can CONFIRM a change; if you cannot confirm a change for a field, keep the existing value exactly. Never invent a program. Keep "id", "group", "name", "kind", and "location" unchanged unless plainly wrong.

Each deal object is: { "name": "program name", "price": "e.g. $10 or $11–$30", "who": "who qualifies", "how": "how to get it, concretely", "url": "official link" }.

Return ONLY the single venue object as valid JSON (no markdown, no commentary). If nothing changed, return the input object unchanged.

CURRENT RECORD:
${JSON.stringify(venue, null, 2)}`,
    }],
  });

  // The final text block holds the JSON (web-search turns add other blocks).
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) { console.warn(`  ${venue.name}: no JSON returned — keeping existing`); return venue; }
  try {
    const next = JSON.parse(match[0]);
    if (!next || !next.id || !Array.isArray(next.deals) || !next.deals.length) {
      console.warn(`  ${venue.name}: incomplete record — keeping existing`);
      return venue;
    }
    // Preserve the immutable fields no matter what the model echoed back.
    return { ...next, id: venue.id, group: venue.group };
  } catch (e) {
    console.warn(`  ${venue.name}: JSON parse failed (${e.message}) — keeping existing`);
    return venue;
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic();

  const html   = fs.readFileSync(INDEX_PATH, 'utf8');
  const venues = extractVenues(html);
  if (!venues) {
    console.error('ERROR: PA-START/PA-END block (with PA_VENUES) not found in index.html');
    process.exit(1);
  }
  console.log(`Re-verifying ${venues.length} venue(s)…`);

  const updated = [];
  for (const v of venues) {
    console.log(`  Checking: ${v.name}`);
    try {
      updated.push(await reverifyVenue(client, v));
    } catch (e) {
      console.warn(`  ${v.name}: error (${e.message}) — keeping existing`);
      updated.push(v);
    }
    await new Promise(r => setTimeout(r, 300)); // be gentle on the API
  }

  const today    = new Date().toISOString().slice(0, 10);
  const newBlock = buildBlock(updated, today);
  fs.writeFileSync(INDEX_PATH, html.replace(BLOCK_RE, newBlock), 'utf8');
  console.log(`index.html updated — ${updated.length} venue(s) verified (date: ${today})`);
}

main().catch(e => { console.error(e); process.exit(1); });
