import { json, error, options } from '../lib/response.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const period = url.searchParams.get('period') || url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const source = url.searchParams.get('source');
    const kv = context.env.MATCH_DATA;

    if (!kv) {
      return json({ picks: [] });
    }

    let periods = [];
    if (period) {
      periods = [period];
    } else if (from && to) {
      periods = getPeriodRange(from, to);
    } else if (from) {
      periods = [from];
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      periods = [yesterday, today];
    }

    const allPicks = [];
    for (const d of periods) {
      let found = false;
      if (!source || source === 'recommendation') {
        const recs = await kv.get(`recommendations:${d}`, 'json');
        if (recs && recs.items) {
          allPicks.push(...recs.items);
          found = true;
        }
      }
      if (!source || source === 'pending_plan') {
        const pending = await kv.get(`pending_plans:${d}`, 'json');
        if (pending && pending.items) {
          allPicks.push(...pending.items);
          found = true;
        }
      }
      if (!source || source === 'plan') {
        const plans = await kv.get(`plans:${d}`, 'json');
        if (plans && plans.items) {
          allPicks.push(...plans.items);
          found = true;
        }
      }

      if (!found) {
        const legacy = await kv.get(`picks:${d}`, 'json');
        if (legacy && legacy.picks) {
          const filtered = source
            ? legacy.picks.filter(p => p.source === source)
            : legacy.picks;
          allPicks.push(...filtered);
        }
      }
    }

    return json({ picks: allPicks }, 200, 30);
  } catch (e) {
    return error(e.message, 500);
  }
}

function getPeriodRange(from, to) {
  const periods = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    periods.push(d.toISOString().slice(0, 10));
  }
  return periods;
}

export function onRequestOptions() {
  return options();
}
