/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron: 每小时执行一次
 * - 抓取当天在售比赛赔率
 * - 比赛结束2小时后抓取赛果
 * - 数据写入 KV (MATCH_DATA)
 */

import { getAdapter } from '../../lib/adapters/index.js';
import { createEnvelope } from '../../lib/schema.js';

const adapter = getAdapter('500.com');

async function fetchHtml(url) {
  const resp = await fetch(url, { headers: adapter.fetchHeaders });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder(adapter.encoding);
  return decoder.decode(buf);
}

function getBeijingDate(offsetDays = 0) {
  const now = new Date();
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  beijing.setDate(beijing.getDate() + offsetDays);
  return beijing.toISOString().slice(0, 10);
}

function getBeijingHour() {
  const now = new Date();
  const h = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return h.getHours();
}

function shouldFetchResults(matches) {
  if (!matches || matches.length === 0) return false;
  const now = Date.now();

  for (const m of matches) {
    if (m.status === 'finished') continue;
    const kickoffStr = `${m.date}T${m.kickoff}:00+08:00`;
    const kickoff = new Date(kickoffStr).getTime();
    const matchEnd = kickoff + 120 * 60000;
    if (now > matchEnd) return true;
  }
  return false;
}

function mergeResults(matches, results) {
  for (const match of matches) {
    if (results[match.id]) {
      const r = results[match.id];
      match.score = `${r.home_score}-${r.away_score}`;
      match.status = 'finished';
    }
  }
  return matches;
}

export default {
  async scheduled(event, env, ctx) {
    const today = getBeijingDate(0);
    const yesterday = getBeijingDate(-1);
    const hour = getBeijingHour();

    console.log(`[Cron] Running at Beijing hour ${hour}, date ${today}`);

    try {
      const url = adapter.buildMatchesUrl();
      const html = await fetchHtml(url);
      if (!html || html.length < 1000) {
        console.log('[Cron] Empty page, skipping');
        return;
      }

      const allMatches = adapter.parseMatches(html);
      if (allMatches.length === 0) {
        console.log('[Cron] No matches found');
        return;
      }

      const byDate = {};
      allMatches.forEach(m => {
        if (!byDate[m.date]) byDate[m.date] = [];
        byDate[m.date].push(m);
      });

      for (const [date, matches] of Object.entries(byDate)) {
        const envelope = createEnvelope(date, adapter.name, matches);
        await env.MATCH_DATA.put(`matches:${date}`, JSON.stringify(envelope), {
          expirationTtl: 86400 * 5
        });
        console.log(`[Cron] Saved ${matches.length} matches for ${date}`);
      }
    } catch (e) {
      console.error(`[Cron] Odds fetch error: ${e.message}`);
    }

    const resultDates = [today];
    if (hour < 12) resultDates.push(yesterday);

    for (const date of resultDates) {
      try {
        const existing = await env.MATCH_DATA.get(`matches:${date}`, 'json');
        if (!existing || !shouldFetchResults(existing.matches)) continue;

        console.log(`[Cron] Fetching results for ${date}...`);
        const url = adapter.buildResultsUrl(date);
        const html = await fetchHtml(url);
        if (!html) continue;

        const results = adapter.parseResults(html);
        existing.matches = mergeResults(existing.matches, results);
        existing.fetched_at = new Date().toISOString();

        await env.MATCH_DATA.put(`matches:${date}`, JSON.stringify(existing), {
          expirationTtl: 86400 * 5
        });
        console.log(`[Cron] Updated results for ${date}`);
      } catch (e) {
        console.error(`[Cron] Results error for ${date}: ${e.message}`);
      }
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
