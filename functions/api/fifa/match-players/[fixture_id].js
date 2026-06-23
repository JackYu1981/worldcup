// GET /api/fifa/match-players/{fixture_id}
// Returns all ~52 players from both sides of the match (starting + substitutes)
// with their full players:{id} records, ready for the stats-compare table.
//
// Response shape:
//   {
//     fixture_id, fifa_id_match,
//     home: { country_code, country_zh, team_name_en },
//     away: { country_code, country_zh, team_name_en },
//     players: [{ ...player_record, side: 'home'|'away', lineup_role: 'starter'|'substitute', shirt_number, position, country_zh, position_label_zh }]
//   }
//
// Server-side enrichment (zero KV writes):
//   - country_code  ← falls back to the match's side country if missing on the player record
//   - country_zh    ← joined from the `countries` seed
//   - position_label_zh ← derived from position code (0=GK, 1=DF, 2=MF, 3=FW)
// This mirrors /api/fifa/player/[id].js to keep frontend consistent.

import { json, error, options } from '../../../lib/response.js';

const POSITION_LABEL_ZH = { 0: '门将', 1: '后卫', 2: '中场', 3: '前锋' };

export async function onRequestGet(context) {
  const { params, env } = context;
  const fixtureId = params.fixture_id;
  if (!fixtureId) return error('missing fixture_id', 400);

  try {
    const lineup = await env.MATCH_DATA.get(`match_lineups:${fixtureId}`, 'json');
    if (!lineup) return error('lineup not available for this fixture', 404);

    // Collect player ids with side+role context
    const lineupEntries = [];
    for (const p of lineup.home?.starting || []) lineupEntries.push({ ...p, side: 'home', lineup_role: 'starter' });
    for (const p of lineup.home?.substitutes || []) lineupEntries.push({ ...p, side: 'home', lineup_role: 'substitute' });
    for (const p of lineup.away?.starting || []) lineupEntries.push({ ...p, side: 'away', lineup_role: 'starter' });
    for (const p of lineup.away?.substitutes || []) lineupEntries.push({ ...p, side: 'away', lineup_role: 'substitute' });

    // Build countries lookup once (used for both team headers and player enrichment)
    const countries = await env.MATCH_DATA.get('countries', 'json');
    const codeToZh = countries?.items
      ? Object.fromEntries(countries.items.map(c => [c.code, c.zh]))
      : {};

    // Each lineup entry knows its side, so we can fill country_code from match data
    const sideCountry = {
      home: lineup.home?.country_code,
      away: lineup.away?.country_code,
    };

    // Parallel KV fetches — CF KV reads are cheap
    const playerRecords = await Promise.all(
      lineupEntries.map(async (lineupP) => {
        const record = await env.MATCH_DATA.get(`players:${lineupP.player_id}`, 'json');
        // country_code: prefer record's, fall back to match side's country
        const countryCode = record?.country_code || sideCountry[lineupP.side] || null;
        // position: lineup data wins (it always has shirt+position; player record often doesn't)
        const position = lineupP.position != null ? lineupP.position : record?.position;
        return {
          // Lineup-derived (always present)
          player_id: lineupP.player_id,
          side: lineupP.side,
          lineup_role: lineupP.lineup_role,
          shirt_number: lineupP.shirt_number,
          position,
          captain: lineupP.captain,
          // Tournament-derived (may be missing if mango cron hasn't refreshed)
          ...(record || {}),
          // Re-apply lineup fields above the spread record so lineup wins on conflict
          player_id: lineupP.player_id,
          side: lineupP.side,
          lineup_role: lineupP.lineup_role,
          shirt_number: lineupP.shirt_number,
          position,
          captain: lineupP.captain,
          country_code: countryCode,
          country_zh: codeToZh[countryCode] || record?.country_zh || null,
          position_label_zh: position != null ? (POSITION_LABEL_ZH[position] || null) : null,
          // lineup's display name as a fallback
          name_default: record?.name_default || lineupP.name || `Player ${lineupP.player_id}`,
          photo_url: record?.photo_url || lineupP.photo_url || null
        };
      })
    );

    return json({
      fixture_id: fixtureId,
      fifa_id_match: lineup.fifa_id_match,
      home: {
        country_code: lineup.home.country_code,
        country_zh: codeToZh[lineup.home.country_code] || lineup.home.country_code,
        team_name_en: lineup.home.team_name_en
      },
      away: {
        country_code: lineup.away.country_code,
        country_zh: codeToZh[lineup.away.country_code] || lineup.away.country_code,
        team_name_en: lineup.away.team_name_en
      },
      players: playerRecords
    }, 200, 60);   // cache 60s
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
