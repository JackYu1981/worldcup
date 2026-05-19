/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron triggers:
 * - 每5分钟: 检查当天 matches 是否缺失，缺失则补抓（轮询机制：直到 500.com 发布当天赛程为止）
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
    // 已有数据，静默跳过（每5分钟跑一次，不刷屏）
    return;
  }

  // 仅在每小时第一次重试时写日志，避免每 5 分钟刷一条
  const nowUtc = new Date();
  const minute = nowUtc.getUTCMinutes();
  const verbose = minute < 5;

  const url = adapter.buildMatchesUrl({ date: today });
  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    if (verbose) await logger(env.MATCH_DATA, '赛程', `${today} 抓取失败：${e.message}（轮询中）`);
    return;
  }
  if (!html || html.length < 1000) {
    if (verbose) await logger(env.MATCH_DATA, '赛程', `${today} 页面为空，轮询中`);
    return;
  }

  const allMatches = adapter.parseMatches(html);
  if (allMatches.length === 0) {
    if (verbose) await logger(env.MATCH_DATA, '赛程', `${today} 解析0场，500.com 可能尚未发布，轮询中`);
    return;
  }

  // 按code前缀(周X)过滤，只保留属于本期的比赛
  const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
  const dayIndex = new Date(today + 'T00:00:00+08:00').getDay();
  const prefix = WEEKDAYS[dayIndex];
  const matches = allMatches.filter(m => m.code && m.code.startsWith(prefix));
  if (matches.length === 0) {
    if (verbose) await logger(env.MATCH_DATA, '赛程', `${today} 无 ${prefix} 期比赛（共解析${allMatches.length}场），轮询中`);
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
  if (!env.SCRAPER_SECRET) {
    console.log('[Settle] SCRAPER_SECRET not configured, skip');
    return;
  }
  try {
    const resp = await fetch('https://worldmoney.pages.dev/api/admin/settle', {
      method: 'POST',
      headers: {
        'User-Agent': 'worldcup-scraper-cron',
        'X-Scraper-Secret': env.SCRAPER_SECRET,
      },
    });
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      console.log(`[Settle] triggered: newly_settled=${body.newly_settled || 0}`);
    } else {
      console.log(`[Settle] /api/admin/settle returned ${resp.status}`);
    }
  } catch (e) {
    console.log(`[Settle] failed to trigger: ${e.message}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    console.log(`[Cron] Triggered: ${event.cron}`);

    if (event.cron === '*/5 * * * *') {
      // 5分钟轮询：缺失则补抓 snapshot；snapshotMatches 内部已有 early-return 跳过已有数据
      await snapshotMatches(env);
    } else {
      await updateScores(env);
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
