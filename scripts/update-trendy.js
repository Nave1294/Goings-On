#!/usr/bin/env node
'use strict';

/**
 * Fetches the Eater Philadelphia RSS feed and keeps the Trending tab current.
 *
 * Behaviour:
 *   - Every Philly restaurant mentioned in a recent Eater article is added.
 *   - Restaurants are grouped into sections by the article they appear in
 *     (the section header is the article title + date).
 *   - The list ACCUMULATES across runs: new articles are appended, articles
 *     already present are skipped, and any article older than 6 months is
 *     dropped automatically.
 *
 * Run manually:  node scripts/update-trendy.js
 * Secrets needed: ANTHROPIC_API_KEY
 */

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');

// Eater Philly feeds to try in order
const RSS_URLS = [
  'https://philly.eater.com/rss/index.xml',
  'https://philly.eater.com/rss/front-page/index.xml',
];

// Articles older than this are never added and existing ones are pruned.
const MAX_AGE_DAYS = 183; // ~6 months

// ─── helpers ────────────────────────────────────────────────────────────────

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (!redirects) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'GoingsOnBot/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchRSS() {
  for (const url of RSS_URLS) {
    try {
      console.log(`Trying RSS: ${url}`);
      const xml = await get(url);
      if (xml.includes('<item>') || xml.includes('<entry>')) return xml;
    } catch (e) {
      console.warn(`  failed: ${e.message}`);
    }
  }
  throw new Error('Could not fetch any Eater Philly RSS feed');
}

function parseItems(xml) {
  const items = [];
  // Support both RSS <item> and Atom <entry>
  const tagRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  for (const m of xml.matchAll(tagRe)) {
    const raw = m[1];
    const str = tag => {
      const re = new RegExp(`<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      return (raw.match(re)?.[1] || '').trim();
    };
    const title   = str('title');
    const link    = str('link') || (raw.match(/href="([^"]+)"/)?.[1] || '');
    const desc    = str('description') || str('summary') || str('content');
    const pubDate = str('pubDate') || str('published') || str('updated');
    if (title && link) items.push({ title, link, desc, pubDate });
  }
  return items;
}

function ageDays(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return Infinity;
  return (Date.now() - d.getTime()) / (24 * 60 * 60 * 1000);
}

function isoDate(input) {
  const d = new Date(input);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function fmtDate(input) {
  const d = new Date(input);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Claude extraction ───────────────────────────────────────────────────────

// Returns, for each input article, the list of Philly restaurants it mentions.
async function extractArticleRestaurants(items, client) {
  if (!items.length) return [];

  const numbered = items.map((item, i) =>
    `${i + 1}. TITLE: ${item.title}
   URL: ${item.link}
   BLURB: ${stripHtml(item.desc)}`
  ).join('\n\n');

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are parsing Eater Philadelphia articles to build a "Trending" list of restaurants worth visiting.

For each article below, list EVERY specific Philadelphia-area restaurant, bar, cafe, or food spot it mentions positively (new openings, reviews, roundups / "best of" lists, must-try features, etc.). Roundups that name many places are great — include all of them.

For each restaurant include what you can infer from the title and blurb. If a detail isn't given, use an empty string.

EXCLUDE:
- Places mentioned only because they are closing or have closed
- Spots outside the greater Philadelphia area
- Generic references that aren't a named establishment

Return ONLY a valid JSON array (no markdown, no commentary). One object per article that mentions at least one restaurant:
[
  {
    "i": 1,                         // the article number above
    "restaurants": [
      { "name": "Restaurant Name", "location": "Neighborhood or address, else \"\"", "cuisine": "Cuisine if known, else \"\"", "desc": "One short sentence on why it's notable" }
    ]
  }
]

If an article names no qualifying restaurant, omit it. If none qualify at all, return [].

Articles:
${numbered}`,
    }],
  });

  const text = msg.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) { console.warn('Claude returned no JSON array'); return []; }
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn('JSON parse failed:', e.message, '\nRaw:', text.slice(0, 300));
    return [];
  }
}

// ─── Read / write the marker block ────────────────────────────────────────────

function extractExistingSections(html) {
  const blockMatch = html.match(/\/\/ TRENDY-START[\s\S]*?\/\/ TRENDY-END/);
  if (!blockMatch) return [];
  const m = blockMatch[0].match(/TRENDY_SECTIONS\s*=\s*(\[[\s\S]*\]);/);
  if (!m) return [];
  try { return JSON.parse(m[1]); }
  catch (e) { console.warn('Could not parse existing TRENDY_SECTIONS:', e.message); return []; }
}

function buildBlock(sections, updated) {
  const json = JSON.stringify(sections, null, 4)
    .split('\n')
    .map((line, i) => i === 0 ? line : '  ' + line)
    .join('\n');
  return `// TRENDY-START — auto-updated by GitHub Action every Monday, do not edit manually
  const TRENDY_UPDATED  = '${updated}';
  const TRENDY_SECTIONS = ${json};
  // TRENDY-END`;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic();

  const html     = fs.readFileSync(INDEX_PATH, 'utf8');
  const existing = extractExistingSections(html);
  const knownUrls = new Set(existing.map(s => s.articleUrl).filter(Boolean));

  const xml   = await fetchRSS();
  const items = parseItems(xml);
  console.log(`RSS: ${items.length} total items`);

  // Candidates: recent enough, and not already on the board.
  const candidates = items.filter(it =>
    ageDays(it.pubDate) <= MAX_AGE_DAYS && !knownUrls.has(it.link));
  console.log(`${candidates.length} new article(s) to process`);

  const extracted = candidates.length
    ? await extractArticleRestaurants(candidates, client)
    : [];

  // Build a new section per article that yielded restaurants.
  const newSections = [];
  for (const entry of extracted) {
    const item = candidates[entry.i - 1];
    if (!item || !Array.isArray(entry.restaurants) || !entry.restaurants.length) continue;
    const date = isoDate(item.pubDate);
    const places = entry.restaurants
      .filter(r => r && r.name)
      .map(r => ({
        name:     r.name,
        location: r.location || '',
        cuisine:  r.cuisine  || '',
        desc:     r.desc     || '',
        website:  '',
        articleUrl: item.link,
        season:   `📰 Eater · ${fmtDate(item.pubDate)}`,
      }));
    if (!places.length) continue;
    newSections.push({
      label: `📰 ${item.title}${fmtDate(item.pubDate) ? ` · ${fmtDate(item.pubDate)}` : ''}`,
      articleUrl: item.link,
      date,
      places,
    });
  }
  console.log(`Added ${newSections.length} new section(s)`);

  // Merge, prune anything older than 6 months, newest first.
  const merged = [...newSections, ...existing]
    .filter(s => ageDays(s.date) <= MAX_AGE_DAYS)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const dropped = existing.length - merged.filter(s => existing.includes(s)).length;
  if (dropped > 0) console.log(`Pruned ${dropped} expired section(s)`);

  if (!/\/\/ TRENDY-START[\s\S]*?\/\/ TRENDY-END/.test(html)) {
    console.error('ERROR: TRENDY-START/TRENDY-END markers not found in index.html');
    process.exit(1);
  }

  const today    = new Date().toISOString().slice(0, 10);
  const newBlock = buildBlock(merged, today);
  const updated  = html.replace(/\/\/ TRENDY-START[\s\S]*?\/\/ TRENDY-END/, newBlock);

  fs.writeFileSync(INDEX_PATH, updated, 'utf8');
  console.log(`index.html updated — ${merged.length} section(s) live (date: ${today})`);
}

main().catch(e => { console.error(e); process.exit(1); });
