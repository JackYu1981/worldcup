import { logger } from './logger.js';
import { evaluatePlan } from './evaluate.js';

/**
 * 结算所有 pending 方案：从 plans:pending 读出 → 用对应 period 的 matches 评估
 * → 已决出的搬到 plans:settled。返回 { newlySettled, stillPending }。
 */
export async function settlePendingPlans(kv) {
  const pendingData = await kv.get('plans:pending', 'json');
  const pending = pendingData ? (pendingData.plans || []) : [];
  if (pending.length === 0) return { newlySettled: [], stillPending: [] };

  const settledData = await kv.get('plans:settled', 'json');
  const settled = settledData ? (settledData.plans || []) : [];

  const periods = [...new Set(pending.map(p => p.period || p.date).filter(Boolean))];
  const matchCache = {};
  for (const period of periods) {
    const mData = await kv.get(`matches:${period}`, 'json');
    matchCache[period] = mData ? mData.matches : [];
  }

  const newlySettled = [];
  const stillPending = [];
  for (const plan of pending) {
    const period = plan.period || plan.date;
    const matches = matchCache[period] || [];
    const evaluated = evaluatePlan(plan, matches);
    if (evaluated.status === 'won' || evaluated.status === 'lost') {
      newlySettled.push(evaluated);
    } else {
      stillPending.push(evaluated);
    }
  }

  if (newlySettled.length > 0) {
    await kv.put('plans:settled', JSON.stringify({ plans: [...settled, ...newlySettled] }));
    await kv.put('plans:pending', JSON.stringify({ plans: stillPending }));
    for (const p of newlySettled) {
      await logger(kv, '开奖', `"${p.passphrase || '未命名'}" → ${p.status === 'won' ? '中奖' : '未中'}`);
    }
  }

  return { newlySettled, stillPending };
}
