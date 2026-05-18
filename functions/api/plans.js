import { logger } from '../lib/logger.js';
import { json, error, options } from '../lib/response.js';
import { evaluatePlan } from '../lib/evaluate.js';

export async function onRequestGet(context) {
  try {
    const kv = context.env.MATCH_DATA;
    const url = new URL(context.request.url);
    const statusFilter = url.searchParams.get('status');
    const fromDate = url.searchParams.get('from');
    const toDate = url.searchParams.get('to');

    // 1. Read settled plans
    const settledData = await kv.get('plans:settled', 'json');
    const settled = settledData ? settledData.plans : [];

    // 2. Read pending plans
    const pendingData = await kv.get('plans:pending', 'json');
    let pending = pendingData ? pendingData.plans : [];

    // 3. Migration fallback: check plans:{date} keys
    if (pending.length === 0 && settled.length === 0) {
      pending = await migratePlansFromKv(kv);
    }

    // 4. Evaluate pending plans
    const newlySettled = [];
    const stillPending = [];

    if (pending.length > 0) {
      const periods = [...new Set(pending.map(p => p.period || p.date).filter(Boolean))];
      const matchCache = {};
      for (const period of periods) {
        const mData = await kv.get(`matches:${period}`, 'json');
        matchCache[period] = mData ? mData.matches : [];
      }

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
        const allSettled = [...settled, ...newlySettled];
        await kv.put('plans:settled', JSON.stringify({ plans: allSettled }));
        await kv.put('plans:pending', JSON.stringify({ plans: stillPending }));

        for (const p of newlySettled) {
          await logger(kv, '开奖', `"${p.passphrase || '未命名'}" → ${p.status === 'won' ? '中奖' : '未中'}`);
        }
      }
    }

    // 5. Build response with filters
    let results = [];
    if (statusFilter === 'pending') {
      results = stillPending;
    } else if (statusFilter === 'settled') {
      results = [...settled, ...newlySettled];
    } else {
      results = [...settled, ...newlySettled, ...stillPending];
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

async function migratePlansFromKv(kv) {
  try {
    const plans = [];
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    for (let i = 0; i < 10; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const data = await kv.get(`plans:${dateStr}`, 'json');
      if (data && data.items) {
        const filtered = data.items.filter(p => p.source === 'plan');
        filtered.forEach(p => { if (!p.period) p.period = data.period || dateStr; });
        plans.push(...filtered);
      }
    }
    if (plans.length > 0) {
      await kv.put('plans:pending', JSON.stringify({ plans }));
    }
    return plans;
  } catch (e) {
    return [];
  }
}

export function onRequestOptions() {
  return options();
}
