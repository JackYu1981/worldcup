// GET /api/fifa/match-stats/{fixture_id}
// Returns the match_stats:{500_id} record, enriched with:
//   - player names (from match_lineups, since match_stats only stores IDs)
//   - role context: starter | substitute (with "replaced X" hint)
//   - country side (home/away) so frontend can group/color
//   - flag-grade FOR each side
//
// Response shape:
//   {
//     fixture_id, fifa_id_match, fdh_match_id, fetched_at, match_status,
//     home: { country_code, country_zh },
//     away: { country_code, country_zh },
//     players: [
//       { player_id, name, side, role:'starter'|'substitute',
//         shirt_number, position,
//         replaced_player_id, replaced_player_name,        ← for subs who came on
//         replaces_player_id, replaces_player_name,        ← for starters who came off
//         shots, shots_on_target, fouls_committed, yellow_cards }
//     ]
//   }

import { json, error, options } from '../../../lib/response.js';

export async function onRequestGet(context) {
  const { params, env } = context;
  const fixtureId = params.fixture_id;
  if (!fixtureId) return error('missing fixture_id', 400);

  try {
    const stats = await env.MATCH_DATA.get(`match_stats:${fixtureId}`, 'json');
    if (!stats) {
      return json({
        fixture_id: fixtureId,
        available: false,
        note: 'Live stats not yet collected for this match',
      });
    }

    // Enrichment depends on lineup (player names + roles + sub relations)
    const lineup = await env.MATCH_DATA.get(`match_lineups:${fixtureId}`, 'json');
    if (!lineup) {
      // Bare-bones response — frontend can still show stat numbers without names
      return json({
        fixture_id: fixtureId,
        available: true,
        ...stats,
      }, 200, 30);
    }

    // Country headers
    const countries = await env.MATCH_DATA.get('countries', 'json');
    const codeToZh = countries?.items
      ? Object.fromEntries(countries.items.map(c => [c.code, c.zh]))
      : {};

    // Build player lookup: pid → {name, side, role, shirt, position}
    const playerInfo = {};
    for (const side of ['home', 'away']) {
      const team = lineup[side] || {};
      for (const p of (team.starting || [])) {
        playerInfo[p.player_id] = { ...p, side, role: 'starter' };
      }
      for (const p of (team.substitutes || [])) {
        playerInfo[p.player_id] = { ...p, side, role: 'substitute' };
      }
    }

    // Build substitution relations: off_player_id ↔ on_player_id
    // For a sub who came on: replaced_player_* is the starter they replaced
    // For a starter who came off: replaces_player_* is who came on for them
    const replacedBy = {};   // off_pid → on_player {id,name}
    const replaces   = {};   // on_pid  → off_player {id,name}
    for (const s of (lineup.events?.substitutions || [])) {
      const off = playerInfo[s.off_player_id];
      const on  = playerInfo[s.on_player_id];
      if (off && on) {
        replacedBy[s.off_player_id] = { id: s.on_player_id,  name: on.name,  minute: s.minute };
        replaces[s.on_player_id]    = { id: s.off_player_id, name: off.name, minute: s.minute };
      }
    }

    // Compose enriched player list (only those with stats — fdh skips no-shows)
    const enriched = [];
    for (const [pid, st] of Object.entries(stats.players || {})) {
      const info = playerInfo[pid];
      if (!info) continue;        // unknown player — fdh ID not in our lineup, skip
      const repl = replacedBy[pid];
      const repls = replaces[pid];
      enriched.push({
        player_id: pid,
        name: info.name,
        side: info.side,
        role: info.role,
        shirt_number: info.shirt_number,
        position: info.position,
        captain: info.captain,
        // sub context: only one of these is non-null
        replaced_player_id:   repl?.id   || null,
        replaced_player_name: repl?.name || null,
        replaced_at_minute:   repl?.minute || null,
        replaces_player_id:   repls?.id   || null,
        replaces_player_name: repls?.name || null,
        replaces_at_minute:   repls?.minute || null,
        // stat fields
        shots:           st.shots ?? 0,
        shots_on_target: st.shots_on_target ?? 0,
        fouls_committed: st.fouls_committed ?? 0,
        yellow_cards:    st.yellow_cards ?? 0,
        red_cards:       st.red_cards ?? 0,
      });
    }

    return json({
      fixture_id: fixtureId,
      fifa_id_match: stats.fifa_id_match,
      fdh_match_id: stats.fdh_match_id,
      fetched_at: stats.fetched_at,
      match_status: stats.match_status,
      available: true,
      home: {
        country_code: lineup.home.country_code,
        country_zh: codeToZh[lineup.home.country_code] || lineup.home.country_code,
      },
      away: {
        country_code: lineup.away.country_code,
        country_zh: codeToZh[lineup.away.country_code] || lineup.away.country_code,
      },
      players: enriched,
    }, 200, 30);
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
