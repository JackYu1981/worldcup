/**
 * Cloudflare Worker: 竞彩数据定时抓取
 *
 * Cron triggers:
 * - 每 2 小时整点: 抓 500.com 在售页，按 kickoff 日期分发到 matches:{date}，
 *   已有比赛合并（赔率覆盖、已写入的 score/status='finished' 不被退化）
 *   写入时做 hash 短路 — 数据没变就不写，省 KV 写入额度
 * - 每30分钟: 更新比分（hash 短路同理）
 */

import { getAdapter } from '../../lib/adapters/index.js';
import { createEnvelope } from '../../lib/schema.js';
import { logger } from '../../lib/logger.js';

const adapter = getAdapter('500.com');

// FNV-1a 32-bit — same algorithm as fifa-scraper/lib/lineup.js for consistency.
// Computes a fingerprint of just the match content (id + odds + handicap + score + status)
// so we skip writes when the envelope round-trip would produce identical data.
function matchListHash(matches) {
  const sig = (matches || [])
    .slice()
    .sort((a, b) => (a.id || '').localeCompare(b.id || ''))
    .map(m => {
      const o = m.odds || {};
      const h = m.handicap || {};
      return [
        m.id, m.status || '', m.score || '', m.score_ht || '',
        o.home_win, o.draw, o.away_win,
        h.home_win, h.draw, h.away_win, h.handicap
      ].join('|');
    })
    .join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    hash ^= sig.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Idempotent KV write — only puts if the new content's hash differs from what's there.
// Returns { written: boolean, hash: string }.
async function putIfChanged(kv, key, envelope) {
  const newHash = matchListHash(envelope.matches);
  const existing = await kv.get(key, 'json');
  if (existing && existing._hash === newHash) {
    return { written: false, hash: newHash };
  }
  envelope._hash = newHash;
  await kv.put(key, JSON.stringify(envelope));
  return { written: true, hash: newHash };
}

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

// 按"销售期次"分桶
// adapter 已从 data-buyendtime 解析出 match.period（500.com 权威字段，形如 "2026-05-19"）
// 不要按 kickoff 分桶（凌晨场 kickoff 日期次日但仍属前一日销售期）
function bucketByPeriod(matches) {
  const buckets = {};
  for (const m of matches) {
    if (!m.period) continue;
    if (!buckets[m.period]) buckets[m.period] = [];
    buckets[m.period].push(m);
  }
  return buckets;
}

// 占位赔率检测：500.com 在比赛进行中/刚结束的过渡窗口可能把 data-sp 写成 "1"，
// 整组 odds 全部 == 1 是无意义占位，必须丢弃，否则会覆盖之前已抓到的真实赔率。
function isPlaceholderOdds(odds) {
  if (!odds || typeof odds !== 'object') return true;
  const vals = ['home_win', 'draw', 'away_win']
    .map(k => odds[k])
    .filter(v => v !== null && v !== undefined);
  if (vals.length === 0) return true;
  return vals.every(v => v <= 1.01);
}

// 合并新旧 match 列表：按 id 去重
// 同一 id 的旧 match：只更新赔率（odds + handicap），其他字段一律保留旧值
//   原因：500.com 同一 code（周X001 等）一旦发布，对阵/code/kickoff 都不再变，
//   赔率会随调盘变化。score/status 仅由 updateScores（kaijiang 路径）维护，
//   snapshotMatches 不能写入这两个字段。
//   已 finished 的比赛跳过 odds 更新（竞猜已结束，再抓也无意义且易被占位污染）。
// 在售页新出现的 → 整条新增
// 在售页消失的 → KV 中保留
function mergeMatches(oldMatches, newMatches) {
  const map = new Map();
  for (const m of (oldMatches || [])) {
    if (m && m.id) map.set(m.id, m);
  }
  for (const fresh of newMatches) {
    if (!fresh || !fresh.id) continue;
    const old = map.get(fresh.id);
    if (old) {
      const merged = { ...old };
      if (old.status !== 'finished') {
        if (fresh.odds && !isPlaceholderOdds(fresh.odds)) merged.odds = fresh.odds;
        if (fresh.handicap && !isPlaceholderOdds(fresh.handicap)) merged.handicap = fresh.handicap;
      }
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

  const buckets = bucketByPeriod(allMatches);
  const dates = Object.keys(buckets).sort();
  const summary = [];

  for (const date of dates) {
    const fresh = buckets[date];

    const kvKey = `matches:${date}`;
    const existing = await env.MATCH_DATA.get(kvKey, 'json');
    const oldMatches = (existing && existing.matches) || [];
    const merged = mergeMatches(oldMatches, fresh);

    const oldIds = new Set(oldMatches.map(m => m.id));
    const newCount = merged.filter(m => !oldIds.has(m.id)).length;

    if (merged.length === 0) continue;
    const envelope = createEnvelope(date, adapter.name, merged);
    const { written } = await putIfChanged(env.MATCH_DATA, kvKey, envelope);
    if (written) {
      summary.push(`${date}:${merged.length}场${newCount > 0 ? `(+${newCount})` : ''}`);
    }
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
      const { written } = await putIfChanged(env.MATCH_DATA, kvKey, envelope);
      const nowAllDone = matches.every(m => m.status === 'finished' && m.score);
      if (written) {
        console.log(`[Scores] ${date}: updated ${updated} (${nowAllDone ? 'all done' : 'pending'})`);
        await logger(env.MATCH_DATA, '比分', `${date} 更新${updated}场${nowAllDone ? '(全部完成)' : ''}`);
      }
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

    if (event.cron === '0 */2 * * *') {
      // 每 2 小时整点：抓在售页合并到对应日期 KV（hash 短路）
      await snapshotMatches(env);
    } else {
      await updateScores(env);
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
