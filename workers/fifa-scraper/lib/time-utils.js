// Time utilities — all parsing and formatting work in epoch ms internally.
// Inputs from 500.com are Beijing wall clock (no tz marker); FIFA inputs are UTC ISO with Z.

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Parse a 500.com fixture's kickoff as Beijing wall clock.
 * Supports both forms emitted by 500 adapter:
 *   - kickoff = "YYYY-MM-DD HH:MM"  (full datetime — current adapter output)
 *   - kickoff = "HH:MM" with date = "YYYY-MM-DD"  (legacy)
 * Returns a Date whose .toISOString() yields the equivalent UTC moment.
 */
export function parseKickoffBeijing(fixture) {
  if (!fixture?.kickoff) {
    throw new Error(`parseKickoffBeijing: missing date or kickoff in ${JSON.stringify(fixture)}`);
  }
  const ko = fixture.kickoff.trim();
  let Y, M, D, h, m;
  const fullMatch = ko.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (fullMatch) {
    [, Y, M, D, h, m] = fullMatch;
  } else {
    // Legacy: kickoff="HH:MM" + date="YYYY-MM-DD"
    if (!fixture.date) {
      throw new Error(`parseKickoffBeijing: missing date or kickoff in ${JSON.stringify(fixture)}`);
    }
    const ymd = fixture.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const hm = ko.match(/^(\d{2}):(\d{2})$/);
    if (!ymd || !hm) {
      throw new Error(`parseKickoffBeijing: missing date or kickoff in ${JSON.stringify(fixture)}`);
    }
    [, Y, M, D] = ymd;
    [, h, m] = hm;
  }
  const utcMs = Date.UTC(+Y, +M - 1, +D, +h, +m, 0) - BEIJING_OFFSET_MS;
  return new Date(utcMs);
}

/** Alias kept for readability: parseKickoffBeijing returns a Date in UTC anyway. */
export const parseKickoffUtc = parseKickoffBeijing;

/** Given epoch ms, return YYYY-MM-DD in Beijing TZ. */
export function beijingDateStr(epochMs) {
  const d = new Date(epochMs + BEIJING_OFFSET_MS);
  // d.getUTCFullYear/Month/Date now reflect Beijing wall clock
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Given epoch ms, return 0-23 hour in Beijing TZ. */
export function beijingHour(epochMs) {
  return new Date(epochMs + BEIJING_OFFSET_MS).getUTCHours();
}

/**
 * Match duration (incl. half-time / extra-time cushion) for a given 500 fixture.
 * Group-stage default 105min; knockout (round-of-16 → final) 165min.
 * Stage info is looked up via fixture_mapping → fifa_calendar.
 *
 * Regex anchored to start of stage_name so "Final round of group A" does NOT
 * match the knockout pattern (a group-stage label that contains the substring
 * "final"). Real FIFA values: "Group Stage", "Round of 32", "Round of 16",
 * "Quarter-final", "Semi-final", "Final".
 */
export async function matchDurationMs(env, fixture) {
  const DEFAULT = 105 * 60 * 1000;
  const mapping = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json');
  if (!mapping?.fifa_id_match) return DEFAULT;
  const cal = await env.MATCH_DATA.get('fifa_calendar', 'json');
  const fm = cal?.matches?.find(x => x.id_match === mapping.fifa_id_match);
  const stage = (fm?.stage_name || '').trim();
  return /^(round of|quarter[- ]?final|semi[- ]?final|final$|knockout)/i.test(stage)
    ? 165 * 60 * 1000
    : DEFAULT;
}
