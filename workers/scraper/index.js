/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron triggers:
 * - 每天UTC 03:01 (北京11:01): 抓取当天赛程快照
 * - 每30分钟: 更新比分
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

async function snapshotMatches(env) {
  const today = getBeijingDate(0);
  const kvKey = `matches:${today}`;

  const existing = await env.MATCH_DATA.get(kvKey, 'json');
  if (existing && existing.matches && existing.matches.length > 0) {
    console.log(`[Snapshot] ${today} already exists (${existing.matches.length} matches), skipping`);
    return;
  }

  const url = adapter.buildMatchesUrl({ date: today });
  const html = await fetchHtml(url);
  if (!html || html.length < 1000) {
    console.log(`[Snapshot] ${today} empty page`);
    return;
  }

  const allMatches = adapter.parseMatches(html);
  if (allMatches.length === 0) {
    console.log(`[Snapshot] ${today} no matches parsed`);
    return;
  }

  // 只保留比赛日期等于当期日期的场次，跨天比赛归属其实际日期那期
  const matches = allMatches.filter(m => m.date === today);
  if (matches.length === 0) {
    console.log(`[Snapshot] ${today} no matches for this date (${allMatches.length} total parsed)`);
    return;
  }

  const envelope = createEnvelope(today, adapter.name, matches);
  await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope), { expirationTtl: 86400 * 30 });
  console.log(`[Snapshot] ${today}: saved ${matches.length} matches (filtered from ${allMatches.length})`);
}

async function updateScores(env) {
  const today = getBeijingDate(0);
  const periods = [today, getBeijingDate(-1), getBeijingDate(-2)];

  for (const date of periods) {
    const kvKey = `matches:${date}`;
    const data = await env.MATCH_DATA.get(kvKey, 'json');
    if (!data || !data.matches || data.matches.length === 0) continue;

    const matches = data.matches;
    const allDone = matches.every(m => m.status === 'finished' && m.score);
    if (allDone) {
      console.log(`[Scores] ${date} all done, skip`);
      continue;
    }

    const beijingNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const startedWithoutScore = matches.filter(m => {
      if (m.score) return false;
      if (!m.date || !m.kickoff) return false;
      const kickoffTime = new Date(`${m.date}T${m.kickoff}:00+08:00`);
      return beijingNow > kickoffTime;
    });

    if (startedWithoutScore.length === 0) {
      console.log(`[Scores] ${date} no started matches need scores`);
      continue;
    }

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
      console.log(`[Scores] ${date}: updated ${updated} (${nowAllDone ? 'all done' : 'pending'})`);
    } else {
      console.log(`[Scores] ${date}: no new scores available`);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    console.log(`[Cron] Triggered: ${event.cron}`);

    if (event.cron === '1 3 * * *') {
      await snapshotMatches(env);
    } else {
      await updateScores(env);
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
