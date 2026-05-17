/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron: 每30分钟执行一次
 * 1. 抓取赛程：获取当期和前2期的竞彩页面，保存所有比赛
 *    - 已有数据只合并新增比赛，不覆盖已有场次
 * 2. 抓取结果：从live.500.com获取比分并更新已结束比赛
 */

import { getAdapter } from '../../lib/adapters/index.js';
import { createEnvelope } from '../../lib/schema.js';

const adapter = getAdapter('500.com');

async function fetchHtml(url, encoding) {
  const resp = await fetch(url, { headers: adapter.fetchHeaders });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder(encoding || adapter.encoding);
  return decoder.decode(buf);
}

function getBeijingDate(offsetDays = 0) {
  const now = new Date();
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  beijing.setDate(beijing.getDate() + offsetDays);
  return beijing.toISOString().slice(0, 10);
}

async function fetchScoresForDates(dates) {
  const allScores = {};
  const uniqueDates = [...new Set(dates)];
  for (const date of uniqueDates) {
    try {
      const url = adapter.buildScoresUrl(date);
      const html = await fetchHtml(url, adapter.scoresEncoding);
      if (html && html.length > 500) {
        const scores = adapter.parseScores(html);
        Object.assign(allScores, scores);
      }
    } catch (e) {
      console.log(`[Cron] Failed to fetch scores for ${date}: ${e.message}`);
    }
  }
  return allScores;
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
          existingMatches.every(m => m.status === 'finished' && m.score);

        if (allFinished) {
          console.log(`[Cron] ${date} all finished with scores, skipping`);
          continue;
        }

        const url = adapter.buildMatchesUrl({ date });
        const html = await fetchHtml(url);
        if (!html || html.length < 1000) {
          console.log(`[Cron] ${date} empty page`);
          continue;
        }

        const parsed = adapter.parseMatches(html);
        if (parsed.length === 0 && existingMatches.length === 0) {
          console.log(`[Cron] ${date} no matches parsed`);
          continue;
        }

        // Merge: keep all existing matches, add new ones
        const mergedMap = {};
        existingMatches.forEach(m => { mergedMap[m.id] = m; });

        parsed.forEach(m => {
          if (mergedMap[m.id]) {
            if (m.status === 'finished') {
              mergedMap[m.id].status = 'finished';
            }
            if (m.score) {
              mergedMap[m.id].score = m.score;
            }
          } else {
            mergedMap[m.id] = m;
          }
        });

        // Fetch scores from live.500.com for matches that need them
        const mergedMatches = Object.values(mergedMap);
        const needScores = mergedMatches.some(m => m.status === 'finished' && !m.score);

        if (needScores) {
          const matchDates = [...new Set(mergedMatches.map(m => m.date).filter(Boolean))];
          const scores = await fetchScoresForDates(matchDates);
          let updated = 0;
          mergedMatches.forEach(m => {
            if (m.status === 'finished' && !m.score && scores[m.id]) {
              m.score = scores[m.id];
              updated++;
            }
          });
          console.log(`[Cron] ${date}: updated ${updated} scores from live.500.com`);
        }

        const envelope = createEnvelope(date, adapter.name, mergedMatches);
        const nowAllFinished = mergedMatches.length > 0 &&
          mergedMatches.every(m => m.status === 'finished' && m.score);

        await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope),
          nowAllFinished ? {} : { expirationTtl: 86400 * 30 }
        );
        console.log(`[Cron] ${date}: ${mergedMatches.length} matches (${nowAllFinished ? 'all finished' : 'pending'})`);
      } catch (e) {
        console.error(`[Cron] Error for ${date}: ${e.message}`);
      }
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
