#!/usr/bin/env node
/**
 * 500.com 竞彩足球赔率抓取脚本
 *
 * 抓取 https://trade.500.com/jczq/ 页面的竞彩数据
 * 输出格式匹配项目 data/matches/{date}.json 结构
 *
 * 用法: node scripts/scrape-500.js [date]
 *   date 格式: YYYY-MM-DD (默认今天)
 *
 * 输出: data/matches/{date}.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const TARGET_DATE = process.argv[2] || new Date().toISOString().slice(0, 10);

function fetch500(date) {
  return new Promise((resolve, reject) => {
    const url = `https://trade.500.com/jczq/?date=${date}`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }
    };

    https.get(url, options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const html = iconv.decode(buf, 'gbk');
        resolve(html);
      });
    }).on('error', reject);
  });
}

function parseMatches(html) {
  const matches = [];

  const trRegex = /<tr[^>]*class="bet-tb-tr"[^>]*>/g;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const trStart = trMatch.index;
    const nextTrIdx = html.indexOf('<tr class="bet-tb-tr"', trStart + 1);
    const rowHtml = html.slice(trStart, nextTrIdx > 0 ? nextTrIdx : trStart + 8000);

    const getAttr = (name) => {
      const m = rowHtml.match(new RegExp(`data-${name}="([^"]*)"`));
      return m ? m[1] : '';
    };

    const fixtureId = getAttr('fixtureid');
    const homeName = getAttr('homesxname');
    const awayName = getAttr('awaysxname');
    const matchDate = getAttr('matchdate');
    const matchTime = getAttr('matchtime');
    const rangqiu = getAttr('rangqiu');
    const matchNum = getAttr('matchnum');
    const processDate = getAttr('processdate');

    const codeMatch = matchNum.match(/(\d+)/);
    const code = codeMatch ? codeMatch[1] : '000';

    const nspfOdds = parseOdds(rowHtml, 'nspf');
    const spfOdds = parseOdds(rowHtml, 'spf');
    const handicap = parseInt(rangqiu) || 0;

    matches.push({
      id: `f${fixtureId}`,
      code: code,
      home: homeName,
      away: awayName,
      date: matchDate,
      kickoff: matchTime,
      process_date: processDate,
      status: 'scheduled',
      score: null,
      odds: {
        home_win: spfOdds['3'] || null,
        draw: spfOdds['1'] || null,
        away_win: spfOdds['0'] || null,
      },
      handicap: {
        line: handicap,
        home_win: nspfOdds['3'] || null,
        draw: nspfOdds['1'] || null,
        away_win: nspfOdds['0'] || null,
      }
    });
  }

  return matches;
}

function parseOdds(rowHtml, type) {
  const odds = {};
  const regex = new RegExp(`data-type="${type}"\\s+data-value="(\\d)"\\s+data-sp="([\\d.]+)"`, 'g');
  let m;
  while ((m = regex.exec(rowHtml)) !== null) {
    odds[m[1]] = parseFloat(m[2]);
  }
  return odds;
}

function saveMatches(matches, date) {
  const outputDir = path.join(__dirname, '..', 'data', 'matches');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFile = path.join(outputDir, `${date}.json`);

  const output = {
    date: date,
    source: '500.com',
    fetched_at: new Date().toISOString(),
    match_count: matches.length,
    matches: matches
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nSaved to ${outputFile}`);
}

async function main() {
  console.log(`Fetching 500.com 竞彩数据 for ${TARGET_DATE}...`);

  const html = await fetch500(TARGET_DATE);

  if (!html || html.length < 1000) {
    console.error('Failed to fetch page or empty response');
    process.exit(1);
  }

  const matches = parseMatches(html);

  if (matches.length === 0) {
    console.log(`No matches found on page for date=${TARGET_DATE}`);
    process.exit(0);
  }

  console.log(`Found ${matches.length} matches:\n`);
  matches.forEach(m => {
    const hc = Math.abs(m.handicap.line);
    const hcDir = m.handicap.line > 0 ? `客让${hc}` : m.handicap.line < 0 ? `主让${hc}` : '平手';
    console.log(`  ${m.code} ${m.home} vs ${m.away} (${m.date} ${m.kickoff})`);
    console.log(`       胜平负: ${m.odds.home_win} / ${m.odds.draw} / ${m.odds.away_win}`);
    console.log(`       ${hcDir}: ${m.handicap.home_win} / ${m.handicap.draw} / ${m.handicap.away_win}`);
  });

  saveMatches(matches, TARGET_DATE);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
