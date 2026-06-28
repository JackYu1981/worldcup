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

// ============= Imports =============
import {
  buildFeatureVector,
  scorePlayer as svmScorePlayer,
  buildCumulativeTables,
  getPlayerPerMatch,
  decideBudget as svmDecideBudget,
  quotaSplit as svmQuotaSplit,
  allocateMultiShot as svmAllocateMultiShot,
  BUDGET_TO_PLAYERS,
  MODEL,
} from './lib/svm-score.js';

// ============= Scoring config =============
// Window for preview-stage recommendations: generate ≤ 8h before kickoff.
// Earlier than that, the recommendation can be misleading because (a) AH may
// still be moving, (b) FIFA lineup is too far out to matter. Confirmed stage
// takes over once `lineup_available === true` (typically KO - 60min).
const PREVIEW_WINDOW_MS = 8 * 60 * 60_000;  // 8 hours

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
      try {
        const cumTables = await buildCumulativeTables(env);
        return Response.json(await computeOne(env, fid, true, null, cumTables));
      } catch (e) { return Response.json({ error: e.message, stack: e.stack }, { status: 500 }); }
    }
    return new Response('worldcup-shot-recommender alive — /trigger or /test/{fid}', { status: 200 });
  },
};

// ============= Top-level loop =============
async function runRecommender(env) {
  const now = Date.now();
  const fixtures = await findEligibleFixtures(env, now);
  let stats = { eligible: fixtures.length, preview: 0, confirmed: 0, unchanged: 0, skipped: 0, errored: 0 };
  if (!fixtures.length) return stats;

  // Build walk-forward cumulative tables ONCE per tick (in-memory), reuse
  // across all fixtures. Same data shape that train.py walks forward through —
  // guaranteeing inference features match training distribution.
  let cumTables;
  try {
    cumTables = await buildCumulativeTables(env);
  } catch (e) {
    console.error(`[recommender] buildCumulativeTables failed: ${e?.message}`, e?.stack);
    stats.errored = fixtures.length;
    return stats;
  }

  for (const fix of fixtures) {
    try {
      const r = await computeOne(env, fix.id, false, fix, cumTables);
      if (r.wrote === false && !r.skipped) stats.unchanged++;
      else if (r.stage === 'preview' && r.wrote) stats.preview++;
      else if (r.stage === 'confirmed' && r.wrote) stats.confirmed++;
      else stats.skipped++;
    } catch (e) {
      console.warn(`[recommender] ${fix.id} failed:`, e?.message, e?.stack);
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

  // Manual force-regen: a KV key `force_regen:<fid>` bypasses the ko>now gate.
  // Set the key (any non-empty value) to force this worker tick to regenerate
  // that fid even if kickoff has passed; cron then auto-deletes the key so it
  // only fires once. Useful for backfilling past fixtures after a bug fix.
  const forceList = await env.MATCH_DATA.list({ prefix: 'force_regen:' });
  const forceFids = new Set((forceList.keys || []).map(k => k.name.split(':', 2)[1]));

  const seen = new Set();
  const out = [];
  for (const bucket of buckets) {
    if (!bucket?.matches) continue;
    for (const m of bucket.matches) {
      if (!m.id || seen.has(m.id)) continue;
      if (m.league !== '世界杯') continue;
      seen.add(m.id);
      let ko;
      try { ko = parseKickoffBeijing(m).getTime(); } catch { continue; }
      const isForced = forceFids.has(m.id);
      if (!isForced) {
        if (m.status === 'finished') continue;
        if (ko <= now) continue;
        if (ko - now > PREVIEW_WINDOW_MS) continue;
      }
      m._ko_ms = ko;
      m._forced = isForced;
      out.push(m);
    }
  }

  // After collecting forced fids, delete their trigger keys so this only
  // fires once per request (cron-safe).
  if (forceFids.size > 0) {
    await Promise.all([...forceFids].map(fid =>
      env.MATCH_DATA.delete(`force_regen:${fid}`).catch(() => {})
    ));
  }
  return out;
}

// ============= Per-fixture compute =============
/**
 * Compute (and optionally write) a recommendation for one fixture.
 * fixtureHint: optional match object from findEligibleFixtures (avoids re-read).
 */
async function computeOne(env, fid, includeDebug = false, fixtureHint = null, cumTables = null) {
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

  // === Build candidate pools per stage ===
  const pools = await buildPools(env, mapping, lineup, stage);
  if (!pools.home.length || !pools.away.length) {
    return { wrote: false, skipped: `empty_pool_${stage}`, home: pools.home.length, away: pools.away.length };
  }

  // === SVM scoring: features + Platt-calibrated probability per player ===
  if (!cumTables) cumTables = await buildCumulativeTables(env);
  const { playerCum, teamCum } = cumTables;
  const ahLine = handicap.current?.line ?? null;
  const trend = handicap.trend || 'stable';
  const homeTeamCum = teamCum.get(mapping.home_code) || { matches: 0, goals_conceded: 0, team_ot: 0 };
  const awayTeamCum = teamCum.get(mapping.away_code) || { matches: 0, goals_conceded: 0, team_ot: 0 };

  function scoreOne(player, sideIsHome) {
    const oppCum = sideIsHome ? awayTeamCum : homeTeamCum;
    const ownCum = sideIsHome ? homeTeamCum : awayTeamCum;
    const pm = getPlayerPerMatch(playerCum, player.id);
    const feats = buildFeatureVector(player, oppCum, ahLine, sideIsHome, pm, ownCum);
    const { prob, decision } = svmScorePlayer(feats);
    return { total: Math.round(prob * 1000) / 10, prob, decision };
  }
  const scored = {
    home: pools.home.map(({ player, isStarter }) => ({ player, isStarter, score: scoreOne(player, true) })),
    away: pools.away.map(({ player, isStarter }) => ({ player, isStarter, score: scoreOne(player, false) })),
  };

  // === Allocator-driven quota + multi-shot (hard rule: 6/7/8 → 4/5/5 players) ===
  // Strong side = the one favored by AH (positive own-favoredness from that side).
  const homeOwnFav = ahLine != null ? -ahLine : 0;  // home favored when ah_line < 0
  const awayOwnFav = ahLine != null ?  ahLine : 0;
  const strongSide = homeOwnFav >= awayOwnFav ? 'home' : 'away';
  const weakSide = strongSide === 'home' ? 'away' : 'home';
  const strongFav = strongSide === 'home' ? homeOwnFav : awayOwnFav;
  const lineAbs = Math.abs(ahLine ?? 0);

  // Team attacking capacity (sum of historical on_target / matches over candidates)
  // v1.5 schema: total_ot / matches_played
  const teamCap = (sidePool) => sidePool.reduce((acc, e) => {
    const pm = getPlayerPerMatch(playerCum, e.player.id);
    const mp = pm.matches_played || 0;
    const otpm = mp > 0 ? pm.total_ot / mp : 0;
    return acc + Math.max(0, otpm);
  }, 0);
  const homeCapacity = teamCap(pools.home);
  const awayCapacity = teamCap(pools.away);

  const budget = svmDecideBudget(homeCapacity, awayCapacity, ahLine);
  const maxPlayers = BUDGET_TO_PLAYERS[budget];

  // Sort by prob desc within each side (needed before quota adjustment)
  const sortedStrong = scored[strongSide]
    .slice().sort((a, b) => b.score.prob - a.score.prob)
    .map(e => ({ player: e.player, prob: e.score.prob, score: e.score, isStarter: e.isStarter }));
  const sortedWeak = scored[weakSide]
    .slice().sort((a, b) => b.score.prob - a.score.prob)
    .map(e => ({ player: e.player, prob: e.score.prob, score: e.score, isStarter: e.isStarter }));

  // v1.2 (2026-06-27): COMPREHENSIVE strong/weak判定 — 综合让球 + attacking 数据
  // Default quota from AH line magnitude
  let { strong: strongCount, weak: weakCount } = svmQuotaSplit(budget, strongFav);

  // Rule 1: 弱队整体进攻数据极弱 → 即使受让不大也降级
  // 本队 team_capacity (own attacking ot/match) > 1.5x 对手 → 给对手减一注 + 强队加一注
  const strongTeamCum = strongSide === 'home' ? homeTeamCum : awayTeamCum;
  const weakTeamCum = strongSide === 'home' ? awayTeamCum : homeTeamCum;
  const strongTeamOtPerMatch = strongTeamCum.matches > 0
    ? (strongTeamCum.team_ot || 0) / strongTeamCum.matches : 0;
  const weakTeamOtPerMatch = weakTeamCum.matches > 0
    ? (weakTeamCum.team_ot || 0) / weakTeamCum.matches : 0;
  // 如果弱队整体进攻远低于强队 (< 50%)，把 weak 多一注挪给 strong
  if (weakCount > 0 && weakTeamOtPerMatch > 0 && strongTeamOtPerMatch > 0
      && weakTeamOtPerMatch < 0.5 * strongTeamOtPerMatch) {
    strongCount += 1;
    weakCount -= 1;
  }

  // Rule 2: 弱队强候选保底 — 如果弱队 top-1 prob ≥ 强队 top-1 prob × 0.65，
  // 强制保 weak 至少 1 注 (从 strong 借)
  const FLOOR_RATIO = 0.65;
  if (weakCount === 0 && sortedWeak.length > 0 && sortedStrong.length > 0) {
    const strongTopProb = sortedStrong[0]?.prob ?? 0;
    const weakTopProb = sortedWeak[0]?.prob ?? 0;
    if (strongTopProb > 0 && weakTopProb >= strongTopProb * FLOOR_RATIO) {
      strongCount -= 1;
      weakCount += 1;
    }
  }

  const strongMaxP = strongCount > 0
    ? Math.max(1, Math.round(maxPlayers * strongCount / budget)) : 0;
  const weakMaxP = weakCount > 0 ? (maxPlayers - strongMaxP) : 0;

  const strongAlloc = svmAllocateMultiShot(sortedStrong, strongCount, strongMaxP);
  const weakAlloc = svmAllocateMultiShot(sortedWeak, weakCount, weakMaxP);

  // === Compose final payload picks list ===
  const strongCountry = strongSide === 'home' ? mapping.home_code : mapping.away_code;
  const weakCountry = weakSide === 'home' ? mapping.home_code : mapping.away_code;
  // Defense-in-depth: shot-rec UI must show ENGLISH names, never Chinese.
  // (CJK in name_default + name.eng has been observed — pick first ASCII candidate.)
  const CJK = /[一-鿿]/;
  const isAscii = (s) => typeof s === 'string' && s.length > 0 && !CJK.test(s);
  const enName = (p) => {
    const candidates = [p.name?.eng, p.name_default];
    for (const c of candidates) if (isAscii(c)) return c;
    return `Player ${p.id}`;
  };
  const allocToPickObj = (entry, side, country, isStrong) => ({
    pid: String(entry.player.id),
    name: enName(entry.player),
    side,
    shots: entry.shots,
    score: Math.round(entry.score.total * 10) / 10,   // 0..100 derived from prob
    prob: Math.round(entry.score.prob * 1000) / 1000, // 0..1 raw
    via: entry.isStarter ? 'starting' : 'substitute',
    shirt_number: entry.player.shirt_number ?? null,
    country_code: country,
    reason: buildReason({ ...entry, score: entry.score }, isStrong, lineAbs, trend),
  });
  const picks = [
    ...strongAlloc.map(e => allocToPickObj(e, strongSide, strongCountry, true)),
    ...weakAlloc.map(e => allocToPickObj(e, weakSide, weakCountry, false)),
  ];

  // === Candidate pools: top-4 per side for UI manual-adjust reference ===
  const TOP_N_CANDIDATES = 4;
  const candidatePoolFor = (sortedSide, sideName, country) =>
    sortedSide.slice(0, TOP_N_CANDIDATES).map(e => ({
      pid: String(e.player.id),
      name: enName(e.player),
      side: sideName,
      prob: Math.round(e.prob * 1000) / 1000,
      score: Math.round(e.prob * 1000) / 10,
      shirt_number: e.player.shirt_number ?? null,
      country_code: country,
      position: e.player.position ?? null,
      is_starter: e.isStarter,
    }));
  const candidate_pools = {
    [strongSide]: candidatePoolFor(sortedStrong, strongSide, strongCountry),
    [weakSide]: candidatePoolFor(sortedWeak, weakSide, weakCountry),
  };

  // === Build payload ===
  const baseVersion = (MODEL && MODEL.version) || 'v1_svm';
  const modelVersion = `${baseVersion}-${stage}`;
  const payload = {
    fixture_id: fid,
    stage,
    strong_side: strongSide,
    line_abs: lineAbs,
    distribution: [strongCount, weakCount],
    budget,
    max_players: maxPlayers,
    trend,
    total_shots: picks.reduce((s, p) => s + p.shots, 0),
    picks,
    candidate_pools,
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

// ============= Pool construction =============
async function buildPools(env, mapping, lineup, stage) {
  const pools = { home: [], away: [] };
  if (stage === 'confirmed') {
    // Hard constraint (用户 2026-06-27): confirmed 推荐只看 starting，
    // substitutes 不进候选池。"替补保证"原则在 preview 阶段全员入池时已
    // 隐含（preview 时谁会首发不确定，所以全员评分）。一旦 FIFA 公布
    // 首发，sub 出现在确定版方案里属于违规。
    for (const side of ['home', 'away']) {
      const team = lineup[side] || {};
      const list = team.starting || [];
      const fetched = await Promise.all(list.map(s => env.MATCH_DATA.get(`players:${s.player_id}`, 'json')));
      list.forEach((stub, i) => {
        const p = fetched[i];
        if (!p) return;
        p.shirt_number = stub.shirt_number;
        p.position = stub.position ?? p.position;
        pools[side].push({ player: p, isStarter: true });
      });
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
// buildReason — SVM v1.1: 不再依赖 v0 的 score.raw 结构，直接基于 prob + 上下文。
// pickEntry 形状: { player, prob, shots, isStarter, score:{total, prob, decision} }
function buildReason(pickEntry, isStrongSide, lineAbs, trend) {
  const p = pickEntry.player;
  const score = pickEntry.score || {};
  const prob = (score.prob ?? pickEntry.prob ?? 0);
  const probPct = (prob * 100).toFixed(0);
  const parts = [];
  if (pickEntry.shots > 1) parts.push(`顶级权重投 ${pickEntry.shots} 次`);
  parts.push(`SVM 射正概率 ${probPct}%`);
  parts.push(pickEntry.isStarter ? '首发' : '替补');
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
  return parts.join(' · ');
}

// ============= Signature (hash) for write short-circuit =============
function signaturePayload(p) {
  // Hash only the user-visible part — picks + stage + meta + candidate pool
  // ranking. Avoids re-write when only insignificant fields like generated_at
  // differ; but DOES re-write when top-4 candidate ranking changes even if
  // picks themselves are stable (so the "几乎入选"边界 stays fresh).
  const candHomePids = (p.candidate_pools?.home || []).map(c => c.pid).join(',');
  const candAwayPids = (p.candidate_pools?.away || []).map(c => c.pid).join(',');
  const sigInput = JSON.stringify({
    stage: p.stage,
    strong_side: p.strong_side,
    line_abs: p.line_abs,
    distribution: p.distribution,
    trend: p.trend,
    total_shots: p.total_shots,
    picks: p.picks.map(x => ({ pid: x.pid, side: x.side, shots: x.shots, via: x.via })),
    cand_home: candHomePids,
    cand_away: candAwayPids,
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
