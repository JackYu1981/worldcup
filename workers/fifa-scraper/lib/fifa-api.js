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
      stage_name: pickEnglish(r.StageName),     // "First Stage" / "Round of 32" / "Final" etc.
      group_name: pickEnglish(r.GroupName),     // "Group A" .. "Group L" (null for knockouts)
      stadium_name: pickEnglish(r.Stadium?.Name),  // "Atlanta Stadium" / "Monterrey Stadium" etc.
      stadium_city: pickEnglish(r.Stadium?.CityName) || null,  // populated for some venues
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

/**
 * Fetch FIFA live/football for a mapped fixture.
 * Returns the full liveData object (caller normalizes downstream).
 * Throws on non-OK responses.
 */
export async function fetchLiveFootball(mapping) {
  const { fifa_id_competition: c, fifa_id_season: s, fifa_id_stage: st, fifa_id_match: m } = mapping;
  if (!c || !s || !st || !m) {
    throw new Error(`fetchLiveFootball: incomplete mapping (${JSON.stringify(mapping)})`);
  }
  const url = `https://api.fifa.com/api/v3/live/football/${c}/${s}/${st}/${m}?language=en`;
  const r = await fetch(url, { headers: fifaBrowserHeaders() });
  if (!r.ok) throw new Error(`live/football fetch failed: HTTP ${r.status}`);
  return r.json();
}

/**
 * Fetch fdh-api per-match player stats.
 * Returns the players object { player_id: [[stat_name, value, flag], ...], ... }
 * or null on non-OK (caller decides what to do).
 */
export async function fetchFdhPlayers(fdhMatchId) {
  if (!fdhMatchId) return null;
  const url = `https://fdh-api.fifa.com/v1/stats/match/${fdhMatchId}/players.json`;
  const r = await fetch(url, { headers: fifaBrowserHeaders() });
  if (!r.ok) return null;
  return r.json();
}

/**
 * Fetch one page of a mangodev story (tournament-wide stats leaderboard).
 *
 * Each story holds page_size=50 actors. Per (classification, stat), pagination
 * goes from page=1 until HTTP 404 (typically around page 25-30, since
 * page_count metadata isn't a hard stop — verified by Chunk 4.2 probe).
 *
 * Use limit=1 — mangodev returns HTTP 429 "Pagination limit threshold breached"
 * for limit ≥ ~10.
 *
 * Returns { story, err }.
 *   - story: the story object with .actors[] (50 per page, fewer on last page)
 *   - err: 'HTTP 404' when out of pages, other HTTP errors, or null on success
 *
 * Retries once on HTTP 429 with 3s backoff.
 */
export async function fetchMangoStoryPage(token, seasonId, classification, stat, page) {
  const query = `(and resourceStatus==\`urn:gd:resourceStatus:active\` `
              + `_externalId~\`urn:gd:story:classification:${classification}:competitionId:${seasonId}:${stat}:rank_asc:page:${page}$\`)`;
  const url = `https://gameday-prod.fifa.mangodev.co.uk/1-0/stories`
            + `?query=${encodeURIComponent(query)}`
            + `&skip=0&limit=1`
            + `&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc`;

  const headers = { ...fifaBrowserHeaders(), 'Authorization': `Bearer ${token}` };
  let r = await fetch(url, { headers });
  if (r.status === 429) {
    await new Promise(rr => setTimeout(rr, 3000));
    r = await fetch(url, { headers });
  }
  if (!r.ok) {
    return { story: null, err: `HTTP ${r.status}` };
  }
  const j = await r.json();
  const story = (j.items && j.items[0]) || null;
  return { story, err: null };
}
