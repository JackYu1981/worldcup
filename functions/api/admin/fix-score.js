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
    envelope.fetched_at = new Date().toISOString();
    await kv.put(`matches:${period}`, JSON.stringify(envelope));

    const pendingData = await kv.get('aggregate:pending_plans', 'json');
    const settledData = await kv.get('aggregate:settled_plans', 'json');
    const pending = pendingData ? (pendingData.plans || []) : [];
    const settled = settledData ? (settledData.plans || []) : [];

    const planChanges = [];

    const newPending = [];
    pending.forEach(plan => {
      if ((plan.period || plan.date) !== period) {
        newPending.push(plan);
        return;
      }
      const oldStatus = plan.status || 'pending';
      const evaluated = evaluatePlan(plan, matches);
      const newStatus = evaluated.status || 'pending';
      if (oldStatus !== newStatus) {
        planChanges.push({ passphrase: evaluated.passphrase || '未命名', old: oldStatus, new: newStatus });
      }
      if (newStatus === 'won' || newStatus === 'lost') {
        settled.push(evaluated);
      } else {
        newPending.push(evaluated);
      }
    });

    const newSettled = [];
    settled.forEach(plan => {
      if ((plan.period || plan.date) !== period) {
        newSettled.push(plan);
        return;
      }
      const oldStatus = plan.status || 'pending';
      const evaluated = evaluatePlan(plan, matches);
      const newStatus = evaluated.status || 'pending';
      if (oldStatus !== newStatus) {
        planChanges.push({ passphrase: evaluated.passphrase || '未命名', old: oldStatus, new: newStatus });
      }
      if (newStatus === 'won' || newStatus === 'lost') {
        newSettled.push(evaluated);
      } else {
        newPending.push(evaluated);
      }
    });

    await kv.put('aggregate:pending_plans', JSON.stringify({ plans: newPending }));
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

export function onRequestOptions() {
  return options();
}
