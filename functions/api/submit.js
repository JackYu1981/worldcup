import { verifyToken } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { json, error, options } from '../lib/response.js';

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) {
      return error('未登录或登录已过期', 401);
    }

    const body = await context.request.json();
    const { date, passphrase, source } = body;

    if (!date) {
      return error('缺少日期字段', 400);
    }

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    if (date < todayStr && (source === 'recommendation' || source === 'pending_plan')) {
      return error(`${date} 竞彩已停售，无法提交`, 400);
    }

    if (source !== 'recommendation' && !passphrase) {
      return error('方案需要口令', 400);
    }

    body.submitted_by = user.username;
    body.submitted_at = new Date().toISOString();
    body.period = body.period || date;

    const kv = context.env.MATCH_DATA;

    // 提交预备方案：先校验源 rec 未被使用过，再写 pending_plan、回写 rec.pending_plan_passphrase
    if (source === 'pending_plan') {
      const stampResult = await stampRecommendation(kv, date, body.legs, passphrase);
      if (stampResult.error) {
        return error(stampResult.error, 400);
      }
    }

    await writeToKv(kv, source, date, body);

    if (source === 'pending_plan') {
      await logger(kv, '方案', `预备方案提交: "${passphrase}" (${date}) by ${user.username}`);
    } else if (source === 'recommendation') {
      const legsCount = (body.legs || []).length;
      await logger(kv, '推荐', `推荐提交: ${legsCount}场组合 (${date}) by ${user.username}`);
    }

    return json({ success: true });
  } catch (e) {
    return error(e.message);
  }
}

// 给匹配的 recommendation 打上 pending_plan_passphrase 标记。
// 匹配规则：legs 的 (match_id+pick) 集合完全相等。
// 硬约束：rec 已有 pending_plan_passphrase 即拒绝二次提交。
async function stampRecommendation(kv, date, legs, passphrase) {
  if (!kv || !legs || legs.length === 0) return {};
  const recsData = await kv.get(`recommendations:${date}`, 'json');
  if (!recsData || !recsData.items) return {};

  const targetKey = legSetKey(legs);
  let matched = null;
  for (const rec of recsData.items) {
    if (legSetKey(rec.legs || []) === targetKey) {
      if (rec.pending_plan_passphrase) {
        return { error: `该推荐已提交过预备方案（口令：${rec.pending_plan_passphrase}），不可重复提交` };
      }
      matched = rec;
      break;
    }
  }
  if (matched) {
    matched.pending_plan_passphrase = passphrase;
    await kv.put(`recommendations:${date}`, JSON.stringify(recsData));
  }
  return {};
}

function legSetKey(legs) {
  return [...new Set(legs.map(l => `${l.match_id}+${l.pick}`))].sort().join('|');
}

async function writeToKv(kv, source, date, data) {
  if (!kv) return;
  try {
    let key;
    if (source === 'recommendation') {
      key = `recommendations:${date}`;
    } else if (source === 'pending_plan') {
      key = `pending_plans:${date}`;
    } else {
      key = `plans:${date}`;
    }
    const existing = await kv.get(key, 'json');
    const items = existing ? existing.items : [];
    items.push(data);
    await kv.put(key, JSON.stringify({ period: date, items }));

    if (source === 'plan') {
      const pendingData = await kv.get('aggregate:unsettled_plans', 'json');
      const pending = pendingData ? pendingData.plans : [];
      pending.push(data);
      await kv.put('aggregate:unsettled_plans', JSON.stringify({ plans: pending }));
    }
  } catch (e) {}
}

export function onRequestOptions() {
  return options();
}
