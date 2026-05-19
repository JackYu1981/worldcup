import { json, error, options } from '../lib/response.js';
import { verifyToken } from '../lib/auth.js';

// 单据日期（recommendation/pending_plan/plan 都按 date 分桶；与赛程 period 无关）
// query 参数兼容历史命名：date 优先，period 兼容
export async function onRequestGet(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) return error('未登录', 401);

    const url = new URL(context.request.url);
    const date = url.searchParams.get('date') || url.searchParams.get('period');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const source = url.searchParams.get('source');
    const kv = context.env.MATCH_DATA;

    if (!kv) {
      return json({ picks: [] });
    }

    let dates = [];
    if (date) {
      dates = [date];
    } else if (from && to) {
      dates = getDateRange(from, to);
    } else if (from) {
      dates = [from];
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      dates = [yesterday, today];
    }

    const allPicks = [];
    for (const d of dates) {
      if (!source || source === 'recommendation') {
        const recs = await kv.get(`recommendations:${d}`, 'json');
        if (recs && recs.items) allPicks.push(...recs.items);
      }
      if (!source || source === 'pending_plan') {
        const pending = await kv.get(`pending_plans:${d}`, 'json');
        if (pending && pending.items) allPicks.push(...pending.items);
      }
      if (!source || source === 'plan') {
        const plans = await kv.get(`plans:${d}`, 'json');
        if (plans && plans.items) allPicks.push(...plans.items);
      }
    }

    return json({ picks: allPicks }, 200, 30);
  } catch (e) {
    return error(e.message, 500);
  }
}

function getDateRange(from, to) {
  const dates = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export function onRequestOptions() {
  return options();
}
