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
    body.period = body.period || date;  // 期次=开奖日(=用户选择的赛程日期)

    const kv = context.env.MATCH_DATA;
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
      const pendingData = await kv.get('plans:pending', 'json');
      const pending = pendingData ? pendingData.plans : [];
      pending.push(data);
      await kv.put('plans:pending', JSON.stringify({ plans: pending }));
    }
  } catch (e) {}
}

export function onRequestOptions() {
  return options();
}
