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
// 回溯窗口必须覆盖整届世界杯（6/11 → 7/19，≈38 天）。
// 此前为 14 天，导致小组赛比赛在赛后 14 天滑出扫描窗口、被反向索引静默删除，
// 表现为 lineup「本届战绩」逐场消失（例：6/12 加拿大 vs 波黑在 6/26 之后丢失）。
const FIXTURE_SCAN_DAYS_BACK = 40;
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

  // 3. Build team_fixtures:{country_code} reverse index from mappings + fixtures.
  // This collapses "scan all matches:* + look up fixture_mapping for each + filter
  // by country" (the read path the team-history API used to do) into a single
  // KV get per team. Maintained here on calendar cron — same cadence as mapping
  // changes (new knockout draws etc).
  const teamFixturesIndex = await buildTeamFixturesIndex(env, fixtures, fifaCal);
  const indexWriteCount = await writeTeamFixturesIndex(env, teamFixturesIndex);
  // Always emit a heartbeat so we can observe in SLA logs that the reverse-index
  // code path actually executed each tick — even when 0 writes happen.
  await logSla(env, {
    level: 'info', event: 'team_fixtures_index_pass',
    teams: Object.keys(teamFixturesIndex).length,
    keys_written: indexWriteCount,
  });

  return {
    fetched: true,
    calendarWritten,
    mapped: mappedCount,
    scanned: fixtures.length,
    team_index_keys_written: indexWriteCount,
  };
}

/**
 * Build country_code → [{fixture_id, date_utc, opp_code, is_home}] reverse index.
 *
 * For each 500.com WC fixture we have a mapping with home_code/away_code; we
 * record this fixture under BOTH countries' indexes. Result is keyed by ISO3
 * country code, value is a list sorted oldest→newest.
 *
 * Read path (team-history API) becomes: kv.get(`team_fixtures:${code}`) → list,
 * then for each entry kv.get(`match_lineups:${fixture_id}`) to fetch the score.
 * That's still N+1 reads per query, but N is bounded by ~7 matches/team and
 * eliminates the broad `matches:*` scan + per-fixture mapping lookup.
 *
 * Exported for unit testing — also called once per calendarCron tick.
 */
export async function buildTeamFixturesIndex(env, fixtures, fifaCal) {
  const fifaByMatchId = new Map();
  for (const fm of (fifaCal?.matches || [])) {
    fifaByMatchId.set(fm.id_match, fm);
  }
  const indexByCode = {};
  for (const fix of fixtures) {
    const map = await env.MATCH_DATA.get(`fixture_mapping:${fix.id}`, 'json');
    if (!map || (map.match_confidence !== 'exact' && map.match_confidence !== 'time_skew_5min')) continue;
    const homeCode = map.home_code;
    const awayCode = map.away_code;
    if (!homeCode || !awayCode) continue;
    const fm = fifaByMatchId.get(map.fifa_id_match);
    // Use FIFA's authoritative date_utc for ordering; fall back to mapping kickoff_utc
    const dateUtc = fm?.date_utc || map.kickoff_utc || null;

    const homeEntry = { fixture_id: fix.id, date_utc: dateUtc, opp_code: awayCode, is_home: true };
    const awayEntry = { fixture_id: fix.id, date_utc: dateUtc, opp_code: homeCode, is_home: false };
    (indexByCode[homeCode] = indexByCode[homeCode] || []).push(homeEntry);
    (indexByCode[awayCode] = indexByCode[awayCode] || []).push(awayEntry);
  }
  // Sort each list chronologically
  for (const code of Object.keys(indexByCode)) {
    indexByCode[code].sort((a, b) => (a.date_utc || '').localeCompare(b.date_utc || ''));
  }
  return indexByCode;
}

/**
 * Write team_fixtures:{code} keys when their content changed. FNV hash compare
 * per country — typically only a few teams change between cron runs (a new
 * knockout fixture being added flips 2 keys, calendar churn at most).
 * Returns the number of keys actually written.
 *
 * Exported for unit testing.
 */
export async function writeTeamFixturesIndex(env, indexByCode) {
  let writes = 0;
  for (const [code, entries] of Object.entries(indexByCode)) {
    const next = { country_code: code, fixtures: entries };
    // Hash on a normalized projection so reordering or non-content drift doesn't
    // trigger writes. We hash the same fields we sort by.
    const sig = entries.map(e => `${e.fixture_id}|${e.date_utc}|${e.opp_code}|${e.is_home}`).join('\n');
    const newHash = fnv1a(sig);
    const existing = await env.MATCH_DATA.get(`team_fixtures:${code}`, 'json');
    if (existing?._hash === newHash) continue;
    next._hash = newHash;
    await env.MATCH_DATA.put(`team_fixtures:${code}`, JSON.stringify(next));
    writes++;
  }
  return writes;
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
