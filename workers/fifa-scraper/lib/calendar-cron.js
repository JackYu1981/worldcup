// Calendar cron — runs every 6h.
// 1. Fetch FIFA calendar for a 30-day forward window, write to KV `fifa_calendar`.
// 2. For every 500.com fixture across recent matches:* keys, try auto-mapping.
//    Skip fixtures already mapped with confidence='exact'.
//    Skip unmatched fixtures whose retry cooldown hasn't elapsed.

import { fetchFifaCalendar } from './fifa-api.js';
import { tryAutoMap } from './mapping.js';
import { logSla } from './sla.js';
import { beijingDateStr } from './time-utils.js';

const COMPETITION_ID = 17;
const CALENDAR_WINDOW_DAYS_FORWARD = 35;   // covers ~1 month of upcoming WC fixtures
const CALENDAR_WINDOW_DAYS_BACK = 14;      // include finished group-stage matches for back-mapping
const FIXTURE_SCAN_DAYS_BACK = 14;         // match calendar back-window to give old mappings a chance
const FIXTURE_SCAN_DAYS_FORWARD = 35;

export async function calendarCron(env) {
  // 1. Fetch + cache FIFA calendar
  const now = Date.now();
  // FIFA endpoint quirks (verified by Chunk 2.5 live debugging):
  //   - Rejects ISO with millis (returns "Invalid parameter").
  //   - Rejects URL-encoded colons (%3A).
  //   - Returns body=null (HTTP 200) if `from`/`to` are not at midnight UTC.
  // So we floor to midnight UTC for the date window.
  const floorDay = (ms) => {
    const d = new Date(ms);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  const fromIso = floorDay(now - CALENDAR_WINDOW_DAYS_BACK * 86400_000);
  const toIso = floorDay(now + CALENDAR_WINDOW_DAYS_FORWARD * 86400_000);
  let fifaCal;
  try {
    fifaCal = await fetchFifaCalendar(COMPETITION_ID, fromIso, toIso);
  } catch (e) {
    await logSla(env, { level: 'error', event: 'calendar_fetch_failed', error: e.message });
    return { fetched: false, mapped: 0 };
  }
  await env.MATCH_DATA.put('fifa_calendar', JSON.stringify(fifaCal));
  await logSla(env, {
    level: 'info', event: 'calendar_fetched',
    matches: fifaCal.matches.length, from: fromIso, to: toIso
  });

  // 2. Iterate 500.com fixtures and run mapping where needed
  const fixtures = await load500FixturesAcrossDates(env, FIXTURE_SCAN_DAYS_BACK, FIXTURE_SCAN_DAYS_FORWARD);
  let mappedCount = 0;
  for (const fixture of fixtures) {
    const existing = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json');
    if (existing?.match_confidence === 'exact' || existing?.match_confidence === 'time_skew_5min') continue;
    if (existing?.match_confidence === 'unmatched' &&
        existing.unmatched_retry_after &&
        Date.now() < Date.parse(existing.unmatched_retry_after)) continue;

    const mapped = await tryAutoMap(fixture, env, fifaCal);
    await env.MATCH_DATA.put(`fixture_mapping:${fixture.id}`, JSON.stringify(mapped));
    if (mapped.match_confidence === 'exact' || mapped.match_confidence === 'time_skew_5min') {
      mappedCount++;
    }
  }

  await logSla(env, {
    level: 'info', event: 'mapping_pass_complete',
    scanned: fixtures.length, newly_mapped: mappedCount
  });
  return { fetched: true, mapped: mappedCount, scanned: fixtures.length };
}

/**
 * Load 500.com fixtures across a date window (matches:YYYY-MM-DD keys).
 * Reads `matches:{date}` for each date in [today-back, today+forward].
 * Skips fixtures whose league is not '世界杯' — 500 packs Finnish league /
 * friendly matches into the same envelope, which would pollute SLA logs.
 */
async function load500FixturesAcrossDates(env, daysBack, daysForward) {
  const now = Date.now();
  const all = [];
  const seen = new Set();
  for (let d = -daysBack; d <= daysForward; d++) {
    const dateStr = beijingDateStr(now + d * 86400_000);
    const envelope = await env.MATCH_DATA.get(`matches:${dateStr}`, 'json');
    if (!envelope?.matches) continue;
    for (const m of envelope.matches) {
      if (!m.id || seen.has(m.id)) continue;
      if (m.league !== '世界杯') continue;   // skip non-WC fixtures (Finnish league, friendlies, etc.)
      seen.add(m.id);
      all.push(m);
    }
  }
  return all;
}
