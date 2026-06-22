// Tournament-wide cron — runs 4x daily (UTC 17/21/01/05; Beijing 01/05/09/13).
//
// Design (revised after Chunk 4.5 live-test timing discovery):
//   - Each (classification, page) fetch costs ~500ms via CF Worker → mangodev,
//     so 4 classifications × ~30 pages = ~60s, exceeding the 30s scheduled CPU
//     budget.
//   - SOLUTION: stream-commit per classification — as soon as a classification's
//     pages are all fetched, commit those players' stats to KV, then move on.
//     With a soft time budget (25s), the cron stops between classifications, and
//     the next cron tick (4x daily) catches up — within 24h all classifications
//     refresh.
//
// Writes:
//   - players:{id}                  (mangodev-owned: photo_url, name multilang,
//                                    position_label, fdh_match_ids,
//                                    tournament_stats.attacking/discipline)
//   - players_by_country:{code}.roster[].stats_summary
//
// Strict §3.0 ownership preserved: tournament cron NEVER writes
//   matches_played / minutes_played / last_match_id / shirt_number / position.

import { ensureGamedayToken } from './token.js';
import { fetchMangoStoryPage } from './fifa-api.js';
import {
  extractProfileFromActor,
  parseStatValue,
  CLASSIFICATION_RANK_BY,
  CLASSIFICATION_STAT_KEYS
} from './players.js';
import { logSla } from './sla.js';

const SEASON_ID = '285023';
const MAX_PAGES = 30;
const SOFT_TIME_BUDGET_MS = 25_000;   // hard ceiling ~30s scheduled CPU
const ATTACKING_BUCKET_KEYS = new Set([
  'goals', 'assists', 'attempt_at_goal', 'attempt_at_goal_on_target',
  'attempt_at_goal_off_target', 'attempt_at_goal_conversion_rate',
  'attempt_at_goal_inside_the_penalty_area', 'attempt_at_goal_outside_the_penalty_area',
  'headed_attempt_at_goal', 'xg', 'xg_goal_effiency_rate', 'corners',
  'total_competition_minutes_played'
]);
const DISCIPLINE_BUCKET_KEYS = new Set([
  'fouls_for', 'fouls_against', 'yellow_cards', 'red_cards',
  'indirect_red_cards', 'offsides'
]);

export async function tournamentWideCron(env) {
  const t0 = Date.now();
  const timeLeft = () => Date.now() - t0 < SOFT_TIME_BUDGET_MS;

  let token;
  try {
    token = await ensureGamedayToken(env);
  } catch (e) {
    await logSla(env, { level: 'error', event: 'tournament_token_failed', error: e.message });
    return { committed: false, reason: 'token_failed' };
  }

  // Find which classification to start with: cycle through based on which one
  // has the oldest tournament_stats.fetched_at among any sample player.
  // For now, walk all classifications in order and stop when budget exhausted —
  // next tick picks up where we left off naturally (each classification is
  // independently committable).
  const lastClass = await env.MATCH_DATA.get('debug_tournament_last_class', 'json');
  const classOrder = Object.entries(CLASSIFICATION_RANK_BY);
  // Rotate: start from the one AFTER the last completed (so each cron tick
  // makes progress on a different classification).
  let startIdx = 0;
  if (lastClass?.classification) {
    const i = classOrder.findIndex(([c]) => c === lastClass.classification);
    if (i >= 0) startIdx = (i + 1) % classOrder.length;
  }
  const rotatedOrder = [...classOrder.slice(startIdx), ...classOrder.slice(0, startIdx)];

  let totalWritten = 0;
  let totalActors = 0;
  let totalPages = 0;
  let completedClassifications = [];

  for (const [classification, rankStat] of rotatedOrder) {
    if (!timeLeft()) {
      await logSla(env, {
        level: 'info', event: 'tournament_time_budget',
        completed: completedClassifications, next: classification,
        ms_used: Date.now() - t0
      });
      break;
    }

    const bucketKeys = CLASSIFICATION_STAT_KEYS[classification] || [];
    const acc = {};   // player_id → { profile, attacking, discipline }
    let page = 1;
    let classOk = true;
    while (page <= MAX_PAGES && timeLeft()) {
      const { story, err } = await fetchMangoStoryPage(token, SEASON_ID, classification, rankStat, page);
      if (err === 'HTTP 404') break;
      if (err) {
        await logSla(env, {
          level: 'error', event: 'tournament_fetch_failed',
          classification, page, error: err
        });
        classOk = false;
        break;
      }
      if (!story || !story.actors || story.actors.length === 0) break;

      totalPages++;
      for (const actor of story.actors) {
        const pid = actor.key?._externalSportsPersonId;
        if (!pid) continue;
        if (!acc[pid]) {
          acc[pid] = { profile: extractProfileFromActor(actor), attacking: {}, discipline: {} };
        }
        const newProfile = extractProfileFromActor(actor);
        acc[pid].profile = {
          ...acc[pid].profile,
          ...newProfile,
          name_multilang: { ...acc[pid].profile.name_multilang, ...newProfile.name_multilang }
        };
        for (const k of bucketKeys) {
          const v = parseStatValue(actor, k);
          if (ATTACKING_BUCKET_KEYS.has(k)) acc[pid].attacking[k] = v;
          if (DISCIPLINE_BUCKET_KEYS.has(k)) acc[pid].discipline[k] = v;
        }
        totalActors++;
      }
      page++;
    }

    if (!classOk) {
      await logSla(env, { level: 'warn', event: 'tournament_class_aborted', classification });
      continue;   // try the next classification, don't quit entirely
    }

    // Commit this classification's accumulated players right away
    const written = await commitPlayers(env, acc, classification, bucketKeys);
    totalWritten += written;
    completedClassifications.push(classification);

    // Save progress so next cron tick starts at the next classification
    await env.MATCH_DATA.put('debug_tournament_last_class', JSON.stringify({
      classification, ts: new Date().toISOString(), written
    }));

    // Update roster summary for the country/players we just committed
    await updateRosterStatsSummary(env, acc);
  }

  await logSla(env, {
    level: 'info', event: 'tournament_pass',
    completed: completedClassifications,
    actors: totalActors, pages: totalPages, players_written: totalWritten,
    ms_used: Date.now() - t0
  });

  return {
    committed: completedClassifications.length > 0,
    completed: completedClassifications,
    actors: totalActors, pages: totalPages, players_written: totalWritten,
    ms_used: Date.now() - t0
  };
}

async function commitPlayers(env, acc, classification, bucketKeys) {
  const fetchedAt = new Date().toISOString().replace(/Z$/, '+00:00');
  let written = 0;
  for (const [pid, agg] of Object.entries(acc)) {
    const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json') || { id: pid };
    const existingTs = existing.tournament_stats || {
      attacking: {}, discipline: {},
      matches_played: null, minutes_played: null
    };

    // Merge bucket fields — only update keys this classification owns
    const newAttacking = { ...existingTs.attacking };
    const newDiscipline = { ...existingTs.discipline };
    for (const k of bucketKeys) {
      if (ATTACKING_BUCKET_KEYS.has(k) && agg.attacking[k] !== undefined) {
        newAttacking[k] = agg.attacking[k];
      }
      if (DISCIPLINE_BUCKET_KEYS.has(k) && agg.discipline[k] !== undefined) {
        newDiscipline[k] = agg.discipline[k];
      }
    }

    const updated = {
      ...existing,
      id: pid,
      country_code: existing.country_code || agg.profile.country_code,
      country_zh: existing.country_zh || agg.profile.country_zh,
      team_id: existing.team_id || agg.profile.team_id,
      photo_url: agg.profile.photo_url || existing.photo_url || null,
      position_label: agg.profile.position_label || existing.position_label || null,
      name: {
        ...(existing.name || {}),
        ...agg.profile.name_multilang
      },
      name_default: existing.name_default || agg.profile.name_eng || `Player ${pid}`,
      fdh_match_ids: agg.profile.fdh_match_ids?.length
        ? agg.profile.fdh_match_ids
        : (existing.fdh_match_ids || []),
      tournament_stats: {
        version: 1,
        fetched_at: fetchedAt,
        source: 'mangodev',
        matches_played: existingTs.matches_played,
        minutes_played: existingTs.minutes_played,
        attacking: newAttacking,
        discipline: newDiscipline
      },
      last_updated: fetchedAt
    };
    await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(updated));
    written++;
  }
  return written;
}

async function updateRosterStatsSummary(env, acc) {
  const playersByCountry = {};
  for (const [pid, agg] of Object.entries(acc)) {
    const cc = agg.profile.country_code;
    if (!cc) continue;
    (playersByCountry[cc] ||= {})[pid] = agg;
  }

  for (const [cc, players] of Object.entries(playersByCountry)) {
    const rosterKey = `players_by_country:${cc}`;
    const existing = await env.MATCH_DATA.get(rosterKey, 'json');
    if (!existing || !Array.isArray(existing.roster)) continue;

    for (const entry of existing.roster) {
      const agg = players[entry.player_id];
      if (!agg) continue;
      // Merge — only update keys we have data for, preserve others
      entry.stats_summary = {
        ...(entry.stats_summary || {}),
        goals: agg.attacking.goals ?? entry.stats_summary?.goals ?? 0,
        assists: agg.attacking.assists ?? entry.stats_summary?.assists ?? 0,
        attempt_at_goal_on_target: agg.attacking.attempt_at_goal_on_target ?? entry.stats_summary?.attempt_at_goal_on_target ?? 0,
        fouls_for: agg.discipline.fouls_for ?? entry.stats_summary?.fouls_for ?? 0,
        yellow_cards: agg.discipline.yellow_cards ?? entry.stats_summary?.yellow_cards ?? 0
      };
    }
    existing.updated_at = new Date().toISOString().replace(/Z$/, '+00:00');
    await env.MATCH_DATA.put(rosterKey, JSON.stringify(existing));
  }
}
