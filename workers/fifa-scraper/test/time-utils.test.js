import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKickoffBeijing,
  beijingDateStr,
  beijingHour,
  matchDurationMs,
  parseKickoffUtc
} from '../lib/time-utils.js';

test('parseKickoffBeijing: parses 500-style {date, kickoff} as Beijing wall clock', () => {
  const fixture = { date: '2026-06-21', kickoff: '23:00' };
  const t = parseKickoffBeijing(fixture);
  // Beijing 2026-06-21 23:00 = UTC 2026-06-21 15:00
  assert.equal(t.toISOString(), '2026-06-21T15:00:00.000Z');
});

test('parseKickoffBeijing: parses 500-style kickoff="YYYY-MM-DD HH:MM" (current adapter)', () => {
  // Current 500 adapter writes kickoff as full datetime, date=null
  const fixture = { date: null, kickoff: '2026-06-23 01:00' };
  const t = parseKickoffBeijing(fixture);
  // Beijing 2026-06-23 01:00 = UTC 2026-06-22 17:00
  assert.equal(t.toISOString(), '2026-06-22T17:00:00.000Z');
});

test('parseKickoffUtc: alias for parseKickoffBeijing, returns Date in UTC', () => {
  const fixture = { date: '2026-06-21', kickoff: '04:00' };
  const t = parseKickoffUtc(fixture);
  // Beijing 04:00 = UTC previous day 20:00
  assert.equal(t.toISOString(), '2026-06-20T20:00:00.000Z');
});

test('parseKickoffBeijing: throws on missing fields', () => {
  assert.throws(() => parseKickoffBeijing({}), /missing date or kickoff/);
  assert.throws(() => parseKickoffBeijing({ date: '2026-06-21' }), /missing date or kickoff/);
  assert.throws(() => parseKickoffBeijing(null), /missing date or kickoff/);
});

test('beijingDateStr: epoch ms → YYYY-MM-DD in Beijing TZ', () => {
  // 2026-06-21 23:30 UTC = 2026-06-22 07:30 Beijing → returns '2026-06-22'
  const utc = Date.UTC(2026, 5, 21, 23, 30, 0);
  assert.equal(beijingDateStr(utc), '2026-06-22');
});

test('beijingDateStr: midnight UTC stays today in Beijing (08:00)', () => {
  const utc = Date.UTC(2026, 5, 21, 0, 0, 0);
  assert.equal(beijingDateStr(utc), '2026-06-21');
});

test('beijingHour: returns 0-23 in Beijing TZ', () => {
  // 23:30 UTC = 07:30 Beijing → hour=7
  const utc = Date.UTC(2026, 5, 21, 23, 30, 0);
  assert.equal(beijingHour(utc), 7);
});

test('matchDurationMs: group stage = 105min (no mapping)', async () => {
  const env = makeMockEnv({});
  const ms = await matchDurationMs(env, { id: 'f1' });
  assert.equal(ms, 105 * 60 * 1000);
});

test('matchDurationMs: knockout "Round of 16" = 165min', async () => {
  const env = makeMockEnv({
    'fixture_mapping:f1': { fifa_id_match: 'm1' },
    'fifa_calendar': { matches: [{ id_match: 'm1', stage_name: 'Round of 16' }] }
  });
  const ms = await matchDurationMs(env, { id: 'f1' });
  assert.equal(ms, 165 * 60 * 1000);
});

test('matchDurationMs: knockout "Quarter-final" = 165min', async () => {
  const env = makeMockEnv({
    'fixture_mapping:f2': { fifa_id_match: 'm2' },
    'fifa_calendar': { matches: [{ id_match: 'm2', stage_name: 'Quarter-final' }] }
  });
  assert.equal(await matchDurationMs(env, { id: 'f2' }), 165 * 60 * 1000);
});

test('matchDurationMs: misleading group-stage name "Final round of group A" stays 105min', async () => {
  const env = makeMockEnv({
    'fixture_mapping:f3': { fifa_id_match: 'm3' },
    'fifa_calendar': { matches: [{ id_match: 'm3', stage_name: 'Final round of group A' }] }
  });
  assert.equal(await matchDurationMs(env, { id: 'f3' }), 105 * 60 * 1000);
});

test('matchDurationMs: "Group Stage" = 105min', async () => {
  const env = makeMockEnv({
    'fixture_mapping:f4': { fifa_id_match: 'm4' },
    'fifa_calendar': { matches: [{ id_match: 'm4', stage_name: 'Group Stage' }] }
  });
  assert.equal(await matchDurationMs(env, { id: 'f4' }), 105 * 60 * 1000);
});

test('matchDurationMs: "Final" exact match = 165min', async () => {
  const env = makeMockEnv({
    'fixture_mapping:f5': { fifa_id_match: 'm5' },
    'fifa_calendar': { matches: [{ id_match: 'm5', stage_name: 'Final' }] }
  });
  assert.equal(await matchDurationMs(env, { id: 'f5' }), 165 * 60 * 1000);
});

// Minimal in-memory KV mock — supports .get(key, 'json')
function makeMockEnv(map) {
  return {
    MATCH_DATA: {
      async get(key, type) {
        const v = map[key];
        if (v === undefined) return null;
        return type === 'json' ? v : JSON.stringify(v);
      }
    }
  };
}
