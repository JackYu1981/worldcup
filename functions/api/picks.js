import { json, error, options } from '../lib/response.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
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
      dates = getDateRange(from, from);
    } else {
      // Default: today + yesterday
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      dates = [yesterday, today];
    }

    const allPicks = [];
    for (const d of dates) {
      const cached = await kv.get(`picks:${d}`, 'json');
      if (cached && cached.picks) {
        allPicks.push(...cached.picks);
      }
    }

    // Fallback: if KV empty for requested dates, try GitHub
    if (allPicks.length === 0 && dates.length <= 2) {
      const ghPicks = await fetchFromGitHub(context.env, dates);
      if (ghPicks.length > 0) {
        // Cache fetched data in KV
        for (const d of dates) {
          const datePicks = ghPicks.filter(p => p.date === d);
          if (datePicks.length > 0) {
            await kv.put(`picks:${d}`, JSON.stringify({ picks: datePicks }), { expirationTtl: 86400 * 30 });
          }
        }
        allPicks.push(...ghPicks);
      }
    }

    return json({ picks: allPicks }, 200, 30);
  } catch (e) {
    const kv = context.env.MATCH_DATA;
    if (kv) {
      const url = new URL(context.request.url);
      const date = url.searchParams.get('date');
      if (date) {
        const cached = await kv.get(`picks:${date}`, 'json');
        if (cached) return json(cached, 200, 60);
      }
    }
    return json({ picks: [], error: e.message }, 500);
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

async function fetchFromGitHub(env, dates) {
  try {
    const ghResp = await fetch(
      'https://api.github.com/repos/JackYu1981/worldcup/contents/picks',
      {
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN}`,
          'User-Agent': 'worldmoney-pages',
        },
      }
    );
    if (!ghResp.ok) return [];

    let files = await ghResp.json();
    files = files.filter(f => f.name.endsWith('.json'));
    if (dates.length > 0) {
      files = files.filter(f => dates.some(d => f.name.startsWith(d)));
    }

    return await Promise.all(files.map(async f => {
      const r = await fetch(f.download_url);
      return r.json();
    }));
  } catch (e) {
    return [];
  }
}

export function onRequestOptions() {
  return options();
}
