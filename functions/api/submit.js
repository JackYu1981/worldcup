import { verifyToken } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { json, error, options } from '../lib/response.js';

// 单据日期 = 服务器北京时区当天 YYYY-MM-DD
// 推荐/预备方案/最终方案的 grouping key 都用单据日期，与赛程的 period（销售期次）无关
function beijingToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) {
      return error('未登录或登录已过期', 401);
    }

    const body = await context.request.json();
    const { passphrase, source } = body;

    // date 由服务器决定，忽略前端传值
    const date = beijingToday();
    body.date = date;
    delete body.period;

    if (source !== 'recommendation' && !passphrase) {
      return error('方案需要口令', 400);
    }

    body.submitted_by = user.username;
    body.submitted_at = new Date().toISOString();

    const kv = context.env.MATCH_DATA;

    // 提交预备方案：先在最近的 recommendations:* 里找匹配源 rec、打 pending_plan_passphrase 标记
    if (source === 'pending_plan') {
      const stampResult = await stampRecommendation(kv, date, body.legs, passphrase);
      if (stampResult.error) {
        return error(stampResult.error, 400);
      }
    }

    // plan：去重检查（同 passphrase 已存在则拒绝）
    if (source === 'plan') {
      const dupCheck = await checkPlanDuplicate(kv, passphrase);
      if (dupCheck.duplicate) {
        return error(`方案"${passphrase}"已生成，不可重复生成（位于 ${dupCheck.location}）`, 409);
      }
    }

    await writeToKv(kv, source, date, body);

    if (source === 'pending_plan') {
      await logger(kv, '方案', `预备方案提交: "${passphrase}" (${date}) by ${user.username}`);
    } else if (source === 'recommendation') {
      const legsCount = (body.legs || []).length;
      await logger(kv, '推荐', `推荐提交: ${legsCount}场组合 (${date}) by ${user.username}`);
    } else if (source === 'plan') {
      const pEff = body.p_eff !== undefined ? `P_eff=${(body.p_eff * 100).toFixed(2)}%` : '';
      const nCov = body.n_cov !== undefined ? `N_cov=${body.n_cov}` : '';
      const total = body.total_stake !== undefined ? `total=${body.total_stake}` : '';
      const metrics = [pEff, nCov, total].filter(Boolean).join(', ');
      await logger(kv, '方案', `方案生成: "${passphrase}" (${date}) by ${user.username}${metrics ? ', ' + metrics : ''}`);
    }

    return json({ success: true });
  } catch (e) {
    return error(e.message);
  }
}

// 给匹配的 recommendation 打上 pending_plan_passphrase 标记。
// 匹配规则：legs 的 (match_id+pick) 集合完全相等。
// 硬约束：rec 已有 pending_plan_passphrase 即拒绝二次提交。
// 先查当天的 recommendations:{date}，找不到则扫最近 7 天（覆盖跨天提交场景）。
async function stampRecommendation(kv, date, legs, passphrase) {
  if (!kv || !legs || legs.length === 0) return {};
  const targetKey = legSetKey(legs);

  const candidateDates = [date];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(date + 'T00:00:00+08:00');
    d.setUTCDate(d.getUTCDate() - i);
    candidateDates.push(d.toISOString().slice(0, 10));
  }

  for (const d of candidateDates) {
    const recsData = await kv.get(`recommendations:${d}`, 'json');
    if (!recsData || !recsData.items) continue;
    for (const rec of recsData.items) {
      if (legSetKey(rec.legs || []) !== targetKey) continue;
      if (rec.pending_plan_passphrase) {
        return { error: `该推荐已提交过预备方案（口令：${rec.pending_plan_passphrase}），不可重复提交` };
      }
      rec.pending_plan_passphrase = passphrase;
      await kv.put(`recommendations:${d}`, JSON.stringify(recsData));
      return {};
    }
  }
  return {};
}

function legSetKey(legs) {
  return [...new Set(legs.map(l => `${l.match_id}+${l.pick}`))].sort().join('|');
}

async function writeToKv(kv, source, date, data) {
  if (!kv) throw new Error('KV namespace not bound');
  let key;
  if (source === 'recommendation') {
    key = `recommendations:${date}`;
  } else if (source === 'pending_plan') {
    key = `pending_plans:${date}`;
  } else {
    key = `plans:${date}`;
  }
  const existing = await kv.get(key, 'json');
  let items = existing ? existing.items : [];
  if (source === 'plan' && data.passphrase) {
    items = items.filter(p => p.passphrase !== data.passphrase);
  }
  items.push(data);
  await kv.put(key, JSON.stringify({ date, items }));

  if (source === 'plan') {
    const pendingData = await kv.get('aggregate:unsettled_plans', 'json');
    let pending = pendingData ? pendingData.plans : [];
    if (data.passphrase) {
      pending = pending.filter(p => p.passphrase !== data.passphrase);
    }
    pending.push(data);
    await kv.put('aggregate:unsettled_plans', JSON.stringify({ plans: pending }));
  }
}

// 同口令查重：扫 plans:* 和 aggregate:unsettled_plans / aggregate:settled_plans
async function checkPlanDuplicate(kv, passphrase) {
  const unsettled = await kv.get('aggregate:unsettled_plans', 'json');
  if (unsettled && Array.isArray(unsettled.plans)) {
    const hit = unsettled.plans.find(p => p.passphrase === passphrase);
    if (hit) return { duplicate: true, location: 'aggregate:unsettled_plans' };
  }
  const settled = await kv.get('aggregate:settled_plans', 'json');
  if (settled && Array.isArray(settled.plans)) {
    const hit = settled.plans.find(p => p.passphrase === passphrase);
    if (hit) return { duplicate: true, location: 'aggregate:settled_plans' };
  }
  return { duplicate: false };
}

export function onRequestOptions() {
  return options();
}
