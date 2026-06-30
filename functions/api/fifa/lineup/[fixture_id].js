// GET /api/fifa/lineup/{fixture_id}
//
// Returns a structured response separating WHAT'S ALWAYS KNOWABLE from
// WHAT REQUIRES FIFA TO HAVE PUBLISHED THE LINEUP. Three independent blocks:
//
//   fixture_meta   — ALWAYS present (built from fixture_mapping + countries seed).
//                    Includes: home/away country_code + country_zh + team_name_en,
//                    kickoff_utc, fifa_id_match.
//
//   match_state    — Present whenever match_lineups exists (= worker has seen the
//                    fixture at least once; usually KO-90min onward).
//                    Includes: match_status, match_status_label, period, match_time,
//                    home/away.score, score_ht, events (goals/bookings/subs).
//
//   lineup         — Present ONLY when FIFA has published starters (lineup_available=true).
//                    Includes: home/away.starting[], substitutes[], coach, tactics.
//
// The frontend renders header / 战绩 from fixture_meta unconditionally, scoreboard
// from match_state when available, and the 阵容 section body from lineup when
// available. No more "one missing piece blocks everything" coupling.

import { json, error, options } from '../../../lib/response.js';

// FIFA period codes: 3 = 1st half (incl. 45'+stoppage),
// 5 = 2nd half (incl. 90'+stoppage). HT goals = period <= 3.
function computeHalfTimeScore(events) {
  const goals = (events && events.goals) || [];
  let home = 0, away = 0;
  for (const g of goals) {
    const period = g.period;
    if (period == null || period > 3) continue;
    if (g.side === 'home') home++;
    else if (g.side === 'away') away++;
  }
  return { home, away };
}

export async function onRequestGet(context) {
  const { params, env } = context;
  const fixtureId = params.fixture_id;
  if (!fixtureId) return error('missing fixture_id', 400);

  try {
    // Load all KV sources in parallel — including asian handicap (independent block)
    const [mapping, lineup, countries, fifaCal, handicap] = await Promise.all([
      env.MATCH_DATA.get(`fixture_mapping:${fixtureId}`, 'json').catch(() => null),
      env.MATCH_DATA.get(`match_lineups:${fixtureId}`, 'json').catch(() => null),
      env.MATCH_DATA.get('countries', 'json').catch(() => null),
      env.MATCH_DATA.get('fifa_calendar', 'json').catch(() => null),
      env.MATCH_DATA.get(`asian_handicap:${fixtureId}`, 'json').catch(() => null),
    ]);
    const codeToZh = countries?.items
      ? Object.fromEntries(countries.items.map(c => [c.code, c.zh]))
      : {};
    const codeToEn = countries?.items
      ? Object.fromEntries(countries.items.map(c => [c.code, c.en]))
      : {};
    // Look up stage/group/stadium meta from the FIFA calendar by FIFA match id.
    let fifaMatchMeta = null;
    if (mapping?.fifa_id_match && fifaCal?.matches) {
      fifaMatchMeta = fifaCal.matches.find(fm => fm.id_match === mapping.fifa_id_match) || null;
    }

    // === BLOCK 1: fixture_meta — always built from mapping (or null if no mapping) ===
    // This is what powers header / tabs / 战绩 even when nothing else exists.
    let fixture_meta = null;
    let mapping_state = 'unmapped';   // unmapped | unmatched | matched
    if (mapping) {
      if (mapping.match_confidence === 'exact' || mapping.match_confidence === 'time_skew_5min') {
        mapping_state = 'matched';
      } else {
        mapping_state = 'unmatched';
      }
      if (mapping.home_code && mapping.away_code) {
        fixture_meta = {
          fixture_id: fixtureId,
          fifa_id_match: mapping.fifa_id_match || null,
          kickoff_utc: mapping.kickoff_utc || null,
          stage_name: fifaMatchMeta?.stage_name || null,    // e.g. "First Stage"
          group_name: fifaMatchMeta?.group_name || null,    // e.g. "Group C"
          stadium_name: fifaMatchMeta?.stadium_name || null,
          stadium_city: fifaMatchMeta?.stadium_city || null,
          home: {
            country_code: mapping.home_code,
            country_zh: codeToZh[mapping.home_code] || mapping.home_code,
            country_en: codeToEn[mapping.home_code] || mapping.home_code,
          },
          away: {
            country_code: mapping.away_code,
            country_zh: codeToZh[mapping.away_code] || mapping.away_code,
            country_en: codeToEn[mapping.away_code] || mapping.away_code,
          },
        };
      }
    }

    // === BLOCK 2: match_state — derived from match_lineups when it exists ===
    // Score / status / clock / events. None of this depends on starters being
    // published — FIFA writes status & score independently of the lineup roster.
    let match_state = null;
    if (lineup) {
      const ht = computeHalfTimeScore(lineup.events);
      // FIFA's HomeTeam.Score / AwayTeam.Score is sometimes null even after a
      // match is finished (observed on ARG-AUT, FRA-IRQ, NOR-SEN — most likely
      // a FIFA Live-API quirk where they stop populating Score post-match).
      // Fall back to counting `events.goals` by side, which is always reliable.
      // The lineup's `match_status_label === 'finished'` gates this fallback so
      // we don't show partial in-progress scores as final.
      //
      // PSO carve-out: period=11 goals are PSO conversions — they must NOT count
      // toward the regulation score slot. score_pen surfaces them separately
      // so UI can render "(X) A-B (Y)" on KO matches that went to shootout.
      const goals = lineup.events?.goals || [];
      const regGoalsBySide = (side) => goals.filter(g => g.side === side && g.period !== 11).length;
      const penGoalsBySide = (side) => goals.filter(g => g.side === side && g.period === 11).length;
      const isFinished = lineup.match_status_label === 'finished'
                       || (typeof lineup.period === 'number' && lineup.period >= 10);
      const homeScore = (lineup.home?.score != null) ? lineup.home.score
                      : isFinished                    ? regGoalsBySide('home')
                      : null;
      const awayScore = (lineup.away?.score != null) ? lineup.away.score
                      : isFinished                    ? regGoalsBySide('away')
                      : null;
      // score_pen: prefer scraper-written field; fall back to goal-event count.
      // Only emit when a shootout actually occurred (>0 on either side).
      const homePenRaw = (lineup.home?.score_pen != null) ? lineup.home.score_pen : penGoalsBySide('home');
      const awayPenRaw = (lineup.away?.score_pen != null) ? lineup.away.score_pen : penGoalsBySide('away');
      const hasShootout = (homePenRaw + awayPenRaw) > 0;
      match_state = {
        match_status: lineup.match_status ?? null,
        match_status_label: lineup.match_status_label || null,
        period: lineup.period ?? null,
        match_time: lineup.match_time ?? null,
        fetched_at: lineup.fetched_at || null,
        home_score: homeScore,
        away_score: awayScore,
        home_score_ht: ht.home,
        away_score_ht: ht.away,
        home_score_pen: hasShootout ? homePenRaw : null,
        away_score_pen: hasShootout ? awayPenRaw : null,
        events: lineup.events || { goals: [], bookings: [], substitutions: [] },
      };
    }

    // === BLOCK 3: lineup — only when starters are actually published ===
    // tactics + starting + substitutes + coach. Frontend uses this to render
    // the 阵容 section body; absence triggers the "等待 FIFA 公布" placeholder.
    let lineup_block = null;
    const lineupAvailable = !!(lineup && lineup.lineup_available);
    if (lineupAvailable) {
      // Build id→{name,shirt} table for substitution enrichment.
      const idToName = {};
      const idToShirt = {};
      for (const side of ['home', 'away']) {
        for (const list of [lineup[side]?.starting || [], lineup[side]?.substitutes || []]) {
          for (const p of list) {
            if (p.player_id && p.name) idToName[p.player_id] = p.name;
            if (p.player_id && p.shirt_number != null) idToShirt[p.player_id] = p.shirt_number;
          }
        }
      }
      // Enrich substitution records (used by frontend; the events live in match_state)
      const subs = match_state.events?.substitutions || [];
      for (const s of subs) {
        if (s.off_player_id && !s.off_player_name) s.off_player_name = idToName[s.off_player_id] || null;
        if (s.on_player_id  && !s.on_player_name)  s.on_player_name  = idToName[s.on_player_id]  || null;
        if (s.on_player_id  && s.on_player_shirt  == null) s.on_player_shirt  = idToShirt[s.on_player_id]  ?? null;
        if (s.off_player_id && s.off_player_shirt == null) s.off_player_shirt = idToShirt[s.off_player_id] ?? null;
      }

      lineup_block = {
        fixture_locked: lineup.fixture_locked || false,
        home: {
          tactics: lineup.home?.tactics || null,
          starting: lineup.home?.starting || [],
          substitutes: lineup.home?.substitutes || [],
          coach: lineup.home?.coach || null,
        },
        away: {
          tactics: lineup.away?.tactics || null,
          starting: lineup.away?.starting || [],
          substitutes: lineup.away?.substitutes || [],
          coach: lineup.away?.coach || null,
        },
      };
    }

    // === BLOCK 4: asian_handicap — bet365 from 500.com, written by separate worker ===
    // Independent of lineup/match_state — present whenever the scraper has fetched
    // it (typically from fixture appearance on 500.com odds page until kickoff).
    let asian_handicap = null;
    if (handicap?.current) {
      asian_handicap = {
        bookmaker: handicap.bookmaker || 'bet365',
        current: handicap.current,        // { line, home_water, away_water }
        open:    handicap.open || null,    // initial line for trend context
        trend:   handicap.trend || 'stable',
        fetched_at: handicap.fetched_at || null,
      };
    }

    // === Response shape ===
    const response = {
      fixture_id: fixtureId,
      mapping_state,                     // unmapped | unmatched | matched
      lineup_available: lineupAvailable, // (legacy) true iff lineup block is present
      reason: lineupAvailable ? null : (
        mapping_state === 'unmapped' ? 'fixture_not_mapped' :
        mapping_state === 'unmatched' ? 'fixture_unmatched' :
        'not_yet_published_by_fifa'
      ),
      note: lineupAvailable ? null : (
        mapping_state === 'unmapped' ? 'FIFA mapping not yet computed for this 500.com fixture' :
        mapping_state === 'unmatched' ? (mapping?.match_note || 'No matching FIFA fixture found') :
        'FIFA will publish lineup ~60-90min before kickoff'
      ),
      fixture_meta,
      match_state,
      lineup: lineup_block,
      asian_handicap,                    // null when scraper hasn't fetched yet
    };
    return json(response, 200, 60);
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
