import { json, error, options } from '../lib/response.js';
import { verifyToken } from '../lib/auth.js';

export async function onRequestGet(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) return error('未登录', 401);

    const kv = context.env.MATCH_DATA;
    const url = new URL(context.request.url);
    const statusFilter = url.searchParams.get('status');
    const fromDate = url.searchParams.get('from');
    const toDate = url.searchParams.get('to');

    const settledData = await kv.get('aggregate:settled_plans', 'json');
    const settled = settledData ? (settledData.plans || []) : [];
    const pendingData = await kv.get('aggregate:pending_plans', 'json');
    const pending = pendingData ? (pendingData.plans || []) : [];

    let results;
    if (statusFilter === 'pending') {
      results = pending;
    } else if (statusFilter === 'settled') {
      results = settled;
    } else {
      results = [...settled, ...pending];
    }

    if (fromDate) {
      results = results.filter(p => (p.period || p.date || '') >= fromDate);
    }
    if (toDate) {
      results = results.filter(p => (p.period || p.date || '') <= toDate);
    }

    results.sort((a, b) => {
      const da = a.period || a.date || '';
      const db = b.period || b.date || '';
      if (da !== db) return db.localeCompare(da);
      const ta = a.submitted_at || '';
      const tb = b.submitted_at || '';
      return tb.localeCompare(ta);
    });

    return json({ plans: results }, 200, 30);
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() {
  return options();
}
