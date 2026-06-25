// Lineup utilities — transform FIFA live/football response into our match_lineups schema.
//
// Key probe findings (Chunk 3.1, 2026-06-22):
//   - `Status` (not `FieldStatus`) is the lineup role: 1=starting, 2=substitute.
//   - `FieldStatus` appears to be the "currently on pitch" indicator; after the
//     match ends it gets reset to 0 for everyone. Don't use it for first-XI split.
//   - `MatchStatus`: 0=finished, 1=scheduled (pre-match), 3=live, 4=halftime (TBD).
//   - `Position`: 0=GK, 1=DF, 2=MF, 3=FW (others like 6 may exist).
//   - lineup_available iff BOTH sides have ≥1 Status=1 player.

import { logSla } from './sla.js';

const STATUS_STARTER = 1;
const STATUS_SUBSTITUTE = 2;

// MatchStatus → human-readable label.
// Verified by probe: 0=finished, 1=scheduled. Others are best-guess pending live data.
const MATCH_STATUS_LABELS = {
  0: 'finished',
  1: 'scheduled',
  2: 'postponed',
  3: 'live',
  4: 'halftime',
  // others mapped to 'unknown' below
};

export function matchStatusLabel(code) {
  return MATCH_STATUS_LABELS[code] ?? 'unknown';
}

/** Pick the en-GB locale entry (or first) from FIFA's localized [{Locale, Description}] arrays. */
export function pickEnglish(localized) {
  if (!Array.isArray(localized) || localized.length === 0) return null;
  const en = localized.find(x => /^en/i.test(x.Locale || ''));
  return (en || localized[0]).Description || null;
}

/**
 * Pull the head coach out of FIFA's Coaches[] array. Role=0 = head coach;
 * Role 1+ are assistants/fitness/etc. If no Role-0 entry, fall back to the
 * first coach in the array (still a coaching staff member, just not the
 * top one — better than nothing for display).
 */
export function pickHeadCoach(rawCoaches) {
  if (!Array.isArray(rawCoaches) || rawCoaches.length === 0) return null;
  const head = rawCoaches.find(c => c.Role === 0) || rawCoaches[0];
  if (!head) return null;
  const name = pickEnglish(head.Name) || pickEnglish(head.Alias);
  if (!name) return null;
  return {
    coach_id: head.IdCoach || null,
    name,
    photo_url: head.PictureUrl || null,
    country_code: head.IdCountry || null,
  };
}

/**
 * Split FIFA Players[] into our normalized {starting, substitutes} shape.
 * Each entry has: player_id, name, shirt_number, position, captain, photo_url, lineup_x, lineup_y.
 */
export function splitPlayersByStatus(rawPlayers) {
  const starting = [];
  const substitutes = [];
  for (const p of rawPlayers || []) {
    const entry = {
      player_id: p.IdPlayer,
      name: pickEnglish(p.PlayerName) || pickEnglish(p.ShortName) || `Player ${p.IdPlayer}`,
      shirt_number: p.ShirtNumber ?? null,
      position: p.Position ?? null,
      captain: Boolean(p.Captain),
      photo_url: p.PlayerPicture?.PictureUrl || null,
      lineup_x: p.LineupX ?? null,
      lineup_y: p.LineupY ?? null
    };
    if (p.Status === STATUS_STARTER) starting.push(entry);
    else if (p.Status === STATUS_SUBSTITUTE) substitutes.push(entry);
    // Status values other than 1 / 2 are dropped (e.g., dropped from squad).
  }
  return { starting, substitutes };
}

/** Map FIFA event records to our normalized event shape. */
function normalizeEvents(side, team) {
  const goals = (team.Goals || []).map(g => ({
    side,
    player_id: g.IdPlayer,
    assist_player_id: g.IdAssistPlayer || null,
    minute: g.Minute,
    period: g.Period ?? null,
    type: g.Type ?? null
  }));
  const bookings = (team.Bookings || []).map(b => ({
    side,
    player_id: b.IdPlayer,
    minute: b.Minute,
    period: b.Period ?? null,
    card: b.Card ?? null,        // 1=yellow / 2=red — TBD until first real booking seen
    reason: b.Reason ?? null
  }));
  const substitutions = (team.Substitutions || []).map(s => ({
    side,
    off_player_id: s.IdPlayerOff,
    on_player_id: s.IdPlayerOn,
    minute: s.Minute,
    period: s.Period ?? null,
    reason: s.Reason ?? null
  }));
  return { goals, bookings, substitutions };
}

/**
 * Transform full FIFA live/football response into our match_lineups:{500_id} schema.
 * mapping must supply at least { home_code, away_code, fifa_id_match }.
 */
export function normalizeLineup(liveData, mapping) {
  const homeTeam = liveData.HomeTeam || {};
  const awayTeam = liveData.AwayTeam || {};
  const home = splitPlayersByStatus(homeTeam.Players);
  const away = splitPlayersByStatus(awayTeam.Players);

  const homeHasStarters = home.starting.length > 0;
  const awayHasStarters = away.starting.length > 0;
  // "lineup available" requires BOTH sides to have at least 1 starter — until FIFA
  // publishes both lineups, the page should show a wait state.
  const lineupAvailable = homeHasStarters && awayHasStarters;
  // "fixture locked" requires both to have exactly 11 starters.
  const fixtureLocked = home.starting.length === 11 && away.starting.length === 11;

  const homeEvents = normalizeEvents('home', homeTeam);
  const awayEvents = normalizeEvents('away', awayTeam);

  // Half-time score derived from goals' Period field. FIFA doesn't expose HT score
  // directly — Period codes: 3 = 1st half (incl. 45'+stoppage), 5 = 2nd half.
  // So HT goals are those with Period <= 3.
  let homeHt = 0, awayHt = 0;
  for (const g of homeEvents.goals) if ((g.period ?? 99) <= 3) homeHt++;
  for (const g of awayEvents.goals) if ((g.period ?? 99) <= 3) awayHt++;

  return {
    fifa_id_match: mapping.fifa_id_match || liveData.IdMatch,
    fetched_at: new Date().toISOString().replace(/Z$/, '+00:00'),
    lineup_available: lineupAvailable,
    fixture_locked: fixtureLocked,
    match_status: liveData.MatchStatus ?? null,
    match_status_label: matchStatusLabel(liveData.MatchStatus),
    period: liveData.Period ?? null,
    match_time: liveData.MatchTime ?? null,
    home: {
      country_code: mapping.home_code || homeTeam.IdCountry,
      team_id: homeTeam.IdTeam,
      team_name_en: pickEnglish(homeTeam.TeamName),
      tactics: homeTeam.Tactics || null,
      score: homeTeam.Score ?? null,         // FIFA full-time score
      score_ht: homeHt,                       // computed half-time goals
      starting: home.starting,
      substitutes: home.substitutes,
      coach: pickHeadCoach(homeTeam.Coaches),
    },
    away: {
      country_code: mapping.away_code || awayTeam.IdCountry,
      team_id: awayTeam.IdTeam,
      team_name_en: pickEnglish(awayTeam.TeamName),
      tactics: awayTeam.Tactics || null,
      score: awayTeam.Score ?? null,
      score_ht: awayHt,
      starting: away.starting,
      substitutes: away.substitutes,
      coach: pickHeadCoach(awayTeam.Coaches),
    },
    events: {
      goals: [...homeEvents.goals, ...awayEvents.goals],
      bookings: [...homeEvents.bookings, ...awayEvents.bookings],
      substitutions: [...homeEvents.substitutions, ...awayEvents.substitutions]
    }
  };
}

/** Compose the KV key for a match's lineup. */
export function matchLineupKey(fixture500Id) {
  return `match_lineups:${fixture500Id}`;
}

/**
 * Upsert player archives + players_by_country roster from the lineup data.
 *
 * Strict §3.0 matrix discipline: this function (main cron) writes ONLY these fields:
 *   players:{id}                — id, country_code, country_zh (best-effort), team_id,
 *                                  position, shirt_number, last_match_id, name.eng,
 *                                  name_default, last_updated
 *   players_by_country:{code}   — union-upserts roster entry {player_id, name,
 *                                  shirt_number, position}; preserves any
 *                                  stats_summary written by tournament-wide cron.
 *
 * Fields NOT written by this function (owned by tournament-wide cron, never touch):
 *   players:{id}.photo_url, name.{12 langs}, tournament_stats.attacking,
 *   tournament_stats.discipline
 */
export async function upsertPlayersFromLineup(env, mapping, liveData, lookupCountryZh) {
  const sides = [
    { team: liveData.HomeTeam, country_code: mapping.home_code },
    { team: liveData.AwayTeam, country_code: mapping.away_code }
  ];

  const countryRosterPatch = {};   // country_code -> [{player_id, name, shirt, position, _team_id}]
  let playersWritten = 0;
  let playersSkipped = 0;

  for (const { team, country_code } of sides) {
    if (!country_code) continue;
    countryRosterPatch[country_code] = [];
    for (const p of team?.Players || []) {
      if (!p.IdPlayer) continue;
      const existing = await env.MATCH_DATA.get(`players:${p.IdPlayer}`, 'json') || {};
      const enName = pickEnglish(p.PlayerName) || pickEnglish(p.ShortName);
      // Fields whose change should trigger a put. last_updated is INTENTIONALLY
      // excluded — it changes every tick and would defeat the hash.
      const lineupHash = lineupFieldsHash({
        country_code,
        team_id: team.IdTeam,
        position: p.Position ?? null,
        shirt_number: p.ShirtNumber ?? null,
        eng: enName || ''
      });
      // Always record the roster patch so players_by_country can still dedup
      // based on its own contents (cheap — just an in-memory push).
      countryRosterPatch[country_code].push({
        player_id: p.IdPlayer,
        name: enName || existing.name_default || `Player ${p.IdPlayer}`,
        shirt_number: p.ShirtNumber ?? null,
        position: p.Position ?? null,
        _team_id: team.IdTeam
      });
      // A-mode short-circuit: same lineup-derived fingerprint → no KV write.
      // tournament-refresh writes the volatile fields (photo_url, name.{12 langs},
      // tournament_stats) under a different code path, so skipping here does NOT
      // block their updates.
      if (existing._lineup_hash === lineupHash) {
        playersSkipped++;
        continue;
      }
      const updated = {
        ...existing,
        id: p.IdPlayer,
        country_code,
        country_zh: existing.country_zh || lookupCountryZh(country_code),
        team_id: team.IdTeam,
        position: p.Position ?? existing.position ?? null,
        shirt_number: p.ShirtNumber ?? existing.shirt_number ?? null,
        // NOTE: last_match_id is owned by counters.js (watermark for matches_played
        // accumulator). upsertPlayersFromLineup must NOT touch it, or counters'
        // first-run isNewMatch detection breaks (causing matches_played to stay 0).
        // ...(existing.last_match_id ? ... : ...)  — explicit no-op for clarity
        name: {
          ...(existing.name || {}),
          ...(enName ? { eng: enName } : {})
        },
        name_default: enName || existing.name_default || `Player ${p.IdPlayer}`,
        _lineup_hash: lineupHash,
        last_updated: new Date().toISOString().replace(/Z$/, '+00:00')
      };
      await env.MATCH_DATA.put(`players:${p.IdPlayer}`, JSON.stringify(updated));
      playersWritten++;
    }
  }

  // Union-upsert into players_by_country, preserving any stats_summary already there.
  // We also hash the roster shape so we skip the country-level put when nothing changed
  // (same set of {player_id, name, shirt, position}).
  let countriesWritten = 0;
  let countriesSkipped = 0;
  for (const [code, newEntries] of Object.entries(countryRosterPatch)) {
    if (newEntries.length === 0) continue;
    const existing = await env.MATCH_DATA.get(`players_by_country:${code}`, 'json') || {
      country_code: code,
      country_zh: lookupCountryZh(code),
      team_id: null,
      roster: []
    };
    const byId = new Map(existing.roster.map(r => [r.player_id, r]));
    for (const e of newEntries) {
      const cur = byId.get(e.player_id) || {};
      byId.set(e.player_id, {
        player_id: e.player_id,
        name: e.name,
        shirt_number: e.shirt_number,
        position: e.position,
        // Preserve stats_summary written by tournament-wide cron — never touch it here.
        stats_summary: cur.stats_summary
      });
    }
    const newRoster = Array.from(byId.values());
    // Compare roster shape (player_id + name + shirt + position) — ignore stats_summary
    // because that's owned by another writer and we don't want to trigger a put here
    // just because it was concurrently updated.
    const newSig = rosterSig(newRoster);
    const oldSig = rosterSig(existing.roster);
    if (newSig === oldSig && existing.team_id) {
      countriesSkipped++;
      continue;
    }
    existing.roster = newRoster;
    existing.team_id = existing.team_id || newEntries[0]?._team_id || null;
    existing.country_zh = existing.country_zh || lookupCountryZh(code);
    existing.updated_at = new Date().toISOString().replace(/Z$/, '+00:00');
    await env.MATCH_DATA.put(`players_by_country:${code}`, JSON.stringify(existing));
    countriesWritten++;
  }

  return { playersWritten, playersSkipped, countriesWritten, countriesSkipped };
}

// FNV-1a 32-bit — fast deterministic hash, no crypto module needed in CF Workers.
function lineupFieldsHash(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function rosterSig(roster) {
  // Order-insensitive by sorting on player_id, then compare the lineup-derived fields.
  const sorted = [...roster].sort((a, b) => String(a.player_id).localeCompare(String(b.player_id)));
  return sorted.map(r => `${r.player_id}#${r.name}#${r.shirt_number}#${r.position}`).join('|');
}
