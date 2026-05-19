import { logger } from './logger.js';
import { evaluatePlan } from './evaluate.js';

/**
 * 结算所有 pending 方案：把所有 matches:* 合成一个比赛池（按 match_id 去重），
 * 用统一的比赛池评估每个 plan（支持跨期串单 —— plan.legs 里的比赛可以来自不同 period）。
 * 已决出的搬到 aggregate:settled_plans。返回 { newlySettled, stillPending }。
 */
export async function settlePendingPlans(kv) {
  const pendingData = await kv.get('aggregate:unsettled_plans', 'json');
  const pending = pendingData ? (pendingData.plans || []) : [];
  if (pending.length === 0) return { newlySettled: [], stillPending: [] };

  const settledData = await kv.get('aggregate:settled_plans', 'json');
  const settled = settledData ? (settledData.plans || []) : [];

  const allMatches = await loadAllMatches(kv);

  const newlySettled = [];
  const stillPending = [];
  for (const plan of pending) {
    const evaluated = evaluatePlan(plan, allMatches);
    if (evaluated.status === 'won' || evaluated.status === 'lost') {
      newlySettled.push(evaluated);
    } else {
      stillPending.push(evaluated);
    }
  }

  if (newlySettled.length > 0) {
    await kv.put('aggregate:settled_plans', JSON.stringify({ plans: [...settled, ...newlySettled] }));
    await kv.put('aggregate:unsettled_plans', JSON.stringify({ plans: stillPending }));
    for (const p of newlySettled) {
      await logger(kv, '开奖', `"${p.passphrase || '未命名'}" → ${p.status === 'won' ? '中奖' : '未中'}`);
    }
  }

  return { newlySettled, stillPending };
}

// 把所有 matches:* 的 matches 合成一个数组（按 id 去重，留有 score 的版本）
async function loadAllMatches(kv) {
  const list = await kv.list({ prefix: 'matches:' });
  const byId = new Map();
  for (const key of list.keys || []) {
    const env = await kv.get(key.name, 'json');
    if (!env || !Array.isArray(env.matches)) continue;
    for (const m of env.matches) {
      if (!m || !m.id) continue;
      const existing = byId.get(m.id);
      // 优先保留有 score 的版本
      if (!existing || (!existing.score && m.score)) {
        byId.set(m.id, m);
      }
    }
  }
  return Array.from(byId.values());
}
