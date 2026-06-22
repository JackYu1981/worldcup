// GET /api/fifa/player/{player_id}
// Returns the full players:{player_id} KV record with profile + tournament_stats.

import { json, error, options } from '../../../lib/response.js';

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
    return json(player, 200, 60);   // cache 60s — player stats refresh per match
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
