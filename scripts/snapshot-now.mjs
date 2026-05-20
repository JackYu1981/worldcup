#!/usr/bin/env node
/**
 * 一次性脚本：本地抓 500.com 在售页 → 合并到 KV matches:{date}
 * 用于补今天的赛程（cron 还没到下一个整点时手动触发等价于一次 cron 跑）
 */
import https from 'https';
import iconv from 'iconv-lite';
import { execSync } from 'child_process';
import fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAdapter } from '../lib/adapters/index.js';
import { createEnvelope } from '../lib/schema.js';

const adapter = getAdapter('500.com');
const KV_NS = '278f1209ffd84662bd51921370a2fbe9';

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: adapter.fetchHeaders }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), adapter.encoding)));
    }).on('error', reject);
  });
}

// 按 adapter 已解析的 period (来自 500.com data-buyendtime) 分桶
function bucketByPeriod(matches) {
  const buckets = {};
  for (const m of matches) {
    if (!m.period) continue;
    if (!buckets[m.period]) buckets[m.period] = [];
    buckets[m.period].push(m);
  }
  return buckets;
}

// 同一 id 的旧 match 只更新赔率（odds + handicap），其余字段保留。
// status/score 不由 snapshot 写，仅 kaijiang 流程维护。
//
// 防御：若 fresh.odds / fresh.handicap 看起来是「无效赔率快照」（全 null 或任一 ≤ 1），
// 不覆盖既有有效 odds——保留赛前抓到的赔率。
// 判定理由：足彩赔率永远 > 1.01；= 1 / null 表示 500.com 在比赛结束/下架后返回的占位值，
// 用它覆盖会破坏赛前快照（v2.0 算法依赖赛前赔率算 P_eff）。
function isOddsValid(o) {
  if (!o || typeof o !== 'object') return false;
  const vals = ['home_win', 'draw', 'away_win'].map(k => o[k]);
  if (vals.some(v => v == null)) return false;
  if (vals.some(v => v <= 1)) return false;
  return true;
}

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
      // odds: 仅在 fresh 有效时覆盖；fresh 无效则保留 old.odds
      if (isOddsValid(fresh.odds)) {
        merged.odds = fresh.odds;
      } else if (fresh.odds && !isOddsValid(old.odds)) {
        // old 也无效（首次写入场景），仍写入但记一笔
        merged.odds = fresh.odds;
        console.warn(`  ⚠️  ${fresh.id} ${fresh.code || ''}: odds 仍无效（fresh ${JSON.stringify(fresh.odds)}），保留 fresh 占位`);
      } else if (fresh.odds) {
        console.warn(`  ⚠️  ${fresh.id} ${fresh.code || ''}: 收到无效 odds ${JSON.stringify(fresh.odds)}，保留旧值 ${JSON.stringify(old.odds)}`);
      }
      // handicap 同理（含 line 字段：line 单独可有效，但 spf 三项要校验）
      if (fresh.handicap) {
        const freshSpf = { home_win: fresh.handicap.home_win, draw: fresh.handicap.draw, away_win: fresh.handicap.away_win };
        const oldSpf = old.handicap ? { home_win: old.handicap.home_win, draw: old.handicap.draw, away_win: old.handicap.away_win } : null;
        if (isOddsValid(freshSpf)) {
          merged.handicap = fresh.handicap;
        } else if (!oldSpf || !isOddsValid(oldSpf)) {
          merged.handicap = fresh.handicap;
          console.warn(`  ⚠️  ${fresh.id} ${fresh.code || ''}: handicap 仍无效（fresh ${JSON.stringify(freshSpf)}），保留 fresh 占位`);
        } else {
          // fresh handicap 无效但 line 可能更新——至少保留 line
          merged.handicap = { ...old.handicap, line: fresh.handicap.line ?? old.handicap.line };
          console.warn(`  ⚠️  ${fresh.id} ${fresh.code || ''}: 收到无效 handicap ${JSON.stringify(freshSpf)}，保留旧值`);
        }
      }
      map.set(fresh.id, merged);
    } else {
      map.set(fresh.id, fresh);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.code || '').localeCompare(b.code || ''));
}

function kvGet(key) {
  try {
    const out = execSync(
      `npx wrangler kv key get "${key}" --namespace-id=${KV_NS} --remote 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return JSON.parse(out);
  } catch { return null; }
}

function kvPut(key, value) {
  const tmp = join(tmpdir(), `kv-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(value));
  execSync(
    `npx wrangler kv key put "${key}" --path="${tmp}" --namespace-id=${KV_NS} --remote`,
    { stdio: 'inherit' }
  );
  fs.unlinkSync(tmp);
}

(async () => {
  const url = adapter.buildMatchesUrl();
  console.log('fetching', url);
  const html = await fetchPage(url);
  console.log('html length:', html.length);
  const allMatches = adapter.parseMatches(html);
  console.log('parsed matches:', allMatches.length);

  const buckets = bucketByPeriod(allMatches);
  for (const date of Object.keys(buckets).sort()) {
    const fresh = buckets[date];
    const existing = kvGet(`matches:${date}`);
    const oldMatches = (existing && existing.matches) || [];
    const merged = mergeMatches(oldMatches, fresh);
    const oldIds = new Set(oldMatches.map(m => m.id));
    const newCount = merged.filter(m => !oldIds.has(m.id)).length;
    console.log(`${date}: ${merged.length} matches (+${newCount} new)`);
    const envelope = createEnvelope(date, adapter.name, merged);
    kvPut(`matches:${date}`, envelope);
  }
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
