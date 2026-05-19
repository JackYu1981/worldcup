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

function bucketByKickoffDate(matches) {
  const buckets = {};
  for (const m of matches) {
    if (!m.kickoff) continue;
    const date = m.kickoff.length >= 10 ? m.kickoff.slice(0, 10) : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!buckets[date]) buckets[date] = [];
    buckets[date].push(m);
  }
  return buckets;
}

function mergeMatches(oldMatches, newMatches) {
  const map = new Map();
  for (const m of (oldMatches || [])) {
    if (m && m.id) map.set(m.id, m);
  }
  for (const fresh of newMatches) {
    if (!fresh || !fresh.id) continue;
    const old = map.get(fresh.id);
    if (old && old.status === 'finished' && old.score) continue;
    if (old) {
      const merged = { ...old, ...fresh };
      if (old.status === 'finished' && !fresh.status) merged.status = old.status;
      if (old.score && !fresh.score) merged.score = old.score;
      if (old.score_ht && !fresh.score_ht) merged.score_ht = old.score_ht;
      map.set(fresh.id, merged);
    } else {
      map.set(fresh.id, fresh);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || ''));
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

  const buckets = bucketByKickoffDate(allMatches);
  for (const date of Object.keys(buckets).sort()) {
    const fresh = buckets[date];
    fresh.forEach(m => { m.period = date; });
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
