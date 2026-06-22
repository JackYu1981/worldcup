// Tournament-stats refresh — triggered when a fixture's match_status transitions
// to "finished". Pulls FIFA's mango raw collections and filters to the two
// countries' players, writing only those ~50 KV records.
//
// Data sources (verified by Chunk 4 probes):
//
// 1. fdcp_top_scorers:raw (single endpoint, ~1.2s for 1249 players)
//    Tags per actor (urn:gd:tag:story:fdcp_top_scorers:raw:*):
//      - goals_scored, assists, attempts_on_target
//      - goals_scored_by_{head,left_foot,right_foot,backheel,other_part_of_body}
//      - goals_scored_on_penalty
//      - matches_played, matches_started, actual_minutes_played
//      - id_country, player_name (+ 12 langs), rank, team_type, total, total_attempts
//
// 2. gcp_discipline (30 pages × 500ms ≈ 15s, ~1500 actors)
//    Tags per actor (urn:gd:tag:football:stats:*):
//      - fouls_for, fouls_against, yellow_cards, red_cards,
//        indirect_red_cards, offsides
//    Actor also has urn:gd:tag:story:team:abbreviation = ISO country code.
//
// Total time: ~16s, well under 30s CPU.
// Total writes: ~50 player records per match (2 countries × ~25 players each).

import { ensureGamedayToken, fifaBrowserHeaders } from './token.js';
import { fetchMangoStoryPage } from './fifa-api.js';

const SEASON_ID = '285023';
const MAX_DISCIPLINE_PAGES = 30;

export async function refreshTournamentStatsForMatch(env, mapping, lookupCountryZh) {
  const targetCountries = new Set([mapping.home_code, mapping.away_code].filter(Boolean));
  if (targetCountries.size === 0) return { playersUpdated: 0 };

  const token = await ensureGamedayToken(env);

  // Pull both data sources and accumulate
  const acc = {};   // player_id → merged player record
  await accumulateFromTopScorersRaw(token, targetCountries, acc);
  await accumulateFromDiscipline(token, targetCountries, acc);

  // Commit only filtered players
  const fetchedAt = new Date().toISOString().replace(/Z$/, '+00:00');
  let updated = 0;
  for (const [pid, agg] of Object.entries(acc)) {
    const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json') || { id: pid };
    const ts = existing.tournament_stats || { attacking: {}, discipline: {} };
    const merged = {
      ...existing,
      id: pid,
      country_code: existing.country_code || agg.country_code,
      country_zh: existing.country_zh || lookupCountryZh(agg.country_code),
      photo_url: existing.photo_url || agg.photo_url || null,
      name: { ...(existing.name || {}), ...agg.name_multilang },
      name_default: existing.name_default || agg.name_eng || `Player ${pid}`,
      tournament_stats: {
        version: 2,
        fetched_at: fetchedAt,
        source: 'mango_per_match_refresh',
        matches_played: agg.matches_played ?? ts.matches_played ?? null,
        minutes_played: agg.minutes_played ?? ts.minutes_played ?? null,
        attacking: { ...(ts.attacking || {}), ...agg.attacking },
        discipline: { ...(ts.discipline || {}), ...agg.discipline }
      },
      last_updated: fetchedAt
    };
    await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(merged));
    updated++;
  }

  // Update players_by_country roster's stats_summary for these 2 countries
  for (const code of targetCountries) {
    const rosterKey = `players_by_country:${code}`;
    const roster = await env.MATCH_DATA.get(rosterKey, 'json');
    if (!roster?.roster) continue;
    let changed = false;
    for (const entry of roster.roster) {
      const agg = acc[entry.player_id];
      if (!agg) continue;
      entry.stats_summary = {
        goals: agg.attacking?.goals_scored ?? entry.stats_summary?.goals ?? 0,
        assists: agg.attacking?.assists ?? entry.stats_summary?.assists ?? 0,
        attempts_on_target: agg.attacking?.attempts_on_target ?? entry.stats_summary?.attempts_on_target ?? 0,
        fouls_for: agg.discipline?.fouls_for ?? entry.stats_summary?.fouls_for ?? 0,
        yellow_cards: agg.discipline?.yellow_cards ?? entry.stats_summary?.yellow_cards ?? 0
      };
      changed = true;
    }
    if (changed) {
      roster.updated_at = new Date().toISOString().replace(/Z$/, '+00:00');
      await env.MATCH_DATA.put(rosterKey, JSON.stringify(roster));
    }
  }

  return { playersUpdated: updated, countries: [...targetCountries] };
}

/**
 * Stage 1: fdcp_top_scorers:raw — single request returns ~1249 actors.
 * Filter by id_country tag, accumulate attacking + counters into acc.
 */
async function accumulateFromTopScorersRaw(token, targetCountries, acc) {
  const q = 'classification~`fdcp_top_scorers:raw`';
  const url = 'https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query='
            + encodeURIComponent(q) + '&skip=0&limit=1';
  const r = await fetch(url, { headers: { ...fifaBrowserHeaders(), 'Authorization': `Bearer ${token}` } });
  if (!r.ok) throw new Error(`fdcp_top_scorers:raw fetch failed: HTTP ${r.status}`);
  const j = await r.json();
  const story = j.items?.[0];
  if (!story) return;

  for (const actor of story.actors || []) {
    const tagMap = Object.fromEntries((actor.tags || []).map(t => [t.name, t.value]));
    const country = tagMap['urn:gd:tag:story:fdcp_top_scorers:raw:id_country'];
    if (!targetCountries.has(country)) continue;

    const pid = actor.key?._externalSportsPersonId;
    if (!pid) continue;

    const T = (k) => tagMap[`urn:gd:tag:story:fdcp_top_scorers:raw:${k}`];
    const num = (v) => (v === null || v === undefined ? null : Number(v));

    if (!acc[pid]) acc[pid] = { country_code: country, attacking: {}, discipline: {}, name_multilang: {}, name_eng: null };
    acc[pid].country_code = country;
    // name fields are in tag form fdcp_top_scorers:raw:player_name:{lang}
    const nameLangs = ['eng','spa','fra','deu','ara','por','jpn','ita','kor','ind','rus','zho'];
    for (const lang of nameLangs) {
      const v = T(`player_name:${lang}`);
      if (v) acc[pid].name_multilang[lang] = v;
    }
    acc[pid].name_eng = acc[pid].name_multilang.eng || acc[pid].name_eng;
    acc[pid].matches_played = num(T('matches_played'));
    acc[pid].minutes_played = num(T('actual_minutes_played'));
    acc[pid].attacking.goals_scored = num(T('goals_scored'));
    acc[pid].attacking.assists = num(T('assists'));
    acc[pid].attacking.attempts_on_target = num(T('attempts_on_target'));
    acc[pid].attacking.goals_scored_by_head = num(T('goals_scored_by_head'));
    acc[pid].attacking.goals_scored_by_left_foot = num(T('goals_scored_by_left_foot'));
    acc[pid].attacking.goals_scored_by_right_foot = num(T('goals_scored_by_right_foot'));
    acc[pid].attacking.goals_scored_on_penalty = num(T('goals_scored_on_penalty'));
  }
}

/**
 * Stage 2: gcp_discipline pages — paginated, ~30 pages × 50 actors.
 * Per-actor tags use urn:gd:tag:football:stats:{stat} format.
 * Filter by urn:gd:tag:story:team:abbreviation.
 */
async function accumulateFromDiscipline(token, targetCountries, acc) {
  const DISCIPLINE_KEYS = ['fouls_for', 'fouls_against', 'yellow_cards', 'red_cards',
                            'indirect_red_cards', 'offsides'];
  for (let page = 1; page <= MAX_DISCIPLINE_PAGES; page++) {
    const { story, err } = await fetchMangoStoryPage(token, SEASON_ID, 'gcp_discipline', 'yellow_cards', page);
    if (err === 'HTTP 404') break;
    if (err) throw new Error(`gcp_discipline page ${page}: ${err}`);
    if (!story?.actors?.length) break;

    for (const actor of story.actors) {
      const tagMap = Object.fromEntries((actor.tags || []).map(t => [t.name, t.value]));
      const country = tagMap['urn:gd:tag:story:team:abbreviation'];
      if (!targetCountries.has(country)) continue;

      const pid = actor.key?._externalSportsPersonId;
      if (!pid) continue;

      if (!acc[pid]) {
        acc[pid] = { country_code: country, attacking: {}, discipline: {}, name_multilang: {}, name_eng: actor.name?.eng };
      }
      // Also pick up photo_url from discipline actor if not already accumulated
      acc[pid].photo_url = acc[pid].photo_url || tagMap['urn:gd:tag:story:staff:image'];
      // Merge name_multilang
      Object.assign(acc[pid].name_multilang, actor.name || {});
      acc[pid].name_eng = acc[pid].name_eng || actor.name?.eng;

      for (const k of DISCIPLINE_KEYS) {
        const v = tagMap[`urn:gd:tag:football:stats:${k}`];
        acc[pid].discipline[k] = v === null || v === undefined ? 0 : Number(v) || 0;
      }
    }
  }
}
