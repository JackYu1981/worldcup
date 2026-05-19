/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron triggers:
 * - 每小时整点: 抓 500.com 在售页，按 kickoff 日期分发到 matches:{date}，
 *   已有比赛合并（赔率覆盖、已写入的 score/status='finished' 不被退化）
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

// 用 code 里的"周X"反推 500.com 的"销售日期/开奖期次"
// 500 的期次以 code 里"周一/周二/..."为准（销售日），不以 kickoff 日期为准
// （部分凌晨场 kickoff 日期是次日，但仍属前一日销售期）
const WEEKDAY_NAMES = ['周日','周一','周二','周三','周四','周五','周六'];

function periodFromCode(code, todayBeijing) {
  if (!code) return null;
  const m = code.match(/^(周[日一二三四五六])/);
  if (!m) return null;
  const codeDayIdx = WEEKDAY_NAMES.indexOf(m[1]);
  if (codeDayIdx < 0) return null;
  // todayBeijing 形如 "2026-05-19"
  const todayDate = new Date(todayBeijing + 'T00:00:00+08:00');
  const todayDayIdx = todayDate.getUTCDay();  // 0=Sun..6=Sat（北京日 00:00 UTC == 前一日 16:00 但 getDay 仍为该日）
  // 计算 code 周X 相对今天的 offset：500 在售页通常包含今天及未来几天
  // diff = codeDay - todayDay；负数则 +7（当周后续）
  let diff = codeDayIdx - todayDayIdx;
  if (diff < 0) diff += 7;
  // 但若 diff > 6（不可能）或场次明显属过去，500.com 不会列出，所以无需处理过去
  const period = new Date(todayDate);
  period.setUTCDate(period.getUTCDate() + diff);
  return period.toISOString().slice(0, 10);
}

// 按"销售期次"分桶（code 决定，不是 kickoff）
function bucketByPeriod(matches, todayBeijing) {
  const buckets = {};
  for (const m of matches) {
    const period = periodFromCode(m.code, todayBeijing);
    if (!period) continue;
    if (!buckets[period]) buckets[period] = [];
    buckets[period].push(m);
  }
  return buckets;
}

// 合并新旧 match 列表：按 id 去重
// - 已 finished + 有 score 的旧 match 完整保留（避免新拉取没有比分时退化）
// - 否则用新值覆盖（赔率/状态会更新）
// - 在售页消失但 KV 已有的旧 match 保留
function mergeMatches(oldMatches, newMatches) {
  const map = new Map();
  for (const m of (oldMatches || [])) {
    if (m && m.id) map.set(m.id, m);
  }
  for (const fresh of newMatches) {
    if (!fresh || !fresh.id) continue;
    const old = map.get(fresh.id);
    if (old && old.status === 'finished' && old.score) {
      // 已开奖的不被新数据覆盖（在售页对 finished 比赛通常没有完整分数）
      continue;
    }
    if (old) {
      // 合并：新值优先，但保留旧的 score/status='finished' 不被空值退化
      const merged = { ...old, ...fresh };
      if (old.status === 'finished' && !fresh.status) merged.status = old.status;
      if (old.score && !fresh.score) merged.score = old.score;
      if (old.score_ht && !fresh.score_ht) merged.score_ht = old.score_ht;
      map.set(fresh.id, merged);
    } else {
      map.set(fresh.id, fresh);
    }
  }
  // 按 kickoff 排序输出
  return Array.from(map.values()).sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || ''));
}

async function snapshotMatches(env) {
  const url = adapter.buildMatchesUrl();  // 不带 date，拿当前在售全部
  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    await logger(env.MATCH_DATA, '赛程', `在售页抓取失败：${e.message}`);
    return;
  }
  if (!html || html.length < 1000) {
    await logger(env.MATCH_DATA, '赛程', `在售页为空`);
    return;
  }

  const allMatches = adapter.parseMatches(html);
  if (allMatches.length === 0) {
    await logger(env.MATCH_DATA, '赛程', `在售页解析0场（500.com 可能无在售比赛）`);
    return;
  }

  const buckets = bucketByPeriod(allMatches, getBeijingDate(0));
  const dates = Object.keys(buckets).sort();
  const summary = [];

  for (const date of dates) {
    const fresh = buckets[date];
    fresh.forEach(m => { m.period = date; });

    const kvKey = `matches:${date}`;
    const existing = await env.MATCH_DATA.get(kvKey, 'json');
    const oldMatches = (existing && existing.matches) || [];
    const merged = mergeMatches(oldMatches, fresh);

    const oldIds = new Set(oldMatches.map(m => m.id));
    const newCount = merged.filter(m => !oldIds.has(m.id)).length;

    if (merged.length === 0) continue;
    const envelope = createEnvelope(date, adapter.name, merged);
    await env.MATCH_DATA.put(kvKey, JSON.stringify(envelope));
    summary.push(`${date}:${merged.length}场${newCount > 0 ? `(+${newCount})` : ''}`);
  }

  if (summary.length > 0) {
    console.log(`[Snapshot] ${summary.join(' / ')}`);
    await logger(env.MATCH_DATA, '赛程', summary.join(' / '));
  }
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

    if (event.cron === '0 * * * *') {
      // 每整点：抓在售页合并到对应日期 KV
      await snapshotMatches(env);
    } else {
      await updateScores(env);
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
