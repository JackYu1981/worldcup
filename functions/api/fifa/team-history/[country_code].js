// GET /api/fifa/team-history/{country_code}
//
// Returns this team's already-played matches in the current World Cup, with
// opponent + score + W/D/L outcome. Used by the lineup modal's bottom
// "本届本队战绩" section.
//
// Data source: `team_fixtures:{country_code}` reverse index built by the
// fifa-scraper calendar cron (maintained on every cron tick, hash-short-circuited
// so writes are rare). The index gives us the exact fixture list for this team
// in one KV read; we then parallel-load each fixture's match_lineups to get
// scores. No broad `matches:*` scan needed.
//
// Falls back to the legacy date-bucket scan if the index isn't built yet
// (graceful migration window).
//
// Cache 300s — history rarely changes (only when a match flips to finished).

import { json, error, options } from '../../../lib/response.js';

const WC_PERIOD_START = '2026-06-11';   // tournament starts 6/11
const WC_PERIOD_END   = '2026-07-19';

function enumerateDates(startStr, endStr) {
  const out = [];
  const start = new Date(startStr + 'T00:00:00+08:00');
  const end = new Date(endStr + 'T00:00:00+08:00');
  for (let d = start.getTime(); d <= end.getTime(); d += 86400_000) {
    const dt = new Date(d);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

export async function onRequestGet(context) {
  const { params, env } = context;
  const code = (params.country_code || '').toUpperCase();
  if (!code || code.length !== 3) return error('country_code must be ISO3 like BRA', 400);

  try {
    // Fast path: use the team_fixtures:{code} reverse index when present.
    const index = await env.MATCH_DATA.get(`team_fixtures:${code}`, 'json');
    let candidates;
    if (index?.fixtures) {
      candidates = await fromReverseIndex(env, index.fixtures);
    } else {
      // Cold/legacy path: scan matches:* buckets. Triggers when the cron hasn't
      // yet built the index (first deploy or KV reset).
      candidates = await fromMatchesScan(env, code);
    }

    // Filter to truly finished matches + assemble the public response shape
    const history = [];
    for (const c of candidates) {
      const lu = c.lineup;
      const m = c.match;
      const mp = c.mapping;
      const finished = lu?.match_status === 0 || m?.status === 'finished';
      if (!finished) continue;

      // Score waterfall: FIFA lineup > 500 score string
      let homeScore = null, awayScore = null;
      if (lu?.home?.score != null && lu?.away?.score != null) {
        homeScore = lu.home.score;
        awayScore = lu.away.score;
      } else if (typeof m?.score === 'string' && m.score.includes('-')) {
        const [hs, as] = m.score.split('-').map(s => parseInt(s, 10));
        if (Number.isFinite(hs) && Number.isFinite(as)) {
          homeScore = hs;
          awayScore = as;
        }
      }
      if (homeScore == null || awayScore == null) continue;

      // Keep REAL home/away ordering
      const winner = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'draw';

      history.push({
        fixture_id: c.fixture_id,
        date: c.date,
        home_code: mp.home_code,
        away_code: mp.away_code,
        home_score: homeScore,
        away_score: awayScore,
        winner,
      });
    }

    // Sort oldest → newest (history chronology)
    history.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // Enrich each row with country names (zh + en) via the `countries` seed,
    // so the UI can pick whichever locale fits. UI currently shows Chinese names.
    const countries = await env.MATCH_DATA.get('countries', 'json');
    const enByCode = {};
    const zhByCode = {};
    for (const c of (countries?.items || [])) {
      if (c.code && c.en && !enByCode[c.code]) enByCode[c.code] = c.en;
      if (c.code && c.zh && !zhByCode[c.code]) zhByCode[c.code] = c.zh;
    }
    for (const h of history) {
      h.home_name_en = enByCode[h.home_code] || h.home_code;
      h.away_name_en = enByCode[h.away_code] || h.away_code;
      h.home_name_zh = zhByCode[h.home_code] || h.home_code;
      h.away_name_zh = zhByCode[h.away_code] || h.away_code;
    }

    return json({ country_code: code, history }, 200, 300);
  } catch (e) {
    return error(e.message, 500);
  }
}

/**
 * Fast path — given the team_fixtures:{code} index list, parallel-load each
 * fixture's mapping + lineup + the source date bucket (for 500.com score
 * fallback when match_lineups lacks final score, which happens with older
 * fixtures from before the lineup schema included score fields).
 */
async function fromReverseIndex(env, indexFixtures) {
  // Compute beijing date(s) for each entry. 500.com buckets by SALES PERIOD,
  // not kickoff date, so a match with kickoff 00:00 Beijing (UTC -1d) usually
  // lives in the previous day's `matches:` key. Probe ±1 day around the kickoff.
  const enriched = indexFixtures.map(e => {
    const koBJ = e.date_utc ? beijingDateFromUtc(e.date_utc) : null;
    return { ...e, date_bj: koBJ };
  });
  // Collect ±1 day variants for each unique date
  const uniqueDates = new Set();
  for (const e of enriched) {
    if (!e.date_bj) continue;
    uniqueDates.add(e.date_bj);
    // ±1 day
    const t = Date.parse(e.date_bj + 'T00:00:00+08:00');
    if (Number.isFinite(t)) {
      uniqueDates.add(beijingDateFromUtc(new Date(t - 86400_000).toISOString()));
      uniqueDates.add(beijingDateFromUtc(new Date(t + 86400_000).toISOString()));
    }
  }
  const datesArr = [...uniqueDates];

  const [mappings, lineups, dateBuckets] = await Promise.all([
    Promise.all(enriched.map(e =>
      env.MATCH_DATA.get(`fixture_mapping:${e.fixture_id}`, 'json').catch(() => null))),
    Promise.all(enriched.map(e =>
      env.MATCH_DATA.get(`match_lineups:${e.fixture_id}`, 'json').catch(() => null))),
    Promise.all(datesArr.map(d =>
      env.MATCH_DATA.get(`matches:${d}`, 'json').catch(() => null))),
  ]);
  // Build fixture_id → 500 match record map across all buckets
  const matchById = new Map();
  for (const b of dateBuckets) {
    if (!b?.matches) continue;
    for (const m of b.matches) matchById.set(m.id, m);
  }

  const out = [];
  for (let i = 0; i < enriched.length; i++) {
    const entry = enriched[i];
    const mp = mappings[i];
    if (!mp?.home_code || !mp?.away_code) continue;
    out.push({
      fixture_id: entry.fixture_id,
      date: entry.date_bj,
      mapping: mp,
      lineup: lineups[i],
      match: matchById.get(entry.fixture_id) || null,
    });
  }
  return out;
}

/**
 * Legacy/cold path — scan matches:{YYYY-MM-DD} buckets. Slower (N date keys +
 * filter by league==='世界杯' + per-match mapping fetch). Used only when the
 * reverse index is missing (first deploy / KV reset).
 */
async function fromMatchesScan(env, code) {
  const todayBJ = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const dates = enumerateDates(WC_PERIOD_START,
    todayBJ < WC_PERIOD_END ? todayBJ : WC_PERIOD_END);
  const buckets = await Promise.all(
    dates.map(d => env.MATCH_DATA.get(`matches:${d}`, 'json').catch(() => null))
  );
  const candidates = [];
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (!bucket?.matches) continue;
    for (const m of bucket.matches) {
      if (m.league !== '世界杯') continue;
      candidates.push({ ...m, _date: dates[i] });
    }
  }
  const fixIds = candidates.map(m => m.id);
  const [mappings, lineups] = await Promise.all([
    Promise.all(fixIds.map(id =>
      env.MATCH_DATA.get(`fixture_mapping:${id}`, 'json').catch(() => null))),
    Promise.all(fixIds.map(id =>
      env.MATCH_DATA.get(`match_lineups:${id}`, 'json').catch(() => null))),
  ]);
  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const mp = mappings[i];
    if (!mp?.home_code || !mp?.away_code) continue;
    if (mp.home_code !== code && mp.away_code !== code) continue;
    out.push({
      fixture_id: m.id,
      date: m._date,
      mapping: mp,
      lineup: lineups[i],
      match: m,
    });
  }
  return out;
}

function beijingDateFromUtc(utcIso) {
  // utcIso like '2026-06-23T19:00:00Z' → add 8h → 'YYYY-MM-DD' in Beijing
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

export function onRequestOptions() { return options(); }
