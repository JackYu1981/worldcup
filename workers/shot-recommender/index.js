// worldcup-shot-recommender
//
// Cloudflare Worker that runs every 5 min via cron and (re)computes shot-shot
// recommendations for upcoming WC fixtures. Output is written to KV under
// `recommendation:{fid}` and consumed by /api/recommend/shots/{fid} for the UI.
//
// Two-stage operation:
//   PREVIEW   — runs ≤6h before kickoff if asian_handicap is available but
//               match_lineups is not yet published (or has lineup_available=false).
//               Candidate pool = `players_by_country:{cc}` full roster.
//   CONFIRMED — runs once match_lineups.lineup_available === true.
//               Candidate pool = starting + substitutes (hard constraint per
//               user 2026-06-25: "生成推荐需要在得到fifa的首发阵容之后才可以").
//
// On the PREVIEW → CONFIRMED transition we keep a snapshot of the previous
// preview picks so the UI can render them below as "before-vs-after".
//
// Quotas (Workers Paid):
//   - cron 5min × ~12 fixtures × ≤5 KV reads each + ≤1 write each (hash-short-circuit)
//   - well within the 10M reads/day, 1M invocations/day allowances.
// =============================================================================

// ============= Scoring config (v0.5; thresholds will be ML-tuned via backtest later) =============
const WEIGHTS = {
  on_target_per_match: 0.45,
  attempt_per_match:   0.20,
  position_bonus:      0.15,
  xg_per_match:        0.10,
  starter_bonus:       0.03,
  successor_bonus:     0.07,   // 替补保证: starter-only, +5%w from typical replacement
};
const POSITION_SCORE = { 3: 100, 2: 60, 1: 20, 0: 0, 6: 30 };
// strong/weak split table — same as Python inference for parity
const DISTRIBUTION_RULES = [
  { min: 1.5, strong_frac: 1.0  },  // 让 2 球以上 → 全压强方
  { min: 1.0, strong_frac: 5/6  },  // 让 1 球   → 5:1
  { min: 0.25, strong_frac: 4/6 },  // 让半球    → 4:2
  { min: 0,   strong_frac: 0.5  },  // 平手      → 3:3
];
// Multi-shot score thresholds (will be tuned by backtest later)
const SHOT_T1 = 75;   // score ≥ T1 → 3 shots (elite shooter, can monopolize)
const SHOT_T2 = 60;   // score ≥ T2 → 2 shots
// Total shot budget: 6 default, 7 if either team is ultra-attacking
const BASE_TOTAL_SHOTS = 6;
const TEAM_CAPACITY_BONUS_THRESHOLD = 15;  // sum of on-target/match
// Preview stage: generate 8h before kickoff. Earlier than that, the
// recommendation can be misleading because (a) AH may still be moving, (b)
// FIFA lineup is too far out to matter. Confirmed stage takes over once
// `lineup_available === true` (typically KO - 60min).
// (Widened from 6h to 8h on 2026-06-26: user reported TUN-NED at 6.3h to KO
// had no preview, just outside the boundary. 8h covers all reasonable
// "check-before-bed" use cases without excessive writes.)
const PREVIEW_WINDOW_MS = 8 * 60 * 60_000;  // 8 hours
// Trend bonus to elite shooters when line is rising in their favor
const TREND_BONUS = { rising: 5, falling: -5, stable: 0, null: 0 };

const MODEL_VERSION_PREVIEW = 'v0.5-preview';
const MODEL_VERSION_CONFIRMED = 'v0.5-confirmed';

// ============= Worker entry =============
export default {
  async scheduled(event, env, ctx) {
    try {
      const r = await runRecommender(env);
      console.log('[recommender] tick:', r);
    } catch (e) {
      console.error('[recommender] cron error:', e?.message, e?.stack);
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      try { return Response.json(await runRecommender(env)); }
      catch (e) { return Response.json({ error: e.message, stack: e.stack }, { status: 500 }); }
    }
    if (url.pathname.startsWith('/test/')) {
      const fid = url.pathname.split('/').pop();
      try { return Response.json(await computeOne(env, fid, true)); }
      catch (e) { return Response.json({ error: e.message, stack: e.stack }, { status: 500 }); }
    }
    return new Response('worldcup-shot-recommender alive — /trigger or /test/{fid}', { status: 200 });
  },
};

// ============= Top-level loop =============
async function runRecommender(env) {
  const now = Date.now();
  const fixtures = await findEligibleFixtures(env, now);
  let stats = { eligible: fixtures.length, preview: 0, confirmed: 0, unchanged: 0, skipped: 0, errored: 0 };
  for (const fix of fixtures) {
    try {
      const r = await computeOne(env, fix.id, false, fix);
      if (r.wrote === false) stats.unchanged++;
      else if (r.stage === 'preview') stats.preview++;
      else if (r.stage === 'confirmed') stats.confirmed++;
      else stats.skipped++;
    } catch (e) {
      console.warn(`[recommender] ${fix.id} failed:`, e?.message);
      stats.errored++;
    }
  }
  return stats;
}

/**
 * Find upcoming WC fixtures eligible for either preview or confirmed stage.
 * Eligibility:
 *   - league === '世界杯'
 *   - status !== 'finished'
 *   - kickoff > now (not started)
 *   - within PREVIEW_WINDOW_MS of kickoff (i.e. KO - now ≤ 6h)
 */
async function findEligibleFixtures(env, now) {
  // 500.com groups fixtures by "matchday date" which mostly follows UTC date,
  // not Beijing date. ECU-GER (kickoff 2026-06-26T04:00 BJ = 2026-06-25T20:00
  // UTC) lives in matches:2026-06-25, not matches:2026-06-26.
  //
  // Don't trust the date-key for matching the window — list ALL matches:*
  // buckets and filter by each fixture's kickoff field directly. The KV
  // namespace has at most ~50 date buckets for an entire World Cup, so the
  // list+read cost is well within budget.
  const listRes = await env.MATCH_DATA.list({ prefix: 'matches:' });
  const buckets = await Promise.all(
    listRes.keys.map(k => env.MATCH_DATA.get(k.name, 'json'))
  );
  const seen = new Set();
  const out = [];
  for (const bucket of buckets) {
    if (!bucket?.matches) continue;
    for (const m of bucket.matches) {
      if (!m.id || seen.has(m.id)) continue;
      if (m.league !== '世界杯') continue;
      if (m.status === 'finished') continue;
      seen.add(m.id);
      let ko;
      try { ko = parseKickoffBeijing(m).getTime(); } catch { continue; }
      if (ko <= now) continue;
      if (ko - now > PREVIEW_WINDOW_MS) continue;
      m._ko_ms = ko;
      out.push(m);
    }
  }
  return out;
}

// ============= Per-fixture compute =============
/**
 * Compute (and optionally write) a recommendation for one fixture.
 * fixtureHint: optional match object from findEligibleFixtures (avoids re-read).
 */
async function computeOne(env, fid, includeDebug = false, fixtureHint = null) {
  if (!fid.startsWith('f')) fid = `f${fid}`;
  const nowIso = new Date().toISOString().replace(/Z$/, '+00:00');

  // === Load inputs ===
  const [mapping, lineup, handicap, existing] = await Promise.all([
    env.MATCH_DATA.get(`fixture_mapping:${fid}`, 'json'),
    env.MATCH_DATA.get(`match_lineups:${fid}`, 'json'),
    env.MATCH_DATA.get(`asian_handicap:${fid}`, 'json'),
    env.MATCH_DATA.get(`recommendation:${fid}`, 'json'),
  ]);
  if (!mapping?.home_code) return { wrote: false, skipped: 'no_mapping' };
  if (!handicap?.current) return { wrote: false, skipped: 'no_ah' };

  const hasLineup = !!(lineup && lineup.lineup_available);
  const stage = hasLineup ? 'confirmed' : 'preview';

  // === Strong-side decision from AH (Crown sign convention) ===
  const { strongSide, lineAbs, trend } = decideStrongSide(handicap);
  const totalShots = await decideTotalShots(env, mapping, lineup, strongSide);
  const { strongCount, weakCount } = decideDistribution(lineAbs, totalShots);

  // === Build candidate pools per stage ===
  const pools = await buildPools(env, mapping, lineup, stage);
  if (!pools.home.length || !pools.away.length) {
    return { wrote: false, skipped: `empty_pool_${stage}`, home: pools.home.length, away: pools.away.length };
  }

  // === Score everyone (successor_bonus deferred to phase C; pass 0 for now) ===
  const scored = {
    home: pools.home.map(({ player, isStarter }) => ({ player, isStarter, score: scorePlayer(player, isStarter, 0) })),
    away: pools.away.map(({ player, isStarter }) => ({ player, isStarter, score: scorePlayer(player, isStarter, 0) })),
  };

  // === Pick with multi-shot threshold buckets ===
  const trendBonus = TREND_BONUS[trend] ?? 0;
  const strongPicks = pickWithMultiShot(scored[strongSide], strongCount, trendBonus);
  const weakSide = strongSide === 'home' ? 'away' : 'home';
  const weakPicks = pickWithMultiShot(scored[weakSide], weakCount, 0);

  // === Compose final payload picks list ===
  // Include `shirt_number` + `country_code` so the UI doesn't need a separate
  // lookup. In preview stage `shirt_number` may be null (no lineup yet);
  // confirmed stage always has it because pools come from the lineup itself.
  const strongCountry = strongSide === 'home' ? mapping.home_code : mapping.away_code;
  const weakCountry = weakSide === 'home' ? mapping.home_code : mapping.away_code;
  // Bug fix #1782443374169: shot-rec UI must show ENGLISH names, never Chinese.
  // (Chinese names are reserved for player-card multilang display only.)
  //
  // Root cause: both `name_default` AND occasionally `name.eng` can be polluted
  // with Chinese characters — lineup.js writes `name_default = enName || existing
  // .name_default`, and a single bad lineup payload (FIFA returns Chinese in the
  // `eng` slot at times) sticks because subsequent writes use OR-fallback. We've
  // verified this on f1359193 / 2026-06-26: Pepi pid=419082 had name_default =
  // '里卡多 佩皮' at recommendation gen time, then team-v3-refresh repaired it.
  //
  // Defense in depth: pick the first candidate that's both present AND CJK-free.
  // CJK range U+4E00–U+9FFF covers all common Han characters; we don't care about
  // exotic CJK extensions for player names.
  const CJK = /[一-鿿]/;
  const isAscii = (s) => typeof s === 'string' && s.length > 0 && !CJK.test(s);
  const enName = (p) => {
    const candidates = [p.name?.eng, p.name_default];
    for (const c of candidates) if (isAscii(c)) return c;
    return `Player ${p.id}`;
  };
  const picks = [
    ...strongPicks.map(p => ({
      pid: String(p.player.id),
      name: enName(p.player),
      side: strongSide,
      shots: p.shots,
      score: p.score.total,
      via: p.isStarter ? 'starting' : 'substitute',
      shirt_number: p.player.shirt_number ?? null,
      country_code: strongCountry,
      reason: buildReason(p, true, lineAbs, trend),
    })),
    ...weakPicks.map(p => ({
      pid: String(p.player.id),
      name: enName(p.player),
      side: weakSide,
      shots: p.shots,
      score: p.score.total,
      via: p.isStarter ? 'starting' : 'substitute',
      shirt_number: p.player.shirt_number ?? null,
      country_code: weakCountry,
      reason: buildReason(p, false, lineAbs, trend),
    })),
    ...strongPicks.map(p => ({
      pid: String(p.player.id),
      name: enName(p.player),
      side: strongSide,
      shots: p.shots,
      score: p.score.total,
      via: p.isStarter ? 'starting' : 'substitute',
      shirt_number: p.player.shirt_number ?? null,
      country_code: strongCountry,
      reason: buildReason(p, true, lineAbs, trend),
    })),
    ...weakPicks.map(p => ({
      pid: String(p.player.id),
      name: enName(p.player),
      side: weakSide,
      shots: p.shots,
      score: p.score.total,
      via: p.isStarter ? 'starting' : 'substitute',
      shirt_number: p.player.shirt_number ?? null,
      country_code: weakCountry,
      reason: buildReason(p, false, lineAbs, trend),
    })),
  ];

  // === Build payload ===
  const modelVersion = stage === 'confirmed' ? MODEL_VERSION_CONFIRMED : MODEL_VERSION_PREVIEW;
  const payload = {
    fixture_id: fid,
    stage,
    strong_side: strongSide,
    line_abs: lineAbs,
    distribution: [strongCount, weakCount],
    trend,
    total_shots: picks.reduce((s, p) => s + p.shots, 0),
    picks,
    model_version: modelVersion,
    generated_at: nowIso,
    inputs_snapshot: {
      ah_current: handicap.current,
      ah_open: handicap.open,
      lineup_available: hasLineup,
      home_pool_size: pools.home.length,
      away_pool_size: pools.away.length,
    },
    // preview_snapshot is filled below on the preview → confirmed transition
    preview_snapshot: existing?.preview_snapshot ?? null,
    preview_to_confirmed_at: existing?.preview_to_confirmed_at ?? null,
  };

  // === Preview → Confirmed transition snapshot ===
  if (stage === 'confirmed' && existing?.stage === 'preview') {
    payload.preview_snapshot = {
      picks: existing.picks,
      strong_side: existing.strong_side,
      distribution: existing.distribution,
      total_shots: existing.total_shots,
      model_version: existing.model_version,
      generated_at: existing.generated_at,
    };
    payload.preview_to_confirmed_at = nowIso;
  }

  // === Skip writing if already confirmed and inputs unchanged ===
  // hash-short-circuit: signature over picks + meta (everything that matters
  // for the UI). If unchanged AND the stage is the same, no KV write.
  const sig = signaturePayload(payload);
  if (existing && existing._hash === sig && existing.stage === stage) {
    return { wrote: false, stage, fid, unchanged: true, snapshot: includeDebug ? payload : undefined };
  }
  payload._hash = sig;

  await env.MATCH_DATA.put(`recommendation:${fid}`, JSON.stringify(payload));
  return { wrote: true, stage, fid, snapshot: includeDebug ? payload : undefined };
}

// ============= Scoring =============
function safeDiv(a, b) { return b ? a / b : 0; }

function scorePlayer(player, isStarter, successorNorm = 0) {
  const ts = player.tournament_stats || {};
  const att = ts.attacking || {};
  const mp = ts.matches_played || 0;
  const minutes = ts.minutes_played || 0;

  const onTarget = safeDiv(att.attempt_at_goal_on_target || 0, mp);
  const onTargetNorm = Math.min(100, onTarget * 15);
  const attempt = safeDiv(att.attempt_at_goal || 0, mp);
  const attemptNorm = Math.min(100, attempt * 10);
  const pos = player.position ?? 6;
  const positionNorm = POSITION_SCORE[pos] ?? 30;
  const xg = safeDiv(att.xg || 0, mp);
  const xgNorm = Math.min(100, xg * 30);
  const starterNorm = isStarter ? 100 : 0;
  const effSuccessorNorm = isStarter ? successorNorm : 0;

  const total =
      WEIGHTS.on_target_per_match * onTargetNorm
    + WEIGHTS.attempt_per_match   * attemptNorm
    + WEIGHTS.position_bonus      * positionNorm
    + WEIGHTS.xg_per_match        * xgNorm
    + WEIGHTS.starter_bonus       * starterNorm
    + WEIGHTS.successor_bonus     * effSuccessorNorm;

  return {
    total: Math.round(total * 100) / 100,
    raw: {
      on_target_per_match: Math.round(onTarget * 100) / 100,
      attempt_per_match:   Math.round(attempt * 100) / 100,
      xg_per_match:        Math.round(xg * 100) / 100,
      matches_played:      mp,
      minutes_played:      minutes,
      is_starter:          isStarter,
      position:            pos,
      successor_norm:      Math.round(effSuccessorNorm * 10) / 10,
    },
  };
}

/**
 * Score-bucket multi-shot allocation: pure threshold mapping, no rank cap.
 * Elite shooters CAN monopolize the whole quota (per user 2026-06-25:
 * "强队的优秀射手可以独占两次甚至更高").
 *
 *   score (+ trend_bonus) ≥ SHOT_T1 → 3 shots
 *   score (+ trend_bonus) ≥ SHOT_T2 → 2 shots
 *   else                            → 1 shot
 * Truncate to quotaRemaining; iterate until quota=0.
 */
function pickWithMultiShot(scored, quota, trendBonus = 0) {
  if (quota <= 0) return [];
  // sort desc by score
  const sorted = [...scored].sort((a, b) => b.score.total - a.score.total);
  const out = [];
  let remaining = quota;
  for (const entry of sorted) {
    if (remaining <= 0) break;
    const adj = entry.score.total + trendBonus;
    let shots;
    if (adj >= SHOT_T1)      shots = 3;
    else if (adj >= SHOT_T2) shots = 2;
    else                     shots = 1;
    shots = Math.min(shots, remaining);
    out.push({ ...entry, shots });
    remaining -= shots;
  }
  return out;
}

function decideStrongSide(handicap) {
  // 500.com Crown sign convention (verified 2026-06-25):
  //   line > 0 → 主队受让 → AWAY is strong
  //   line < 0 → 主队让   → HOME is strong
  //   line == 0 → pick-em
  const cur = handicap.current || handicap;
  const line = Number(cur.line) || 0;
  const trend = handicap.trend ?? 'stable';
  if (line > 0.01)  return { strongSide: 'away', lineAbs: Math.abs(line), trend };
  if (line < -0.01) return { strongSide: 'home', lineAbs: Math.abs(line), trend };
  return { strongSide: 'home', lineAbs: 0, trend };  // pick-em fallback to home
}

/**
 * Total shot budget: default 6; bump to 7 if EITHER team's attacking capacity
 * is "ultra-elite" (sum of starter on_target/match ≥ 15 across the lineup, OR
 * — preview stage — sum across the country roster top 14 ≥ 15).
 */
async function decideTotalShots(env, mapping, lineup, strongSide) {
  const capacities = await Promise.all([
    teamAttackCapacity(env, mapping.home_code, lineup, 'home'),
    teamAttackCapacity(env, mapping.away_code, lineup, 'away'),
  ]);
  if (Math.max(...capacities) >= TEAM_CAPACITY_BONUS_THRESHOLD) return BASE_TOTAL_SHOTS + 1;
  return BASE_TOTAL_SHOTS;
}

async function teamAttackCapacity(env, countryCode, lineup, side) {
  // If lineup published, sum on_target/match across starters + 0.5×substitutes.
  // Otherwise use top 14 (rough starter+key-sub estimate) from country roster.
  let players = [];
  let isFromLineup = false;
  if (lineup && lineup.lineup_available && lineup[side]) {
    const team = lineup[side];
    const starting = team.starting || [];
    const subs = team.substitutes || [];
    const starterPids = starting.map(s => s.player_id);
    const subPids = subs.map(s => s.player_id);
    const [starterP, subP] = await Promise.all([
      Promise.all(starterPids.map(pid => env.MATCH_DATA.get(`players:${pid}`, 'json'))),
      Promise.all(subPids.map(pid => env.MATCH_DATA.get(`players:${pid}`, 'json'))),
    ]);
    players = [
      ...starterP.filter(Boolean).map(p => ({ p, weight: 1.0 })),
      ...subP.filter(Boolean).map(p => ({ p, weight: 0.5 })),
    ];
    isFromLineup = true;
  } else {
    const roster = await env.MATCH_DATA.get(`players_by_country:${countryCode}`, 'json');
    if (!roster?.roster) return 0;
    const allP = await Promise.all(roster.roster.slice(0, 14).map(s => env.MATCH_DATA.get(`players:${s.player_id}`, 'json')));
    players = allP.filter(Boolean).map(p => ({ p, weight: 0.8 }));  // top 14 ≈ likely lineup, light discount
  }
  let cap = 0;
  for (const { p, weight } of players) {
    const att = p.tournament_stats?.attacking || {};
    const mp = p.tournament_stats?.matches_played || 0;
    if (!mp) continue;
    cap += weight * safeDiv(att.attempt_at_goal_on_target || 0, mp);
  }
  return cap;
}

function decideDistribution(lineAbs, totalShots) {
  let strongFrac;
  for (const rule of DISTRIBUTION_RULES) {
    if (lineAbs >= rule.min) { strongFrac = rule.strong_frac; break; }
  }
  if (strongFrac == null) strongFrac = 0.5;
  let strongCount = Math.round(totalShots * strongFrac);
  if (strongFrac === 1.0) strongCount = totalShots;  // 让 2 球+ 全压
  let weakCount = totalShots - strongCount;
  if (strongCount + weakCount !== totalShots) weakCount = totalShots - strongCount;
  return { strongCount, weakCount };
}

// ============= Pool construction =============
async function buildPools(env, mapping, lineup, stage) {
  const pools = { home: [], away: [] };
  if (stage === 'confirmed') {
    // Hard constraint: candidates must be in starting + substitutes
    for (const side of ['home', 'away']) {
      const team = lineup[side] || {};
      for (const grpKey of ['starting', 'substitutes']) {
        const isStarter = grpKey === 'starting';
        const list = team[grpKey] || [];
        const fetched = await Promise.all(list.map(s => env.MATCH_DATA.get(`players:${s.player_id}`, 'json')));
        list.forEach((stub, i) => {
          const p = fetched[i];
          if (!p) return;
          p.shirt_number = stub.shirt_number;
          p.position = stub.position ?? p.position;
          pools[side].push({ player: p, isStarter });
        });
      }
    }
  } else {
    // Preview: pool = entire country roster, all marked is_starter=false
    // (we don't pretend to know who'll start; ranking by score alone)
    for (const side of ['home', 'away']) {
      const code = side === 'home' ? mapping.home_code : mapping.away_code;
      const roster = await env.MATCH_DATA.get(`players_by_country:${code}`, 'json');
      if (!roster?.roster) continue;
      const fetched = await Promise.all(roster.roster.map(s => env.MATCH_DATA.get(`players:${s.player_id}`, 'json')));
      roster.roster.forEach((stub, i) => {
        const p = fetched[i];
        if (!p) return;
        p.shirt_number = stub.shirt_number ?? p.shirt_number;
        p.position = stub.position ?? p.position;
        // In preview, everyone is treated as a potential starter for scoring
        // purposes; this gives the starter_bonus to all candidates so position
        // + shot density dominate. UI surfaces this with the "🔮 预测版" badge.
        pools[side].push({ player: p, isStarter: true });
      });
    }
  }
  return pools;
}

// ============= Reason builder (Chinese — UI-facing) =============
const POS_LABEL = { 0: '门将', 1: '后卫', 2: '中场', 3: '前锋', 6: '其他' };
function buildReason(pickEntry, isStrongSide, lineAbs, trend) {
  const p = pickEntry.player;
  const raw = pickEntry.score.raw;
  const parts = [];
  if (pickEntry.shots > 1) parts.push(`顶级权重投 ${pickEntry.shots} 次`);
  if (raw.on_target_per_match > 0) {
    let kpi = `均场射正 ${raw.on_target_per_match}、均场射门 ${raw.attempt_per_match}`;
    if (raw.xg_per_match) kpi += `、xG ${raw.xg_per_match}/场`;
    parts.push(kpi);
  }
  parts.push(raw.is_starter ? '首发' : '替补');
  if (isStrongSide) {
    if (lineAbs >= 1.5)       parts.push(`对手让 ${lineAbs} 球，进攻空间大`);
    else if (lineAbs >= 1.0)  parts.push(`对手让 ${lineAbs} 球，机会多`);
    else if (lineAbs >= 0.25) parts.push(`对手让 ${lineAbs} 球，略胜`);
    else                      parts.push('平手盘，势均力敌');
    if (trend === 'rising')   parts.push('📈 升盘，庄家加码');
    else if (trend === 'falling') parts.push('📉 降盘，强队信心动摇');
  } else {
    parts.push(`弱队进攻威胁（对手让 ${lineAbs}）`);
  }
  parts.push(`综合 ${pickEntry.score.total.toFixed(1)}/100`);
  return parts.join(' · ');
}

// ============= Signature (hash) for write short-circuit =============
function signaturePayload(p) {
  // Hash only the user-visible part — picks + stage + meta. Avoids re-write
  // when only insignificant fields like generated_at differ.
  const sigInput = JSON.stringify({
    stage: p.stage,
    strong_side: p.strong_side,
    line_abs: p.line_abs,
    distribution: p.distribution,
    trend: p.trend,
    total_shots: p.total_shots,
    picks: p.picks.map(x => ({ pid: x.pid, side: x.side, shots: x.shots, via: x.via })),
  });
  return fnv1a(sigInput);
}
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ============= Time utils =============
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
function parseKickoffBeijing(fixture) {
  if (!fixture?.kickoff) throw new Error('no kickoff');
  const ko = fixture.kickoff.trim();
  let Y, M, D, h, m;
  const full = ko.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (full) [, Y, M, D, h, m] = full;
  else {
    if (!fixture.date) throw new Error('no date+kickoff');
    const ymd = fixture.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const hm = ko.match(/^(\d{2}):(\d{2})$/);
    if (!ymd || !hm) throw new Error('bad ko');
    [, Y, M, D] = ymd; [, h, m] = hm;
  }
  return new Date(Date.UTC(+Y, +M - 1, +D, +h, +m, 0) - BEIJING_OFFSET_MS);
}
function beijingDateStr(epochMs) {
  const d = new Date(epochMs + BEIJING_OFFSET_MS);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}
