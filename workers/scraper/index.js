/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron: 每30分钟执行一次
 * 1. 赛程快照：只抓今天和明天的期，KV中已有则跳过（不merge，一次抓全）
 * 2. 比分更新：对未全部完赛的期，按比赛实际日期从live.500.com精确抓取比分
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

function getBeijingHour() {
  const now = new Date();
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return beijing.getHours();
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
    const tomorrow = getBeijingDate(1);
    console.log(`[Cron] Running, Beijing date ${today}`);

    // --- Phase 1: 赛程快照 (今天+明天的期，不存在才抓) ---
    for (const date of [today, tomorrow]) {
      const kvKey = `matches:${date}`;
      const existing = await env.MATCH_DATA.get(kvKey, 'json');
      if (existing && existing.matches && existing.matches.length > 0) {
        continue;
      }
      try {
        const url = adapter.buildMatchesUrl({ date });
        const html = await fetchHtml(url);
        if (!html || html.length < 1000) {
          console.log(`[Cron] ${date} empty page, skipping`);
          continue;
        }
        const matches = adapter.parseMatches(html);
        if (matches.length === 0) {
          console.log(`[Cron] ${date} no matches parsed`);
          continue;
        }
        const envelope = createEnvelope(date, adapter.name, matches);
        await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope), { expirationTtl: 86400 * 30 });
        console.log(`[Cron] ${date}: snapshot saved, ${matches.length} matches`);
      } catch (e) {
        console.error(`[Cron] Snapshot error for ${date}: ${e.message}`);
      }
    }

    // --- Phase 2: 比分更新 (今天+前2天的期，有未完赛的才更新) ---
    const scoreDates = [today, getBeijingDate(-1), getBeijingDate(-2)];
    for (const date of scoreDates) {
      const kvKey = `matches:${date}`;
      const data = await env.MATCH_DATA.get(kvKey, 'json');
      if (!data || !data.matches || data.matches.length === 0) continue;

      const matches = data.matches;
      const allDone = matches.every(m => m.status === 'finished' && m.score);
      if (allDone) {
        console.log(`[Cron] ${date} all done, skip scores`);
        continue;
      }

      // 找出需要比分的比赛的实际比赛日期
      const pendingMatches = matches.filter(m => !m.score);
      // 判断哪些比赛已经开赛了（当前北京时间 > 比赛kickoff时间）
      const beijingNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
      const startedWithoutScore = pendingMatches.filter(m => {
        if (!m.date || !m.kickoff) return false;
        const kickoffTime = new Date(`${m.date}T${m.kickoff}:00+08:00`);
        return beijingNow > kickoffTime;
      });

      if (startedWithoutScore.length === 0) {
        console.log(`[Cron] ${date} no started matches need scores`);
        continue;
      }

      // 按比赛实际日期抓取比分
      const matchDates = [...new Set(startedWithoutScore.map(m => m.date))];
      const scores = await fetchScoresForDates(matchDates);

      let updated = 0;
      matches.forEach(m => {
        if (!m.score && scores[m.id]) {
          m.score = scores[m.id];
          m.status = 'finished';
          updated++;
        }
      });

      if (updated > 0) {
        const nowAllDone = matches.every(m => m.status === 'finished' && m.score);
        const envelope = createEnvelope(date, adapter.name, matches);
        await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope),
          nowAllDone ? {} : { expirationTtl: 86400 * 30 }
        );
        console.log(`[Cron] ${date}: updated ${updated} scores (${nowAllDone ? 'all done' : 'pending'})`);
      } else {
        console.log(`[Cron] ${date}: no new scores available`);
      }
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
