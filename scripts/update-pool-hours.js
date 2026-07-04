#!/usr/bin/env node
'use strict';

/**
 * Keeps the seasonal Pools tab's open-hours current, straight from the official
 * Philadelphia Parks & Recreation pool schedule (phila.gov).
 *
 * Why a script instead of a plain fetch: phila.gov's pool pages sit behind bot
 * protection that returns HTTP 403 to datacenter IPs like GitHub Actions
 * runners, so a direct scrape can't read them. Instead — exactly like the
 * performing-arts and events jobs — we let Claude run its server-side
 * `web_search` tool, which executes on Anthropic's infrastructure (not the
 * runner) and gets through. Claude returns each pool's current hours and we
 * splice them into the POOL-PLACES block in index.html.
 *
 * SAFETY: this only ever rewrites the `hours:` field of a pool line. It never
 * touches name/location/coords/geo, and it validates that each edited line
 * still parses as a JS object before keeping it — so a bad model response can
 * never corrupt the file (a single dropped comma once took the whole site
 * down; that class of bug is designed out here).
 *
 * Conservative by design: if Claude can't confirm a pool's hours it returns an
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
const BATCH_SIZE   = 12;   // pools per web-search call (schedules are centralized)

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
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    messages: [{
      role: 'user',
      content: `You maintain a Philadelphia summer guide. Find the CURRENT open hours for these free Philadelphia Parks & Recreation public swimming pools, using the official city schedule on phila.gov (start at https://www.phila.gov/programs/summer/pools/ and the current-season pool schedule / "find a pool" pages). Base hours ONLY on the official city source — do not guess.

POOLS:
${list}

For each pool return a SHORT hours string, e.g. "Daily 11am–7pm", "Mon–Fri 1–7pm, Sat–Sun 11am–5pm", "Opens June 27", or "Closed for the season". If you cannot confirm a pool's current hours from the official source, return an empty string "" for it (do NOT invent hours).

Return ONLY minified JSON: an object mapping each pool name EXACTLY as written above to its hours string. No markdown, no commentary. Example: {"Cruz Pool":"Daily 11am–7pm","Lee Pool":""}`,
    }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]); }
  catch (e) { console.warn(`  batch JSON parse failed: ${e.message}`); return {}; }
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
