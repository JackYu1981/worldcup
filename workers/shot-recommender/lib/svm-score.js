// SVM v1.5 inference + walk-forward feature derivation + allocator.
//
// Mirrors scripts/shot_recommender/v1_svm/{build_dataset.py,allocator.py,train.py}.
// Single source of truth: data/model.json (exported by train.py).
//
// v1.5 = v1.4 + att_per_mp (per-game shooting frequency).
// 2-fold CV (R2/R3): Metric A 持平 41.32%, Metric B 翻倍 2.08% → 4.17%.
//
// v1.4 changelog (vs v1.3):
//   - dropped vs_weak/vs_strong/vs_medium buckets (6 features)
//   - dropped ot_strength_adj / att_strength_adj (2)
//   - dropped ot_overall_weighted / ot_position_adjusted (2)
//   - dropped ot_x_FW / ot_x_DF interactions (2)
//   - added total_ot / total_att / total_minutes / opp_strength_sum (raw累计)
//   - matches_played 改为整数 (≥15min +1) 不再 mp_weight
//   - cold-start: matches_played < 1
//
// Inference pipeline (per player):
//   1. buildFeatureVector(...) → 14-D feature vector
//   2. standardize: x_s = (x - scaler_mean) / scaler_scale
//   3. linear decision: d = coef · x_s + intercept
//   4. Platt sigmoid: prob = 1 / (1 + exp(platt_a · d + platt_b))

import { MODEL } from './model.js';

// === Feature names in canonical order (must match MODEL.features) ===
export const FEATURE_NAMES = MODEL.features;

// === Position one-hot mapping ===
const POSITION_FW = 3, POSITION_MF = 2, POSITION_DF = 1, POSITION_GK = 0;

// v1.4 cold-start gate: drop if player has < 1 prior match.
// 注意: 训练时也用同一阈值，但推理时让 worker 决定是否 skip (默认不 skip).
const MIN_MINUTES_FOR_MP = 15;

/**
 * Build the 14-D feature vector for one player in the context of a fixture.
 *
 * v1.5 feature order (must match MODEL.features exactly):
 *   total_ot, total_att, total_minutes, matches_played, opp_strength_sum,
 *   att_per_mp,
 *   is_FW, is_MF, is_DF, is_GK,
 *   opp_gc_per_match, team_favoredness, own_team_capacity, opp_team_capacity
 *
 * @param player      lineup player record (has .position, .player_id)
 * @param oppTeamCum  pre-match cumulative stats for opponent { matches, goals_conceded, team_ot, ot_against }
 * @param ahLine      bet365 line (home-perspective; negative = home favored)
 * @param sideIsHome  true if this player is on the home side
 * @param playerCum   pre-match cumulative for this player { total_ot, total_att, total_minutes, matches_played, opp_strength_sum }
 * @param ownTeamCum  pre-match cumulative for player's own team
 */
export function buildFeatureVector(player, oppTeamCum, ahLine, sideIsHome, playerCum, ownTeamCum) {
  const total_ot = playerCum.total_ot || 0;
  const total_att = playerCum.total_att || 0;
  const total_minutes = playerCum.total_minutes || 0;
  const matches_played = playerCum.matches_played || 0;
  const opp_strength_sum = playerCum.opp_strength_sum || 0;

  // v1.5 NEW: per-game shooting frequency
  const att_per_mp = total_att / Math.max(1, matches_played);

  // Position one-hot
  const pos = player.position;
  const isFW = pos === POSITION_FW ? 1 : 0;
  const isMF = pos === POSITION_MF ? 1 : 0;
  const isDF = pos === POSITION_DF ? 1 : 0;
  const isGK = pos === POSITION_GK ? 1 : 0;

  // Match context
  const oppGcPerMatch = oppTeamCum.matches > 0
    ? oppTeamCum.goals_conceded / oppTeamCum.matches : 0;

  let teamFav = 0;
  if (ahLine !== null && ahLine !== undefined) {
    teamFav = sideIsHome ? -ahLine : ahLine;
  }

  const ownMatches = ownTeamCum?.matches || 0;
  const ownTeamCapacity = ownMatches > 0 ? (ownTeamCum.team_ot || 0) / ownMatches : 0;
  const oppTeamCapacity = oppTeamCum.matches > 0 ? (oppTeamCum.team_ot || 0) / oppTeamCum.matches : 0;

  // CRITICAL: order MUST match FEATURE_NAMES (model.features) exactly.
  // Verified against scripts/shot_recommender/v1_svm/build_dataset.py csv header.
  return [
    total_ot,         // 1
    total_att,        // 2
    total_minutes,    // 3
    matches_played,   // 4
    opp_strength_sum, // 5
    att_per_mp,       // 6 (v1.5 NEW)
    isFW,             // 7
    isMF,             // 8
    isDF,             // 9
    isGK,             // 10
    oppGcPerMatch,    // 11
    teamFav,          // 12
    ownTeamCapacity,  // 13
    oppTeamCapacity,  // 14
  ];
}

/**
 * Standardize + linear decision + Platt sigmoid → probability in [0, 1].
 */
export function scorePlayer(featureVec) {
  if (featureVec.length !== MODEL.coef.length) {
    throw new Error(`feature length ${featureVec.length} != model coef length ${MODEL.coef.length}`);
  }
  let decision = MODEL.intercept;
  for (let i = 0; i < featureVec.length; i++) {
    const xs = (featureVec[i] - MODEL.scaler_mean[i]) / MODEL.scaler_scale[i];
    decision += MODEL.coef[i] * xs;
  }
  const z = MODEL.platt_a * decision + MODEL.platt_b;
  const prob = 1 / (1 + Math.exp(z));
  return { prob, decision };
}

// =========== Allocator (mirrors allocator.py) ===========

const DISTRIBUTION_RULES = [
  { min: 1.5,  strongFrac: 1.0 },     // 让 ≥1.5 球 → 强队全包
  { min: 1.0,  strongFrac: 5/6 },     // 让 1 球   → 5:1
  { min: 0.25, strongFrac: 4/6 },     // 让半球    → 4:2
  { min: 0,    strongFrac: 0.5 },     // 平手      → 3:3
];

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
// v1.4/v1.5: raw cumulative (no buckets).
// Each player tracks: total_ot, total_att, total_minutes, matches_played, opp_strength_sum.

// v1.4: composite opponent strength in [0, 1].
// Mirrors scripts/shot_recommender/v1_svm/build_dataset.py compute_opp_strength.
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

// Parse FIFA minute "56'" or "90'+5'" → integer minutes.
function parseMinute(s) {
  if (!s) return 0;
  const str = String(s).replace(/[''""]/g, '').trim();
  if (str.includes('+')) {
    const [a, b] = str.split('+', 2);
    return (parseInt(a, 10) || 0) + (parseInt(b, 10) || 0);
  }
  return parseInt(str, 10) || 0;
}

// Compute player's actual minutes played in a match.
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

function emptyPlayerCum() {
  return { total_ot: 0, total_att: 0, total_minutes: 0,
           matches_played: 0, opp_strength_sum: 0 };
}

/**
 * Build cumulative tables for all players and teams from KV.
 * v1.4/v1.5 raw schema (no buckets).
 */
export async function buildCumulativeTables(env, fidKickoff = null) {
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

  const luList = await env.MATCH_DATA.list({ prefix: 'match_lineups:' });
  const luFids = (luList.keys || [])
    .map(k => k.name.split(':', 2)[1])
    .filter(fid => fidKickoff.has(fid));
  luFids.sort((a, b) => (fidKickoff.get(a) > fidKickoff.get(b) ? 1 : -1));

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

    // Team init (before player fold so opp_strength uses pre-match state)
    if (!teamCum.has(homeCc)) teamCum.set(homeCc, { matches: 0, goals_conceded: 0, team_ot: 0, ot_against: 0 });
    if (!teamCum.has(awayCc)) teamCum.set(awayCc, { matches: 0, goals_conceded: 0, team_ot: 0, ot_against: 0 });

    const subsList = (lu.events?.substitutions) || [];
    const matchTotalMinutes = parseMinute(lu.match_time) || 90;

    for (const [side, info, sideIsHome] of [
      ['home', home, true], ['away', away, false]
    ]) {
      const oppCc = sideIsHome ? awayCc : homeCc;
      const oppPrevState = teamCum.get(oppCc);
      const oppStrength = computeOppStrength(oppPrevState, ahLine, sideIsHome);

      const startersSet = new Set((info.starting || []).map(p => String(p.player_id || '')));
      const subsSet = new Set((info.substitutes || []).map(p => String(p.player_id || '')));
      const subsWhoCameOn = new Set();
      for (const s of subsList) {
        if (s.side === side) subsWhoCameOn.add(String(s.on_player_id || ''));
      }

      // Build appeared players
      const appearedPlayers = new Map();
      for (const p of [...(info.starting || []), ...(info.substitutes || [])]) {
        const pid = String(p.player_id || ''); if (!pid) continue;
        const pStats = (ms.players || {})[pid];
        const ot = pStats?.shots_on_target || 0;
        const att = pStats?.shots || 0;
        if (startersSet.has(pid)) {
          appearedPlayers.set(pid, { ot, att });
        } else if (subsSet.has(pid) && subsWhoCameOn.has(pid)) {
          appearedPlayers.set(pid, { ot, att });
        }
      }

      // v1.4/v1.5: fold raw cumulative. matches_played 整数 (≥15min +1).
      for (const [pid, stats] of appearedPlayers) {
        const minutes = computePlayerMinutes(pid, startersSet, subsSet, subsList, matchTotalMinutes);
        if (minutes <= 0) continue;
        if (!playerCum.has(pid)) playerCum.set(pid, emptyPlayerCum());
        const pc = playerCum.get(pid);
        pc.total_ot += stats.ot;
        pc.total_att += stats.att;
        pc.total_minutes += minutes;
        if (minutes >= MIN_MINUTES_FOR_MP) pc.matches_played += 1;
        pc.opp_strength_sum += oppStrength;
      }
    }

    // Team fold AFTER player fold
    const eventsGoals = (lu.events?.goals) || [];
    let homeScore = home.score;
    let awayScore = away.score;
    if (homeScore == null) homeScore = eventsGoals.filter(g => g.side === 'home').length;
    if (awayScore == null) awayScore = eventsGoals.filter(g => g.side === 'away').length;
    teamCum.get(homeCc).matches += 1;
    teamCum.get(homeCc).goals_conceded += awayScore;
    teamCum.get(awayCc).matches += 1;
    teamCum.get(awayCc).goals_conceded += homeScore;
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
 * v1.4/v1.5: get player cumulative dict (raw schema, no buckets).
 */
export function getPlayerPerMatch(playerCum, pid) {
  const pc = playerCum.get(String(pid));
  if (!pc) return emptyPlayerCum();
  return {
    total_ot: pc.total_ot,
    total_att: pc.total_att,
    total_minutes: pc.total_minutes,
    matches_played: pc.matches_played,
    opp_strength_sum: pc.opp_strength_sum,
  };
}
