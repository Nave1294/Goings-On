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
    hint: 'Hidden City Philadelphia\'s ticketed walking tours and events. Its editorial blog at hiddencityphila.org rarely lists dated events — the actual schedule lives at hiddencityphila.org/tours/ and on its ticketing platforms, hiddencityphila.ticketleap.com and eventbrite.com/o/hidden-city-philadelphia-22593391359. Search those specifically for upcoming dated tours (e.g. Lost Jewish Quarter, Mount Moriah Cemetery, North Central Philly, Forgotten North Broad Street) and any special members-only site visits.',
  },
  {
    id: 'citycast',
    label: 'CityCast Philly',
    hint: 'CityCast Philly\'s curated local events roundup, published at philly.citycast.fm/events — a regularly-updated list of specific dated happenings around Philadelphia (festivals, markets, concerts, comedy, talks, community and neighborhood events). Read that events page directly and follow through to each dated listing it names; the page is the schedule, not an editorial article.',
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
  return `${sourceId}|${normTitle(title)}|${date}`;
}

// ─── duplicate detection ──────────────────────────────────────────────────────
// Two events are "the same" if they share a day and a near-identical title. We
// normalize titles (drop punctuation, filler words, years, "Philadelphia") and
// compare by exact match, substring, or token overlap so small wording
// differences between sources still collapse to one event.

const TITLE_STOPWORDS = new Set([
  'the','a','an','of','at','in','on','to','for','and','or','with','presents',
  'present','presented','by','featuring','feat','philly','philadelphia','phila',
  '2024','2025','2026','2027',
]);

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !TITLE_STOPWORDS.has(w))
    .join(' ')
    .trim();
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Distinctive venue words, dropping street numbers, directionals, road types
// and city noise — so "Franklin Square" and "Franklin Square, 200 N 6th St"
// reduce to the same {franklin, square}. Used as a second duplicate signal:
// two events on the same day at the same venue are almost certainly the same
// event even when two sources headline it differently.
const VENUE_STOPWORDS = new Set([
  'the','at','in','on','of','and','a','to','st','street','ave','avenue','blvd',
  'boulevard','rd','road','dr','drive','ln','lane','pl','place','sq','ste','suite',
  'fl','floor','unit','philadelphia','philly','phila','pa','us','usa',
  'n','s','e','w','north','south','east','west',
]);
function venueTokens(loc) {
  return new Set(
    String(loc || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !/^\d+$/.test(w) && !VENUE_STOPWORDS.has(w))
  );
}

// Every calendar day an event touches (capped so a year-long entry can't blow up).
function expandDates(startISO, endISO) {
  const out = [];
  let d = startISO, guard = 0;
  const last = (endISO && endISO >= startISO) ? endISO : startISO;
  while (d <= last && guard++ < 120) { out.push(d); d = addDaysISO(d, 1); }
  return out;
}

// Days covered by an existing Google event (all-day end date is exclusive).
function eventDates(ev) {
  const startISO = ev.start?.date || (ev.start?.dateTime || '').slice(0, 10);
  if (!startISO) return [];
  let endISO;
  if (ev.end?.date)          endISO = addDaysISO(ev.end.date, -1);
  else if (ev.end?.dateTime) endISO = ev.end.dateTime.slice(0, 10);
  else                       endISO = startISO;
  return expandDates(startISO, endISO);
}

// Days covered by one of our normalized candidate events.
function candidateDates(e) {
  return expandDates(e.date, e.endDate || e.date);
}

// Does candidate `e` match anything already indexed on a shared day?
function isDuplicate(existing, source, e) {
  // Fast path: we already created this exact event on a prior run.
  if (existing.sigs.has(signature(source.id, e.title, e.date))) return true;

  const norm = normTitle(e.title);
  if (!norm) return false;
  const tokens = new Set(norm.split(' ').filter(Boolean));
  const venue  = venueTokens(e.location);

  for (const day of candidateDates(e)) {
    const list = existing.byDay.get(day);
    if (!list) continue;
    for (const x of list) {
      // Title-only signals (safe on their own).
      if (x.norm === norm) return true;
      if (norm.length >= 8 && (x.norm.includes(norm) || norm.includes(x.norm))) return true;
      if (jaccard(tokens, x.tokens) >= 0.7) return true;
      // Cross-source signal: same day at the same venue, with a real (if looser)
      // title relation. Different sources headline the same festival differently,
      // so the venue match lets us relax the title bar without merging two
      // genuinely different events at the same big venue (those share no title).
      if (venue.size && x.venue && x.venue.size &&
          jaccard(venue, x.venue) >= 0.5 && jaccard(tokens, x.tokens) >= 0.35) return true;
    }
  }
  return false;
}

// Record an event (existing or just-inserted) in the day index so later
// candidates in the same run dedup against it too.
function indexEvent(existing, title, dates, location) {
  const norm = normTitle(title);
  if (!norm) return;
  const tokens = new Set(norm.split(' ').filter(Boolean));
  const venue  = venueTokens(location);
  for (const day of dates) {
    if (!existing.byDay.has(day)) existing.byDay.set(day, []);
    existing.byDay.get(day).push({ norm, tokens, venue });
  }
}

// ─── Claude: discover events via server-side web search ───────────────────────

async function findEvents(client, source) {
  const todayISO = toISODate(new Date());
  const untilISO = addDaysISO(todayISO, HORIZON_DAYS);

  const msg = await client.messages.create({
    model: MODEL,
    // Generous budget: with web_search, every search round-trip (queries +
    // result summaries) is counted against this same output-token cap before
    // the final JSON is written, so a tight limit can truncate the answer
    // right when there are many events to list (max_uses=8 search calls plus
    // a 10+ event source can easily run past 4096).
    max_tokens: 8192,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    messages: [{
      role: 'user',
      content: `You curate a Philadelphia events calendar. Using web search, find specific, real, upcoming events from ${source.hint}.

Today is ${todayISO}. Only include events whose date falls between ${todayISO} and ${untilISO} (inclusive). Search whatever pages that source actually publishes its dated schedule on — that might be a "this week / this weekend" blog roundup, a dedicated tours/events page, or a third-party ticketing platform it sells through — and follow through to the specific events listed there, not just the homepage or editorial articles.

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

  if (msg.stop_reason === 'max_tokens') {
    console.warn(`  ${source.label}: response hit max_tokens — output may be truncated, raise max_tokens if this recurs`);
  }

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

// Load EVERY event already on the calendar in the window — manually-added,
// previously auto-added, or from any other source — into a per-day title index
// plus a set of our own signatures, so we never insert a duplicate of something
// that's already there. We fetch a little past the horizon to catch long
// festivals a candidate might overlap.
async function loadExisting(cal, todayISO, untilISO) {
  const existing = { byDay: new Map(), sigs: new Set() };
  let pageToken;
  do {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      timeMin: new Date(`${todayISO}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${addDaysISO(untilISO, 30)}T00:00:00Z`).toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    for (const ev of res.data.items || []) {
      if (ev.status === 'cancelled' || !ev.summary) continue;
      indexEvent(existing, ev.summary, eventDates(ev), ev.location);
      const sig = ev.extendedProperties?.private?.goingsOnSig;
      if (sig) existing.sigs.add(sig);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return existing;
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cal      = getCalendar();
  const client   = new Anthropic();
  const todayISO = toISODate(new Date());
  const untilISO = addDaysISO(todayISO, HORIZON_DAYS);

  const existing = await loadExisting(cal, todayISO, untilISO);
  console.log(`Indexed events already on the calendar across ${existing.byDay.size} day(s)`);

  let added = 0, skippedDup = 0, skippedBad = 0;

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
      if (!e) { skippedBad++; continue; }
      if (isDuplicate(existing, source, e)) {
        console.log(`  = already on calendar, skipping: ${e.date}  ${e.title}`);
        skippedDup++;
        continue;
      }

      try {
        await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: toEventResource(e, source) });
        console.log(`  + ${e.date}  ${e.title}`);
        added++;
        // Index it immediately so later candidates this run dedup against it.
        existing.sigs.add(signature(source.id, e.title, e.date));
        indexEvent(existing, e.title, candidateDates(e), e.location);
      } catch (err) {
        console.warn(`  ! failed to insert "${e.title}": ${err.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 400)); // be gentle on the API
  }

  console.log(`\nDone — ${added} added, ${skippedDup} duplicate(s) skipped, ${skippedBad} invalid skipped.`);
}

main().catch(e => { console.error(e); process.exit(1); });
