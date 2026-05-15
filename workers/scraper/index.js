/**
 * Cloudflare Worker: 500.com 竞彩数据定时抓取
 *
 * Cron: 每小时执行一次
 * - 抓取当天在售比赛赔率
 * - 比赛结束2小时后抓取赛果
 * - 数据写入 KV (MATCH_DATA)
 */

const ICONV_NOT_NEEDED = true; // Cloudflare Workers use TextDecoder with 'gbk' label

async function fetch500(date) {
  const url = `https://trade.500.com/jczq/?date=${date}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder('gbk');
  return decoder.decode(buf);
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

async function fetchResults(date) {
  const url = `https://trade.500.com/jczq/result.php?date=${date}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }
  });

  if (!resp.ok) return null;

  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder('gbk');
  return decoder.decode(buf);
}

function parseResults(html) {
  const results = {};
  const scoreRegex = /data-fixtureid="(\d+)"[^>]*data-homescore="(\d+)"[^>]*data-awayscore="(\d+)"/g;
  let m;
  while ((m = scoreRegex.exec(html)) !== null) {
    results[`f${m[1]}`] = { home: parseInt(m[1]), away: parseInt(m[2]), home_score: parseInt(m[2]), away_score: parseInt(m[3]) };
  }
  return results;
}

function mergeResults(matches, results) {
  for (const match of matches) {
    if (results[match.id]) {
      const r = results[match.id];
      match.score = `${r.home_score}-${r.away_score}`;
      match.status = 'finished';
    }
  }
  return matches;
}

function getBeijingDate(offsetHours = 0) {
  const now = new Date(Date.now() + offsetHours * 3600000);
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return beijing.toISOString().slice(0, 10);
}

function getBeijingHour() {
  const now = new Date();
  const h = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return h.getHours();
}

function shouldFetchResults(matches) {
  if (!matches || matches.length === 0) return false;
  const now = Date.now();
  const beijingOffset = 8 * 3600000;

  for (const m of matches) {
    if (m.status === 'finished') continue;
    const kickoffStr = `${m.date}T${m.kickoff}:00+08:00`;
    const kickoff = new Date(kickoffStr).getTime();
    const matchEnd = kickoff + 120 * 60000; // 比赛约120分钟
    if (now > matchEnd) return true;
  }
  return false;
}

export default {
  async scheduled(event, env, ctx) {
    const today = getBeijingDate();
    const hour = getBeijingHour();

    console.log(`[Cron] Running at Beijing hour ${hour}, date ${today}`);

    try {
      const html = await fetch500(today);
      if (!html || html.length < 1000) {
        console.log('[Cron] Empty page, skipping');
        return;
      }

      let matches = parseMatches(html);
      if (matches.length === 0) {
        console.log('[Cron] No matches found');
        return;
      }

      // 检查是否有已结束的比赛需要抓赛果
      const existing = await env.MATCH_DATA.get(`matches:${today}`, 'json');
      if (existing && shouldFetchResults(existing.matches)) {
        console.log('[Cron] Fetching results for finished matches...');
        const resultHtml = await fetchResults(today);
        if (resultHtml) {
          const results = parseResults(resultHtml);
          matches = mergeResults(matches, results);
        }
      }

      const output = {
        date: today,
        source: '500.com',
        fetched_at: new Date().toISOString(),
        match_count: matches.length,
        matches: matches
      };

      await env.MATCH_DATA.put(`matches:${today}`, JSON.stringify(output), {
        expirationTtl: 86400 * 3
      });

      console.log(`[Cron] Saved ${matches.length} matches for ${today}`);

    } catch (e) {
      console.error(`[Cron] Error: ${e.message}`);
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
