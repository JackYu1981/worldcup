import { json, error, options } from '../lib/response.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const date = url.searchParams.get('date');
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
