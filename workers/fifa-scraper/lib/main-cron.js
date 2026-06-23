// Main cron — runs every 10 min, but only writes KV when there's actual work.
//
// Per-tick logic:
//   1. Find 500.com 世界杯 fixtures whose kickoff is in [KO-90min, KO_end+15min].
//      If none → early return (no KV writes).
//   2. For each fixture in window:
//      a. Ensure mapping (lazy-load fifa_calendar on first miss; cached forever).
//      b. Fetch live/football → write match_lineups:{id} only if lineupSignature
//         changed (covers lineup_available state, starting XI, event counts).
//      c. Upsert players_by_country roster only when lineup just became available
//         (rare event — typically 1 write per fixture per tournament).
//      d. **Detect status transition to "finished"** (status was not finished
//         in previous tick, is now). On transition, trigger mango tournament-stats
//         refresh: pull fdcp_top_scorers:raw + gcp_discipline, filter to the
//         match's 2 home/away countries, update those ~50 players' KV records.
//
// Write budget: ~2 lineup writes + ~50 player writes per fixture = ~52/fixture.
// 8 fixtures/day × 52 ≈ 400 writes/day (well under CF KV free 1000/day).
//
// fifa_calendar is LAZY — fetched once on first cron tick that needs it,
// cached in KV indefinitely. Manual /trigger/calendar route forces refresh.

import { fetchLiveFootball } from './fifa-api.js';
import { normalizeLineup, upsertPlayersFromLineup, matchLineupKey } from './lineup.js';
import { refreshTournamentStatsForMatch } from './tournament-refresh.js';
import { parseKickoffBeijing, beijingDateStr, matchDurationMs } from './time-utils.js';
import { logSla } from './sla.js';

const KO_PREROLL_MS = 90 * 60_000;
const KO_POSTROLL_MS = 15 * 60_000;
const DEFAULT_MATCH_MS = 105 * 60_000;
const FINISHED_STATUS_CODE = 0;   // verified by Chunk 3.1 probe

export async function mainCron(env) {
  const NOW = Date.now();

  // 1. Window scan
  const fixtures = await findFixturesInWindow(env, NOW);
  if (fixtures.length === 0) return { in_window: 0 };

  // Lookups loaded once per tick
  const countries = await env.MATCH_DATA.get('countries', 'json');
  const codeToZh = countries?.items
    ? Object.fromEntries(countries.items.map(c => [c.code, c.zh]))
    : {};
  const lookupCountryZh = (code) => codeToZh[code] || null;

  // Lazy fifa_calendar load (only when a fixture is missing its mapping)
  let fifaCal = null;
  const ensureFifaCal = async () => {
    if (fifaCal) return fifaCal;
    fifaCal = await env.MATCH_DATA.get('fifa_calendar', 'json');
    if (!fifaCal) {
      const { fetchFifaCalendar } = await import('./fifa-api.js');
      // Fixed window: 2026-06-01 → 2026-07-27. World Cup runs 2026-06-11 ~ 2026-07-19,
      // we pad ±14d for safety. This is intentionally NOT a rolling window — if the
      // calendar gets flushed mid-tournament and re-fetched at a late date, a rolling
      // [-14d, +35d] window would drop early-stage matches we still need to map.
      try {
        fifaCal = await fetchFifaCalendar(17, '2026-06-01T00:00:00Z', '2026-07-27T00:00:00Z');
        await env.MATCH_DATA.put('fifa_calendar', JSON.stringify(fifaCal));
        await logSla(env, { level: 'info', event: 'fifa_calendar_lazy_fetched', matches: fifaCal.matches.length });
      } catch (e) {
        await logSla(env, { level: 'error', event: 'fifa_calendar_lazy_failed', error: e.message });
        return null;
      }
    }
    return fifaCal;
  };

  let lineupOk = 0, lineupErr = 0, refreshOk = 0, refreshErr = 0, finishedDetected = 0;
  let finishedSkipped = 0;
  let playersWrittenTotal = 0, playersSkippedTotal = 0;
  let countriesWrittenTotal = 0, countriesSkippedTotal = 0;

  for (const fixture of fixtures) {
    let mapping = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json');

    // Lazy auto-mapping
    if (!mapping || (mapping.match_confidence === 'unmatched' &&
                     mapping.unmatched_retry_after &&
                     Date.now() > Date.parse(mapping.unmatched_retry_after))) {
      const cal = await ensureFifaCal();
      if (cal) {
        const { tryAutoMap } = await import('./mapping.js');
        mapping = await tryAutoMap(fixture, env, cal);
        await env.MATCH_DATA.put(`fixture_mapping:${fixture.id}`, JSON.stringify(mapping));
      }
    }
    if (!mapping || (mapping.match_confidence !== 'exact' && mapping.match_confidence !== 'time_skew_5min')) {
      continue;
    }

    // 2a-pre. D — finished-skip: if our KV already records this match as FINISHED,
    // there is nothing left to learn from FIFA. Skip the network call AND the KV write.
    // The tournament-refresh has already run on the status→finished transition tick.
    // Lineup, score, events are immutable post-finish. This is the single biggest
    // KV-write saver: the worst case before this was a finished match staying in
    // window for ~15min post-roll and being re-fetched 1-2 times producing 55+
    // wasted player writes per tick.
    const existingLineup = await env.MATCH_DATA.get(matchLineupKey(fixture.id), 'json');
    if (existingLineup?.match_status === FINISHED_STATUS_CODE) {
      finishedSkipped++;
      continue;
    }

    // 2a. live/football
    let liveData;
    try {
      liveData = await fetchLiveFootball(mapping);
    } catch (e) {
      await logSla(env, { level: 'warn', fixture: fixture.id, event: 'live_fetch_failed', error: e.message });
      lineupErr++;
      continue;
    }

    // 2b. normalize + diff-then-write lineup
    const lineup = normalizeLineup(liveData, mapping);
    const prevStatus = existingLineup?.match_status;
    const lineupChanged = !existingLineup || lineupSignature(existingLineup) !== lineupSignature(lineup);

    // GUARD: never write an "empty lineup" record (lineup_available=false means FIFA
    // hasn't published starters yet). The frontend treats absence-of-record and
    // empty-lineup the same way (shows "FIFA 尚未公布阵容"), so writing the empty
    // version pollutes KV without any visible benefit AND can later be misread as
    // "we already have data, skip" — bug we hit on 2026-06-22.
    //
    // If an existing record has real starters but the fresh fetch returns empty
    // (e.g. FIFA briefly nulled it), we ALSO skip — never downgrade.
    if (!lineup.lineup_available) {
      if (lineupChanged) {
        // Log this so we can see in SLA that FIFA hasn't published yet — diagnostic only
        const minutesToKickoff = Math.round((parseKickoffBeijing(fixture).getTime() - Date.now()) / 60_000);
        await logSla(env, {
          level: 'info', fixture: fixture.id, event: 'lineup_not_yet_published',
          minutes_to_kickoff: minutesToKickoff,
          match_status: lineup.match_status_label
        });
      }
      lineupOk++;
      continue;   // skip the write + skip the player upsert + skip finished-detection
    }

    if (lineupChanged) {
      await env.MATCH_DATA.put(matchLineupKey(fixture.id), JSON.stringify(lineup));
    }
    lineupOk++;

    // 2c. Upsert players only on lineup-just-available (rare event)
    if (lineupChanged && lineup.lineup_available) {
      const upsertStats = await upsertPlayersFromLineup(env, mapping, liveData, lookupCountryZh);
      playersWrittenTotal += upsertStats.playersWritten;
      playersSkippedTotal += upsertStats.playersSkipped;
      countriesWrittenTotal += upsertStats.countriesWritten;
      countriesSkippedTotal += upsertStats.countriesSkipped;
    }

    // SLA log on lineup change or KO-60min risk
    const minutesToKickoff = Math.round((parseKickoffBeijing(fixture).getTime() - Date.now()) / 60_000);
    const slaAtRisk = !lineup.lineup_available && minutesToKickoff <= 60 && minutesToKickoff > -120;
    if (lineupChanged || slaAtRisk) {
      await logSlaForLineup(env, fixture, lineup, minutesToKickoff);
    }

    // 2d. **Status transition detection**: finished JUST now
    const becameFinished =
      lineup.match_status === FINISHED_STATUS_CODE &&
      prevStatus !== FINISHED_STATUS_CODE &&
      existingLineup;   // had a prior record (i.e. we tracked the match)

    if (becameFinished) {
      finishedDetected++;
      try {
        const r = await refreshTournamentStatsForMatch(env, mapping, lookupCountryZh);
        await logSla(env, {
          level: 'info', fixture: fixture.id, event: 'tournament_refresh',
          players_updated: r.playersUpdated,
          countries: [mapping.home_code, mapping.away_code]
        });
        refreshOk++;
      } catch (e) {
        await logSla(env, { level: 'warn', fixture: fixture.id, event: 'tournament_refresh_failed', error: e.message });
        refreshErr++;
      }
    }
  }

  // Summary log only when there's interesting activity
  if (lineupChanged_anywhere() || finishedDetected > 0 || lineupErr > 0 || finishedSkipped > 0) {
    await logSla(env, {
      level: 'info', event: 'main_cron_pass',
      in_window: fixtures.length,
      finished_skipped: finishedSkipped,
      lineup_ok: lineupOk, lineup_err: lineupErr,
      finished_detected: finishedDetected,
      refresh_ok: refreshOk, refresh_err: refreshErr,
      players_written: playersWrittenTotal, players_skipped: playersSkippedTotal,
      countries_written: countriesWrittenTotal, countries_skipped: countriesSkippedTotal
    });
  }

  return {
    in_window: fixtures.length,
    finished_skipped: finishedSkipped,
    lineup_ok: lineupOk, lineup_err: lineupErr,
    finished_detected: finishedDetected,
    refresh_ok: refreshOk, refresh_err: refreshErr,
    players_written: playersWrittenTotal, players_skipped: playersSkippedTotal,
    countries_written: countriesWrittenTotal, countries_skipped: countriesSkippedTotal
  };

  // Helper: was any lineup written this tick?
  function lineupChanged_anywhere() { return lineupOk > 0; }
}

/**
 * Lineup signature for change detection. Skip KV write when unchanged.
 */
function lineupSignature(lineup) {
  return JSON.stringify({
    avail: lineup.lineup_available,
    locked: lineup.fixture_locked,
    status: lineup.match_status,
    period: lineup.period,
    time: lineup.match_time,
    hs: lineup.home?.starting?.map(p => `${p.player_id}#${p.shirt_number}`).join(',') || '',
    as: lineup.away?.starting?.map(p => `${p.player_id}#${p.shirt_number}`).join(',') || '',
    g: lineup.events?.goals?.length || 0,
    b: lineup.events?.bookings?.length || 0,
    s: lineup.events?.substitutions?.length || 0
  });
}

async function findFixturesInWindow(env, now) {
  const today = beijingDateStr(now);
  const yesterday = beijingDateStr(now - 86400_000);
  const tomorrow = beijingDateStr(now + 86400_000);
  const buckets = await Promise.all([
    env.MATCH_DATA.get(`matches:${yesterday}`, 'json'),
    env.MATCH_DATA.get(`matches:${today}`, 'json'),
    env.MATCH_DATA.get(`matches:${tomorrow}`, 'json')
  ]);
  const seen = new Set();
  const inWindow = [];
  for (const env_ of buckets) {
    if (!env_?.matches) continue;
    for (const m of env_.matches) {
      if (!m.id || seen.has(m.id)) continue;
      if (m.league !== '世界杯') continue;
      seen.add(m.id);
      let ko;
      try { ko = parseKickoffBeijing(m).getTime(); } catch { continue; }
      const matchMs = await matchDurationMs(env, m).catch(() => DEFAULT_MATCH_MS);
      const koEnd = ko + matchMs;
      if (now >= ko - KO_PREROLL_MS && now <= koEnd + KO_POSTROLL_MS) {
        inWindow.push(m);
      }
    }
  }
  return inWindow;
}

async function logSlaForLineup(env, fixture, lineup, minutesToKickoff) {
  const hasStarters = lineup.lineup_available;
  const slaAtRisk = !hasStarters && minutesToKickoff <= 60 && minutesToKickoff > -120;
  await logSla(env, {
    level: slaAtRisk ? 'warn' : 'info',
    fixture: fixture.id,
    event: hasStarters ? 'lineup_fetched' : 'lineup_not_yet_published',
    lineup_locked: lineup.fixture_locked,
    lineup_available: lineup.lineup_available,
    minutes_to_kickoff: minutesToKickoff,
    match_status: lineup.match_status_label
  });
}
