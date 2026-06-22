import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMatchPlayedCounters } from '../lib/counters.js';

// In-memory KV mock that tracks puts and supports rich get
function makeMockEnv(initial = {}) {
  const store = { ...initial };
  return {
    MATCH_DATA: {
      async get(key, type) {
        const v = store[key];
        if (v === undefined) return null;
        return type === 'json' ? v : JSON.stringify(v);
      },
      async put(key, value) { store[key] = JSON.parse(value); }
    },
    _store: store
  };
}

// fdh-api players.json shape: { player_id: [["StatName", value, flag], ...] }
function fdhRow(matchesPlayed, timePlayed) {
  return [
    ['Assists', 0, true],
    ['MatchesPlayed', matchesPlayed, true],
    ['TimePlayed', timePlayed, true],
    ['Goals', 0, true]
  ];
}

test('updateMatchPlayedCounters: new match → matches_played +=1, watermark set', async () => {
  const env = makeMockEnv({
    'players:p1': { id: 'p1', last_match_id: 'oldMatch', tournament_stats: { matches_played: 2, minutes_played: 180, attacking: {}, discipline: {} } }
  });
  const fdh = { 'p1': fdhRow(1, 45) };
  const mapping = { fifa_id_match: 'm1' };
  await updateMatchPlayedCounters(env, mapping, fdh);

  const u = env._store['players:p1'];
  assert.equal(u.last_match_id, 'm1');
  assert.equal(u.tournament_stats.matches_played, 3);   // 2 + 1
  assert.equal(u.tournament_stats.minutes_played, 225); // 180 + 45
  assert.equal(u.tournament_stats._current_match_minutes, 45);
});

test('updateMatchPlayedCounters: same match repeated (2min poll) → no double-count', async () => {
  const env = makeMockEnv({
    'players:p1': { id: 'p1', last_match_id: 'oldMatch', tournament_stats: { matches_played: 2, minutes_played: 180, attacking: {}, discipline: {} } }
  });
  const mapping = { fifa_id_match: 'm1' };

  // First poll at minute 5
  await updateMatchPlayedCounters(env, mapping, { 'p1': fdhRow(1, 5) });
  assert.equal(env._store['players:p1'].tournament_stats.matches_played, 3);
  assert.equal(env._store['players:p1'].tournament_stats.minutes_played, 185);

  // Second poll at minute 7
  await updateMatchPlayedCounters(env, mapping, { 'p1': fdhRow(1, 7) });
  assert.equal(env._store['players:p1'].tournament_stats.matches_played, 3, 'matches_played should still be 3');
  assert.equal(env._store['players:p1'].tournament_stats.minutes_played, 187, 'minutes_played should overlay (180+7=187)');

  // Third poll at minute 90 (full match)
  await updateMatchPlayedCounters(env, mapping, { 'p1': fdhRow(1, 90) });
  assert.equal(env._store['players:p1'].tournament_stats.matches_played, 3);
  assert.equal(env._store['players:p1'].tournament_stats.minutes_played, 270);
});

test('updateMatchPlayedCounters: player did not play (MatchesPlayed=0) → skip', async () => {
  const env = makeMockEnv({
    'players:p1': { id: 'p1', last_match_id: 'oldMatch', tournament_stats: { matches_played: 2, minutes_played: 180 } }
  });
  await updateMatchPlayedCounters(env, { fifa_id_match: 'm1' }, { 'p1': fdhRow(0, 0) });
  const u = env._store['players:p1'];
  assert.equal(u.tournament_stats.matches_played, 2, 'unchanged when player did not play');
  assert.equal(u.last_match_id, 'oldMatch', 'watermark unchanged');
});

test('updateMatchPlayedCounters: skips players whose archive does not exist (upsert is main cron\'s job)', async () => {
  const env = makeMockEnv({});
  await updateMatchPlayedCounters(env, { fifa_id_match: 'm1' }, { 'p_new': fdhRow(1, 30) });
  // No players:p_new written
  assert.equal(env._store['players:p_new'], undefined);
});

test('updateMatchPlayedCounters: initializes tournament_stats if missing', async () => {
  const env = makeMockEnv({
    'players:p1': { id: 'p1' /* no tournament_stats yet */ }
  });
  await updateMatchPlayedCounters(env, { fifa_id_match: 'm1' }, { 'p1': fdhRow(1, 60) });
  const u = env._store['players:p1'];
  assert.ok(u.tournament_stats);
  assert.equal(u.tournament_stats.matches_played, 1);
  assert.equal(u.tournament_stats.minutes_played, 60);
});

test('updateMatchPlayedCounters: cross-match transition (m1 ended → m2 starting)', async () => {
  const env = makeMockEnv({
    'players:p1': { id: 'p1', last_match_id: 'm0', tournament_stats: { matches_played: 1, minutes_played: 90 } }
  });

  // Match m1: poll at min 90 (full game)
  await updateMatchPlayedCounters(env, { fifa_id_match: 'm1' }, { 'p1': fdhRow(1, 90) });
  assert.equal(env._store['players:p1'].tournament_stats.matches_played, 2);
  assert.equal(env._store['players:p1'].tournament_stats.minutes_played, 180);
  assert.equal(env._store['players:p1'].last_match_id, 'm1');

  // Match m2 starts: poll at min 2
  await updateMatchPlayedCounters(env, { fifa_id_match: 'm2' }, { 'p1': fdhRow(1, 2) });
  assert.equal(env._store['players:p1'].tournament_stats.matches_played, 3, 'should +=1 for new match');
  assert.equal(env._store['players:p1'].tournament_stats.minutes_played, 182, 'm1=90 + m2=2');
  assert.equal(env._store['players:p1'].last_match_id, 'm2');
});

test('updateMatchPlayedCounters: handles multiple players in one fdh response', async () => {
  const env = makeMockEnv({
    'players:p1': { id: 'p1', last_match_id: null, tournament_stats: { matches_played: 0, minutes_played: 0 } },
    'players:p2': { id: 'p2', last_match_id: null, tournament_stats: { matches_played: 0, minutes_played: 0 } }
  });
  await updateMatchPlayedCounters(env, { fifa_id_match: 'm1' }, {
    'p1': fdhRow(1, 80),
    'p2': fdhRow(1, 30),
    'p3_unknown': fdhRow(1, 45)   // not in store → skip
  });
  assert.equal(env._store['players:p1'].tournament_stats.matches_played, 1);
  assert.equal(env._store['players:p1'].tournament_stats.minutes_played, 80);
  assert.equal(env._store['players:p2'].tournament_stats.matches_played, 1);
  assert.equal(env._store['players:p2'].tournament_stats.minutes_played, 30);
  assert.equal(env._store['players:p3_unknown'], undefined);
});
