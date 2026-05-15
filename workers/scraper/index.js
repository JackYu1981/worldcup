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
  const url = date ? `https://trade.500.com/jczq/?date=${date}` : 'https://trade.500.com/jczq/';
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
    const league = getAttr('simpleleague');

    const codeMatch = matchNum.match(/(\d+)/);
    const code = codeMatch ? codeMatch[1] : '000';

    const nspfOdds = parseOdds(rowHtml, 'nspf');
    const spfOdds = parseOdds(rowHtml, 'spf');
    const handicap = parseInt(rangqiu) || 0;

    matches.push({
      id: `f${fixtureId}`,
      code: code,
      league: league,
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

function getBeijingDate(offsetDays = 0) {
  const now = new Date();
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  beijing.setDate(beijing.getDate() + offsetDays);
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
    const today = getBeijingDate(0);
    const yesterday = getBeijingDate(-1);
    const hour = getBeijingHour();

    console.log(`[Cron] Running at Beijing hour ${hour}, date ${today}`);

    // 抓取所有在售比赛（不带date参数，返回未来几天）
    try {
      const html = await fetch500(null);
      if (!html || html.length < 1000) {
        console.log('[Cron] Empty page, skipping');
        return;
      }

      const allMatches = parseMatches(html);
      if (allMatches.length === 0) {
        console.log('[Cron] No matches found');
        return;
      }

      // 按日期分组
      const byDate = {};
      allMatches.forEach(m => {
        if (!byDate[m.date]) byDate[m.date] = [];
        byDate[m.date].push(m);
      });

      for (const [date, matches] of Object.entries(byDate)) {
        const output = {
          date,
          source: '500.com',
          fetched_at: new Date().toISOString(),
          match_count: matches.length,
          matches
        };
        await env.MATCH_DATA.put(`matches:${date}`, JSON.stringify(output), {
          expirationTtl: 86400 * 5
        });
        console.log(`[Cron] Saved ${matches.length} matches for ${date}`);
      }
    } catch (e) {
      console.error(`[Cron] Odds fetch error: ${e.message}`);
    }

    // 抓取昨天和今天的赛果（上午时段检查昨天，全天检查今天）
    const resultDates = [today];
    if (hour < 12) resultDates.push(yesterday);

    for (const date of resultDates) {
      try {
        const existing = await env.MATCH_DATA.get(`matches:${date}`, 'json');
        if (!existing || !shouldFetchResults(existing.matches)) continue;

        console.log(`[Cron] Fetching results for ${date}...`);
        const resultHtml = await fetchResults(date);
        if (!resultHtml) continue;

        const results = parseResults(resultHtml);
        const updated = mergeResults(existing.matches, results);
        existing.matches = updated;
        existing.fetched_at = new Date().toISOString();

        await env.MATCH_DATA.put(`matches:${date}`, JSON.stringify(existing), {
          expirationTtl: 86400 * 5
        });
        console.log(`[Cron] Updated results for ${date}`);
      } catch (e) {
        console.error(`[Cron] Results error for ${date}: ${e.message}`);
      }
    }
  },

  async fetch(request, env) {
    return new Response('Scraper worker is running. Use cron triggers.', { status: 200 });
  }
};
