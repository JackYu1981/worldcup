// FIFA API fetchers — all calls use browser-mimic headers to avoid WAF blocks.
// Each fetcher throws on non-OK responses; callers decide how to degrade.

import { fifaBrowserHeaders } from './token.js';

/**
 * Fetch FIFA calendar/matches for a competition over a UTC date window.
 * @param {string|number} competitionId  - e.g. 17 for World Cup
 * @param {string} fromIso               - UTC ISO start (e.g. '2026-06-15T00:00:00Z')
 * @param {string} toIso                 - UTC ISO end
 * @returns normalized {fetched_at, from_utc, to_utc, competition_id, matches:[...]}
 */
export async function fetchFifaCalendar(competitionId, fromIso, toIso) {
  // NOTE: do NOT encodeURIComponent the timestamps. FIFA endpoint rejects
  // URL-encoded colons (%3A); it expects raw `2026-06-15T00:00:00Z` form.
  // Verified by Chunk 2.5 live debugging: encoded URLs return non-JSON 400-ish
  // error pages, leading to "Unexpected token I" JSON parse failure downstream.
  const url = `https://api.fifa.com/api/v3/calendar/matches`
    + `?idCompetition=${encodeURIComponent(competitionId)}`
    + `&from=${fromIso}`
    + `&to=${toIso}`
    + `&language=en&count=500`;
  const r = await fetch(url, { headers: fifaBrowserHeaders() });
  if (!r.ok) throw new Error(`FIFA calendar fetch failed: HTTP ${r.status}`);
  const raw = await r.json();
  return normalizeCalendarResponse(raw, competitionId, fromIso, toIso);
}

/**
 * Pure function: normalize FIFA calendar response into our internal shape.
 * Exposed for unit testing without network.
 *
 * KEY DISCOVERY 2026-06-22 (post-Chunk-1 verification):
 *   `Properties.IdIFES` (6-digit number, e.g. "151637") IS the fdh-api match_id.
 *   This avoids the spec-v4 reverseLookupFdhMatchId path entirely — calendar gives
 *   us the fdh_match_id directly, alongside the 9-digit IdMatch and the 4 hash IDs
 *   exposed elsewhere (live/football has a different 25-char `IdStatsPerform`).
 */
export function normalizeCalendarResponse(raw, competitionId, fromIso, toIso) {
  const matches = [];
  for (const r of raw.Results || []) {
    const homeCode = r.Home?.IdCountry;
    const awayCode = r.Away?.IdCountry;
    if (!homeCode || !awayCode) continue;   // skip placeholders (TBD knockouts)
    matches.push({
      id_match: r.IdMatch,                    // 9-digit public id (e.g. 400021474)
      id_competition: r.IdCompetition,        // 6-digit (e.g. "17")
      id_season: r.IdSeason,                  // 6-digit (e.g. "285023")
      id_stage: r.IdStage,                    // 6-digit (e.g. "289273")
      id_group: r.IdGroup || null,
      fdh_match_id: r.Properties?.IdIFES || null,   // 6-digit fdh-api id
      date_utc: r.Date,
      home_code: homeCode,
      away_code: awayCode,
      home_name_en: pickEnglish(r.Home?.TeamName),
      away_name_en: pickEnglish(r.Away?.TeamName),
      match_status: r.MatchStatus ?? null,
      stage_name: pickEnglish(r.StageName)
    });
  }
  return {
    fetched_at: new Date().toISOString().replace(/Z$/, '+00:00'),
    from_utc: fromIso,
    to_utc: toIso,
    competition_id: competitionId,
    matches
  };
}

function pickEnglish(localized) {
  if (!Array.isArray(localized) || localized.length === 0) return null;
  const en = localized.find(x => /^en/i.test(x.Locale || ''));
  return (en || localized[0]).Description || null;
}
