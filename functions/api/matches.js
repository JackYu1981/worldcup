// GET /api/matches?period=YYYY-MM-DD
//
// Returns the 500.com matches envelope, but for World Cup matches we join FIFA's
// match_lineups:{500_id} record so FIFA's score / score_ht / status override
// 500's (slower-updating) figures. Odds and handicap remain 500-sourced.
//
// FIFA-authoritative overrides per WC match:
//   - status:    'finished' if FIFA match_status==0 (terminal)
//                'live'     if FIFA match_status==3
//                else preserves 500's status
//   - score:     "{home.score}-{away.score}" from FIFA HomeTeam/AwayTeam.Score
//   - score_ht:  "{home.score_ht}-{away.score_ht}" from goals where period<=3
//
// 500.com remains the source of truth for: odds, handicap, kickoff (display), code.
// Frontend code (getMatchResult / result-hit highlighting) consumes m.score unchanged.

import { json, error, options } from '../lib/response.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const period = url.searchParams.get('period') || url.searchParams.get('date');

  if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    return error('请提供period参数 (YYYY-MM-DD)', 400);
  }

  try {
    const data = await context.env.MATCH_DATA.get(`matches:${period}`, 'json');
    if (!data) {
      return error('该期暂无数据', 404);
    }

    // Join FIFA match_lineups for World Cup matches (parallel KV reads — cheap).
    const wcMatches = (data.matches || []).filter(m => m.league === '世界杯');
    const lineups = await Promise.all(
      wcMatches.map(m =>
        context.env.MATCH_DATA.get(`match_lineups:${m.id}`, 'json').catch(() => null)
      )
    );
    const lineupById = new Map();
    wcMatches.forEach((m, i) => { if (lineups[i]) lineupById.set(m.id, lineups[i]); });

    for (const m of (data.matches || [])) {
      const lu = lineupById.get(m.id);
      if (!lu) continue;
      const homeScore = lu.home?.score;
      const awayScore = lu.away?.score;
      const homeHt = lu.home?.score_ht;
      const awayHt = lu.away?.score_ht;

      if (lu.match_status === 0) {
        m.status = 'finished';
      } else if (lu.match_status === 3) {
        m.status = 'live';
      }
      // else leave m.status as 500's

      if (homeScore != null && awayScore != null) {
        m.score = `${homeScore}-${awayScore}`;
      }
      if (homeHt != null && awayHt != null) {
        m.score_ht = `${homeHt}-${awayHt}`;
      }
      m._score_source = (homeScore != null && awayScore != null) ? 'fifa' : '500';
    }

    return json(data, 200, 60);   // cache 60s (was 300s — FIFA score can change every 10min)
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
