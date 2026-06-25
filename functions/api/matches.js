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

    // Join FIFA match_lineups + asian_handicap for World Cup matches (parallel KV reads — cheap).
    const wcMatches = (data.matches || []).filter(m => m.league === '世界杯');
    const [lineups, mappings, fifaCal, handicaps] = await Promise.all([
      Promise.all(wcMatches.map(m =>
        context.env.MATCH_DATA.get(`match_lineups:${m.id}`, 'json').catch(() => null)
      )),
      Promise.all(wcMatches.map(m =>
        context.env.MATCH_DATA.get(`fixture_mapping:${m.id}`, 'json').catch(() => null)
      )),
      context.env.MATCH_DATA.get('fifa_calendar', 'json').catch(() => null),
      Promise.all(wcMatches.map(m =>
        context.env.MATCH_DATA.get(`asian_handicap:${m.id}`, 'json').catch(() => null)
      )),
    ]);
    const lineupById = new Map();
    const mappingById = new Map();
    const handicapById = new Map();
    wcMatches.forEach((m, i) => {
      if (lineups[i]) lineupById.set(m.id, lineups[i]);
      if (mappings[i]) mappingById.set(m.id, mappings[i]);
      if (handicaps[i]) handicapById.set(m.id, handicaps[i]);
    });
    // fifa_calendar carries stage/group/stadium info, keyed by id_match (FIFA's)
    const fifaByMatchId = new Map();
    if (fifaCal?.matches) {
      for (const fm of fifaCal.matches) {
        fifaByMatchId.set(fm.id_match, fm);
      }
    }

    for (const m of (data.matches || [])) {
      const lu = lineupById.get(m.id);
      const mp = mappingById.get(m.id);
      const ah = handicapById.get(m.id);
      // Attach bet365 asian handicap when available (WC matches with scraped data).
      // Frontend renders this in the pre-match scoreboard area on index cards.
      if (ah?.current) {
        m.asian_handicap = {
          current: ah.current,
          open: ah.open || null,
          trend: ah.trend || 'stable',
          bookmaker: ah.bookmaker || 'bet365',
        };
      }
      // Attach FIFA fixture metadata (stage / group / stadium) for World Cup matches
      // so the frontend can show "First Stage · Group C · Atlanta Stadium" subline.
      // Safe degradation: if calendar isn't refreshed yet (old schema), new fields
      // will be undefined and frontend just hides that subline.
      if (mp?.fifa_id_match) {
        const fm = fifaByMatchId.get(mp.fifa_id_match);
        if (fm) {
          m.fifa_meta = {
            home_code: fm.home_code,           // ISO3 for flag lookup
            away_code: fm.away_code,
            home_name_en: fm.home_name_en,
            away_name_en: fm.away_name_en,
            stage_name: fm.stage_name,         // "First Stage" / "Round of 32" / ...
            group_name: fm.group_name || null, // "Group A".."Group L" or null
            stadium_name: fm.stadium_name || null,
            stadium_city: fm.stadium_city || null,
          };
        }
      }

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

      // Live clock anchor for live matches — frontend ticks every second based on
      // fetched_at + match_time, then auto-refreshes the anchor every 30s via /api/matches.
      // period: 3 = 1st half, 4 = HT, 5 = 2nd half, 6 = 2H-end break, 7 = 1ET, 8 = HT-ET,
      //         9 = 2ET, 10 = finished (FT). match_time like "45'+2'" / "87'" / "HT".
      if (lu.match_status === 3) {
        m.live_clock = {
          period: lu.period,
          match_time: lu.match_time,
          fetched_at: lu.fetched_at,
        };
      }
    }

    return json(data, 200, 60);   // cache 60s (was 300s — FIFA score can change every 10min)
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
