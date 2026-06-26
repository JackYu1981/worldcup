// GET /api/fifa/player/{player_id}?fixture_id=fXXXX (optional)
// Returns the full players:{player_id} KV record with profile + tournament_stats.
// When fixture_id is provided, also returns this player's PER-MATCH stats
// (`match_stats` field on the response), allowing the UI to show
//   "累计 N (本场 M)" comparisons.
//
// Server-side enrichment (no extra KV writes anywhere):
//   - country_zh   ← joined from the `countries` seed when missing on the record
//   - shirt_number ← scanned from match_lineups:* records if missing (gctp/gcp
//                    classifications don't expose this; lineup data has it)
//   - position     ← same fallback as shirt_number
//   - match_stats  ← {goals, assists, shots, shots_on_target, fouls_committed,
//                     yellow_cards, red_cards} for the given fixture, when fixture_id
//                     is passed. Two sources joined:
//                       a) match_stats:{fixture}.players[pid]  — fdh-api in-match data
//                       b) match_lineups:{fixture}.events     — goals/bookings counted

import { json, error, options } from '../../../lib/response.js';

// Position code → Chinese label (matches index.html POS_LABEL)
const POSITION_LABEL_ZH = { 0: '门将', 1: '后卫', 2: '中场', 3: '前锋' };

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const playerId = params.player_id;
  if (!playerId) return error('missing player_id', 400);

  const url = new URL(request.url);
  const fixtureId = url.searchParams.get('fixture_id') || null;

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

    // Per-match stats enrichment (when fixture_id provided)
    if (fixtureId) {
      // Pull both sources in parallel
      const [matchStats, lineup] = await Promise.all([
        env.MATCH_DATA.get(`match_stats:${fixtureId}`, 'json'),
        env.MATCH_DATA.get(`match_lineups:${fixtureId}`, 'json'),
      ]);

      const ms = {};
      // From match_stats: shots/shots_on_target/fouls_committed/yellow_cards/red_cards
      const inMatch = (matchStats?.players || {})[playerId];
      if (inMatch) {
        ms.shots = inMatch.shots ?? 0;
        ms.shots_on_target = inMatch.shots_on_target ?? 0;
        ms.fouls_committed = inMatch.fouls_committed ?? 0;
        ms.yellow_cards = inMatch.yellow_cards ?? 0;
        ms.red_cards = inMatch.red_cards ?? 0;
      }
      // From match_lineups.events: goals + assists (count occurrences for this pid)
      // Goals: each event with player_id = pid (own goals tagged is_own_goal=true
      //        in lineup.js based on FIFA Type=3, verified 2026-06-26 probe)
      // Assists: lineups events.goals[i].assist_player_id matches pid
      const events = lineup?.events || {};
      const goalEvents = events.goals || [];
      let goals = 0, assists = 0, ownGoals = 0;
      for (const g of goalEvents) {
        if (String(g.player_id) === String(playerId)) {
          if (g.is_own_goal) {
            // Own goal: don't credit as scoring stat; track separately.
            ownGoals++;
          } else {
            goals++;
          }
        }
        if (String(g.assist_player_id) === String(playerId)) {
          assists++;
        }
      }
      if (goals > 0 || assists > 0 || ownGoals > 0 || Object.keys(ms).length > 0) {
        ms.goals = goals;
        ms.assists = assists;
        if (ownGoals > 0) ms.own_goals = ownGoals;
        player.match_stats = ms;
        player.match_stats_fixture_id = fixtureId;
      }

      // ----- Live-add this match into cumulative tournament_stats -----
      // Bug fix #1782445094586: while a match is in-progress the KV-resident
      // tournament_stats was last refreshed when the PREVIOUS match finished —
      // so the "累计" number stays stale and shows N when reality is N + this
      // match's contribution. Fix by adding match_stats into tournament_stats
      // at API response time, gated by whether KV has already absorbed this
      // match. Gate signal: `lineup.tournament_refresh_done_at` — set exactly
      // once when refreshTournamentStatsForMatch finalizes the post-match write
      // (see workers/fifa-scraper/lib/main-cron.js becameFinished branch).
      //
      // - tournament_refresh_done_at present → KV already has this match;
      //   adding ms would double-count. Skip.
      // - absent → match is live or just-finished but cron hasn't refreshed yet;
      //   add ms to the cumulative numbers so the user sees a live total.
      const alreadyAbsorbed = !!lineup?.tournament_refresh_done_at;
      if (!alreadyAbsorbed && ms && Object.keys(ms).length > 0) {
        const ts = player.tournament_stats || (player.tournament_stats = {});
        const att = ts.attacking || (ts.attacking = {});
        const dis = ts.discipline || (ts.discipline = {});
        const gk  = ts.goalkeeping || (ts.goalkeeping = {});
        // (cumulative_field, match_stats_field, bucket)
        // Only add when the live value is a number > 0 so we don't accidentally
        // zero-out an existing cumulative value with a missing/null ms field.
        const additions = [
          // top-level Golden Boot
          ['goals',           ms.goals,           att],
          ['assists',         ms.assists,         att],
          ['own_goals',       ms.own_goals,       att],
          // Attacking — fdh-api per-match shots map to attempt_at_goal_* slugs
          ['attempt_at_goal',            ms.shots,           att],
          ['attempt_at_goal_on_target',  ms.shots_on_target, att],
          // Discipline — note `fouls_for` is the tournament cumulative slug,
          // match_stats uses `fouls_committed` (same concept, different name).
          ['fouls_for',     ms.fouls_committed,   dis],
          ['yellow_cards',  ms.yellow_cards,      dis],
          ['red_cards',     ms.red_cards,         dis],
        ];
        for (const [field, addend, bucket] of additions) {
          if (typeof addend === 'number' && addend > 0) {
            bucket[field] = (bucket[field] || 0) + addend;
          }
        }
        // Flag for transparency / debugging — UI can show a hint if it wants.
        ts.live_added_from_fixture = fixtureId;
      }
    }

    return json(player, 200, 60);   // cache 60s
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
