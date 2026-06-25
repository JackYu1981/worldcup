import { json, error, options } from '../../lib/response.js';
import { verifyToken } from '../../lib/auth.js';
import { evaluatePlan } from '../../lib/evaluate.js';
import { logger } from '../../lib/logger.js';

const SCORE_RE = /^\d+-\d+$/;
const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user || user.role !== 'admin') {
      return error('无权限', 401);
    }

    const body = await context.request.json();
    const { period, match_id, code, score, score_ht } = body || {};

    if (!period || !PERIOD_RE.test(period)) return error('period 格式错误', 400);
    if (!score || !SCORE_RE.test(score)) return error('比分格式错误', 400);
    if (!score_ht || !SCORE_RE.test(score_ht)) return error('比分格式错误', 400);
    if (!match_id && !code) return error('缺少 match_id 或 code', 400);

    const kv = context.env.MATCH_DATA;
    const envelope = await kv.get(`matches:${period}`, 'json');
    if (!envelope || !Array.isArray(envelope.matches)) {
      return error('该期无数据', 404);
    }

    const matches = envelope.matches;
    let target = match_id ? matches.find(m => m.id === match_id) : null;
    if (!target && code) target = matches.find(m => m.code === code);
    if (!target) return error('比赛不存在', 400);
    if (target.status !== 'finished') return error('比赛不可编辑', 400);

    const oldScore = target.score;
    const oldScoreHt = target.score_ht;
    if (oldScore === score && oldScoreHt === score_ht) {
      return error('比分未变化', 400);
    }

    target.score = score;
    target.score_ht = score_ht;
    envelope.fetched_at = new Date().toISOString().replace(/Z$/, '+00:00');
    await kv.put(`matches:${period}`, JSON.stringify(envelope));

    // 跨期串单方案的 plan.legs 可能来自不同 period，必须用全量赛程池评估
    const allMatches = await loadAllMatches(kv);
    // 修正比分的目标 match 用最新值覆盖（loadAllMatches 取的可能是缓存里旧的）
    const targetIdx = allMatches.findIndex(m => m.id === target.id);
    if (targetIdx >= 0) allMatches[targetIdx] = target;
    else allMatches.push(target);

    // 仅重算 legs 里包含被修正比赛的 plan
    const affectsPlan = plan => {
      const legs = collectLegs(plan);
      return legs.some(l => l.match_id === target.id || (target.code && l.code === target.code));
    };

    const pendingData = await kv.get('aggregate:unsettled_plans', 'json');
    const settledData = await kv.get('aggregate:settled_plans', 'json');
    const pending = pendingData ? (pendingData.plans || []) : [];
    const settled = settledData ? (settledData.plans || []) : [];

    const planChanges = [];
    const newPending = [];
    const newSettled = [];

    const reEvaluate = (plan, sourceList) => {
      if (!affectsPlan(plan)) {
        sourceList.push(plan);
        return;
      }
      const oldStatus = plan.status || 'pending';
      const evaluated = evaluatePlan(plan, allMatches);
      const newStatus = evaluated.status || 'pending';
      if (oldStatus !== newStatus) {
        planChanges.push({ passphrase: evaluated.passphrase || '未命名', old: oldStatus, new: newStatus });
      }
      if (newStatus === 'won' || newStatus === 'lost') newSettled.push(evaluated);
      else newPending.push(evaluated);
    };

    pending.forEach(p => reEvaluate(p, newPending));
    settled.forEach(p => reEvaluate(p, newSettled));

    await kv.put('aggregate:unsettled_plans', JSON.stringify({ plans: newPending }));
    await kv.put('aggregate:settled_plans', JSON.stringify({ plans: newSettled }));

    const matchDesc = `${target.code || ''} ${target.home || ''}vs${target.away || ''}`.trim();
    await logger(kv, '比分修正',
      `admin ${user.username} 修正 ${period} ${matchDesc}：score ${oldScore || '-'}→${score}, score_ht ${oldScoreHt || '-'}→${score_ht}`);

    for (const ch of planChanges) {
      await logger(kv, '开奖修正',
        `"${ch.passphrase}" ${ch.old}→${ch.new}（因${target.code || target.id}比分修正）`);
    }

    return json({
      success: true,
      updated_match: { code: target.code, score, score_ht },
      plan_changes: planChanges
    });
  } catch (e) {
    return error(e.message, 500);
  }
}

// 收集 plan 中所有 leg（兼容 v2.0 bets[]/v1.x combinations[]/v1.0 legs）
function collectLegs(plan) {
  const legs = [];
  if (Array.isArray(plan.bets)) {
    plan.bets.forEach(b => (b.legs || []).forEach(l => legs.push(l)));
  }
  if (Array.isArray(plan.combinations)) {
    plan.combinations.forEach(c => (c.legs || []).forEach(l => legs.push(l)));
  }
  if (Array.isArray(plan.legs)) plan.legs.forEach(l => legs.push(l));
  return legs;
}

async function loadAllMatches(kv) {
  const list = await kv.list({ prefix: 'matches:' });
  const byId = new Map();
  for (const key of list.keys || []) {
    const env = await kv.get(key.name, 'json');
    if (!env || !Array.isArray(env.matches)) continue;
    for (const m of env.matches) {
      if (!m || !m.id) continue;
      const existing = byId.get(m.id);
      if (!existing || (!existing.score && m.score)) byId.set(m.id, m);
    }
  }
  return Array.from(byId.values());
}

export function onRequestOptions() {
  return options();
}
