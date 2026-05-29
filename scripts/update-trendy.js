#!/usr/bin/env node
'use strict';

/**
 * Fetches the Eater Philadelphia RSS feed, extracts restaurant write-ups
 * from the past 14 days using Claude, and rewrites the TRENDY-START/TRENDY-END
 * block in index.html so the Trending tab stays current.
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
  'https://philadelphia.eater.com/rss/index.xml',
  'https://www.eater.com/rss/philadelphia',
];

// How far back to look for articles
const LOOKBACK_DAYS = 14;

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

function recentItems(items) {
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return items.filter(item => {
    const d = new Date(item.pubDate);
    return !isNaN(d.getTime()) && d.getTime() > cutoff;
  });
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function extractRestaurants(items, client) {
  if (!items.length) return [];

  const numbered = items.map((item, i) =>
    `${i + 1}. TITLE: ${item.title}
   DATE: ${item.pubDate}
   URL: ${item.link}
   BLURB: ${stripHtml(item.desc)}`
  ).join('\n\n');

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are parsing Eater Philadelphia articles to build a "Trending" restaurant list.

For each article below, decide if it is primarily spotlighting one specific Philadelphia restaurant or food spot (a new opening, a review, a "must try", a chef profile tied to one place, etc.).

SKIP any article that:
- Is a roundup of 5+ places
- Is about a permanent closing
- Is about bars, nightlife, or drinks only (unless food is central)
- Is outside the Philadelphia city area
- Is about non-restaurant topics (news, policy, events, etc.)

For each QUALIFYING article, output one JSON object:
{
  "name": "Restaurant Name",
  "location": "Neighborhood or street address if mentioned, else empty string",
  "cuisine": "Cuisine type if mentioned, else empty string",
  "desc": "One sentence — what makes this place notable, based on the article",
  "website": "",
  "articleUrl": "the article URL exactly as given",
  "season": "📰 Eater · MONTH DAY"  // e.g. "📰 Eater · May 29"
}

Return ONLY a valid JSON array (wrap in [ ] ), no markdown, no explanation. If no articles qualify, return [].

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

function buildBlock(places, updated) {
  const json = JSON.stringify(places, null, 4)
    .split('\n')
    .map((line, i) => i === 0 ? line : '  ' + line)
    .join('\n');
  return `// TRENDY-START — auto-updated by GitHub Action every Monday, do not edit manually
  const TRENDY_UPDATED = '${updated}';
  const TRENDY_PLACES  = ${json};
  // TRENDY-END`;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic();

  const xml   = await fetchRSS();
  const all   = parseItems(xml);
  const recent = recentItems(all);
  console.log(`RSS: ${all.length} total items, ${recent.length} from past ${LOOKBACK_DAYS} days`);

  const places = recent.length ? await extractRestaurants(recent, client) : [];
  console.log(`Extracted ${places.length} restaurant mention(s)`);

  const html    = fs.readFileSync(INDEX_PATH, 'utf8');
  const today   = new Date().toISOString().slice(0, 10);
  const newBlock = buildBlock(places, today);

  const updated = html.replace(
    /\/\/ TRENDY-START[\s\S]*?\/\/ TRENDY-END/,
    newBlock,
  );

  if (updated === html) {
    console.error('ERROR: TRENDY-START/TRENDY-END markers not found in index.html');
    process.exit(1);
  }

  fs.writeFileSync(INDEX_PATH, updated, 'utf8');
  console.log(`index.html updated (${places.length} trending places, date: ${today})`);
}

main().catch(e => { console.error(e); process.exit(1); });
