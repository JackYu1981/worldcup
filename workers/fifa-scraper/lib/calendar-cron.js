// Calendar cron — fetches FIFA calendar and runs mapping pass.
// Now also invoked inline by main-cron on every 10min tick (hash short-circuit
// keeps the actual write cost ≈1-3/day even with frequent invocations).
//
// 1. Fetch FIFA calendar for a 30-day forward window, write to KV `fifa_calendar`
//    only if content changed (hash short-circuit).
// 2. For every 500.com fixture across recent matches:* keys, try auto-mapping.
//    Skip fixtures already mapped with confidence='exact'.
//    Skip unmatched fixtures whose retry cooldown hasn't elapsed.

import { fetchFifaCalendar } from './fifa-api.js';
import { tryAutoMap } from './mapping.js';
import { logSla } from './sla.js';
import { beijingDateStr } from './time-utils.js';

const COMPETITION_ID = 17;
const CALENDAR_WINDOW_DAYS_FORWARD = 35;
const CALENDAR_WINDOW_DAYS_BACK = 14;
const FIXTURE_SCAN_DAYS_BACK = 14;
const FIXTURE_SCAN_DAYS_FORWARD = 35;

// FNV-1a 32-bit on a canonical projection of the calendar — used to short-circuit
// the KV write when nothing material has changed since last refresh.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function calendarFingerprint(cal) {
  // Project only fields that drive behavior — ignore fetched_at and tag ordering.
  const projected = (cal.matches || [])
    .map(m => [
      m.id_match,
      m.date_utc,
      m.match_status,
      m.home_code,
      m.away_code,
      m.id_stage,
    ].join('|'))
    .sort()
    .join('\n');
  return fnv1a(projected);
}

export async function calendarCron(env) {
  // 1. Fetch + cache FIFA calendar
  const now = Date.now();
  const floorDay = (ms) => {
    const d = new Date(ms);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
      .toISOString().replace(/\.\d{3}Z$/, 'Z');
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

  // Hash short-circuit: only write if the calendar content has changed
  const newHash = calendarFingerprint(fifaCal);
  const existing = await env.MATCH_DATA.get('fifa_calendar', 'json');
  const oldHash = existing?._hash;

  let calendarWritten = false;
  if (oldHash !== newHash) {
    fifaCal._hash = newHash;
    await env.MATCH_DATA.put('fifa_calendar', JSON.stringify(fifaCal));
    calendarWritten = true;
    await logSla(env, {
      level: 'info', event: 'calendar_refreshed',
      matches: fifaCal.matches.length, from: fromIso, to: toIso
    });
  } else {
    // Use existing record for downstream mapping (it's identical content anyway)
    fifaCal = existing;
  }

  // 2. Iterate 500.com fixtures and run mapping where needed
  const fixtures = await load500FixturesAcrossDates(env, FIXTURE_SCAN_DAYS_BACK, FIXTURE_SCAN_DAYS_FORWARD);
  let mappedCount = 0;
  for (const fixture of fixtures) {
    const existingMap = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json');
    if (existingMap?.match_confidence === 'exact' || existingMap?.match_confidence === 'time_skew_5min') continue;
    if (existingMap?.match_confidence === 'unmatched' &&
        existingMap.unmatched_retry_after &&
        Date.now() < Date.parse(existingMap.unmatched_retry_after)) continue;

    const mapped = await tryAutoMap(fixture, env, fifaCal);
    await env.MATCH_DATA.put(`fixture_mapping:${fixture.id}`, JSON.stringify(mapped));
    if (mapped.match_confidence === 'exact' || mapped.match_confidence === 'time_skew_5min') {
      mappedCount++;
    }
  }

  return { fetched: true, calendarWritten, mapped: mappedCount, scanned: fixtures.length };
}

/**
 * Load 500.com fixtures across a date window (matches:YYYY-MM-DD keys).
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
      if (m.league !== '世界杯') continue;
      seen.add(m.id);
      all.push(m);
    }
  }
  return all;
}
