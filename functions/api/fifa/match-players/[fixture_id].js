// GET /api/fifa/match-players/{fixture_id}
// Returns all ~52 players from both sides of the match (starting + substitutes)
// with their full players:{id} records, ready for the stats-compare table.
//
// Response shape:
//   {
//     fixture_id, fifa_id_match,
//     home: { country_code, country_zh, team_name_en },
//     away: { country_code, country_zh, team_name_en },
//     players: [{ ...player_record, side: 'home'|'away', lineup_role: 'starter'|'substitute', shirt_number, position }]
//   }

import { json, error, options } from '../../../lib/response.js';

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

    // Parallel KV fetches — CF KV reads are cheap
    const playerRecords = await Promise.all(
      lineupEntries.map(async (lineupP) => {
        const record = await env.MATCH_DATA.get(`players:${lineupP.player_id}`, 'json');
        return {
          // Lineup-derived (always present)
          player_id: lineupP.player_id,
          side: lineupP.side,
          lineup_role: lineupP.lineup_role,
          shirt_number: lineupP.shirt_number,
          position: lineupP.position,
          captain: lineupP.captain,
          // Tournament-derived (may be missing if mango cron hasn't refreshed)
          ...(record || {}),
          // Re-apply lineup fields above the spread record so lineup wins on conflict
          player_id: lineupP.player_id,
          side: lineupP.side,
          lineup_role: lineupP.lineup_role,
          shirt_number: lineupP.shirt_number,
          position: lineupP.position,
          captain: lineupP.captain,
          // lineup's display name as a fallback
          name_default: record?.name_default || lineupP.name || `Player ${lineupP.player_id}`,
          photo_url: record?.photo_url || lineupP.photo_url || null
        };
      })
    );

    // Augment country_zh from countries seed
    const countries = await env.MATCH_DATA.get('countries', 'json');
    const codeToZh = countries?.items
      ? Object.fromEntries(countries.items.map(c => [c.code, c.zh]))
      : {};

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
    }, 200, 30);
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
