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
      starting: home.starting,
      substitutes: home.substitutes
    },
    away: {
      country_code: mapping.away_code || awayTeam.IdCountry,
      team_id: awayTeam.IdTeam,
      team_name_en: pickEnglish(awayTeam.TeamName),
      tactics: awayTeam.Tactics || null,
      starting: away.starting,
      substitutes: away.substitutes
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
