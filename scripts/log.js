#!/usr/bin/env node
/**
 * 写入系统日志到KV
 * 用法: node scripts/log.js <类型> <消息>
 * 例如: node scripts/log.js 方案 "AI优化: 发财测试1/3/4/5 → 正式方案(4个)"
 */

import { execSync } from 'child_process';

const KV_NS = '278f1209ffd84662bd51921370a2fbe9';
const type = process.argv[2];
const message = process.argv[3];

if (!type || !message) {
  console.error('用法: node scripts/log.js <类型> <消息>');
  process.exit(1);
}

const raw = execSync(
  `npx wrangler kv key get --namespace-id=${KV_NS} "system:logs" --remote`,
  { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
).trim();

let logs = [];
try {
  const data = JSON.parse(raw);
  logs = data.logs || [];
} catch (e) {}

logs.unshift({ type, message, time: new Date().toISOString() });
if (logs.length > 100) logs.length = 100;

const fs = await import('fs');
const tmpFile = '/tmp/_log_entry.json';
fs.writeFileSync(tmpFile, JSON.stringify({ logs }));

execSync(
  `npx wrangler kv key put --namespace-id=${KV_NS} "system:logs" --path=${tmpFile} --remote`,
  { stdio: 'inherit' }
);

console.log(`✅ 日志已写入: [${type}] ${message}`);
