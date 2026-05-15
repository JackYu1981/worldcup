/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron: 每小时执行一次
 * - 抓取当天在售比赛赔率（含已完场比赛的比分）
 * - 抓取前2天的页面获取比赛结果
 * - 数据写入 KV (MATCH_DATA)，含结果的数据永久保存
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

export default {
  async scheduled(event, env, ctx) {
    const today = getBeijingDate(0);
    console.log(`[Cron] Running, Beijing date ${today}`);

    const datesToFetch = [today, getBeijingDate(-1), getBeijingDate(-2)];

    for (const date of datesToFetch) {
      try {
        const existing = await env.MATCH_DATA.get(`matches:${date}`, 'json');
        const allFinished = existing && existing.matches &&
          existing.matches.length > 0 &&
          existing.matches.every(m => m.status === 'finished');

        if (allFinished) {
          console.log(`[Cron] ${date} all finished, skipping`);
          continue;
        }

        const url = adapter.buildMatchesUrl({ date });
        const html = await fetchHtml(url);
        if (!html || html.length < 1000) {
          console.log(`[Cron] ${date} empty page`);
          continue;
        }

        const matches = adapter.parseMatches(html);
        if (matches.length === 0) {
          console.log(`[Cron] ${date} no matches`);
          continue;
        }

        const dateMatches = matches.filter(m => m.date === date);
        if (dateMatches.length === 0) continue;

        const envelope = createEnvelope(date, adapter.name, dateMatches);
        const nowAllFinished = dateMatches.every(m => m.status === 'finished');

        await env.MATCH_DATA.put(`matches:${date}`, JSON.stringify(envelope),
          nowAllFinished ? {} : { expirationTtl: 86400 * 30 }
        );
        console.log(`[Cron] Saved ${dateMatches.length} matches for ${date} (${nowAllFinished ? 'final' : 'pending'})`);
      } catch (e) {
        console.error(`[Cron] Error for ${date}: ${e.message}`);
      }
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
