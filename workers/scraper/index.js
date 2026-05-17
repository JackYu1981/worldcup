/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron triggers:
 * - 每天UTC 03:01 (北京11:01): 抓取当天赛程快照
 * - 每30分钟: 更新比分
 */

import { getAdapter } from '../../lib/adapters/index.js';
import { createEnvelope } from '../../lib/schema.js';
import { logger } from '../../lib/logger.js';

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
      console.log(`[Cron] Failed to fetch live scores for ${date}: ${e.message}`);
    }
  }
  return allScores;
}

async function fetchJczqScores(date) {
  const results = {};
  try {
    const url = adapter.buildMatchesUrl({ date });
    const html = await fetchHtml(url);
    if (html && html.length > 1000) {
      const parsed = adapter.parseMatches(html);
      parsed.forEach(p => {
        if (p.status === 'finished' && p.score) {
          results[p.id] = p.score;
        }
      });
    }
  } catch (e) {
    console.log(`[Cron] Failed to fetch jczq for ${date}: ${e.message}`);
  }
  return results;
}

async function snapshotMatches(env) {
  const today = getBeijingDate(0);
  const kvKey = `matches:${today}`;

  const existing = await env.MATCH_DATA.get(kvKey, 'json');
  if (existing && existing.matches && existing.matches.length > 0) {
    console.log(`[Snapshot] ${today} already exists (${existing.matches.length} matches), skipping`);
    await logger(env.MATCH_DATA, '赛程', `${today} 已存在(${existing.matches.length}场)，跳过`);
    return;
  }

  const url = adapter.buildMatchesUrl({ date: today });
  const html = await fetchHtml(url);
  if (!html || html.length < 1000) {
    console.log(`[Snapshot] ${today} empty page`);
    await logger(env.MATCH_DATA, '赛程', `${today} 页面为空，抓取失败`);
    return;
  }

  const allMatches = adapter.parseMatches(html);
  if (allMatches.length === 0) {
    console.log(`[Snapshot] ${today} no matches parsed`);
    await logger(env.MATCH_DATA, '赛程', `${today} 解析0场，抓取失败`);
    return;
  }

  // 按code前缀(周X)过滤，只保留属于本期的比赛
  const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
  const dayIndex = new Date(today + 'T00:00:00+08:00').getDay();
  const prefix = WEEKDAYS[dayIndex];
  const matches = allMatches.filter(m => m.code && m.code.startsWith(prefix));
  if (matches.length === 0) {
    console.log(`[Snapshot] ${today} no matches with prefix "${prefix}" (${allMatches.length} total parsed)`);
    return;
  }

  const envelope = createEnvelope(today, adapter.name, matches);
  await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope));
  console.log(`[Snapshot] ${today}: saved ${matches.length} matches (filtered from ${allMatches.length})`);
  await logger(env.MATCH_DATA, '赛程', `${today} 保存${matches.length}场比赛(${prefix}期)`);
}

async function updateScores(env) {
  const today = getBeijingDate(0);
  const periods = [today, getBeijingDate(-1), getBeijingDate(-2)];
  let totalUpdated = 0;
  let totalPending = 0;

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
      totalPending += matches.filter(m => !m.score).length;
      continue;
    }

    const SCORE_RE = /^\d+-\d+$/;
    let updated = 0;

    // Primary source: jczq page (data-isend=1) — 90分钟竞彩比分
    const jczqScores = await fetchJczqScores(date);
    matches.forEach(m => {
      if (!m.score && jczqScores[m.id] && SCORE_RE.test(jczqScores[m.id])) {
        m.score = jczqScores[m.id];
        m.status = 'finished';
        updated++;
      }
    });

    // Secondary source: live.500.com (status=3/4) — 最终比分（含加时点球）
    const matchDates = [...new Set(matches.filter(m => !m.score_ft).map(m => m.date))];
    const liveScores = await fetchScoresForDates(matchDates);
    matches.forEach(m => {
      if (liveScores[m.id] && SCORE_RE.test(liveScores[m.id])) {
        m.score_ft = liveScores[m.id];
        // If no 90-min score yet but live shows finished, use as fallback
        if (!m.score) {
          m.score = liveScores[m.id];
          m.status = 'finished';
          updated++;
        }
      }
    });

    if (updated > 0) {
      const nowAllDone = matches.every(m => m.status === 'finished' && m.score);
      const envelope = createEnvelope(date, adapter.name, matches);
      await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope));
      console.log(`[Scores] ${date}: updated ${updated} (${nowAllDone ? 'all done' : 'pending'})`);
      await logger(env.MATCH_DATA, '比分', `${date} 更新${updated}场${nowAllDone ? '(全部完成)' : ''}`);
    }

    totalUpdated += updated;
    totalPending += matches.filter(m => !m.score).length;
  }

  if (totalUpdated === 0) {
    const msg = totalPending > 0
      ? `定时检查：无新结果(${totalPending}场待更新)`
      : '定时检查：无新结果(所有比赛已完成或无进行中比赛)';
    await logger(env.MATCH_DATA, '比分', msg);
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
