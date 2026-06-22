// Main cron — runs every 2 minutes.
// For each 500.com fixture in the active scrape window [KO−90min, KO_end+15min]:
//   1. Verify mapping exists & is 'exact' (or 'time_skew_5min')
//   2. Fetch live/football → write match_lineups + upsert players + log SLA
//   3. Fetch fdh-api/players.json → run watermark match-played counters
//
// Window definition uses fixture-mapping-derived stage info via matchDurationMs.

import { fetchLiveFootball, fetchFdhPlayers } from './fifa-api.js';
import { normalizeLineup, upsertPlayersFromLineup, matchLineupKey } from './lineup.js';
import { updateMatchPlayedCounters } from './counters.js';
import { parseKickoffBeijing, beijingDateStr, matchDurationMs } from './time-utils.js';
import { logSla } from './sla.js';

const KO_PREROLL_MS = 90 * 60_000;
const KO_POSTROLL_MS = 15 * 60_000;
const DEFAULT_MATCH_MS = 105 * 60_000;   // fallback if matchDurationMs lookup misses

export async function mainCron(env) {
  const NOW = Date.now();

  // Load countries once for in-memory zh lookup
  const countries = await env.MATCH_DATA.get('countries', 'json');
  const codeToZh = countries?.items
    ? Object.fromEntries(countries.items.map(c => [c.code, c.zh]))
    : {};
  const lookupCountryZh = (code) => codeToZh[code] || null;

  // Find fixtures in the active scrape window
  const fixtures = await findFixturesInWindow(env, NOW);
  if (fixtures.length === 0) {
    return { in_window: 0 };
  }

  let lineupOk = 0, lineupErr = 0, statsOk = 0, statsErr = 0;

  // Lazy-load fifa_calendar if any fixture lacks mapping (only fetch once per cron tick)
  let fifaCal = null;
  const ensureFifaCal = async () => {
    if (fifaCal) return fifaCal;
    fifaCal = await env.MATCH_DATA.get('fifa_calendar', 'json');
    if (!fifaCal) {
      // Cache miss — fetch from FIFA. This happens on cold-start or after manual cache flush.
      const { fetchFifaCalendar } = await import('./fifa-api.js');
      const isoDay = (offsetDays) => {
        const d = new Date(Date.now() + offsetDays * 86400_000);
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
          .toISOString().replace(/\.\d{3}Z$/, 'Z');
      };
      try {
        fifaCal = await fetchFifaCalendar(17, isoDay(-14), isoDay(35));
        await env.MATCH_DATA.put('fifa_calendar', JSON.stringify(fifaCal));
        await logSla(env, {
          level: 'info', event: 'fifa_calendar_lazy_fetched',
          matches: fifaCal.matches.length
        });
      } catch (e) {
        await logSla(env, { level: 'error', event: 'fifa_calendar_lazy_failed', error: e.message });
        return null;
      }
    }
    return fifaCal;
  };

  for (const fixture of fixtures) {
    let mapping = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json');

    // Lazy mapping: if missing or unmatched with expired retry, compute now
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

    // 1. Pull live/football
    let liveData;
    try {
      liveData = await fetchLiveFootball(mapping);
    } catch (e) {
      await logSla(env, { level: 'warn', fixture: fixture.id, event: 'live_fetch_failed', error: e.message });
      lineupErr++;
      continue;
    }

    // 2. Normalize + write match_lineups (skip if unchanged to save KV writes)
    const lineup = normalizeLineup(liveData, mapping);
    const existingLineup = await env.MATCH_DATA.get(matchLineupKey(fixture.id), 'json');
    const lineupChanged = !existingLineup || lineupSignature(existingLineup) !== lineupSignature(lineup);
    if (lineupChanged) {
      await env.MATCH_DATA.put(matchLineupKey(fixture.id), JSON.stringify(lineup));
    }
    lineupOk++;

    // 3. Upsert player archives + roster ONLY when lineup just became available
    //    or events changed (avoid 50 KV writes per cron tick when nothing's new).
    if (lineupChanged && lineup.lineup_available) {
      await upsertPlayersFromLineup(env, mapping, liveData, lookupCountryZh);
    }

    // 4. SLA log — only when lineup state CHANGED (avoid 8 SLA writes per cron
    //    tick when nothing's new). Always log if KO−60min and still missing.
    const minutesToKickoff = Math.round((parseKickoffBeijing(fixture).getTime() - Date.now()) / 60_000);
    const slaAtRisk = !lineup.lineup_available && minutesToKickoff <= 60 && minutesToKickoff > -120;
    if (lineupChanged || slaAtRisk) {
      await logSlaForLineup(env, fixture, lineup);
    }

    // 5. Pull fdh-api per-match stats → match-played counters
    if (mapping.fdh_match_id && lineup.lineup_available) {
      try {
        const fdhStats = await fetchFdhPlayers(mapping.fdh_match_id);
        if (fdhStats) {
          await updateMatchPlayedCounters(env, mapping, fdhStats);
          statsOk++;
        }
      } catch (e) {
        await logSla(env, { level: 'warn', fixture: fixture.id, event: 'fdh_fetch_failed', error: e.message });
        statsErr++;
      }
    }
  }

  // Only log a summary entry when there was actual work — avoids ~144 entries/day
  // when no fixtures are in window (most of the time).
  if (fixtures.length > 0) {
    await logSla(env, {
      level: 'info', event: 'main_cron_pass',
      in_window: fixtures.length, lineup_ok: lineupOk, lineup_err: lineupErr,
      stats_ok: statsOk, stats_err: statsErr
    });
  }

  return { in_window: fixtures.length, lineup_ok: lineupOk, lineup_err: lineupErr, stats_ok: statsOk, stats_err: statsErr };
}

/**
 * Compact signature for change detection — covers fields that materially affect
 * what we surface to users. If signature unchanged, skip KV write.
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

/**
 * Scan matches:{today±1} buckets and filter to fixtures whose kickoff is within
 * the active scrape window [KO−90min, KO_end+15min]. Skips non-世界杯 fixtures.
 */
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

/**
 * SLA evaluator — flags 'warn' if we're already within KO−60min and lineup is missing.
 */
async function logSlaForLineup(env, fixture, lineup) {
  let koMs;
  try { koMs = parseKickoffBeijing(fixture).getTime(); } catch { return; }
  const minutesToKickoff = Math.round((koMs - Date.now()) / 60_000);
  const hasStarters = lineup.lineup_available;
  // Within KO−60min and no lineup → warn (SLA at risk)
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
