// Tournament-stats refresh — triggered when a fixture's match_status transitions
// to "finished". Refreshes the two teams' ~52 players using FIFA's gctp_* endpoints
// (team-filtered classification stories that return ALL squad members in one call).
//
// Why gctp_*: mangodev gcp_top_scorers/gcp_attack/gcp_discipline only list each
// stat's TOP 50 — bench/non-top players are missed. gctp_* (Team-Player variant)
// filters by teamId and returns the full 26-player squad with every stat.
//
// Three classifications fetched per team:
//   gctp_top_scorer  → goals, assists, total_competition_minutes_played, matches_played
//   gctp_attack      → attempt_at_goal_*, xg, corners, possession, etc. (~10 fields)
//   gctp_discipline  → fouls_for, fouls_against, yellow_cards, red_cards,
//                      indirect_red_cards, offsides
//
// Mirrors scripts/team-v3-refresh.py logic verbatim. Hash-short-circuit ensures
// only changed players write to KV — typical post-match refresh is 5-20 writes.
//
// Total time: 2 teams × 3 classifications × ~1s = ~6s, well under 30s CPU.

import { ensureGamedayToken, fifaBrowserHeaders } from './token.js';

const SEASON_ID = '285023';
const CLASSIFICATIONS = ['gctp_top_scorer', 'gctp_attack', 'gctp_discipline'];

// v3 schema bucket assignment (matches index.html STATS_CATEGORIES + countries seed
// integration). Source of truth: scripts/team-v3-refresh.py
const DISCIPLINE_KEYS = new Set([
  'fouls_for', 'fouls_against', 'yellow_cards', 'red_cards',
  'indirect_red_cards', 'offsides'
]);
const TOP_LEVEL_MAP = {
  total_competition_minutes_played: 'minutes_played',
  matches_played: 'matches_played',
  total_competition_matches_played: 'matches_played',
};
// Noise fields we intentionally never surface (UI doesn't show; clutters records)
const NOISE_KEYS = new Set(['fdcp_top_scorer_rank', 'xg_goal_effiency_rate']);

// FNV-1a 32-bit — matches lineup.js / team-v3-refresh.py
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Stable canonical JSON (sorted keys) — same hash on both sides.
function canonJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonJson(v[k])).join(',') + '}';
}

function hashRecordPayload(record) {
  const ts = record.tournament_stats || {};
  const payload = {
    country_code: record.country_code,
    team_id: record.team_id,
    photo_url: record.photo_url,
    name: record.name,
    name_default: record.name_default,
    minutes_played: ts.minutes_played,
    matches_played: ts.matches_played,
    attacking: ts.attacking,
    discipline: ts.discipline,
  };
  return fnv1a(canonJson(payload));
}

// Fetch one classification's wildcard story for a team. Retries on 429/503.
async function fetchTeamClassification(token, teamExternalId, classification) {
  const q =
    '(and resourceStatus==`urn:gd:resourceStatus:active` ' +
    '_externalId~`urn:gd:story:classification:' + classification +
    ':competitionId:' + SEASON_ID + ':teamId:' + teamExternalId +
    ':(.*):rank_asc:page:1$`)';
  const url =
    'https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query=' +
    encodeURIComponent(q) +
    '&skip=0&limit=20' +
    '&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc';
  const headers = { ...fifaBrowserHeaders(), 'Authorization': `Bearer ${token}` };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers });
    if (r.ok) {
      const j = await r.json();
      return j.items || [];
    }
    if ((r.status === 429 || r.status === 503) && attempt < 2) {
      await new Promise(rr => setTimeout(rr, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`gctp ${classification} HTTP ${r.status}`);
  }
  return [];
}

// Authoritative classification per stat field.
// DISCOVERED 2026-06-24 (post POR-UZB): `gctp_top_scorer:goals` showed Ronaldo
// goals=2 (correct), but `gctp_attack:goals` showed goals=0 (stale — likely a
// different "goal" definition). So each stat is locked to ONE classification.
const AUTHORITATIVE_CLS = {
  // gctp_top_scorer — accumulated tournament totals
  goals: 'gctp_top_scorer',
  assists: 'gctp_top_scorer',
  total_competition_minutes_played: 'gctp_top_scorer',
  total_competition_matches_played: 'gctp_top_scorer',
  fdcp_top_scorer_rank: 'gctp_top_scorer',
  // gctp_attack — attacking detail
  attempt_at_goal: 'gctp_attack',
  attempt_at_goal_on_target: 'gctp_attack',
  attempt_at_goal_on_target_rate: 'gctp_attack',
  attempt_at_goal_conversion_rate: 'gctp_attack',
  attempt_at_goal_inside_the_penalty_area: 'gctp_attack',
  attempt_at_goal_outside_the_penalty_area: 'gctp_attack',
  headed_attempt_at_goal: 'gctp_attack',
  number_of_shot_ending_sequences: 'gctp_attack',
  goals_conceded: 'gctp_attack',
  corners: 'gctp_attack',
  xg: 'gctp_attack',
  xg_goal_effiency_rate: 'gctp_attack',
  possession: 'gctp_attack',
  // gctp_discipline — discipline fields
  fouls_for: 'gctp_discipline',
  fouls_against: 'gctp_discipline',
  yellow_cards: 'gctp_discipline',
  red_cards: 'gctp_discipline',
  indirect_red_cards: 'gctp_discipline',
  offsides: 'gctp_discipline',
};

function storyPrimaryStat(story) {
  const eid = story?._externalId || '';
  const parts = eid.split(':');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'rank_asc' || parts[i] === 'rank_desc') {
      if (i >= 1) return parts[i - 1];
    }
  }
  return null;
}

// Extract per-player stats + name + image from a list of stories of one classification.
// Two-level gating prevents stale-snapshot pollution:
//   1. story primary stat: each story is ranked by ONE stat; only that stat's value is fresh
//   2. authoritative classification: each stat has a single canonical classification
function extractPlayersFromStories(stories, classification) {
  const byPid = {};
  for (const story of stories) {
    const primaryStat = storyPrimaryStat(story);
    for (const actor of story.actors || []) {
      const pid = actor.key?._externalSportsPersonId;
      if (!pid) continue;
      const entry = byPid[pid] || (byPid[pid] = {
        stats: {}, name_multilang: {}, photo_url: null,
        country_code: null, team_id: null,
      });
      for (const [k, v] of Object.entries(actor.name || {})) {
        if (v) entry.name_multilang[k] = v;
      }
      for (const t of actor.tags || []) {
        const name = t.name || '';
        if (name.startsWith('urn:gd:tag:football:stats:')) {
          const stat = name.split(':').pop();
          if (primaryStat !== null && stat !== primaryStat) continue;
          const auth = AUTHORITATIVE_CLS[stat];
          if (auth !== undefined && auth !== classification) continue;
          if (t.value === null && stat in entry.stats) continue;
          entry.stats[stat] = t.value;
        } else if (name === 'urn:gd:tag:story:staff:image' && !entry.photo_url) {
          entry.photo_url = t.value;
        } else if (name === 'urn:gd:tag:story:team:abbreviation' && !entry.country_code) {
          entry.country_code = t.value;
        }
      }
      const tid = actor.key?._externalTeamId || '';
      if (tid && !entry.team_id) {
        entry.team_id = tid.split('_').pop();
      }
    }
  }
  return byPid;
}

function buildTournamentStats(stats) {
  const top = {}, attacking = {}, discipline = {};
  for (const [k, v] of Object.entries(stats)) {
    if (DISCIPLINE_KEYS.has(k)) {
      discipline[k] = v;
    } else if (TOP_LEVEL_MAP[k]) {
      top[TOP_LEVEL_MAP[k]] = v;
    } else if (NOISE_KEYS.has(k)) {
      // drop
    } else {
      attacking[k] = v;
    }
  }
  return { top, attacking, discipline };
}

/**
 * Refresh all players in a single team.
 * Returns { writes, unchanged, errors }.
 *
 * @param env            CF env
 * @param token          gameday JWT
 * @param teamExternalId "{seasonId}_{teamId}" — from fifa_calendar mapping
 * @param teamCountryCode 3-letter ISO (fallback when actor tag missing)
 * @param countriesLookup { code → zh } for country_zh enrichment
 */
async function refreshTeam(env, token, teamExternalId, teamCountryCode, countriesLookup) {
  const teamId = teamExternalId.split('_').pop();

  const merged = {};
  for (const cls of CLASSIFICATIONS) {
    let stories;
    try {
      stories = await fetchTeamClassification(token, teamExternalId, cls);
    } catch (e) {
      console.warn(`[tournament-refresh] team=${teamId} cls=${cls} fetch failed: ${e.message}`);
      continue;
    }
    const players = extractPlayersFromStories(stories, cls);
    for (const [pid, info] of Object.entries(players)) {
      const tgt = merged[pid] || (merged[pid] = {
        stats: {}, name_multilang: {}, photo_url: null,
        country_code: null, team_id: null,
      });
      Object.assign(tgt.stats, info.stats);
      Object.assign(tgt.name_multilang, info.name_multilang);
      tgt.photo_url = tgt.photo_url || info.photo_url;
      tgt.country_code = tgt.country_code || info.country_code;
      tgt.team_id = tgt.team_id || info.team_id;
    }
  }

  const now = new Date().toISOString().replace(/Z$/, '+00:00');
  let writes = 0, unchanged = 0, errors = 0;

  for (const [pid, agg] of Object.entries(merged)) {
    const { top, attacking, discipline } = buildTournamentStats(agg.stats);
    const existing = (await env.MATCH_DATA.get(`players:${pid}`, 'json')) || {};
    const newName = { ...(existing.name || {}), ...agg.name_multilang };
    const countryCode = agg.country_code || existing.country_code || teamCountryCode;
    const countryZh =
      (countryCode && countriesLookup[countryCode]) || existing.country_zh || null;
    const newRecord = {
      ...existing,
      id: pid,
      country_code: countryCode,
      country_zh: countryZh,
      team_id: agg.team_id || existing.team_id || teamId,
      photo_url: agg.photo_url || existing.photo_url,
      name: newName,
      name_default: newName.eng || existing.name_default || `Player ${pid}`,
      tournament_stats: {
        version: 3,
        fetched_at: now,
        source: 'mangodev_gctp',
        ...top,
        attacking,
        discipline,
      },
      last_updated: now,
    };
    // Strip v1/v2 stale fields (clean migration)
    delete newRecord.fdh_match_ids;
    delete newRecord.last_match_id;
    delete newRecord._lineup_hash;

    const newHash = hashRecordPayload(newRecord);
    newRecord._hash = newHash;
    if (existing._hash === newHash) {
      unchanged++;
      continue;
    }
    try {
      await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(newRecord));
      writes++;
    } catch (e) {
      console.error(`[tournament-refresh] put players:${pid} failed: ${e.message}`);
      errors++;
    }
  }

  return { writes, unchanged, errors, totalPlayers: Object.keys(merged).length };
}

/**
 * Top-level entry: refresh both teams of a finished match.
 *
 * @param env       CF env
 * @param mapping   fixture_mapping:{500_id} record (must have home_code/away_code)
 * @param lookupCountryZh  legacy function (we now use countries seed directly)
 * @returns { playersUpdated, perTeam: { [teamCode]: stats } }
 */
export async function refreshTournamentStatsForMatch(env, mapping, lookupCountryZh) {
  const token = await ensureGamedayToken(env);
  const homeCode = mapping.home_code;
  const awayCode = mapping.away_code;
  if (!homeCode || !awayCode) {
    throw new Error('refreshTournamentStatsForMatch: mapping missing home_code/away_code');
  }

  // Map country code → mangodev team external id via fifa_calendar.
  // fifa_calendar.matches[].home_code + fdh_match_id won't help; we need the
  // _externalId from /teams endpoint. Cache it in KV.
  const teamCache = (await env.MATCH_DATA.get('fifa_team_external_ids', 'json')) || {};
  const needFetch = !teamCache[homeCode] || !teamCache[awayCode];
  let teams;
  if (needFetch) {
    teams = await fetchAllTeams(token);
    const next = { ...teamCache };
    for (const t of teams) {
      const code = (t.shortName?.eng || '').toUpperCase();
      if (code) next[code] = t._externalId;
    }
    // Write only if changed (cheap hash compare)
    const oldKeys = Object.keys(teamCache).sort().join(',');
    const newKeys = Object.keys(next).sort().join(',');
    if (oldKeys !== newKeys) {
      await env.MATCH_DATA.put('fifa_team_external_ids', JSON.stringify(next));
    }
    Object.assign(teamCache, next);
  }
  const homeEid = teamCache[homeCode];
  const awayEid = teamCache[awayCode];
  if (!homeEid || !awayEid) {
    throw new Error(`team external id missing: home=${homeCode}(${homeEid}) away=${awayCode}(${awayEid})`);
  }

  // Countries seed for country_zh enrichment.
  const countries = await env.MATCH_DATA.get('countries', 'json');
  const countriesLookup = {};
  for (const c of (countries?.items || [])) {
    if (c.code && c.zh) countriesLookup[c.code] = c.zh;
  }

  const home = await refreshTeam(env, token, homeEid, homeCode, countriesLookup);
  const away = await refreshTeam(env, token, awayEid, awayCode, countriesLookup);

  return {
    playersUpdated: home.writes + away.writes,
    home: { code: homeCode, ...home },
    away: { code: awayCode, ...away },
  };
}

/** Fetch all teams from mangodev (paginated, limit≤20). */
async function fetchAllTeams(token) {
  const teams = [];
  const PAGE = 20;
  let skip = 0;
  while (true) {
    const q = '_externalCompetitionId==`' + SEASON_ID + '`';
    const url =
      'https://gameday-prod.fifa.mangodev.co.uk/1-0/teams?query=' +
      encodeURIComponent(q) +
      '&skip=' + skip + '&limit=' + PAGE;
    const headers = { ...fifaBrowserHeaders(), 'Authorization': `Bearer ${token}` };
    let page;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, { headers });
      if (r.ok) {
        const j = await r.json();
        page = j.items || [];
        break;
      }
      if ((r.status === 429 || r.status === 503) && attempt < 2) {
        await new Promise(rr => setTimeout(rr, 3000 * (attempt + 1)));
        continue;
      }
      throw new Error(`teams fetch HTTP ${r.status}`);
    }
    if (!page || !page.length) break;
    teams.push(...page);
    if (page.length < PAGE) break;
    skip += page.length;
  }
  return teams;
}
