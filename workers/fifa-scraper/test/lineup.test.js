import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLineup,
  splitPlayersByStatus,
  pickEnglish,
  matchStatusLabel
} from '../lib/lineup.js';

test('pickEnglish: picks en-GB locale from localized array', () => {
  assert.equal(pickEnglish([{ Locale: 'en-GB', Description: 'England' }]), 'England');
  assert.equal(pickEnglish([{ Locale: 'es', Description: 'Inglaterra' }, { Locale: 'en-GB', Description: 'England' }]), 'England');
  assert.equal(pickEnglish([]), null);
  assert.equal(pickEnglish(undefined), null);
});

test('matchStatusLabel: maps known status codes', () => {
  assert.equal(matchStatusLabel(0), 'finished');
  assert.equal(matchStatusLabel(1), 'scheduled');
  assert.equal(matchStatusLabel(3), 'live');
  assert.equal(matchStatusLabel(4), 'halftime');
  assert.equal(matchStatusLabel(99), 'unknown');
});

test('splitPlayersByStatus: Status=1 → starting, Status=2 → substitutes', () => {
  const players = [
    { IdPlayer: '1', Status: 1, ShirtNumber: 1, Position: 0, Captain: false, PlayerName: [{ Locale: 'en-GB', Description: 'A' }], PlayerPicture: { PictureUrl: 'urlA' } },
    { IdPlayer: '2', Status: 2, ShirtNumber: 12, Position: 0, Captain: false, PlayerName: [{ Locale: 'en-GB', Description: 'B' }] },
    { IdPlayer: '3', Status: 1, ShirtNumber: 10, Position: 3, Captain: true, PlayerName: [{ Locale: 'en-GB', Description: 'C' }] }
  ];
  const { starting, substitutes } = splitPlayersByStatus(players);
  assert.equal(starting.length, 2);
  assert.equal(substitutes.length, 1);
  assert.equal(starting[0].player_id, '1');
  assert.equal(starting[1].player_id, '3');
  assert.equal(starting[1].captain, true);
  assert.equal(starting[0].photo_url, 'urlA');
  assert.equal(substitutes[0].player_id, '2');
});

test('normalizeLineup: full match (finished, with events)', () => {
  const liveData = {
    IdMatch: '400021442',
    MatchStatus: 0,
    Period: 10,
    MatchTime: "97'",
    HomeTeam: {
      IdTeam: '43911',
      IdCountry: 'MEX',
      TeamName: [{ Locale: 'en-GB', Description: 'Mexico' }],
      Tactics: '4-3-3',
      Players: [
        { IdPlayer: 'p1', Status: 1, ShirtNumber: 1, Position: 0, PlayerName: [{ Locale: 'en-GB', Description: 'Keeper' }] },
        { IdPlayer: 'p2', Status: 2, ShirtNumber: 12, Position: 0, PlayerName: [{ Locale: 'en-GB', Description: 'SubKeeper' }] }
      ],
      Goals: [{ IdPlayer: 'p1', Minute: "50'", Type: 2, Period: 5, IdAssistPlayer: null, IdTeam: '43911' }],
      Bookings: [],
      Substitutions: [{ IdPlayerOff: 'p1', IdPlayerOn: 'p2', Minute: "70'", Period: 5, IdTeam: '43911' }]
    },
    AwayTeam: {
      IdTeam: '43904',
      IdCountry: 'KOR',
      TeamName: [{ Locale: 'en-GB', Description: 'Korea Republic' }],
      Tactics: '4-2-3-1',
      Players: [
        { IdPlayer: 'k1', Status: 1, ShirtNumber: 1, Position: 0, PlayerName: [{ Locale: 'en-GB', Description: 'KKeeper' }] }
      ],
      Goals: [],
      Bookings: [{ IdPlayer: 'k1', Minute: "41'", Period: 5, IdTeam: '43904', Card: 1, Reason: null }],
      Substitutions: []
    }
  };
  const mapping = { home_code: 'MEX', away_code: 'KOR', fifa_id_match: '400021442' };
  const out = normalizeLineup(liveData, mapping);

  assert.equal(out.fifa_id_match, '400021442');
  assert.equal(out.match_status, 0);
  assert.equal(out.match_status_label, 'finished');
  assert.equal(out.lineup_available, true);
  assert.equal(out.fixture_locked, false);   // both sides have only 1 starter in this mock → not "locked" (need 11+11)
  assert.equal(out.period, 10);
  assert.equal(out.match_time, "97'");

  assert.equal(out.home.country_code, 'MEX');
  assert.equal(out.home.team_name_en, 'Mexico');
  assert.equal(out.home.team_id, '43911');
  assert.equal(out.home.tactics, '4-3-3');
  assert.equal(out.home.starting.length, 1);
  assert.equal(out.home.substitutes.length, 1);

  assert.equal(out.away.starting.length, 1);
  assert.equal(out.away.substitutes.length, 0);

  // Events
  assert.equal(out.events.goals.length, 1);
  assert.equal(out.events.goals[0].side, 'home');
  assert.equal(out.events.goals[0].player_id, 'p1');
  assert.equal(out.events.goals[0].minute, "50'");

  assert.equal(out.events.bookings.length, 1);
  assert.equal(out.events.bookings[0].side, 'away');
  assert.equal(out.events.bookings[0].player_id, 'k1');

  assert.equal(out.events.substitutions.length, 1);
  assert.equal(out.events.substitutions[0].side, 'home');
  assert.equal(out.events.substitutions[0].off_player_id, 'p1');
  assert.equal(out.events.substitutions[0].on_player_id, 'p2');

  // fetched_at present and proper format
  assert.match(out.fetched_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('normalizeLineup: pre-match (no players) → lineup_available=false', () => {
  const liveData = {
    IdMatch: '400021494',
    MatchStatus: 1,
    Period: 0,
    MatchTime: null,
    HomeTeam: { IdCountry: 'ARG', IdTeam: '1', TeamName: [], Players: [], Goals: [], Bookings: [], Substitutions: [] },
    AwayTeam: { IdCountry: 'AUT', IdTeam: '2', TeamName: [], Players: [], Goals: [], Bookings: [], Substitutions: [] }
  };
  const out = normalizeLineup(liveData, { home_code: 'ARG', away_code: 'AUT', fifa_id_match: '400021494' });
  assert.equal(out.lineup_available, false);
  assert.equal(out.fixture_locked, false);
  assert.equal(out.match_status_label, 'scheduled');
  assert.equal(out.home.starting.length, 0);
});

test('normalizeLineup: lineup_available true only when both sides have ≥1 Status=1 player', () => {
  // Home has 11 starters, away has 0 — still not fully available
  const liveData = {
    IdMatch: 'x', MatchStatus: 1, Period: 0,
    HomeTeam: {
      IdCountry: 'A', IdTeam: '1', TeamName: [],
      Players: Array.from({ length: 11 }, (_, i) => ({ IdPlayer: `h${i}`, Status: 1, Position: 0, ShirtNumber: i + 1, PlayerName: [] })),
      Goals: [], Bookings: [], Substitutions: []
    },
    AwayTeam: { IdCountry: 'B', IdTeam: '2', TeamName: [], Players: [], Goals: [], Bookings: [], Substitutions: [] }
  };
  const out = normalizeLineup(liveData, { home_code: 'A', away_code: 'B' });
  assert.equal(out.lineup_available, false);
  assert.equal(out.fixture_locked, false);
});

test('normalizeLineup: pickEnglish for PlayerName & TeamName works with multiple locales', () => {
  const liveData = {
    IdMatch: 'x', MatchStatus: 1, Period: 0,
    HomeTeam: {
      IdCountry: 'A', IdTeam: '1',
      TeamName: [{ Locale: 'es', Description: 'X' }, { Locale: 'en-GB', Description: 'TeamA' }],
      Players: [{ IdPlayer: 'p1', Status: 1, Position: 0, ShirtNumber: 9,
        PlayerName: [{ Locale: 'es', Description: 'José' }, { Locale: 'en-GB', Description: 'Joseph' }] }],
      Goals: [], Bookings: [], Substitutions: []
    },
    AwayTeam: { IdCountry: 'B', IdTeam: '2', TeamName: [], Players: [], Goals: [], Bookings: [], Substitutions: [] }
  };
  const out = normalizeLineup(liveData, { home_code: 'A', away_code: 'B' });
  assert.equal(out.home.team_name_en, 'TeamA');
  assert.equal(out.home.starting[0].name, 'Joseph');
});
