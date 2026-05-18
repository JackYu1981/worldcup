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

async function fetchKaijiang(date) {
  try {
    const url = adapter.buildKaijiangUrl(date);
    const html = await fetchHtml(url);
    if (!html || html.length < 1000) return {};
    return adapter.parseKaijiang(html);
  } catch (e) {
    console.log(`[Cron] Failed to fetch kaijiang for ${date}: ${e.message}`);
    return {};
  }
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

  // 每场比赛打上期次标识（=开奖日=today）
  matches.forEach(m => { m.period = today; });

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

    // 开奖页只列已开奖的比赛 — 用它做唯一权威源，覆盖式更新
    const kaijiang = await fetchKaijiang(date);
    const SCORE_RE = /^\d+-\d+$/;
    let updated = 0;

    matches.forEach(m => {
      const k = kaijiang[m.code];
      if (!k) return;
      if (!SCORE_RE.test(k.score)) return;
      const changed = m.score !== k.score || m.score_ht !== k.score_ht || m.status !== 'finished';
      if (changed) {
        m.score = k.score;
        m.score_ht = k.score_ht;
        m.status = 'finished';
        updated++;
      }
    });

    if (updated > 0) {
      const envelope = createEnvelope(date, adapter.name, matches);
      await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope));
      const nowAllDone = matches.every(m => m.status === 'finished' && m.score);
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
    return;
  }

  // 比分有更新 → 触发 Pages 端的方案结算（按需评估 pending plans）
  try {
    const resp = await fetch('https://worldmoney.pages.dev/api/plans?status=settled', {
      headers: { 'User-Agent': 'worldcup-scraper-cron' }
    });
    if (resp.ok) {
      console.log('[Settle] triggered /api/plans for auto-settlement');
    } else {
      console.log(`[Settle] /api/plans returned ${resp.status}`);
    }
  } catch (e) {
    console.log(`[Settle] failed to trigger: ${e.message}`);
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
