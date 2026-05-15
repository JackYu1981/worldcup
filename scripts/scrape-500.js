#!/usr/bin/env node
/**
 * 竞彩足球赔率抓取脚本 (本地调试用)
 *
 * 用法: node scripts/scrape-500.js [date]
 *   date 格式: YYYY-MM-DD (默认不传参，获取所有在售比赛)
 *
 * 输出: data/matches/{date}.json
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import { getAdapter } from '../lib/adapters/index.js';
import { createEnvelope } from '../lib/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const adapter = getAdapter('500.com');
const TARGET_DATE = process.argv[2] || null;

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: adapter.fetchHeaders }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const html = iconv.decode(buf, adapter.encoding);
        resolve(html);
      });
    }).on('error', reject);
  });
}

function saveMatches(matches, date) {
  const outputDir = path.join(__dirname, '..', 'data', 'matches');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFile = path.join(outputDir, `${date}.json`);
  const envelope = createEnvelope(date, adapter.name, matches);
  fs.writeFileSync(outputFile, JSON.stringify(envelope, null, 2), 'utf8');
  console.log(`Saved to ${outputFile}`);
}

async function main() {
  const url = adapter.buildMatchesUrl(TARGET_DATE ? { date: TARGET_DATE } : {});
  console.log(`Fetching ${adapter.name} 竞彩数据... (${url})`);

  const html = await fetchPage(url);

  if (!html || html.length < 1000) {
    console.error('Failed to fetch page or empty response');
    process.exit(1);
  }

  const allMatches = adapter.parseMatches(html);

  if (allMatches.length === 0) {
    console.log('No matches found on page');
    process.exit(0);
  }

  const byDate = {};
  allMatches.forEach(m => {
    if (!byDate[m.date]) byDate[m.date] = [];
    byDate[m.date].push(m);
  });

  console.log(`Found ${allMatches.length} matches across ${Object.keys(byDate).length} date(s):\n`);

  for (const [date, matches] of Object.entries(byDate)) {
    console.log(`--- ${date} (${matches.length} matches) ---`);
    matches.forEach(m => {
      const hc = Math.abs(m.handicap.line);
      const hcDir = m.handicap.line > 0 ? `客让${hc}` : m.handicap.line < 0 ? `主让${hc}` : '平手';
      console.log(`  ${m.code} ${m.home} vs ${m.away} (${m.kickoff})`);
      console.log(`       胜平负: ${m.odds.home_win} / ${m.odds.draw} / ${m.odds.away_win}`);
      console.log(`       ${hcDir}: ${m.handicap.home_win} / ${m.handicap.draw} / ${m.handicap.away_win}`);
    });

    saveMatches(matches, date);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
