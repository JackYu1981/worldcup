// Tournament-wide cron — runs 4x daily (UTC 17/21/01/05; Beijing 01/05/09/13).
// Fetches mangodev stats leaderboards and writes:
//   - players:{id}     (mangodev-owned fields: name multilang, photo_url,
//                       tournament_stats.attacking/discipline, country/position/team
//                       backfill — see spec §3.0 ownership matrix)
//   - players_by_country:{code}.roster[].stats_summary
//   - fdh_match_ids per player (so main cron can reverse-lookup)
//
// Strict partial-write safety: accumulate ALL stats in memory across all
// (classification, page) fetches first; commit ONLY if all 4 classifications
// completed without unrecoverable errors. On failure, leave old data intact.

import { ensureGamedayToken } from './token.js';
import { fetchMangoStoryPage } from './fifa-api.js';
import {
  extractProfileFromActor,
  parseStatValue,
  CLASSIFICATION_RANK_BY,
  CLASSIFICATION_STAT_KEYS
} from './players.js';
import { logSla } from './sla.js';

const SEASON_ID = '285023';        // FWC 2026 (verified in Chunk 1 probes)
const MAX_PAGES = 30;              // page_count metadata says 25 but real cap is ~30 (Chunk 4.2 finding)
const POLITE_DELAY_MS = 300;       // delay between page fetches to avoid 429
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
  let token;
  try {
    token = await ensureGamedayToken(env);
  } catch (e) {
    await logSla(env, { level: 'error', event: 'tournament_token_failed', error: e.message });
    return { committed: false, reason: 'token_failed' };
  }

  // Phase 1: fetch + accumulate in memory
  const acc = {};   // player_id → { profile, attacking: {}, discipline: {} }
  let allOk = true;
  let totalActors = 0;
  let totalPages = 0;

  for (const [classification, rankStat] of Object.entries(CLASSIFICATION_RANK_BY)) {
    const bucketKeys = CLASSIFICATION_STAT_KEYS[classification] || [];
    let page = 1;
    let classificationOk = true;
    while (page <= MAX_PAGES) {
      const { story, err } = await fetchMangoStoryPage(token, SEASON_ID, classification, rankStat, page);
      if (err === 'HTTP 404') break;   // out of pages
      if (err) {
        await logSla(env, {
          level: 'error', event: 'tournament_fetch_failed',
          classification, stat: rankStat, page, error: err
        });
        classificationOk = false;
        allOk = false;
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
        // Always refresh profile (later actors may have more recent data)
        const newProfile = extractProfileFromActor(actor);
        // Merge name_multilang — preserve langs from earlier classifications that may
        // be missing in later ones
        acc[pid].profile = {
          ...acc[pid].profile,
          ...newProfile,
          name_multilang: { ...acc[pid].profile.name_multilang, ...newProfile.name_multilang }
        };

        // Read all bucket stats for this classification
        for (const k of bucketKeys) {
          const v = parseStatValue(actor, k);
          if (ATTACKING_BUCKET_KEYS.has(k)) acc[pid].attacking[k] = v;
          if (DISCIPLINE_BUCKET_KEYS.has(k)) acc[pid].discipline[k] = v;
        }
        totalActors++;
      }

      page++;
      // polite delay to avoid 429
      await new Promise(rr => setTimeout(rr, POLITE_DELAY_MS));
    }
    if (!classificationOk) break;   // abort whole pass on unrecoverable error
  }

  if (!allOk) {
    await logSla(env, {
      level: 'warn', event: 'tournament_pass_aborted',
      partial_actors: totalActors, partial_pages: totalPages
    });
    return { committed: false, reason: 'partial_fetch_failed', actors: totalActors, pages: totalPages };
  }

  if (Object.keys(acc).length === 0) {
    await logSla(env, { level: 'warn', event: 'tournament_no_actors' });
    return { committed: false, reason: 'empty', actors: 0, pages: totalPages };
  }

  // Phase 2: commit. For each player, merge mangodev-owned fields into existing record.
  // Main-cron-owned fields (last_match_id, shirt_number, position numeric, ...) preserved.
  let written = 0;
  const fetchedAt = new Date().toISOString().replace(/Z$/, '+00:00');
  for (const [pid, agg] of Object.entries(acc)) {
    const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json') || { id: pid };
    const updated = {
      ...existing,
      id: pid,
      // mangodev backfill of profile fields (only if main cron hasn't written them yet)
      country_code: existing.country_code || agg.profile.country_code,
      country_zh: existing.country_zh || agg.profile.country_zh,
      team_id: existing.team_id || agg.profile.team_id,
      // mangodev-owned fields (always overwrite — this cron is the authority)
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
        // matches_played / minutes_played are managed by counters.js — preserve
        matches_played: existing?.tournament_stats?.matches_played ?? null,
        minutes_played: existing?.tournament_stats?.minutes_played ?? null,
        attacking: agg.attacking,
        discipline: agg.discipline
      },
      last_updated: fetchedAt
    };
    await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(updated));
    written++;
  }

  // Phase 3: update players_by_country.roster[].stats_summary
  await updateRosterStatsSummary(env, acc);

  await logSla(env, {
    level: 'info', event: 'tournament_pass_complete',
    actors: totalActors, pages: totalPages, players_written: written
  });

  return { committed: true, actors: totalActors, pages: totalPages, players_written: written };
}

/**
 * Refresh stats_summary in each players_by_country roster entry.
 * Roster membership is owned by main cron (union from lineup); we only update
 * the summary block, preserving any roster entries main cron has added.
 */
async function updateRosterStatsSummary(env, acc) {
  // Group player IDs by country for batch lookup
  const playersByCountry = {};
  for (const [pid, agg] of Object.entries(acc)) {
    const cc = agg.profile.country_code;
    if (!cc) continue;
    (playersByCountry[cc] ||= {})[pid] = agg;
  }

  for (const [cc, players] of Object.entries(playersByCountry)) {
    const rosterKey = `players_by_country:${cc}`;
    const existing = await env.MATCH_DATA.get(rosterKey, 'json');
    if (!existing || !Array.isArray(existing.roster)) continue;   // main cron creates the key first

    for (const entry of existing.roster) {
      const agg = players[entry.player_id];
      if (!agg) continue;
      entry.stats_summary = {
        goals: agg.attacking.goals || 0,
        assists: agg.attacking.assists || 0,
        attempt_at_goal_on_target: agg.attacking.attempt_at_goal_on_target || 0,
        fouls_for: agg.discipline.fouls_for || 0,
        yellow_cards: agg.discipline.yellow_cards || 0
      };
    }
    existing.updated_at = new Date().toISOString().replace(/Z$/, '+00:00');
    await env.MATCH_DATA.put(rosterKey, JSON.stringify(existing));
  }
}
