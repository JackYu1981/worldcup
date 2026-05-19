/**
 * 500.com adapter — maps 500.com jczq page data to canonical match schema.
 */

import { BaseAdapter } from './base.js';
import { normalizeMatch } from '../schema.js';

const FIELD_MAP = {
  fixtureid:    'id',
  homesxname:   'home',
  awaysxname:   'away',
  matchdate:    'date',
  matchtime:    'kickoff',
  simpleleague: 'league',
  matchnum:     'code',
  rangqiu:      'handicap_line',
};

export class Adapter500 extends BaseAdapter {
  get name() {
    return '500.com';
  }

  get encoding() {
    return 'gbk';
  }

  buildMatchesUrl(options = {}) {
    const base = 'https://trade.500.com/jczq/';
    if (options.date) return `${base}?playtype=1&date=${options.date}`;
    return base;
  }

  buildResultsUrl(date) {
    return `https://trade.500.com/jczq/result.php?date=${date}`;
  }

  buildKaijiangUrl(date) {
    return `https://zx.500.com/jczq/kaijiang.php?date=${date}`;
  }

  // 解析开奖页：权威90分钟全场比分 + 半场比分
  // 字段关系: code(如"周日001")是稳定主键，"(H1:A1) H2:A2" → score_ht=H1-A1, score=H2-A2
  parseKaijiang(html) {
    const result = {};
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let m;
    while ((m = trRegex.exec(html)) !== null) {
      const row = m[1];
      const codeMatch = row.match(/<td>(周[日一二三四五六]\d+)<\/td>/);
      if (!codeMatch) continue;
      const scoreMatch = row.match(/<td[^>]*class="eng"[^>]*>\s*\((\d+):(\d+)\)\s*(\d+):(\d+)\s*<\/td>/);
      if (!scoreMatch) continue;
      result[codeMatch[1]] = {
        score_ht: `${scoreMatch[1]}-${scoreMatch[2]}`,
        score: `${scoreMatch[3]}-${scoreMatch[4]}`,
      };
    }
    return result;
  }

  get fetchHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
  }

  parseMatches(html) {
    const matches = [];
    const trRegex = /<tr[^>]*class="bet-tb-tr[^"]*"[^>]*>/g;
    let trMatch;

    while ((trMatch = trRegex.exec(html)) !== null) {
      const trStart = trMatch.index;
      const nextTrIdx = html.indexOf('<tr', trStart + 10);
      const rowHtml = html.slice(trStart, nextTrIdx > 0 ? nextTrIdx : trStart + 8000);

      const raw = this.transformMatch(rowHtml);
      if (raw) matches.push(normalizeMatch(raw));
    }

    return matches;
  }

  parseResults(html) {
    const results = {};
    const trRegex = /<tr[^>]*class="bet-tb-tr[^"]*"[^>]*>/g;
    let trMatch;
    while ((trMatch = trRegex.exec(html)) !== null) {
      const trStart = trMatch.index;
      const nextTrIdx = html.indexOf('<tr', trStart + 1);
      const rowHtml = html.slice(trStart, nextTrIdx > 0 ? nextTrIdx : trStart + 8000);

      const fidMatch = rowHtml.match(/data-fixtureid="(\d+)"/);
      const isEnd = rowHtml.match(/data-isend="1"/);
      if (!fidMatch || !isEnd) continue;

      const scoreMatch = rowHtml.match(/class="score"[^>]*>(\d+):(\d+)<\/a>/);
      if (scoreMatch) {
        results[`f${fidMatch[1]}`] = {
          home_score: parseInt(scoreMatch[1]),
          away_score: parseInt(scoreMatch[2])
        };
      }
    }
    return results;
  }

  transformMatch(rowHtml) {
    const getAttr = (name) => {
      const m = rowHtml.match(new RegExp(`data-${name}="([^"]*)"`));
      return m ? m[1] : '';
    };

    const fixtureId = getAttr('fixtureid');
    if (!fixtureId) return null;

    const matchNum = getAttr('matchnum');

    const spfOdds = this._parseOdds(rowHtml, 'spf');
    const nspfOdds = this._parseOdds(rowHtml, 'nspf');
    const rangqiu = parseInt(getAttr('rangqiu')) || 0;

    const isEnd = getAttr('isend') === '1';
    let score = null;
    let status = isEnd ? 'finished' : 'scheduled';
    if (isEnd) {
      const scoreMatch = rowHtml.match(/class="score"[^>]*>(\d+):(\d+)<\/a>/);
      if (scoreMatch) {
        score = `${scoreMatch[1]}-${scoreMatch[2]}`;
      }
    }

    const matchDate = getAttr('matchdate');
    const matchTime = getAttr('matchtime');
    const kickoff = (matchDate && matchTime) ? `${matchDate} ${matchTime}` : (matchTime || '');

    // buyendtime 形如 "2026-05-19 22:00:00"，前 10 字符就是 500.com 标的"销售/开奖期次"日期
    const buyEndTime = getAttr('buyendtime');
    const period = buyEndTime && buyEndTime.length >= 10 ? buyEndTime.slice(0, 10) : null;

    return {
      id: `f${fixtureId}`,
      code: matchNum || '000',
      league: getAttr('simpleleague'),
      home: getAttr('homesxname'),
      away: getAttr('awaysxname'),
      kickoff,
      period,
      status,
      score,
      odds: {
        home_win: nspfOdds['3'] || null,
        draw: nspfOdds['1'] || null,
        away_win: nspfOdds['0'] || null,
      },
      handicap: {
        line: rangqiu,
        home_win: spfOdds['3'] || null,
        draw: spfOdds['1'] || null,
        away_win: spfOdds['0'] || null,
      }
    };
  }

  _parseOdds(rowHtml, type) {
    const odds = {};
    const regex = new RegExp(`data-type="${type}"\\s+data-value="(\\d)"\\s+data-sp="([\\d.]+)"`, 'g');
    let m;
    while ((m = regex.exec(rowHtml)) !== null) {
      odds[m[1]] = parseFloat(m[2]);
    }
    return odds;
  }
}
