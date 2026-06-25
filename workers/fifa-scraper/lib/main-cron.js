// Main cron — runs every 1 min (Workers Paid). Highly parallelized:
//   - Fixtures are processed concurrently via Promise.all (R1)
//   - Within each fixture, KV reads and FIFA fetches are batched in parallel (R2)
//   - Tournament-refresh internally parallelizes per-team / per-classification (R3)
//
// Per-tick logic:
//   1. Find 500.com 世界杯 fixtures in [KO-90min, FIFA-finished/+4h].
//   2. For each fixture (in parallel):
//      a. Read existing mapping + lineup (parallel KV gets)
//      b. Skip if finished (FIFA match_status=0)
//      c. Fetch live/football + fdh-api in parallel
//      d. Write match_lineups if hash changed
//      e. Detect status 3→0 transition → trigger tournament-refresh
//      f. Always refresh match_stats (in-match shots/fouls) — hash-short-circuit inside
//
// Idempotent safety (R4): if a finished match doesn't have a successful
// tournament_refresh_done_at marker, we'll retry on the next tick.

import { fetchLiveFootball } from './fifa-api.js';
import { normalizeLineup, upsertPlayersFromLineup, matchLineupKey } from './lineup.js';
import { refreshTournamentStatsForMatch } from './tournament-refresh.js';
import { refreshMatchStats } from './match-stats.js';
import { parseKickoffBeijing, beijingDateStr } from './time-utils.js';
import { logSla } from './sla.js';

const KO_PREROLL_MS = 90 * 60_000;
const KO_HARD_TIMEOUT_MS = 4 * 60 * 60_000;
const FINISHED_STATUS_CODE = 0;

// R4: idempotent tournament-refresh marker. If a finished match's lineup record
// has no `tournament_refresh_done_at` (or it's older than this many ms), force a
// refresh on the next tick. This recovers from worker crashes / network errors
// during the 3→0 transition tick (which previously caused stats to silently miss).
const TOURNAMENT_REFRESH_MAX_AGE_MS = 30 * 60_000;   // 30min — re-refresh stale post-match

// R4 EXTENDED: finished matches missing the marker stay in the window beyond the
// regular 4h cap, until the gctp refresh succeeds (or we give up after enough
// retries). Without this, a transient gctp failure at the 3→0 transition could
// silently leave a match's tournament stats stale — SCO-BRA 2026-06-25 was the
// canonical failure mode (caught only by ops scripts).
//
// Bounds to prevent infinite retry on a permanently broken match:
//   - max retries = 10  (one per cron tick on a 1min schedule = 10min retry budget
//                       after KO+4h, plenty of time for transient errors to clear)
//   - hard ceiling = KO + 72h (3 days). Beyond this we stop trying and emit a
//                              giveup SLA log. Likely indicates a permanently
//                              mis-mapped fixture or removed FIFA data.
const TOURNAMENT_REFRESH_MAX_RETRIES = 10;
const KO_REFRESH_HARD_CEILING_MS = 72 * 60 * 60_000;

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

  // R1: process all fixtures concurrently. Each promise returns its per-fixture
  // result; we aggregate counters at the end (no shared mutable state).
  const results = await Promise.all(fixtures.map(fx => processFixture(env, fx, lookupCountryZh, ensureFifaCal)));

  // Aggregate counters
  let lineupOk = 0, lineupErr = 0, refreshOk = 0, refreshErr = 0, finishedDetected = 0;
  let finishedSkipped = 0;
  let playersWrittenTotal = 0, playersSkippedTotal = 0;
  let matchStatsWritten = 0;
  let countriesWrittenTotal = 0, countriesSkippedTotal = 0;
  for (const r of results) {
    if (!r) continue;
    lineupOk += r.lineupOk || 0;
    lineupErr += r.lineupErr || 0;
    refreshOk += r.refreshOk || 0;
    refreshErr += r.refreshErr || 0;
    finishedDetected += r.finishedDetected || 0;
    finishedSkipped += r.finishedSkipped || 0;
    playersWrittenTotal += r.playersWritten || 0;
    playersSkippedTotal += r.playersSkipped || 0;
    matchStatsWritten += r.matchStatsWritten || 0;
    countriesWrittenTotal += r.countriesWritten || 0;
    countriesSkippedTotal += r.countriesSkipped || 0;
  }

  // Summary log only when there's interesting activity
  if (lineupOk > 0 || finishedDetected > 0 || lineupErr > 0 || finishedSkipped > 0 || matchStatsWritten > 0) {
    await logSla(env, {
      level: 'info', event: 'main_cron_pass',
      in_window: fixtures.length,
      finished_skipped: finishedSkipped,
      lineup_ok: lineupOk, lineup_err: lineupErr,
      finished_detected: finishedDetected,
      refresh_ok: refreshOk, refresh_err: refreshErr,
      players_written: playersWrittenTotal, players_skipped: playersSkippedTotal,
      countries_written: countriesWrittenTotal, countries_skipped: countriesSkippedTotal,
      match_stats_written: matchStatsWritten
    });
  }

  return {
    in_window: fixtures.length,
    finished_skipped: finishedSkipped,
    lineup_ok: lineupOk, lineup_err: lineupErr,
    finished_detected: finishedDetected,
    refresh_ok: refreshOk, refresh_err: refreshErr,
    players_written: playersWrittenTotal, players_skipped: playersSkippedTotal,
    countries_written: countriesWrittenTotal, countries_skipped: countriesSkippedTotal,
    match_stats_written: matchStatsWritten
  };
}

/**
 * Process a single fixture. All network + KV operations within are batched in
 * parallel where dependencies allow. Returns counter deltas for aggregation.
 */
async function processFixture(env, fixture, lookupCountryZh, ensureFifaCal) {
  const counters = {
    lineupOk: 0, lineupErr: 0, refreshOk: 0, refreshErr: 0,
    finishedDetected: 0, finishedSkipped: 0,
    playersWritten: 0, playersSkipped: 0,
    countriesWritten: 0, countriesSkipped: 0,
    matchStatsWritten: 0,
  };

  // R2 phase 1: parallel KV reads. Mapping + existing lineup are independent.
  const [mapping0, existingLineup0] = await Promise.all([
    env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json'),
    env.MATCH_DATA.get(matchLineupKey(fixture.id), 'json'),
  ]);

  let mapping = mapping0;
  let existingLineup = existingLineup0;

  // Lazy auto-mapping if mapping is missing or its retry cooldown has elapsed
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
    return counters;
  }

  // R4: if already FINISHED in KV, skip the network call UNLESS we missed the
  // tournament_refresh (idempotent recovery). 95%+ of finished fixtures fall into
  // the skip branch — only the rare crashed/timed-out ones get a one-time retry.
  if (existingLineup?.match_status === FINISHED_STATUS_CODE) {
    const refreshDoneAt = Date.parse(existingLineup.tournament_refresh_done_at || '');
    const tooStale = !refreshDoneAt || (Date.now() - refreshDoneAt > TOURNAMENT_REFRESH_MAX_AGE_MS);
    if (!tooStale) {
      counters.finishedSkipped++;
      return counters;
    }
    // Idempotent retry: run tournament_refresh ONCE for this finished match.
    // On success: stamp the marker (resets retries implicitly — marker present
    //             = success path, retries counter ignored thereafter).
    // On failure: increment retries; once it hits TOURNAMENT_REFRESH_MAX_RETRIES
    //             the findFixturesInWindow filter will stop including this match.
    try {
      const r = await refreshTournamentStatsForMatch(env, mapping, lookupCountryZh);
      await logSla(env, {
        level: 'info', fixture: fixture.id, event: 'tournament_refresh_recovery',
        players_updated: r.playersUpdated,
        countries: [mapping.home_code, mapping.away_code],
      });
      // Stamp the marker so we don't retry again
      existingLineup.tournament_refresh_done_at = new Date().toISOString().replace(/Z$/, '+00:00');
      // Clear retry counter on success (defensive; not strictly needed since
      // marker presence is what filters this out, but keeps record clean).
      delete existingLineup.tournament_refresh_retries;
      await env.MATCH_DATA.put(matchLineupKey(fixture.id), JSON.stringify(existingLineup));
      counters.refreshOk++;
    } catch (e) {
      const prevRetries = existingLineup.tournament_refresh_retries || 0;
      existingLineup.tournament_refresh_retries = prevRetries + 1;
      await env.MATCH_DATA.put(matchLineupKey(fixture.id), JSON.stringify(existingLineup));
      await logSla(env, {
        level: 'warn', fixture: fixture.id, event: 'tournament_refresh_recovery_failed',
        error: e.message, retries: prevRetries + 1,
      });
      counters.refreshErr++;
    }
    counters.finishedSkipped++;
    return counters;
  }

  // R2 phase 2: parallel FIFA fetches. live/football and fdh-api stats are
  // independent — both keyed on the same mapping. fdh stats won't be valid
  // until lineup_available, but the fetch itself is cheap; we just don't write
  // it if there's no useful data (handled inside refreshMatchStats).
  let liveData;
  try {
    liveData = await fetchLiveFootball(mapping);
  } catch (e) {
    await logSla(env, { level: 'warn', fixture: fixture.id, event: 'live_fetch_failed', error: e.message });
    counters.lineupErr++;
    return counters;
  }

  const lineup = normalizeLineup(liveData, mapping);
  const prevStatus = existingLineup?.match_status;
  const lineupChanged = !existingLineup || lineupSignature(existingLineup) !== lineupSignature(lineup);

  // Empty-lineup guard: don't write a placeholder before FIFA publishes XI.
  if (!lineup.lineup_available) {
    if (lineupChanged) {
      const minutesToKickoff = Math.round((parseKickoffBeijing(fixture).getTime() - Date.now()) / 60_000);
      await logSla(env, {
        level: 'info', fixture: fixture.id, event: 'lineup_not_yet_published',
        minutes_to_kickoff: minutesToKickoff,
        match_status: lineup.match_status_label,
      });
    }
    counters.lineupOk++;
    return counters;
  }

  // R2 phase 3: parallel writes — lineup, player upsert, and match-stats are
  // independent KV operations. lineup must include tournament_refresh_done_at
  // when we trigger the refresh later this tick (R4 marker preservation).
  const writePromises = [];

  if (lineupChanged) {
    // Carry over the refresh marker (if any) so we don't lose idempotency state
    if (existingLineup?.tournament_refresh_done_at) {
      lineup.tournament_refresh_done_at = existingLineup.tournament_refresh_done_at;
    }
    writePromises.push(env.MATCH_DATA.put(matchLineupKey(fixture.id), JSON.stringify(lineup)));
  }

  // Player roster upsert — only when lineup signature changed (rare event)
  if (lineupChanged) {
    writePromises.push(
      upsertPlayersFromLineup(env, mapping, liveData, lookupCountryZh)
        .then(s => {
          counters.playersWritten += s.playersWritten;
          counters.playersSkipped += s.playersSkipped;
          counters.countriesWritten += s.countriesWritten;
          counters.countriesSkipped += s.countriesSkipped;
        })
        .catch(e => logSla(env, { level: 'warn', fixture: fixture.id, event: 'upsert_players_failed', error: e.message }))
    );
  }

  // Match-stats (shots/fouls/cards) — always try, hash-short-circuit inside
  writePromises.push(
    refreshMatchStats(env, fixture.id, mapping, lineup.match_status)
      .then(r => { if (r.written) counters.matchStatsWritten++; })
      .catch(e => logSla(env, { level: 'warn', fixture: fixture.id, event: 'match_stats_failed', error: e.message }))
  );

  await Promise.all(writePromises);
  counters.lineupOk++;

  // SLA log on lineup change or KO-60min risk
  const minutesToKickoff = Math.round((parseKickoffBeijing(fixture).getTime() - Date.now()) / 60_000);
  const slaAtRisk = !lineup.lineup_available && minutesToKickoff <= 60 && minutesToKickoff > -120;
  if (lineupChanged || slaAtRisk) {
    await logSlaForLineup(env, fixture, lineup, minutesToKickoff);
  }

  // Status transition detection: finished JUST now
  const becameFinished =
    lineup.match_status === FINISHED_STATUS_CODE &&
    prevStatus !== FINISHED_STATUS_CODE &&
    existingLineup;

  if (becameFinished) {
    counters.finishedDetected++;
    try {
      const r = await refreshTournamentStatsForMatch(env, mapping, lookupCountryZh);
      await logSla(env, {
        level: 'info', fixture: fixture.id, event: 'tournament_refresh',
        players_updated: r.playersUpdated,
        countries: [mapping.home_code, mapping.away_code],
      });
      counters.refreshOk++;
      // R4: stamp the marker on the just-written lineup so we don't retry
      lineup.tournament_refresh_done_at = new Date().toISOString().replace(/Z$/, '+00:00');
      await env.MATCH_DATA.put(matchLineupKey(fixture.id), JSON.stringify(lineup));
    } catch (e) {
      await logSla(env, { level: 'warn', fixture: fixture.id, event: 'tournament_refresh_failed', error: e.message });
      counters.refreshErr++;
    }
  }

  return counters;
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
  // 500.com names matches:{date} buckets by "销售期 (settlement period)" date,
  // not by Beijing kickoff date. Late-night fixtures (e.g. 04:00 BJ) frequently
  // file under the PREVIOUS day's bucket. To avoid border misses, scan all
  // matches:* buckets and filter by each fixture's kickoff field directly.
  // KV namespace has at most ~50 date buckets — list+read fits comfortably.
  const listRes = await env.MATCH_DATA.list({ prefix: 'matches:' });
  const buckets = await Promise.all(
    listRes.keys.map(k => env.MATCH_DATA.get(k.name, 'json'))
  );
  // Phase 1: filter to WC matches in the basic time window (cheap pure-CPU pass).
  // Note: the 4h hard cap is applied LATER, only after we know the match's marker
  // status — finished matches missing the gctp marker stay in window past 4h.
  const seen = new Set();
  const candidates = [];
  for (const env_ of buckets) {
    if (!env_?.matches) continue;
    for (const m of env_.matches) {
      if (!m.id || seen.has(m.id)) continue;
      if (m.league !== '世界杯') continue;
      seen.add(m.id);
      let ko;
      try { ko = parseKickoffBeijing(m).getTime(); } catch { continue; }
      if (now < ko - KO_PREROLL_MS) continue;
      m._ko_ms = ko;   // stash for the phase-2 cap check
      candidates.push(m);
    }
  }
  // Phase 2: parallel KV lookup for marker status. Three outcomes per match:
  //   A. Finished + recent marker (≤30min)  → drop (no work to do)
  //   B. Finished + missing/stale marker    → keep IFF retries<10 and now<KO+72h
  //                                            (bypasses the regular 4h cap)
  //   C. Not finished                       → keep IFF now<KO+4h (regular cap)
  const lineups = await Promise.all(candidates.map(m =>
    env.MATCH_DATA.get(`match_lineups:${m.id}`, 'json').catch(() => null)
  ));
  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const lu = lineups[i];
    const ko = m._ko_ms;
    const sincKo = now - ko;
    if (lu?.match_status === FINISHED_STATUS_CODE) {
      const done = Date.parse(lu.tournament_refresh_done_at || '');
      const hasFreshMarker = !!done && (now - done <= TOURNAMENT_REFRESH_MAX_AGE_MS);
      if (hasFreshMarker) continue;   // outcome A
      // outcome B: finished but marker missing/stale — keep in window
      const retries = lu.tournament_refresh_retries || 0;
      if (retries >= TOURNAMENT_REFRESH_MAX_RETRIES) continue;
      if (sincKo > KO_REFRESH_HARD_CEILING_MS) {
        // Emit one-shot giveup log so ops can investigate (only when retries
        // hit the cap exactly to avoid spamming every tick).
        if (retries === TOURNAMENT_REFRESH_MAX_RETRIES) {
          await logSla(env, {
            level: 'error', fixture: m.id, event: 'tournament_refresh_giveup',
            retries, hours_since_ko: Math.round(sincKo / 3600_000),
          });
        }
        continue;
      }
      out.push(m);
    } else {
      // outcome C: not yet finished — regular 4h cap applies
      if (sincKo > KO_HARD_TIMEOUT_MS) continue;
      out.push(m);
    }
  }
  return out;
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
