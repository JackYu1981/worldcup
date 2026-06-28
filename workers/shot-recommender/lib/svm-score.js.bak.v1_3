// SVM v1.1 inference + walk-forward feature derivation + allocator.
//
// Mirrors scripts/shot_recommender/v1_svm/{build_dataset.py,allocator.py,train.py}.
// Single source of truth: data/model.json (exported by train.py).
//
// Inference pipeline (per player):
//   1. extractFeatures(player, oppTeam, ahLine, sideIsHome) → 17-D feature vector
//   2. standardize: x_s = (x - scaler_mean) / scaler_scale
//   3. linear decision: d = coef · x_s + intercept
//   4. Platt sigmoid: prob = 1 / (1 + exp(platt_a · d + platt_b))
//
// Walk-forward features at inference time use the team's CURRENT cumulative
// stats from KV — same source of truth as the training-time walk-forward
// reconstruction. Worker reads `players:{pid}.tournament_stats` (already
// reconciled by counters.js after each finished match).

import { MODEL } from './model.js';

// === Feature names in canonical order (must match MODEL.features) ===
export const FEATURE_NAMES = MODEL.features;

// === Position one-hot mapping ===
const POSITION_FW = 3, POSITION_MF = 2, POSITION_DF = 1, POSITION_GK = 0;

/**
 * Build the 21-D feature vector for one player in the context of a fixture.
 *
 * @param player      players:{pid} record with tournament_stats
 * @param oppTeamCum  pre-match cumulative stats for the opponent team
 *                    { matches, goals_conceded, team_ot }
 * @param ahLine      bet365 line (home-perspective; negative = home favored)
 * @param sideIsHome  true if this player is on the home side
 * @param playerPerMatch  per-bucket pre-match averages for this player
 * @param ownTeamCum  pre-match cumulative stats for the player's own team
 *                    { matches, goals_conceded, team_ot } — needed for
 *                    own_team_capacity feature (v1.2)
 */
export function buildFeatureVector(player, oppTeamCum, ahLine, sideIsHome, playerPerMatch, ownTeamCum) {
  const pm = playerPerMatch;
  const matches = pm.matches_overall;
  const otOverall = matches > 0 ? pm.ot_overall / matches : -1;
  const attOverall = matches > 0 ? pm.att_overall / matches : 0;

  const matchesVsWeak = pm.matches_vs_weak;
  const otVsWeak = matchesVsWeak > 0 ? pm.ot_vs_weak / matchesVsWeak : -1;
  const matchesVsStrong = pm.matches_vs_strong;
  const otVsStrong = matchesVsStrong > 0 ? pm.ot_vs_strong / matchesVsStrong : -1;
  const matchesVsMedium = pm.matches_vs_medium;
  const otVsMedium = matchesVsMedium > 0 ? pm.ot_vs_medium / matchesVsMedium : -1;

  const pos = player.position;
  const isFW = pos === POSITION_FW ? 1 : 0;
  const isMF = pos === POSITION_MF ? 1 : 0;
  const isDF = pos === POSITION_DF ? 1 : 0;
  const isGK = pos === POSITION_GK ? 1 : 0;
  const otVsStrongClean = otVsStrong >= 0 ? otVsStrong : 0;
  const otXFW = otVsStrongClean * isFW;
  const otXDF = otVsStrongClean * isDF;

  const oppGcPerMatch = oppTeamCum.matches > 0
    ? oppTeamCum.goals_conceded / oppTeamCum.matches : 0;

  let teamFav = 0;
  if (ahLine !== null && ahLine !== undefined) {
    teamFav = sideIsHome ? -ahLine : ahLine;
  }

  // v1.2 NEW features
  // (1) mp-weighted ot: mp=1 noise discount
  const mpWeight = matches >= 2 ? 1.0 : 0.5;
  const otOverallClean = otOverall >= 0 ? otOverall : 0;
  const otOverallWeighted = otOverallClean * mpWeight;
  // (2) position-credibility-adjusted ot: DF data isn't predictive
  const posCredibility = pos === 3 ? 1.0 : pos === 2 ? 0.9 : pos === 1 ? 0.4 : pos === 0 ? 0.0 : 0.7;
  const otPositionAdjusted = otOverallClean * posCredibility;
  // (3) own team capacity: team-level ot/match (proxy for 整队进攻能力)
  const ownMatches = ownTeamCum?.matches || 0;
  const ownTeamCapacity = ownMatches > 0 ? (ownTeamCum.team_ot || 0) / ownMatches : 0;
  // (4) opp team capacity: same for opponent — used to flag weak opponent
  const oppTeamCapacity = oppTeamCum.matches > 0 ? (oppTeamCum.team_ot || 0) / oppTeamCum.matches : 0;

  // v1.3 NEW features — opp_strength-weighted ot/att
  // Σ(ot_i × opp_strength_i) / Σ(opp_strength_i) — "vs 强队的射正才是真本事"
  const otStrengthAdj = pm.opp_strength_sum > 0
    ? (pm.weighted_on_target || 0) / pm.opp_strength_sum
    : -1;
  const attStrengthAdj = pm.opp_strength_sum > 0
    ? (pm.weighted_attempts || 0) / pm.opp_strength_sum
    : 0;

  // CRITICAL: order MUST match FEATURE_NAMES (model.features) exactly.
  // Verified against scripts/shot_recommender/v1_svm/build_dataset.py csv header.
  return [
    otOverall,              // ot_overall
    otVsWeak,               // ot_vs_weak
    otVsStrong,             // ot_vs_strong
    otVsMedium,             // ot_vs_medium
    attOverall,             // att_overall
    matches,                // matches_played
    matchesVsWeak,          // n_vs_weak
    matchesVsStrong,        // n_vs_strong
    matchesVsMedium,        // n_vs_medium
    isFW,                   // is_FW
    isMF,                   // is_MF
    isDF,                   // is_DF
    isGK,                   // is_GK
    otXFW,                  // ot_x_FW
    otXDF,                  // ot_x_DF
    oppGcPerMatch,          // opp_gc_per_match
    teamFav,                // team_favoredness
    otOverallWeighted,      // ot_overall_weighted (v1.2)
    otPositionAdjusted,     // ot_position_adjusted (v1.2)
    ownTeamCapacity,        // own_team_capacity (v1.2)
    oppTeamCapacity,        // opp_team_capacity (v1.2)
    otStrengthAdj,          // ot_overall_strength_adj (v1.3)
    attStrengthAdj,         // att_overall_strength_adj (v1.3)
  ];
}

/**
 * Standardize + linear decision + Platt sigmoid → probability in [0, 1].
 */
export function scorePlayer(featureVec) {
  if (featureVec.length !== MODEL.coef.length) {
    throw new Error(`feature length ${featureVec.length} != model coef length ${MODEL.coef.length}`);
  }
  // Standardize: x_s = (x - mean) / scale
  let decision = MODEL.intercept;
  for (let i = 0; i < featureVec.length; i++) {
    const xs = (featureVec[i] - MODEL.scaler_mean[i]) / MODEL.scaler_scale[i];
    decision += MODEL.coef[i] * xs;
  }
  // Platt sigmoid: prob = 1 / (1 + exp(a · d + b))
  // sklearn's CalibratedClassifierCV uses this exact form for binary
  // classification with method='sigmoid'.
  const z = MODEL.platt_a * decision + MODEL.platt_b;
  const prob = 1 / (1 + Math.exp(z));
  return { prob, decision };
}

// =========== Allocator (mirrors allocator.py) ===========

// Strong-side share of total budget based on AH line magnitude.
const DISTRIBUTION_RULES = [
  { min: 1.5,  strongFrac: 1.0 },     // 让 ≥1.5 球 → 强队全包
  { min: 1.0,  strongFrac: 5/6 },     // 让 1 球   → 5:1
  { min: 0.25, strongFrac: 4/6 },     // 让半球    → 4:2
  { min: 0,    strongFrac: 0.5 },     // 平手      → 3:3
];

// Budget → max player count (hard rule, 2026-06-26)
const BUDGET_TO_PLAYERS = { 6: 4, 7: 5, 8: 5 };

const CAPACITY_THRESHOLD_7 = 15.0;
const CAPACITY_THRESHOLD_8 = 22.0;

export function decideBudget(homeCapacity, awayCapacity, ahLine) {
  const lineMag = ahLine != null ? Math.abs(ahLine) : 0;
  const bothStrong = homeCapacity >= CAPACITY_THRESHOLD_8 && awayCapacity >= CAPACITY_THRESHOLD_8;
  if (bothStrong && lineMag < 0.5) return 8;
  if (Math.max(homeCapacity, awayCapacity) >= CAPACITY_THRESHOLD_7) return 7;
  return 6;
}

export function quotaSplit(budget, ownFavStrongSide) {
  const absLine = Math.abs(ownFavStrongSide);
  let frac = 0.5;
  for (const rule of DISTRIBUTION_RULES) {
    if (absLine >= rule.min) { frac = rule.strongFrac; break; }
  }
  const strong = Math.round(budget * frac);
  const weak = budget - strong;
  return { strong, weak };
}

/**
 * Greedy round-robin allocation with per-player shots cap = 3.
 *
 * @param scored  array of { player, prob } sorted desc by prob
 * @param quota   total shots to distribute on this side
 * @param maxPlayers  max number of distinct players (4 or 5)
 * @returns array of { player, shots }
 */
export function allocateMultiShot(scored, quota, maxPlayers, shotsCap = 3) {
  if (quota <= 0 || !scored.length) return [];
  const pool = scored.slice(0, maxPlayers).map(e => ({ ...e, shots: 0 }));
  let remaining = quota;
  while (remaining > 0) {
    let progress = false;
    for (const entry of pool) {
      if (remaining <= 0) break;
      if (entry.shots < shotsCap) {
        entry.shots += 1;
        remaining -= 1;
        progress = true;
      }
    }
    if (!progress) break;
  }
  return pool.filter(e => e.shots > 0);
}

export { MODEL, BUDGET_TO_PLAYERS };

// =========== Walk-forward cumulative builder ===========
// Same logic as scripts/shot_recommender/v1_svm/build_dataset.py — iterate
// finished match_lineups by kickoff order, fold each player's shots into
// (overall, vs_weak, vs_strong, vs_medium) buckets based on the match's AH
// line strength from the player's side perspective.
//
// Used by the worker at the start of each cron tick to assemble the
// per-player feature inputs needed for SVM inference. Cost is bounded by
// the number of finished fixtures (~60 for WC2026), each requiring
// match_lineups + match_stats + asian_handicap reads.

function isWeakOpponent(ahLine, sideIsHome) {
  if (ahLine == null) return false;
  const ownFav = sideIsHome ? -ahLine : ahLine;
  return ownFav >= 2.0;
}

function isStrongOpponent(ahLine, sideIsHome) {
  if (ahLine == null) return false;
  const ownFav = sideIsHome ? -ahLine : ahLine;
  return ownFav <= -0.5;
}

// v1.3: composite opponent strength in [0, 1].
// Mirrors scripts/shot_recommender/v1_svm/build_dataset.py compute_opp_strength.
// Higher = stronger opponent. Used to weight player's per-match ot accumulation:
// "对强队的射正才是真本事" — Σ(ot_i × opp_strength_i) / Σ(opp_strength_i).
function computeOppStrength(oppTeamState, ahLine, sideIsHome, alpha = [0.3, 0.5, 0.2]) {
  const ownDisfavor = ahLine != null ? (sideIsHome ? ahLine : -ahLine) : 0;
  const ahNorm = Math.max(0, Math.min(1, 0.5 + ownDisfavor / 4.0));
  const matches = oppTeamState?.matches || 0;
  if (matches === 0) return ahNorm;
  const gcPm = (oppTeamState.goals_conceded || 0) / matches;
  const gcNorm = Math.max(0, Math.min(1, 1.0 - gcPm / 2.0));
  const otPm = (oppTeamState.ot_against || 0) / matches;
  const otNorm = Math.max(0, Math.min(1, 1.0 - otPm / 6.0));
  const [wAh, wGc, wOt] = alpha;
  return wAh * ahNorm + wGc * gcNorm + wOt * otNorm;
}

// Parse FIFA minute "56'" or "90'+5'" → integer minutes. Match build_dataset.py.
function parseMinute(s) {
  if (!s) return 0;
  const str = String(s).replace(/[''""]/g, '').trim();
  if (str.includes('+')) {
    const [a, b] = str.split('+', 2);
    return (parseInt(a, 10) || 0) + (parseInt(b, 10) || 0);
  }
  return parseInt(str, 10) || 0;
}

// Compute player's actual minutes played in a match (mirror of build_dataset).
function computePlayerMinutes(pid, startersSet, subsSet, subsList, matchTotal) {
  const pidStr = String(pid);
  let onMinute = null, offMinute = null;
  for (const s of subsList) {
    if (String(s.on_player_id || '') === pidStr) onMinute = parseMinute(s.minute);
    if (String(s.off_player_id || '') === pidStr) offMinute = parseMinute(s.minute);
  }
  if (startersSet.has(pidStr)) {
    const end = offMinute != null ? offMinute : matchTotal;
    return Math.max(0, end);
  }
  if (subsSet.has(pidStr) && onMinute != null) {
    const end = offMinute != null ? offMinute : matchTotal;
    return Math.max(0, end - onMinute);
  }
  return 0;
}

function emptyBucket() {
  return { matches: 0, on_target: 0, attempts: 0,
           weighted_on_target: 0, weighted_attempts: 0, opp_strength_sum: 0 };
}

function emptyPlayerCum() {
  return {
    overall: emptyBucket(), vs_weak: emptyBucket(),
    vs_strong: emptyBucket(), vs_medium: emptyBucket(),
  };
}

/**
 * Build cumulative tables for all players and teams from KV.
 *
 * Iterates finished `match_lineups:*` keys in kickoff-ascending order,
 * pulling match_stats + asian_handicap per fixture. Returns:
 *   {
 *     playerCum: Map<pid, { overall, vs_weak, vs_strong, vs_medium }>,
 *     teamCum:   Map<cc,  { matches, goals_conceded }>,
 *   }
 *
 * `fidKickoff` map is built once by scanning `matches:*` daily buckets;
 * pass it in if you've already built it elsewhere this tick.
 */
export async function buildCumulativeTables(env, fidKickoff = null) {
  // Build fid → kickoff map if not provided
  if (!fidKickoff) {
    fidKickoff = new Map();
    const matchesList = await env.MATCH_DATA.list({ prefix: 'matches:' });
    const dailyBuckets = await Promise.all(
      (matchesList.keys || []).map(k => env.MATCH_DATA.get(k.name, 'json'))
    );
    for (const bucket of dailyBuckets) {
      if (!bucket) continue;
      const items = bucket.matches || bucket.items || [];
      for (const m of items) {
        if (m.id && m.kickoff) fidKickoff.set(m.id, m.kickoff);
      }
    }
  }

  // List + sort finished match_lineups by kickoff
  const luList = await env.MATCH_DATA.list({ prefix: 'match_lineups:' });
  const luFids = (luList.keys || [])
    .map(k => k.name.split(':', 2)[1])
    .filter(fid => fidKickoff.has(fid));
  luFids.sort((a, b) => (fidKickoff.get(a) > fidKickoff.get(b) ? 1 : -1));

  // Parallel fetch all per-fixture data. Cloudflare KV supports high
  // concurrency on reads — bundling all reads up front is much faster
  // than serial awaits (and stays well under the 30s CPU limit).
  const allReads = await Promise.all(luFids.map(fid => Promise.all([
    env.MATCH_DATA.get(`match_lineups:${fid}`, 'json'),
    env.MATCH_DATA.get(`match_stats:${fid}`, 'json'),
    env.MATCH_DATA.get(`asian_handicap:${fid}`, 'json'),
  ])));

  const playerCum = new Map();
  const teamCum = new Map();

  for (let idx = 0; idx < luFids.length; idx++) {
    const fid = luFids[idx];
    const [lu, ms, ah] = allReads[idx];
    if (!lu || lu.match_status_label !== 'finished' || !ms) continue;
    const ahLine = ah?.current?.line ?? null;

    const home = lu.home || {};
    const away = lu.away || {};
    const homeCc = home.country_code;
    const awayCc = away.country_code;
    if (!homeCc || !awayCc) continue;

    // === Team-level fold FIRST (so player fold can compute opp_strength using
    // pre-this-match team state). Order matters: opp_strength reads opp.matches
    // BEFORE adding this match. Walk-forward safety.
    const eventsGoals = (lu.events?.goals) || [];
    let homeScore = home.score;
    let awayScore = away.score;
    if (homeScore == null) homeScore = eventsGoals.filter(g => g.side === 'home').length;
    if (awayScore == null) awayScore = eventsGoals.filter(g => g.side === 'away').length;
    if (!teamCum.has(homeCc)) teamCum.set(homeCc, { matches: 0, goals_conceded: 0, team_ot: 0, ot_against: 0 });
    if (!teamCum.has(awayCc)) teamCum.set(awayCc, { matches: 0, goals_conceded: 0, team_ot: 0, ot_against: 0 });

    // === fold per-player shots into buckets (use THIS match's ah_line + pre-match team state) ===
    const subsList = (lu.events?.substitutions) || [];
    const matchTotalMinutes = parseMinute(lu.match_time) || 90;

    for (const [side, info, sideIsHome] of [
      ['home', home, true], ['away', away, false]
    ]) {
      const oppCc = sideIsHome ? awayCc : homeCc;
      // Compute opp_strength using opponent's PRE-this-match state
      const oppPrevState = teamCum.get(oppCc);
      const oppStrength = computeOppStrength(oppPrevState, ahLine, sideIsHome);

      let bucketName;
      if (isWeakOpponent(ahLine, sideIsHome)) bucketName = 'vs_weak';
      else if (isStrongOpponent(ahLine, sideIsHome)) bucketName = 'vs_strong';
      else bucketName = 'vs_medium';

      const startersSet = new Set((info.starting || []).map(p => String(p.player_id || '')));
      const subsSet = new Set((info.substitutes || []).map(p => String(p.player_id || '')));
      const subsWhoCameOn = new Set();
      for (const s of subsList) {
        if (String(s.on_player_id || '') && (s.side === side || (sideIsHome && s.side === 'home') || (!sideIsHome && s.side === 'away'))) {
          // simpler check — substitutions[].side matches this side
          if (s.side === side) subsWhoCameOn.add(String(s.on_player_id));
        }
      }

      // Build appeared players for this side (starters + subs who came on)
      const appearedPlayers = new Map();
      for (const p of (info.starting || [])) {
        const pid = String(p.player_id || ''); if (!pid) continue;
        appearedPlayers.set(pid, { ot: 0, att: 0 });
      }
      for (const p of [...(info.starting || []), ...(info.substitutes || [])]) {
        const pid = String(p.player_id || ''); if (!pid) continue;
        const pStats = (ms.players || {})[pid];
        if (!pStats) continue;
        const ot = pStats.shots_on_target || 0;
        const att = pStats.shots || 0;
        if (startersSet.has(pid)) {
          appearedPlayers.set(pid, { ot, att });
        } else if (subsSet.has(pid) && subsWhoCameOn.has(pid)) {
          appearedPlayers.set(pid, { ot, att });
        }
      }

      // Fold into player_cum with minute-weighted mp + opp_strength-weighted ot
      for (const [pid, stats] of appearedPlayers) {
        const minutes = computePlayerMinutes(pid, startersSet, subsSet, subsList, matchTotalMinutes);
        const mpWeight = minutes / 90.0;
        if (mpWeight <= 0) continue;
        if (!playerCum.has(pid)) playerCum.set(pid, emptyPlayerCum());
        const pc = playerCum.get(pid);
        pc.overall.matches += mpWeight;
        pc.overall.on_target += stats.ot;
        pc.overall.attempts += stats.att;
        pc.overall.weighted_on_target += stats.ot * oppStrength;
        pc.overall.weighted_attempts += stats.att * oppStrength;
        pc.overall.opp_strength_sum += oppStrength * mpWeight;
        pc[bucketName].matches += mpWeight;
        pc[bucketName].on_target += stats.ot;
        pc[bucketName].attempts += stats.att;
        pc[bucketName].weighted_on_target += stats.ot * oppStrength;
        pc[bucketName].weighted_attempts += stats.att * oppStrength;
        pc[bucketName].opp_strength_sum += oppStrength * mpWeight;
      }
    }

    // === fold team-level concede + team_ot + ot_against AFTER player fold ===
    teamCum.get(homeCc).matches += 1;
    teamCum.get(homeCc).goals_conceded += awayScore;
    teamCum.get(awayCc).matches += 1;
    teamCum.get(awayCc).goals_conceded += homeScore;
    // Sum each team's on_target + opponent's ot_against this match
    for (const [pidMs, pStats] of Object.entries(ms.players || {})) {
      const ot = pStats.shots_on_target || 0;
      const onHome = (home.starting || []).concat(home.substitutes || [])
        .some(x => String(x.player_id) === String(pidMs));
      if (onHome) {
        teamCum.get(homeCc).team_ot += ot;
        teamCum.get(awayCc).ot_against += ot;
      } else {
        teamCum.get(awayCc).team_ot += ot;
        teamCum.get(homeCc).ot_against += ot;
      }
    }
  }

  return { playerCum, teamCum, fidKickoff };
}

/**
 * Convenience: extract the playerPerMatch dict expected by buildFeatureVector.
 */
export function getPlayerPerMatch(playerCum, pid) {
  const pc = playerCum.get(String(pid));
  if (!pc) {
    return {
      matches_overall: 0, ot_overall: 0, att_overall: 0,
      matches_vs_weak: 0, ot_vs_weak: 0,
      matches_vs_strong: 0, ot_vs_strong: 0,
      matches_vs_medium: 0, ot_vs_medium: 0,
      weighted_on_target: 0, weighted_attempts: 0, opp_strength_sum: 0,
    };
  }
  return {
    matches_overall: pc.overall.matches,
    ot_overall: pc.overall.on_target,
    att_overall: pc.overall.attempts,
    matches_vs_weak: pc.vs_weak.matches,
    ot_vs_weak: pc.vs_weak.on_target,
    matches_vs_strong: pc.vs_strong.matches,
    ot_vs_strong: pc.vs_strong.on_target,
    matches_vs_medium: pc.vs_medium.matches,
    ot_vs_medium: pc.vs_medium.on_target,
    // v1.3: opp_strength-weighted
    weighted_on_target: pc.overall.weighted_on_target || 0,
    weighted_attempts: pc.overall.weighted_attempts || 0,
    opp_strength_sum: pc.overall.opp_strength_sum || 0,
  };
}
