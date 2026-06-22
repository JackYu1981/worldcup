// Auto-mapping: 500.com fixture → FIFA match by (home_code, away_code, kickoff_utc).
//
// Strategy:
//   1. Look up country codes via `countries` KV (zh → 3-letter code).
//   2. Look up FIFA calendar (pre-loaded from KV or passed in as fifaCal arg).
//   3. Find candidate FIFA matches where home/away codes both match AND
//      kickoff is within 30min of 500.com's stated kickoff.
//   4. Return one of:
//      - { match_confidence: 'exact' }       — single candidate, time skew < 60s
//      - { match_confidence: 'time_skew_5min' } — single candidate, time skew 60s-30min
//      - { match_confidence: 'unmatched', unmatched_retry_after } — 0 or >1 candidates
//
// Unmatched results are persisted with `unmatched_retry_after = now + 1h` so the
// next cron tick skips them until the retry window elapses (avoids hot loops on
// fixtures that will never map, e.g. friendlies tagged competition=17 in error).

import { parseKickoffUtc } from './time-utils.js';
import { logSla } from './sla.js';

const TIME_WINDOW_MS = 30 * 60 * 1000;   // ±30min for candidate match
const EXACT_THRESHOLD_MS = 60 * 1000;    // <60s → exact, else time_skew_5min
const UNMATCHED_RETRY_MS = 60 * 60 * 1000;   // 1h retry cooldown

/**
 * Attempt to auto-map a 500.com fixture to a FIFA match.
 * Returns the mapping object (always — even unmatched cases get persisted).
 *
 * @param {Object} fixture500  - 500.com match: { id, home, away, date, kickoff }
 * @param {Object} env         - Cloudflare Worker env (must have MATCH_DATA)
 * @param {Object} [fifaCal]   - optional: pre-loaded fifa_calendar (skips KV read)
 */
export async function tryAutoMap(fixture500, env, fifaCal = null) {
  const retryAfter = new Date(Date.now() + UNMATCHED_RETRY_MS).toISOString().replace(/Z$/, '+00:00');
  const matchedAt = new Date().toISOString().replace(/Z$/, '+00:00');

  // 1. Resolve country codes
  const countries = await env.MATCH_DATA.get('countries', 'json');
  if (!countries?.items) {
    await logSla(env, { level: 'warn', event: 'countries_kv_missing', fixture: fixture500.id });
    return unmatched('countries KV missing', matchedAt, retryAfter);
  }
  const zhToCode = Object.fromEntries(countries.items.map(c => [c.zh, c.code]));
  const homeCode = zhToCode[fixture500.home];
  const awayCode = zhToCode[fixture500.away];
  if (!homeCode || !awayCode) {
    await logSla(env, {
      level: 'warn', event: 'country_mapping_missing',
      fixture: fixture500.id, home: fixture500.home, away: fixture500.away
    });
    return unmatched('country code lookup failed', matchedAt, retryAfter);
  }

  // 2. Resolve fifa_calendar
  const cal = fifaCal || await env.MATCH_DATA.get('fifa_calendar', 'json');
  if (!cal?.matches) {
    await logSla(env, { level: 'warn', event: 'fifa_calendar_missing', fixture: fixture500.id });
    return unmatched('fifa_calendar missing', matchedAt, retryAfter);
  }

  // 3. Find candidates
  const kickoffUtcMs = parseKickoffUtc(fixture500).getTime();
  const candidates = cal.matches.filter(fm =>
    fm.home_code === homeCode &&
    fm.away_code === awayCode &&
    Math.abs(new Date(fm.date_utc).getTime() - kickoffUtcMs) < TIME_WINDOW_MS
  );

  if (candidates.length === 0) {
    await logSla(env, {
      level: 'warn', event: 'no_fifa_match',
      fixture: fixture500.id, home: homeCode, away: awayCode,
      kickoff_utc: new Date(kickoffUtcMs).toISOString().replace(/Z$/, '+00:00')
    });
    return unmatched('no fifa candidate', matchedAt, retryAfter);
  }
  if (candidates.length > 1) {
    await logSla(env, {
      level: 'error', event: 'multi_candidates',
      fixture: fixture500.id, count: candidates.length,
      candidates: candidates.map(c => c.id_match)
    });
    return unmatched(`multi candidates (${candidates.length})`, matchedAt, retryAfter);
  }

  const fm = candidates[0];
  const skewMs = Math.abs(new Date(fm.date_utc).getTime() - kickoffUtcMs);
  // kickoff_local_beijing: prefer formatted "YYYY-MM-DD HH:MM" if both fields exist;
  // otherwise just use kickoff (which may already be full datetime in current 500 schema)
  const localBeijing = (fixture500.date && /^\d{2}:\d{2}$/.test(fixture500.kickoff))
    ? `${fixture500.date} ${fixture500.kickoff}`
    : fixture500.kickoff;
  return {
    fifa_id_match: fm.id_match,
    fifa_id_season: fm.id_season,
    fifa_id_stage: fm.id_stage,
    fifa_id_competition: fm.id_competition,
    fdh_match_id: fm.fdh_match_id || null,
    home_code: homeCode,
    away_code: awayCode,
    kickoff_utc: new Date(kickoffUtcMs).toISOString().replace(/Z$/, '+00:00'),
    kickoff_local_beijing: localBeijing,
    matched_at: matchedAt,
    match_confidence: skewMs < EXACT_THRESHOLD_MS ? 'exact' : 'time_skew_5min',
    match_note: skewMs >= EXACT_THRESHOLD_MS ? `time skew ${Math.round(skewMs / 1000)}s` : null,
    unmatched_retry_after: null
  };
}

function unmatched(note, matchedAt, retryAfter) {
  return {
    fifa_id_match: null,
    fifa_id_season: null,
    fifa_id_stage: null,
    fifa_id_competition: null,
    fdh_match_id: null,
    home_code: null,
    away_code: null,
    kickoff_utc: null,
    kickoff_local_beijing: null,
    matched_at: matchedAt,
    match_confidence: 'unmatched',
    match_note: note,
    unmatched_retry_after: retryAfter
  };
}
