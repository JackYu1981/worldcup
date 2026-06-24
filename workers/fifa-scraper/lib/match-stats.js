// Match Stats — in-match fdh-api data (shots, fouls, cards).
//
// Stored separately from player_records (tournament_stats). Live in-match data
// is volatile and ephemeral; mixing it into players:{id} would pollute the
// canonical per-tournament profile. So we keep it in match_stats:{500_id}.
//
// Schema:
//   match_stats:{500_id} = {
//     fifa_id_match: "400021511",
//     fdh_match_id:  "151675",
//     fetched_at:    "2026-06-24T01:30:00+00:00",
//     match_status:  0,        // mirrors lineup.match_status at fetch time
//     _hash:         "abc123", // FNV-1a of players payload
//     players: {
//       "{player_id}": {
//         shots: 1,
//         shots_on_target: 1,
//         fouls_committed: 2,
//         yellow_cards: 0
//       }
//     }
//   }
//
// Hash short-circuit: write only when player stats actually changed.

import { fetchFdhPlayers } from './fifa-api.js';

// fdh-api → our schema
const FIELD_MAP = {
  AttemptAtGoal:         'shots',
  AttemptAtGoalOnTarget: 'shots_on_target',
  FoulsFor:              'fouls_committed',  // FIFA naming: "FoulsFor" = fouls THIS player commits
  YellowCards:           'yellow_cards',
};

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function canonJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonJson(v[k])).join(',') + '}';
}

/**
 * Normalize fdh-api players.json response into our compact schema.
 * Drops players with all-zero stats (most subs who haven't come on yet).
 */
export function normalizeMatchStats(fdhData) {
  if (!fdhData || typeof fdhData !== 'object') return {};
  const out = {};
  for (const [pid, raw] of Object.entries(fdhData)) {
    if (pid === '-1') continue;                  // sentinel team-aggregate row
    if (!Array.isArray(raw)) continue;
    const stats = {};
    let hasAny = false;
    for (const tuple of raw) {
      if (!Array.isArray(tuple) || tuple.length < 2) continue;
      const [k, v] = tuple;
      const mapped = FIELD_MAP[k];
      if (!mapped) continue;
      const num = Number(v) || 0;
      stats[mapped] = num;
      if (num > 0) hasAny = true;
    }
    if (hasAny) out[pid] = stats;
  }
  return out;
}

/**
 * Fetch live stats for one match and write to KV if changed.
 * Returns { written, players, fetched } booleans for SLA logging.
 *
 * Caller MUST pass mapping with fdh_match_id, fifa_id_match, and the matching
 * lineup's match_status (so we record state alongside stats).
 */
export async function refreshMatchStats(env, fixture500Id, mapping, currentMatchStatus) {
  const fdhId = mapping.fdh_match_id;
  if (!fdhId) return { written: false, fetched: false, reason: 'no_fdh_id' };

  const fdhData = await fetchFdhPlayers(fdhId);
  if (!fdhData) return { written: false, fetched: true, reason: 'fdh_empty' };

  const playerStats = normalizeMatchStats(fdhData);
  if (Object.keys(playerStats).length === 0) {
    return { written: false, fetched: true, reason: 'no_active_players' };
  }

  const newHash = fnv1a(canonJson(playerStats));
  const key = `match_stats:${fixture500Id}`;
  const existing = await env.MATCH_DATA.get(key, 'json');
  if (existing?._hash === newHash) {
    return { written: false, fetched: true, reason: 'unchanged', players: Object.keys(playerStats).length };
  }

  const record = {
    fifa_id_match: mapping.fifa_id_match,
    fdh_match_id: fdhId,
    fetched_at: new Date().toISOString().replace(/Z$/, '+00:00'),
    match_status: currentMatchStatus,
    _hash: newHash,
    players: playerStats,
  };
  await env.MATCH_DATA.put(key, JSON.stringify(record));
  return { written: true, fetched: true, players: Object.keys(playerStats).length };
}
