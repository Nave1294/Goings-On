#!/usr/bin/env node
'use strict';

/**
 * Weekly re-verification of the auto-added events already on the Goings-On
 * calendar. Catches wrong dates that predate the scraper's verify-before-add
 * gate (e.g. the Boyz II Men concert added before that fix), and anything that
 * ever slips through later.
 *
 * For each FUTURE event we added (extendedProperties.private.goingsOnAuto ==
 * 'true'), it independently re-confirms the date via verify-event-date.js:
 *   - confirmed            → stamp goingsOnVerifiedAt, leave it (clear any strike).
 *   - wrong + real date    → MOVE it to the correct date (preserving time & length),
 *                            stamp goingsOnVerifiedAt.
 *   - unverifiable / wrong-without-date → strike it; REMOVE after 2 consecutive
 *                            strikes, so one flaky search can't delete a real event.
 *
 * COST CONTROL: an event stamped goingsOnVerifiedAt within the last
 * VERIFIED_SKIP_DAYS is skipped with NO API call. scrape-events.js already
 * stamps every event it inserts (it just independently verified the date right
 * before adding it), so in steady state this job only spends money on the
 * one-time legacy backlog and on events whose stamp has aged out — not on
 * re-checking the same confirmed date every single week forever.
 *
 * It ONLY ever touches events we auto-added; hand-added calendar events are never
 * modified or removed.
 *
 * Run manually:  node scripts/audit-events.js
 * Secrets: ANTHROPIC_API_KEY, GCAL_SERVICE_ACCOUNT, (optional) CALENDAR_ID
 */

const { google } = require('googleapis');
const Anthropic   = require('@anthropic-ai/sdk');
const { verifyEventDate } = require('./verify-event-date');

const CALENDAR_ID = process.env.CALENDAR_ID
  || '1d79153a3e99e53af1c993acfbf2b3f120c5d78d210297c80de3581d5e924f71@group.calendar.google.com';
const TZ                = 'America/New_York';
const HORIZON_DAYS      = 30;   // only audit events within this many days ahead (was 60 — narrower window, less to check)
const REMOVE_AFTER      = 2;    // consecutive unverifiable audits before deletion
const VERIFIED_SKIP_DAYS = 21;  // don't re-spend on an event confirmed this recently

const pad = n => String(n).padStart(2, '0');
const toISODate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function daysSinceISO(iso, todayISO) {
  if (!isISODate(iso)) return Infinity;
  const [y1, m1, d1] = iso.split('-').map(Number);
  const [y2, m2, d2] = todayISO.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Number of all-day days an event spans (Calendar all-day end date is exclusive).
function allDaySpan(startISO, endExclISO) {
  let d = startISO, n = 0, g = 0;
  const end = (endExclISO && endExclISO > startISO) ? endExclISO : addDaysISO(startISO, 1);
  while (d < end && g++ < 120) { n++; d = addDaysISO(d, 1); }
  return Math.max(1, n);
}

// Build a start/end patch that moves an event to `newDate`, preserving whether
// it's all-day vs timed, its local start time, and its length.
function shiftToDate(ev, newDate) {
  if (ev.start?.date) {
    const span = allDaySpan(ev.start.date, ev.end?.date);
    return { start: { date: newDate }, end: { date: addDaysISO(newDate, span) } };
  }
  const tz = ev.start?.timeZone || TZ;
  const startDT = ev.start?.dateTime, endDT = ev.end?.dateTime;
  const [sh, sm] = startDT.slice(11, 16).split(':').map(Number);
  let durMin = endDT ? Math.round((new Date(endDT) - new Date(startDT)) / 60000) : 120;
  if (!(durMin > 0)) durMin = 120;
  const total = sh * 60 + sm + durMin;
  const endDayOffset = Math.floor(total / (24 * 60));
  const endMin = total % (24 * 60);
  return {
    start: { dateTime: `${newDate}T${pad(sh)}:${pad(sm)}:00`, timeZone: tz },
    end:   { dateTime: `${addDaysISO(newDate, endDayOffset)}T${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}:00`, timeZone: tz },
  };
}

function getCalendar() {
  const raw = process.env.GCAL_SERVICE_ACCOUNT;
  if (!raw) { console.error('ERROR: GCAL_SERVICE_ACCOUNT is not set. See ADDING-PLACES.md §7.'); process.exit(1); }
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { console.error(`ERROR: GCAL_SERVICE_ACCOUNT is not valid JSON (${e.message})`); process.exit(1); }
  const auth = new google.auth.JWT(creds.client_email, null, creds.private_key,
    ['https://www.googleapis.com/auth/calendar.events']);
  return google.calendar({ version: 'v3', auth });
}

async function listAutoEvents(cal, todayISO, untilISO) {
  const out = [];
  let pageToken;
  do {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      timeMin: new Date(`${todayISO}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${untilISO}T00:00:00Z`).toISOString(),
      singleEvents: true, maxResults: 2500, pageToken,
    });
    for (const ev of res.data.items || []) {
      if (ev.status === 'cancelled' || !ev.summary) continue;
      if (ev.extendedProperties?.private?.goingsOnAuto !== 'true') continue; // never touch hand-added
      out.push(ev);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function main() {
  const cal      = getCalendar();
  const client   = new Anthropic();
  const todayISO = toISODate(new Date());
  const untilISO = addDaysISO(todayISO, HORIZON_DAYS);

  const events = await listAutoEvents(cal, todayISO, untilISO);
  console.log(`${events.length} auto-added event(s) between ${todayISO} and ${untilISO}`);

  let confirmed = 0, moved = 0, removed = 0, struck = 0, errored = 0, skipped = 0;

  for (const ev of events) {
    const startISO = ev.start?.date || (ev.start?.dateTime || '').slice(0, 10);
    if (!isISODate(startISO)) continue;
    const title = ev.summary;

    // Cost control: already confirmed recently — no need to spend an API call
    // re-proving the same date again this soon.
    const verifiedAt = ev.extendedProperties?.private?.goingsOnVerifiedAt;
    if (isISODate(verifiedAt) && daysSinceISO(verifiedAt, todayISO) < VERIFIED_SKIP_DAYS) {
      skipped++;
      continue;
    }

    let v;
    try { v = await verifyEventDate(client, { title, date: startISO, location: ev.location || '' }); }
    catch (e) { console.warn(`  ! verify error for "${title}": ${e.message}`); errored++; continue; }

    const strikes = Number(ev.extendedProperties?.private?.goingsOnUnverified || 0);

    if (v.status === 'confirmed') {
      console.log(`  ✓ ${startISO}  ${title}`);
      confirmed++;
      try { await stampVerified(cal, ev, todayISO); } catch (e) { console.warn(`  ! stamp failed for "${title}": ${e.message}`); }
      continue;
    }

    if (v.status === 'wrong' && v.correctDate && v.correctDate >= todayISO) {
      console.log(`  → moving ${startISO} → ${v.correctDate}: ${title}`);
      try {
        await cal.events.patch({ calendarId: CALENDAR_ID, eventId: ev.id, requestBody: shiftToDate(ev, v.correctDate) });
        moved++;
        await stampVerified(cal, ev, todayISO);
      } catch (e) { console.warn(`  ! move failed for "${title}": ${e.message}`); errored++; }
      continue;
    }

    // unverifiable, or "wrong" with an unusable date → strike, then remove on repeat.
    const next = strikes + 1;
    if (next >= REMOVE_AFTER) {
      console.log(`  ✗ removing (unverifiable ${next}×): ${startISO}  ${title}`);
      try { await cal.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id }); removed++; }
      catch (e) { console.warn(`  ! delete failed for "${title}": ${e.message}`); errored++; }
    } else {
      console.log(`  ? unverifiable (strike ${next}/${REMOVE_AFTER}): ${startISO}  ${title}`);
      try { await setStrike(cal, ev, next); struck++; }
      catch (e) { console.warn(`  ! strike patch failed for "${title}": ${e.message}`); errored++; }
    }
  }

  console.log(`\nDone — ${confirmed} confirmed, ${moved} moved, ${struck} struck, ${removed} removed, ${skipped} skipped (recently verified), ${errored} error(s).`);
}

// extendedProperties.private patches merge key-by-key, so each of these only
// touches its own field — safe to call independently.
function setStrike(cal, ev, n) {
  return cal.events.patch({ calendarId: CALENDAR_ID, eventId: ev.id,
    requestBody: { extendedProperties: { private: { goingsOnUnverified: String(n) } } } });
}
// Confirmed (or corrected) as of today: stamp the date and clear any strike —
// this is what lets future runs skip it for VERIFIED_SKIP_DAYS.
function stampVerified(cal, ev, todayISO) {
  return cal.events.patch({ calendarId: CALENDAR_ID, eventId: ev.id,
    requestBody: { extendedProperties: { private: { goingsOnVerifiedAt: todayISO, goingsOnUnverified: null } } } });
}

main().catch(e => { console.error(e); process.exit(1); });
