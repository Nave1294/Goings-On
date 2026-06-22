#!/usr/bin/env node
'use strict';

/**
 * Finds upcoming Philadelphia events from Visit Philly and Hidden City and adds
 * them to the Goings-On Google Calendar. The website already reads that calendar,
 * so events flow into the app automatically on the next load — and each one is
 * tagged so the app can show a "🤖 auto-added" badge on the card.
 *
 * Why web search instead of a plain HTTP scraper: both visitphilly.com and
 * hiddencityphila.org sit behind edge bot-protection and return HTTP 403 to
 * datacenter IPs (GitHub Actions runners, this script's host — verified). So a
 * direct fetch can't read them. Instead we let Claude run its server-side
 * `web_search` tool: those searches execute on Anthropic's infrastructure, not
 * the runner, so they get through. Claude returns the events as JSON and we
 * insert them via the Calendar API. (Same approach as update-arts-discounts.js.)
 *
 * Idempotent: every event we create carries extendedProperties.private.goingsOnSig
 * (a normalized title+date+source signature). Before inserting we list the
 * calendar's existing auto-added events and skip any signature already present, so
 * the twice-weekly runs never create duplicates. We only ever INSERT events we
 * mark ourselves — manually-added calendar events are never touched.
 *
 * Run manually:  node scripts/scrape-events.js
 * Secrets needed:
 *   ANTHROPIC_API_KEY     – for Claude + web search
 *   GCAL_SERVICE_ACCOUNT  – the full JSON of a Google service-account key that the
 *                           calendar has been shared with ("Make changes to events").
 *                           See scripts/ADDING-PLACES.md §7 for one-time setup.
 *   CALENDAR_ID           – optional; defaults to the live Goings-On calendar.
 */

const { google } = require('googleapis');
const Anthropic   = require('@anthropic-ai/sdk');

const CALENDAR_ID  = process.env.CALENDAR_ID
  || '1d79153a3e99e53af1c993acfbf2b3f120c5d78d210297c80de3581d5e924f71@group.calendar.google.com';
const TZ           = 'America/New_York';
const HORIZON_DAYS = 45;   // only add events within this many days from today
const MODEL        = 'claude-haiku-4-5-20251001';

// Keep these ids in sync with AUTO_SOURCE_LABELS in index.html.
const SOURCES = [
  {
    id: 'visitphilly',
    label: 'Visit Philly',
    hint: 'Visit Philadelphia (visitphilly.com) and its Uwishunu "things to do this week & weekend" guides',
  },
  {
    id: 'hiddencity',
    label: 'Hidden City',
    hint: 'Hidden City Philadelphia (hiddencityphila.org) — its tours, talks, and special events',
  },
];

// ─── helpers ──────────────────────────────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');
const toISODate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addHoursHM(hm, hours) {
  const [h, m] = hm.split(':').map(Number);
  let total = (h * 60 + m) + hours * 60;
  total = Math.min(total, 23 * 60 + 59);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isHM      = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

function signature(sourceId, title, date) {
  const norm = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${sourceId}|${norm}|${date}`;
}

// ─── Claude: discover events via server-side web search ───────────────────────

async function findEvents(client, source) {
  const todayISO = toISODate(new Date());
  const untilISO = addDaysISO(todayISO, HORIZON_DAYS);

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    messages: [{
      role: 'user',
      content: `You curate a Philadelphia events calendar. Using web search, find specific, real, upcoming events from ${source.hint}.

Today is ${todayISO}. Only include events whose date falls between ${todayISO} and ${untilISO} (inclusive). Search that source's current "this week / this weekend / upcoming events" coverage and follow through to the specific events it lists.

INCLUDE only events you can tie to a CONCRETE calendar date (a festival, concert, tour, exhibit opening, market, talk, etc. happening on a known day). EXCLUDE:
- Anything without a specific date, or only a vague month/"all summer".
- Permanent attractions, generic "things to do", restaurants, or evergreen listicles.
- Events outside the greater Philadelphia area, or already past.
- Anything you are not confident is real — when in doubt, leave it out. Accuracy matters far more than quantity.

For each event return an object:
{
  "title": "Event name",
  "date": "YYYY-MM-DD",            // first/only day
  "endDate": "YYYY-MM-DD or \"\"", // last day if multi-day, else ""
  "allDay": true/false,            // true if no specific start time
  "startTime": "HH:MM or \"\"",    // 24-hour local time if known
  "endTime": "HH:MM or \"\"",
  "location": "Venue, address or neighborhood, else \"\"",
  "description": "1-2 sentence summary of what it is",
  "url": "official or source link"
}

Return ONLY a valid JSON array (no markdown, no commentary). Return [] if you find nothing you are confident about.`,
    }],
  });

  const text  = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) { console.warn(`  ${source.label}: no JSON array returned`); return []; }
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn(`  ${source.label}: JSON parse failed (${e.message})`);
    return [];
  }
}

// Validate + normalize one raw event. Returns null if it should be skipped.
function normalizeEvent(raw, todayISO, untilISO) {
  if (!raw || !raw.title || !isISODate(raw.date)) return null;
  if (raw.date < todayISO || raw.date > untilISO) return null;

  const endDate   = isISODate(raw.endDate) && raw.endDate >= raw.date ? raw.endDate : '';
  const startTime = isHM(raw.startTime) ? raw.startTime : '';
  const allDay    = raw.allDay === true || !startTime;
  const endTime   = (!allDay && isHM(raw.endTime)) ? raw.endTime : '';

  return {
    title:       String(raw.title).trim().slice(0, 200),
    date:        raw.date,
    endDate,
    allDay,
    startTime:   allDay ? '' : startTime,
    endTime,
    location:    String(raw.location || '').trim().slice(0, 250),
    description: String(raw.description || '').trim().slice(0, 600),
    url:         /^https?:\/\//i.test(raw.url) ? raw.url.trim() : '',
  };
}

// ─── build a Google Calendar event resource ───────────────────────────────────

function toEventResource(e, source) {
  const descParts = [];
  if (e.description) descParts.push(e.description);
  if (e.url)         descParts.push(`More info: ${e.url}`);
  descParts.push(`Auto-added from ${source.label}.`);
  descParts.push(`[goings-on:auto:${source.id}]`);

  const resource = {
    summary:     e.title,
    description: descParts.join('\n\n'),
    extendedProperties: {
      private: {
        goingsOnAuto:   'true',
        goingsOnSource: source.id,
        goingsOnSig:    signature(source.id, e.title, e.date),
      },
    },
  };
  if (e.location) resource.location = e.location;
  if (e.url)      resource.source = { title: source.label, url: e.url };

  if (e.allDay) {
    // All-day end date is exclusive in the Calendar API.
    const lastDay = e.endDate || e.date;
    resource.start = { date: e.date };
    resource.end   = { date: addDaysISO(lastDay, 1) };
  } else {
    const endDate = e.endDate || e.date;
    const endTime = e.endTime || addHoursHM(e.startTime, 2);
    resource.start = { dateTime: `${e.date}T${e.startTime}:00`, timeZone: TZ };
    resource.end   = { dateTime: `${endDate}T${endTime}:00`,    timeZone: TZ };
  }
  return resource;
}

// ─── Google Calendar client ───────────────────────────────────────────────────

function getCalendar() {
  const raw = process.env.GCAL_SERVICE_ACCOUNT;
  if (!raw) {
    console.error(
      'ERROR: GCAL_SERVICE_ACCOUNT is not set.\n' +
      'This script writes to the Google Calendar and needs a service-account key.\n' +
      'See scripts/ADDING-PLACES.md §7 for the one-time setup.');
    process.exit(1);
  }
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { console.error(`ERROR: GCAL_SERVICE_ACCOUNT is not valid JSON (${e.message})`); process.exit(1); }

  const auth = new google.auth.JWT(
    creds.client_email, null, creds.private_key,
    ['https://www.googleapis.com/auth/calendar.events'],
  );
  return google.calendar({ version: 'v3', auth });
}

// Signatures of auto-added events already on the calendar in our window.
async function existingSignatures(cal, todayISO, untilISO) {
  const sigs = new Set();
  let pageToken;
  do {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      privateExtendedProperty: 'goingsOnAuto=true',
      timeMin: new Date(`${todayISO}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${addDaysISO(untilISO, 1)}T00:00:00Z`).toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    for (const ev of res.data.items || []) {
      const sig = ev.extendedProperties?.private?.goingsOnSig;
      if (sig) sigs.add(sig);
      else if (ev.summary) {
        const src  = ev.extendedProperties?.private?.goingsOnSource || '';
        const date = ev.start?.date || (ev.start?.dateTime || '').slice(0, 10);
        if (date) sigs.add(signature(src, ev.summary, date));
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return sigs;
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cal      = getCalendar();
  const client   = new Anthropic();
  const todayISO = toISODate(new Date());
  const untilISO = addDaysISO(todayISO, HORIZON_DAYS);

  const known = await existingSignatures(cal, todayISO, untilISO);
  console.log(`${known.size} auto-added event(s) already on the calendar in window`);

  let added = 0, skipped = 0;
  const seenThisRun = new Set();

  for (const source of SOURCES) {
    console.log(`\nSearching: ${source.label}`);
    let raw;
    try {
      raw = await findEvents(client, source);
    } catch (e) {
      console.warn(`  ${source.label}: search failed (${e.message}) — skipping source`);
      continue;
    }
    console.log(`  ${raw.length} candidate(s) returned`);

    for (const r of raw) {
      const e = normalizeEvent(r, todayISO, untilISO);
      if (!e) { skipped++; continue; }
      const sig = signature(source.id, e.title, e.date);
      if (known.has(sig) || seenThisRun.has(sig)) { skipped++; continue; }
      seenThisRun.add(sig);

      try {
        await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: toEventResource(e, source) });
        console.log(`  + ${e.date}  ${e.title}`);
        added++;
      } catch (err) {
        console.warn(`  ! failed to insert "${e.title}": ${err.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 400)); // be gentle on the API
  }

  console.log(`\nDone — ${added} added, ${skipped} skipped (duplicate or invalid).`);
}

main().catch(e => { console.error(e); process.exit(1); });
