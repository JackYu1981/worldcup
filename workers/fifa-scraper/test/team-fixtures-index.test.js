// Unit tests for team_fixtures:{code} reverse-index logic in calendar-cron.
//
// These cover three scenarios:
//   1. Initial build — empty KV → indexes get written for every team
//   2. Idempotent re-run — same input → 0 writes (hash short-circuit)
//   3. New fixture added — only affected teams get rewritten
//   4. Knockout draw appears — new teams enter the index correctly
//
// We do NOT test calendarCron() top-to-bottom (it needs to mock fetchFifaCalendar
// + load500FixturesAcrossDates + tryAutoMap, too much wiring). Instead we test
// the two exported helpers directly with hand-crafted inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamFixturesIndex, writeTeamFixturesIndex } from '../lib/calendar-cron.js';

// In-memory mock env. Tracks read & write counts so we can assert no-op behavior.
function makeMockEnv(initial = {}) {
  const store = { ...initial };
  let reads = 0, writes = 0;
  return {
    MATCH_DATA: {
      async get(key, type) {
        reads++;
        const v = store[key];
        if (v === undefined) return null;
        return type === 'json' ? v : JSON.stringify(v);
      },
      async put(key, value) {
        writes++;
        store[key] = JSON.parse(value);
      },
    },
    _store: store,
    _stats: () => ({ reads, writes }),
    _writes: () => writes,
  };
}

const SAMPLE_FIFA_CAL = {
  matches: [
    { id_match: '400021443', date_utc: '2026-06-11T19:00:00Z', home_code: 'MEX', away_code: 'RSA' },
    { id_match: '400021474', date_utc: '2026-06-21T16:00:00Z', home_code: 'ESP', away_code: 'KSA' },
    { id_match: '400021511', date_utc: '2026-06-23T23:00:00Z', home_code: 'PAN', away_code: 'CRO' },
  ],
};

const SAMPLE_FIXTURES = [
  { id: 'f1', league: '世界杯' },
  { id: 'f2', league: '世界杯' },
  { id: 'f3', league: '世界杯' },
];

const SAMPLE_MAPPINGS = {
  'fixture_mapping:f1': { fifa_id_match: '400021443', home_code: 'MEX', away_code: 'RSA', match_confidence: 'exact', kickoff_utc: '2026-06-11T19:00:00Z' },
  'fixture_mapping:f2': { fifa_id_match: '400021474', home_code: 'ESP', away_code: 'KSA', match_confidence: 'exact', kickoff_utc: '2026-06-21T16:00:00Z' },
  'fixture_mapping:f3': { fifa_id_match: '400021511', home_code: 'PAN', away_code: 'CRO', match_confidence: 'exact', kickoff_utc: '2026-06-23T23:00:00Z' },
};


test('buildTeamFixturesIndex: writes one entry per team per fixture (home + away)', async () => {
  const env = makeMockEnv(SAMPLE_MAPPINGS);
  const idx = await buildTeamFixturesIndex(env, SAMPLE_FIXTURES, SAMPLE_FIFA_CAL);

  // 3 fixtures × 2 teams = 6 unique entries across 6 country codes
  assert.equal(Object.keys(idx).sort().join(','), 'CRO,ESP,KSA,MEX,PAN,RSA');
  // Each team has exactly 1 fixture in this dataset
  for (const code of Object.keys(idx)) {
    assert.equal(idx[code].length, 1, `${code} should have 1 fixture`);
  }
  // Check structure of a specific entry
  assert.deepEqual(idx['MEX'][0], {
    fixture_id: 'f1',
    date_utc: '2026-06-11T19:00:00Z',
    opp_code: 'RSA',
    is_home: true,
  });
  assert.deepEqual(idx['RSA'][0], {
    fixture_id: 'f1',
    date_utc: '2026-06-11T19:00:00Z',
    opp_code: 'MEX',
    is_home: false,
  });
});


test('buildTeamFixturesIndex: skips unmatched mappings', async () => {
  const env = makeMockEnv({
    'fixture_mapping:f1': { fifa_id_match: '...', match_confidence: 'exact', home_code: 'MEX', away_code: 'RSA' },
    'fixture_mapping:f2': { fifa_id_match: '...', match_confidence: 'unmatched' },   // <- not mapped
  });
  const idx = await buildTeamFixturesIndex(env, [{ id: 'f1' }, { id: 'f2' }], SAMPLE_FIFA_CAL);
  // Only MEX + RSA should appear; ESP/KSA from f2 are skipped because unmatched
  assert.equal(Object.keys(idx).sort().join(','), 'MEX,RSA');
});


test('buildTeamFixturesIndex: handles team playing 3 group games (sorted chronologically)', async () => {
  // BRA plays in 3 matches: f1 (vs MAR 6/13), f2 (vs HAI 6/19), f3 (vs SCO 6/24)
  const env = makeMockEnv({
    'fixture_mapping:fA': { fifa_id_match: 'M1', home_code: 'BRA', away_code: 'MAR', match_confidence: 'exact' },
    'fixture_mapping:fB': { fifa_id_match: 'M2', home_code: 'BRA', away_code: 'HAI', match_confidence: 'exact' },
    'fixture_mapping:fC': { fifa_id_match: 'M3', home_code: 'SCO', away_code: 'BRA', match_confidence: 'exact' },
  });
  const cal = {
    matches: [
      // Note: deliberately out-of-order; the result must be sorted by date_utc asc
      { id_match: 'M3', date_utc: '2026-06-24T22:00:00Z', home_code: 'SCO', away_code: 'BRA' },
      { id_match: 'M1', date_utc: '2026-06-13T22:00:00Z', home_code: 'BRA', away_code: 'MAR' },
      { id_match: 'M2', date_utc: '2026-06-19T19:00:00Z', home_code: 'BRA', away_code: 'HAI' },
    ],
  };
  const idx = await buildTeamFixturesIndex(env, [{ id: 'fA' }, { id: 'fB' }, { id: 'fC' }], cal);
  assert.equal(idx['BRA'].length, 3);
  assert.deepEqual(idx['BRA'].map(e => e.fixture_id), ['fA', 'fB', 'fC']);
  assert.deepEqual(idx['BRA'].map(e => e.opp_code), ['MAR', 'HAI', 'SCO']);
  // BRA was home in 2 games (fA, fB) and away in 1 (fC)
  assert.deepEqual(idx['BRA'].map(e => e.is_home), [true, true, false]);
});


test('writeTeamFixturesIndex: initial write — every team gets a key', async () => {
  const env = makeMockEnv();
  const idx = {
    'MEX': [{ fixture_id: 'f1', date_utc: '2026-06-11T19:00:00Z', opp_code: 'RSA', is_home: true }],
    'RSA': [{ fixture_id: 'f1', date_utc: '2026-06-11T19:00:00Z', opp_code: 'MEX', is_home: false }],
  };
  const writes = await writeTeamFixturesIndex(env, idx);
  assert.equal(writes, 2, 'should write both team keys on cold start');
  assert.ok(env._store['team_fixtures:MEX']);
  assert.ok(env._store['team_fixtures:RSA']);
  // Records carry the hash for future short-circuit
  assert.ok(env._store['team_fixtures:MEX']._hash);
});


test('writeTeamFixturesIndex: idempotent re-run is 0 writes (hash short-circuit)', async () => {
  // Pre-seed env with the same content that we're about to "write"
  const idx = {
    'MEX': [{ fixture_id: 'f1', date_utc: '2026-06-11T19:00:00Z', opp_code: 'RSA', is_home: true }],
  };
  const env = makeMockEnv();
  // First write — establishes the hash
  await writeTeamFixturesIndex(env, idx);
  const firstWrites = env._writes();
  assert.equal(firstWrites, 1);
  // Second call with identical input — no new writes
  await writeTeamFixturesIndex(env, idx);
  assert.equal(env._writes(), firstWrites, 'idempotent re-run must produce 0 additional writes');
});


test('writeTeamFixturesIndex: only changed teams get rewritten', async () => {
  const initial = {
    'MEX': [{ fixture_id: 'f1', date_utc: '2026-06-11T19:00:00Z', opp_code: 'RSA', is_home: true }],
    'BRA': [{ fixture_id: 'fA', date_utc: '2026-06-13T22:00:00Z', opp_code: 'MAR', is_home: true }],
  };
  const env = makeMockEnv();
  await writeTeamFixturesIndex(env, initial);
  const writesAfterSeed = env._writes();
  assert.equal(writesAfterSeed, 2);

  // Now BRA plays its 2nd match — BRA's list grows, MEX is unchanged
  const updated = {
    ...initial,
    'BRA': [
      ...initial['BRA'],
      { fixture_id: 'fB', date_utc: '2026-06-19T19:00:00Z', opp_code: 'HAI', is_home: true },
    ],
  };
  await writeTeamFixturesIndex(env, updated);
  assert.equal(env._writes(), writesAfterSeed + 1,
    'only BRA should be rewritten; MEX is unchanged');
  assert.equal(env._store['team_fixtures:BRA'].fixtures.length, 2);
});


test('writeTeamFixturesIndex: detects new knockout fixture added mid-tournament', async () => {
  // Simulates: round of 16 draw happens, ARG suddenly has a new fixture
  const env = makeMockEnv();
  await writeTeamFixturesIndex(env, {
    'ARG': [
      { fixture_id: 'g1', date_utc: '2026-06-12T22:00:00Z', opp_code: 'ALG', is_home: true },
      { fixture_id: 'g2', date_utc: '2026-06-17T22:00:00Z', opp_code: 'AUT', is_home: true },
    ],
  });
  const w1 = env._writes();
  // Round of 16: ARG vs ENG appears
  await writeTeamFixturesIndex(env, {
    'ARG': [
      { fixture_id: 'g1', date_utc: '2026-06-12T22:00:00Z', opp_code: 'ALG', is_home: true },
      { fixture_id: 'g2', date_utc: '2026-06-17T22:00:00Z', opp_code: 'AUT', is_home: true },
      { fixture_id: 'r16', date_utc: '2026-07-01T22:00:00Z', opp_code: 'ENG', is_home: true },
    ],
  });
  assert.equal(env._writes(), w1 + 1, 'ARG should be rewritten after new fixture added');
  assert.equal(env._store['team_fixtures:ARG'].fixtures.length, 3);
});


test('end-to-end: build → write → re-build with same data → 0 writes', async () => {
  // Full cycle simulation of what calendarCron does each tick.
  const env = makeMockEnv(SAMPLE_MAPPINGS);
  const idx1 = await buildTeamFixturesIndex(env, SAMPLE_FIXTURES, SAMPLE_FIFA_CAL);
  const writes1 = await writeTeamFixturesIndex(env, idx1);
  assert.equal(writes1, 6, 'initial: 6 teams get keys');

  // Simulate next cron tick — same fixtures, same calendar, no real changes
  const writesBefore = env._writes();
  const idx2 = await buildTeamFixturesIndex(env, SAMPLE_FIXTURES, SAMPLE_FIFA_CAL);
  const writes2 = await writeTeamFixturesIndex(env, idx2);
  assert.equal(writes2, 0, 'idempotent next tick must produce 0 writes');
  assert.equal(env._writes(), writesBefore, 'KV write count must not increase');
});
