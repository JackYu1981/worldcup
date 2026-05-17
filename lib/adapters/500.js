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

  buildScoresUrl(date) {
    return `https://live.500.com/zqdc.php?date=${date}`;
  }

  get scoresEncoding() {
    return 'gbk';
  }

  parseScores(html) {
    const scores = {};
    const trRegex = /<tr[^>]*fid="(\d+)"[^>]*>/g;
    let match;
    while ((match = trRegex.exec(html)) !== null) {
      const fid = match[1];
      const trStart = match.index;
      const trEnd = html.indexOf('</tr>', trStart);
      const tr = html.substring(trStart, trEnd);
      const scoreMatch = tr.match(/<td[^>]*class="red"[^>]*>\s*(\d+)\s*-\s*(\d+)\s*<\/td>/);
      if (scoreMatch) {
        scores[`f${fid}`] = `${scoreMatch[1]}-${scoreMatch[2]}`;
      }
    }
    return scores;
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
    const codeMatch = matchNum.match(/(\d+)/);

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

    return {
      id: `f${fixtureId}`,
      code: codeMatch ? codeMatch[1] : '000',
      league: getAttr('simpleleague'),
      home: getAttr('homesxname'),
      away: getAttr('awaysxname'),
      date: getAttr('matchdate'),
      kickoff: getAttr('matchtime'),
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
