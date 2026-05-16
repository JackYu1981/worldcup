/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron: 每小时执行一次
 * 1. 抓取赛程：获取当期和前2期的竞彩页面，保存所有比赛（不按实际日期过滤）
 *    - 已有数据只合并新增比赛，不覆盖已有场次
 * 2. 抓取结果：对已存储但未完场的比赛，从页面获取比分并更新
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
        const kvKey = `matches:${date}`;
        const existing = await env.MATCH_DATA.get(kvKey, 'json');
        const existingMatches = existing ? (existing.matches || []) : [];
        const allFinished = existingMatches.length > 0 &&
          existingMatches.every(m => m.status === 'finished');

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

        const parsed = adapter.parseMatches(html);
        if (parsed.length === 0) {
          console.log(`[Cron] ${date} no matches parsed`);
          continue;
        }

        // Merge: keep all existing matches, add new ones, update results for existing
        const mergedMap = {};
        existingMatches.forEach(m => { mergedMap[m.id] = m; });

        parsed.forEach(m => {
          if (mergedMap[m.id]) {
            // Update score/status if the match now has results
            if (m.status === 'finished' && m.score) {
              mergedMap[m.id].status = 'finished';
              mergedMap[m.id].score = m.score;
            }
          } else {
            // New match — add it (belongs to this betting period)
            mergedMap[m.id] = m;
          }
        });

        const mergedMatches = Object.values(mergedMap);
        const envelope = createEnvelope(date, adapter.name, mergedMatches);
        const nowAllFinished = mergedMatches.length > 0 &&
          mergedMatches.every(m => m.status === 'finished');

        await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope),
          nowAllFinished ? {} : { expirationTtl: 86400 * 30 }
        );
        console.log(`[Cron] ${date}: ${mergedMatches.length} matches (${existingMatches.length} existing + ${mergedMatches.length - existingMatches.length} new, ${nowAllFinished ? 'all finished' : 'pending'})`);
      } catch (e) {
        console.error(`[Cron] Error for ${date}: ${e.message}`);
      }
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
