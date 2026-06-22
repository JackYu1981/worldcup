import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logSla } from '../lib/sla.js';

// Minimal in-memory KV mock that tracks puts
function makeMockEnv(initialMap = {}) {
  const store = { ...initialMap };
  const puts = [];
  return {
    MATCH_DATA: {
      async get(key, type) {
        const v = store[key];
        if (v === undefined) return null;
        return type === 'json' ? v : JSON.stringify(v);
      },
      async put(key, value, opts) {
        store[key] = JSON.parse(value);
        puts.push({ key, value, opts });
      }
    },
    _store: store,
    _puts: puts
  };
}

// Freeze "now" to a known UTC instant for deterministic shard key.
// 2026-06-22T05:30:00Z = Beijing 2026-06-22 13:30 → shard fifa_sla_logs:2026-06-22:13
const NOW_FIXED = Date.UTC(2026, 5, 22, 5, 30, 0);
const ORIG_NOW = Date.now;
function freezeNow() { Date.now = () => NOW_FIXED; }
function thawNow() { Date.now = ORIG_NOW; }

test('logSla: creates a new shard with one entry on first write', async () => {
  freezeNow();
  try {
    const env = makeMockEnv();
    await logSla(env, { level: 'info', fixture: 'f1', event: 'lineup_fetched', minutes_to_kickoff: 75 });
    assert.equal(env._puts.length, 1);
    const { key } = env._puts[0];
    assert.equal(key, 'fifa_sla_logs:2026-06-22:13');
    const stored = env._store[key];
    assert.equal(stored.date, '2026-06-22');
    assert.equal(stored.hour, 13);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].fixture, 'f1');
    assert.equal(stored.items[0].level, 'info');
    assert.match(stored.items[0].ts, /^2026-06-22T/);
  } finally { thawNow(); }
});

test('logSla: appends to existing shard', async () => {
  freezeNow();
  try {
    const env = makeMockEnv({
      'fifa_sla_logs:2026-06-22:13': {
        date: '2026-06-22', hour: 13,
        items: [{ ts: '2026-06-22T13:00:00+08:00', level: 'info', event: 'prev' }]
      }
    });
    await logSla(env, { level: 'info', fixture: 'f1', event: 'lineup_fetched' });
    const stored = env._store['fifa_sla_logs:2026-06-22:13'];
    assert.equal(stored.items.length, 2);
    assert.equal(stored.items[0].event, 'prev');
    assert.equal(stored.items[1].event, 'lineup_fetched');
  } finally { thawNow(); }
});

test('logSla: caps info items at 300, keeps all warn/error', async () => {
  freezeNow();
  try {
    // Pre-fill with 400 info + 5 warn + 2 error
    const initial = [];
    for (let i = 0; i < 400; i++) initial.push({ ts: `2026-06-22T13:00:${String(i % 60).padStart(2, '0')}+08:00`, level: 'info', n: i });
    for (let i = 0; i < 5; i++) initial.push({ ts: `2026-06-22T13:10:0${i}+08:00`, level: 'warn', n: 1000 + i });
    for (let i = 0; i < 2; i++) initial.push({ ts: `2026-06-22T13:20:0${i}+08:00`, level: 'error', n: 2000 + i });

    const env = makeMockEnv({
      'fifa_sla_logs:2026-06-22:13': { date: '2026-06-22', hour: 13, items: initial }
    });
    await logSla(env, { level: 'info', event: 'tick' });

    const stored = env._store['fifa_sla_logs:2026-06-22:13'];
    const infos = stored.items.filter(i => i.level === 'info');
    const warns = stored.items.filter(i => i.level === 'warn');
    const errors = stored.items.filter(i => i.level === 'error');
    // 300 infos kept (the most recent 300 of 400+new=401)
    assert.equal(infos.length, 300);
    assert.equal(warns.length, 5);
    assert.equal(errors.length, 2);
    // Items sorted by real timestamp ascending (mixed +08:00 / +00:00 offsets handled correctly)
    for (let i = 1; i < stored.items.length; i++) {
      assert.ok(
        Date.parse(stored.items[i - 1].ts) <= Date.parse(stored.items[i].ts),
        `items not sorted at index ${i}: ${stored.items[i - 1].ts} > ${stored.items[i].ts}`
      );
    }
  } finally { thawNow(); }
});

test('logSla: writes with expirationTtl 7 days', async () => {
  freezeNow();
  try {
    const env = makeMockEnv();
    await logSla(env, { level: 'info' });
    assert.equal(env._puts[0].opts?.expirationTtl, 86400 * 7);
  } finally { thawNow(); }
});

test('logSla: hour shard uses Beijing TZ (UTC 16:00 = Beijing 00:00 next day)', async () => {
  // UTC 2026-06-22 16:30 = Beijing 2026-06-23 00:30 → shard :00
  const ORIG = Date.now;
  Date.now = () => Date.UTC(2026, 5, 22, 16, 30, 0);
  try {
    const env = makeMockEnv();
    await logSla(env, { level: 'info', event: 'midnight' });
    assert.equal(env._puts[0].key, 'fifa_sla_logs:2026-06-23:00');
  } finally { Date.now = ORIG; }
});
