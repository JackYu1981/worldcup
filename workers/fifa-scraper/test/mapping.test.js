import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryAutoMap } from '../lib/mapping.js';

// In-memory mock env
function makeMockEnv(initialMap = {}) {
  const store = { ...initialMap };
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

const COUNTRIES_KV = {
  version: 1,
  items: [
    { zh: '西班牙', code: 'ESP' },
    { zh: '沙特阿拉伯', code: 'KSA' },
    { zh: '英格兰', code: 'ENG' },
    { zh: '克罗地亚', code: 'CRO' }
  ]
};

const CAL_KV = {
  matches: [
    {
      id_match: '400021474', fdh_match_id: '151637',
      id_competition: '17', id_season: '285023', id_stage: '289273',
      date_utc: '2026-06-21T16:00:00Z',     // Beijing 2026-06-22 00:00
      home_code: 'ESP', away_code: 'KSA',
      stage_name: 'First Stage'
    },
    {
      id_match: '400021500', fdh_match_id: '151700',
      id_competition: '17', id_season: '285023', id_stage: '289273',
      date_utc: '2026-06-17T20:00:00Z',     // Beijing 2026-06-18 04:00
      home_code: 'ENG', away_code: 'CRO',
      stage_name: 'First Stage'
    }
  ]
};

test('tryAutoMap: exact match by home/away/kickoff', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  const fixture = { id: 'f1359210', home: '西班牙', away: '沙特阿拉伯', date: '2026-06-22', kickoff: '00:00' };
  const r = await tryAutoMap(fixture, env);
  assert.equal(r.match_confidence, 'exact');
  assert.equal(r.fifa_id_match, '400021474');
  assert.equal(r.fifa_id_season, '285023');
  assert.equal(r.fifa_id_stage, '289273');
  assert.equal(r.fdh_match_id, '151637');
  assert.equal(r.home_code, 'ESP');
  assert.equal(r.away_code, 'KSA');
  assert.equal(r.kickoff_utc, '2026-06-21T16:00:00.000+00:00');
});

test('tryAutoMap: time skew 5min still matches with time_skew_5min confidence', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  // 500 says 23:55 Beijing → UTC 15:55, FIFA says 16:00 → 5min skew
  const fixture = { id: 'f1', home: '西班牙', away: '沙特阿拉伯', date: '2026-06-21', kickoff: '23:55' };
  const r = await tryAutoMap(fixture, env);
  assert.equal(r.match_confidence, 'time_skew_5min');
  assert.equal(r.fifa_id_match, '400021474');
  assert.match(r.match_note || '', /time skew/);
});

test('tryAutoMap: unmatched when country mapping missing', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  const fixture = { id: 'f1', home: '火星国', away: '沙特阿拉伯', date: '2026-06-22', kickoff: '00:00' };
  const r = await tryAutoMap(fixture, env);
  assert.equal(r.match_confidence, 'unmatched');
  assert.match(r.match_note, /country code lookup failed/);
  assert.ok(r.unmatched_retry_after, 'should set retry after');
});

test('tryAutoMap: unmatched when no FIFA candidate (time mismatch > 30min)', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  // Same teams but kickoff 1 hour off
  const fixture = { id: 'f1', home: '西班牙', away: '沙特阿拉伯', date: '2026-06-22', kickoff: '02:00' };
  const r = await tryAutoMap(fixture, env);
  assert.equal(r.match_confidence, 'unmatched');
  assert.match(r.match_note, /no fifa candidate/);
});

test('tryAutoMap: unmatched when calendar KV missing', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV });   // no fifa_calendar
  const fixture = { id: 'f1', home: '西班牙', away: '沙特阿拉伯', date: '2026-06-22', kickoff: '00:00' };
  const r = await tryAutoMap(fixture, env);
  assert.equal(r.match_confidence, 'unmatched');
  assert.match(r.match_note, /fifa_calendar missing/);
});

test('tryAutoMap: accepts pre-loaded fifaCal arg (no KV read for calendar)', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV });   // no calendar in KV
  const fixture = { id: 'f1', home: '英格兰', away: '克罗地亚', date: '2026-06-18', kickoff: '04:00' };
  const r = await tryAutoMap(fixture, env, CAL_KV);
  assert.equal(r.match_confidence, 'exact');
  assert.equal(r.fifa_id_match, '400021500');
});

test('tryAutoMap: home/away reversed does NOT match (ESP vs KSA != KSA vs ESP)', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  const fixture = { id: 'f1', home: '沙特阿拉伯', away: '西班牙', date: '2026-06-22', kickoff: '00:00' };
  const r = await tryAutoMap(fixture, env);
  assert.equal(r.match_confidence, 'unmatched');
});

test('tryAutoMap: unmatched_retry_after is ~1 hour in the future', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  const before = Date.now();
  const r = await tryAutoMap({ id: 'f1', home: '火星国', away: '沙特阿拉伯', date: '2026-06-22', kickoff: '00:00' }, env);
  const after = Date.now();
  const retryAfter = Date.parse(r.unmatched_retry_after);
  assert.ok(retryAfter >= before + 3600_000 - 5000 && retryAfter <= after + 3600_000 + 5000,
    `retry_after ${r.unmatched_retry_after} not ~1h from now`);
});

test('tryAutoMap: kickoff_local_beijing reflects original 500 fields', async () => {
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  const r = await tryAutoMap({ id: 'f1', home: '西班牙', away: '沙特阿拉伯', date: '2026-06-22', kickoff: '00:00' }, env);
  assert.equal(r.kickoff_local_beijing, '2026-06-22 00:00');
});

test('tryAutoMap: works with current 500 schema (date=null, kickoff="YYYY-MM-DD HH:MM")', async () => {
  // ESP vs KSA fixture in 500-current form:  kickoff=full datetime, date=null
  const env = makeMockEnv({ countries: COUNTRIES_KV, fifa_calendar: CAL_KV });
  const fixture = { id: 'f1359210', home: '西班牙', away: '沙特阿拉伯', date: null, kickoff: '2026-06-22 00:00' };
  const r = await tryAutoMap(fixture, env);
  assert.equal(r.match_confidence, 'exact');
  assert.equal(r.fifa_id_match, '400021474');
  assert.equal(r.kickoff_local_beijing, '2026-06-22 00:00');
});
