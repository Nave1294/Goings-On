#!/usr/bin/env node
'use strict';

/**
 * Independent, adversarial confirmation of ONE event's calendar date.
 *
 * Shared by two callers:
 *   - scrape-events.js  — verify-BEFORE-insert: never add an event whose date
 *                         we can't independently confirm on an event-specific page.
 *   - audit-events.js   — weekly re-verification of events already on the calendar,
 *                         so a wrong date that ever slips in gets caught and fixed.
 *
 * It uses Claude's server-side `web_search` (venue/ticketing sites 403 datacenter
 * IPs, but the search index gets through) and REFUSES to trust a roundup /
 * "things to do" / "upcoming concerts" listicle — those are the exact source of
 * the scraper's wrong dates. No authoritative event-specific page → "unverifiable".
 */

// A URL that lists MANY events is not proof of a single event's date. Keep this
// in sync with the copy in scrape-events.js.
const ROUNDUP_URL_RE = /things-to-do|upcoming-|this-week|this-weekend|\/weekend|\/guide|\/guides|\/articles?\/|\/blog\/|calendar-of-events|events-calendar|whats-on|what-to-do|roundup|best-.*-in-phil(ly|adelphia)/i;

const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// Returns { status: 'confirmed' | 'wrong' | 'unverifiable', correctDate, url }.
//   confirmed    — an authoritative event-specific page shows it on `ev.date`.
//   wrong        — such a page shows a DIFFERENT date (returned in correctDate).
//   unverifiable — no trustworthy event-specific page found (never guess).
async function verifyEventDate(client, ev, model = 'claude-haiku-4-5-20251001') {
  const loc = ev.location ? ` at ${ev.location}` : '';
  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    messages: [{
      role: 'user',
      content: `Verify the exact calendar date of ONE specific Philadelphia-area event.

EVENT: "${ev.title}"${loc}
CLAIMED DATE: ${ev.date}

Using web search, find the AUTHORITATIVE page for THIS specific event — the venue's own event page or an official ticketing listing (Ticketmaster, Live Nation, Eventbrite, the venue box office) — and confirm the event's real date.

Rules:
- Base your answer ONLY on a page dedicated to THIS specific event. NEVER use a roundup / "things to do" / "this weekend" / "upcoming concerts" listicle — those cause wrong dates.
- If that authoritative page shows the event on the CLAIMED DATE (${ev.date}) → status "confirmed".
- If it shows a DIFFERENT specific date → status "wrong", and put the real date in correctDate (YYYY-MM-DD).
- If you cannot find an authoritative event-specific page → status "unverifiable".
- Check the YEAR too (a September show is not this week). When unsure, use "unverifiable" — never guess.

Return ONLY minified JSON: {"status":"confirmed|wrong|unverifiable","correctDate":"YYYY-MM-DD or empty","url":"the authoritative page URL or empty"}`,
    }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const candidates = text.match(/\{[\s\S]*?\}/g) || [];
  let obj = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { obj = JSON.parse(candidates[i]); break; } catch { /* try previous */ }
  }
  if (!obj) return { status: 'unverifiable', correctDate: '', url: '' };

  let status = String(obj.status || '').toLowerCase();
  if (!['confirmed', 'wrong', 'unverifiable'].includes(status)) status = 'unverifiable';

  let url = /^https?:\/\//i.test(obj.url) ? String(obj.url).trim() : '';
  if (url && ROUNDUP_URL_RE.test(url)) url = '';   // a roundup "proof" is no proof

  let correctDate = isISODate(obj.correctDate) ? obj.correctDate : '';

  // A confirmed/wrong verdict with no acceptable event-specific source isn't
  // trustworthy — treat it as unverifiable.
  if ((status === 'confirmed' || status === 'wrong') && !url) status = 'unverifiable';
  // "wrong" must carry a real corrected date; otherwise it's just "not confirmed".
  if (status === 'wrong' && !correctDate) status = 'unverifiable';
  if (status !== 'wrong') correctDate = '';

  return { status, correctDate, url };
}

module.exports = { verifyEventDate, ROUNDUP_URL_RE };
