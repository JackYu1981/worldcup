// GET /api/fifa/player/{player_id}
// Returns the full players:{player_id} KV record with profile + tournament_stats.
//
// Server-side enrichment (no extra KV writes anywhere):
//   - country_zh   ← joined from the `countries` seed when missing on the record
//   - shirt_number ← scanned from match_lineups:* records if missing (gctp/gcp
//                    classifications don't expose this; lineup data has it)
//   - position     ← same fallback as shirt_number

import { json, error, options } from '../../../lib/response.js';

// Position code → Chinese label (matches index.html POS_LABEL)
const POSITION_LABEL_ZH = { 0: '门将', 1: '后卫', 2: '中场', 3: '前锋' };

export async function onRequestGet(context) {
  const { params, env } = context;
  const playerId = params.player_id;
  if (!playerId) return error('missing player_id', 400);

  try {
    const player = await env.MATCH_DATA.get(`players:${playerId}`, 'json');
    if (!player) {
      return json({
        player_id: playerId,
        found: false,
        note: 'Player not yet ingested — will appear after their first match is finished'
      }, 404);
    }

    // Enrich country_code from team_id if missing (older records may have only team_id).
    // Then enrich country_zh from `countries` seed.
    let countries = null;
    if (!player.country_code && player.team_id) {
      // Scan players_by_country:* to find the country with this team_id
      const list = await env.MATCH_DATA.list({ prefix: 'players_by_country:', limit: 100 });
      for (const k of (list.keys || [])) {
        const roster = await env.MATCH_DATA.get(k.name, 'json');
        if (roster?.team_id === player.team_id) {
          player.country_code = roster.country_code;
          if (roster.country_zh) player.country_zh = roster.country_zh;
          break;
        }
      }
    }
    if (!player.country_zh && player.country_code) {
      countries = await env.MATCH_DATA.get('countries', 'json');
      const item = (countries?.items || []).find(c => c.code === player.country_code);
      if (item?.zh) player.country_zh = item.zh;
    }

    // Enrich shirt_number / position by scanning match_lineups for the most recent
    // appearance. Lineup data carries these per-match; player records often don't
    // (mangodev gctp classifications omit them). Read-only, cheap (≤1 KV read).
    if (player.shirt_number == null || player.position == null) {
      // Best-effort: scan match_lineups for this player. List keys first.
      const list = await env.MATCH_DATA.list({ prefix: 'match_lineups:', limit: 100 });
      for (const k of (list.keys || [])) {
        const lineup = await env.MATCH_DATA.get(k.name, 'json');
        if (!lineup) continue;
        for (const side of ['home', 'away']) {
          const team = lineup[side];
          if (!team) continue;
          const allPlayers = [...(team.starting || []), ...(team.substitutes || [])];
          const hit = allPlayers.find(p => String(p.player_id) === String(playerId));
          if (hit) {
            if (player.shirt_number == null && hit.shirt_number != null) player.shirt_number = hit.shirt_number;
            if (player.position == null && hit.position != null) player.position = hit.position;
            break;
          }
        }
        if (player.shirt_number != null && player.position != null) break;
      }
    }

    // Chinese position label fallback
    if (player.position != null && !player.position_label_zh) {
      player.position_label_zh = POSITION_LABEL_ZH[player.position] || null;
    }

    return json(player, 200, 60);   // cache 60s
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
