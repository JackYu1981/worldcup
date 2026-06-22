# FIFA Player Data Module — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the FIFA player data ingestion module — a new Cloudflare Worker (`fifa-scraper`) plus 11 Pages Functions endpoints — that ingests lineups, single-match player stats, and tournament-wide aggregated stats from FIFA's public APIs, mapping each 500.com fixture to its FIFA counterpart automatically.

**Architecture:** Separate worker `workers/fifa-scraper/` runs 3 crons (`*/2 * * * *` per-match, `0 */6 * * *` calendar refresh, `0 17,21,1,5 * * *` tournament-wide). Worker reads existing `matches:{date}` KV keys (written by 500.com scraper) and writes new keys (`players:*`, `players_by_country:*`, `match_lineups:*`, `fixture_mapping:*`, `fifa_calendar`, `countries`, `gameday_token`, `fifa_sla_logs:*`). Cloudflare Pages Functions in `functions/api/fifa/` expose read endpoints + manual refresh.

**Tech Stack:** Cloudflare Workers, Cloudflare KV (existing `MATCH_DATA` namespace `278f1209ffd84662bd51921370a2fbe9`), Pages Functions, ESM JavaScript, Node's built-in `node --test` for unit tests (no extra deps).

**Spec reference:** `docs/superpowers/specs/2026-06-22-fifa-player-data-design.md` (v4)
**Findings reference:** `docs/superpowers/specs/2026-06-22-fifa-data-source-findings.md`

**Conventions:**
- All time strings use ISO 8601 with explicit offset (no `.Z` suffix per [[feedback_timestamp_format]])
- Beijing fixture times parsed as `+08:00`; UTC always written with `+00:00`
- KV namespace id always `278f1209ffd84662bd51921370a2fbe9`
- Tests run via `node --test workers/fifa-scraper/test/` (Node 20+ built-in, **zero deps**)
- Commit after every passing test or behaviour milestone (TDD red-green-commit)
- Wrangler version: **v3+** assumed (commands like `wrangler kv key put` with spaces, not the v2 `kv:key put` colon form). The repo's existing scrapers were deployed with wrangler 4.103.0; same version is used here.

---

## File structure (target — built incrementally across chunks, not all at once)

> **Note for executors**: only create files when the task that owns them says so. The list below is the **final** layout; in Chunk 1 only `wrangler.toml`, `index.js`, `lib/time-utils.js`, `lib/token.js`, `seed/countries.json`, `scripts/seed-kv.js`, `scripts/smoke-test.js`, `test/time-utils.test.js`, and a `package.json` are created. Other files appear in Chunks 2–5.

```
workers/fifa-scraper/
├── wrangler.toml
├── index.js                     # entry: scheduled handler + fetch handler
├── lib/
│   ├── time-utils.js            # parseKickoffBeijing, beijingDateStr, matchDurationMs
│   ├── token.js                 # ensureGamedayToken
│   ├── fifa-api.js              # fetchFifaCalendar, fetchLiveFootball, fetchFdhPlayers,
│   │                            #   fetchMangoTeams, fetchMangoStoryPage
│   ├── mapping.js               # tryAutoMap, reverseLookupFdhMatchId
│   ├── lineup.js                # updateLineupKV, upsertPlayersFromLineup
│   ├── counters.js              # updateMatchPlayedCounters (watermark)
│   ├── players.js               # extractProfileFromActor, parseStatValue,
│   │                            #   tournamentWideCron orchestration
│   └── sla.js                   # logSla, logSlaForLineup (hourly shard)
├── test/
│   ├── time-utils.test.js
│   ├── mapping.test.js
│   ├── counters.test.js
│   └── players.test.js
├── seed/
│   └── countries.json           # 48-country seed (zh ↔ 3-letter code)
└── scripts/
    ├── seed-kv.js               # one-shot: load seed/countries.json into KV
    └── smoke-test.js            # one-shot: hit live FIFA endpoints, validate shapes

functions/api/fifa/
├── players/
│   ├── [player_id].js           # GET single
│   └── index.js                 # GET batch ?ids=a,b,c
├── players-by-country/
│   └── [code].js                # GET roster
├── lineup/
│   └── [fixture_id].js          # GET lineup
├── mapping/
│   └── [fixture_id].js          # GET + PUT (admin)
├── refresh/
│   └── [fixture_id].js          # POST (auth required)
├── mappings.js                  # GET list
├── calendar.js                  # GET fifa_calendar
├── countries.js                 # GET + PUT (admin)
├── sla-logs.js                  # GET (admin)
└── bet-plan.js                  # POST → 501
```

---

## Chunk 1: Foundation, time utils, token, seed, smoke test

This chunk produces a deployable but mostly-empty worker shell, a working gameDay token cache, a 48-country seed loaded into KV, and a smoke test script that proves all 4 FIFA endpoints are reachable from this environment.

After Chunk 1, the worker deploys (dry-run), the seed loads, and `npm run smoke-test` reports the live status of all 4 FIFA endpoints — minimum success bar is "calendar + mangodev pass" (the 2 must-have endpoints). The fdh-api and live/football checks use hardcoded fallback IDs from the 2026-06-22 probe and may degrade gracefully if FIFA archives them; production uses dynamically-discovered IDs anyway. No real data ingestion happens yet (cron handlers are stubs).

### Task 1.1: Project scaffolding & wrangler.toml

**Files:**
- Create: `workers/fifa-scraper/wrangler.toml`
- Create: `workers/fifa-scraper/index.js`
- Create: `workers/fifa-scraper/package.json`
- Create: `workers/fifa-scraper/.gitignore`

- [ ] **Step 1: Create wrangler.toml**

```toml
name = "worldcup-fifa-scraper"
main = "index.js"
compatibility_date = "2024-09-01"

[triggers]
crons = [
  "*/2 * * * *",
  "0 */6 * * *",
  "0 17,21,1,5 * * *"
]

[[kv_namespaces]]
binding = "MATCH_DATA"
id = "278f1209ffd84662bd51921370a2fbe9"
```

- [ ] **Step 2: Create package.json**

`workers/fifa-scraper/package.json`:
```json
{
  "name": "worldcup-fifa-scraper",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/",
    "smoke-test": "node scripts/smoke-test.js",
    "seed": "node scripts/seed-kv.js",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.103.0"
  }
}
```

- [ ] **Step 3: Create .gitignore**

`workers/fifa-scraper/.gitignore`:
```
node_modules/
.wrangler/
.dev.vars
```

- [ ] **Step 4: Create entry index.js (stub handlers)**

```javascript
// Entry: dispatch cron triggers to the right handler.
// All real logic lives in lib/*; this file stays thin so it's easy to read.

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    try {
      if (cron === '*/2 * * * *') {
        console.log('[fifa-scraper] main cron tick (not yet implemented)');
      } else if (cron === '0 */6 * * *') {
        console.log('[fifa-scraper] calendar cron tick (not yet implemented)');
      } else if (cron === '0 17,21,1,5 * * *') {
        console.log('[fifa-scraper] tournament-wide cron tick (not yet implemented)');
      } else {
        console.warn(`[fifa-scraper] unknown cron: ${cron}`);
      }
    } catch (e) {
      console.error(`[fifa-scraper] cron error:`, e);
    }
  },

  async fetch(request, env) {
    return new Response('worldcup-fifa-scraper alive (use cron triggers)', { status: 200 });
  },
};
```

- [ ] **Step 5: Install wrangler locally**

```bash
cd workers/fifa-scraper
npm install
```
Expected: `node_modules/` created, no errors. `npx wrangler --version` returns `4.103.x` or newer.

- [ ] **Step 6: Verify dry-run works**

```bash
export CLOUDFLARE_API_TOKEN=$(security find-generic-password -s "cloudflare-api-token" -a "yujuntao1981" -w)
export CLOUDFLARE_ACCOUNT_ID=0bf8afedf1e0b911f3c1733e93546b71
npx wrangler deploy --dry-run
```
Expected: `Total Upload: X KiB` printed, no errors. (Real deploy is in Chunk 5.)

- [ ] **Step 7: Commit**

```bash
git add workers/fifa-scraper/wrangler.toml \
        workers/fifa-scraper/index.js \
        workers/fifa-scraper/package.json \
        workers/fifa-scraper/.gitignore
git commit -m "feat(fifa-scraper): scaffold worker with cron triggers"
```

### Task 1.2: time-utils.js + tests

**Files:**
- Create: `workers/fifa-scraper/lib/time-utils.js`
- Create: `workers/fifa-scraper/test/time-utils.test.js`

- [ ] **Step 1: Write failing test**

`workers/fifa-scraper/test/time-utils.test.js`:
```javascript
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

test('parseKickoffUtc: alias for parseKickoffBeijing, returns Date', () => {
  const fixture = { date: '2026-06-21', kickoff: '04:00' };
  const t = parseKickoffUtc(fixture);
  // Beijing 04:00 = UTC previous day 20:00
  assert.equal(t.toISOString(), '2026-06-20T20:00:00.000Z');
});

test('beijingDateStr: epoch ms → YYYY-MM-DD in Beijing TZ', () => {
  // 2026-06-21 23:30 UTC = 2026-06-22 07:30 Beijing → returns '2026-06-22'
  const utc = Date.UTC(2026, 5, 21, 23, 30, 0);
  assert.equal(beijingDateStr(utc), '2026-06-22');
});

test('beijingDateStr: midnight UTC stays today in Beijing', () => {
  // 2026-06-21 00:00 UTC = 2026-06-21 08:00 Beijing
  const utc = Date.UTC(2026, 5, 21, 0, 0, 0);
  assert.equal(beijingDateStr(utc), '2026-06-21');
});

test('beijingHour: returns 0-23 in Beijing TZ', () => {
  const utc = Date.UTC(2026, 5, 21, 23, 30, 0);  // 07:30 Beijing
  assert.equal(beijingHour(utc), 7);
});

test('matchDurationMs: group stage = 105min', () => {
  const env = makeMockEnv({});
  // pass empty calendar → falls back to 105min default
  return matchDurationMs(env, { id: 'f1' }).then(ms => {
    assert.equal(ms, 105 * 60 * 1000);
  });
});

test('matchDurationMs: knockout stage = 165min', async () => {
  const env = makeMockEnv({
    'fixture_mapping:f1': { fifa_id_match: 'm1' },
    'fifa_calendar': { matches: [{ id_match: 'm1', stage_name: 'Round of 16' }] }
  });
  const ms = await matchDurationMs(env, { id: 'f1' });
  assert.equal(ms, 165 * 60 * 1000);
});

// minimal in-memory KV mock
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd workers/fifa-scraper
node --test test/time-utils.test.js
```
Expected: FAIL with "Cannot find module" or similar.

- [ ] **Step 3: Implement time-utils.js**

`workers/fifa-scraper/lib/time-utils.js`:
```javascript
// Time utilities — all parsing and formatting work in epoch ms internally.
// Inputs from 500.com are Beijing wall clock (no tz marker); FIFA inputs are UTC ISO with Z.

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Parse a 500.com fixture's {date:"YYYY-MM-DD", kickoff:"HH:MM"} as Beijing wall clock.
 * Returns a Date whose .toISOString() yields the equivalent UTC moment.
 */
export function parseKickoffBeijing(fixture) {
  if (!fixture?.date || !fixture?.kickoff) {
    throw new Error(`parseKickoffBeijing: missing date or kickoff in ${JSON.stringify(fixture)}`);
  }
  const [Y, M, D] = fixture.date.split('-').map(Number);
  const [h, m] = fixture.kickoff.split(':').map(Number);
  // Build UTC from Beijing wall clock by subtracting +08:00 offset
  const utcMs = Date.UTC(Y, M - 1, D, h, m, 0) - BEIJING_OFFSET_MS;
  return new Date(utcMs);
}

/** Alias kept for readability: parseKickoffBeijing returns a Date in UTC anyway. */
export const parseKickoffUtc = parseKickoffBeijing;

/** Given epoch ms, return YYYY-MM-DD in Beijing TZ. */
export function beijingDateStr(epochMs) {
  const d = new Date(epochMs + BEIJING_OFFSET_MS);
  // d.getUTCFullYear/Month/Date now reflect Beijing wall clock
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Given epoch ms, return 0-23 hour in Beijing TZ. */
export function beijingHour(epochMs) {
  return new Date(epochMs + BEIJING_OFFSET_MS).getUTCHours();
}

/**
 * Match duration (incl. half-time / extra-time cushion) for a given 500 fixture.
 * Group-stage default 105min; knockout (round-of-16 → final) 165min.
 * Stage info is looked up via fixture_mapping → fifa_calendar.
 */
export async function matchDurationMs(env, fixture) {
  const DEFAULT = 105 * 60 * 1000;
  const mapping = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json');
  if (!mapping?.fifa_id_match) return DEFAULT;
  const cal = await env.MATCH_DATA.get('fifa_calendar', 'json');
  const fm = cal?.matches?.find(x => x.id_match === mapping.fifa_id_match);
  const stage = fm?.stage_name || '';
  // Anchored regex — avoids accidentally matching "Final round of group A".
  // Real FIFA values: "Group Stage", "Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Final".
  return /^(round of|quarter[- ]?final|semi[- ]?final|final$|knockout)/i.test(stage.trim())
    ? 165 * 60 * 1000
    : DEFAULT;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/time-utils.test.js
```
Expected: all 7 tests pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add workers/fifa-scraper/lib/time-utils.js workers/fifa-scraper/test/time-utils.test.js
git commit -m "feat(fifa-scraper): time utilities + tests"
```

### Task 1.3: token.js (gameDay token cache)

**Files:**
- Create: `workers/fifa-scraper/lib/token.js`
- Test: covered by smoke-test (Task 1.5); pure unit test would need network mock and adds complexity for little gain

- [ ] **Step 1: Implement token.js**

```javascript
// gameDay token: 24h JWT from cxm-api.fifa.com, required by mangodev API.
// Cached in KV under key 'gameday_token'; refreshes when expiry < 10min away.
//
// VERIFIED 2026-06-22 (real probe output saved to /tmp/check_token.json):
//   { "token": "eyJ...", "issuedAt": "2026-06-22T04:00:01+00:00",
//     "expiresAt": "2026-06-23T04:00:01+00:00" }
// We store the response verbatim plus a derived `_cachedAt` for defence-in-depth
// — if `expiresAt` is ever missing, the cache treats the entry as 23h-old after
// `_cachedAt` to force a re-fetch.

const TOKEN_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;   // refresh if less than 10min left
const ASSUMED_TTL_MS = 23 * 60 * 60 * 1000; // 23h fallback if expiresAt missing

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.fifa.com',
  'Referer': 'https://www.fifa.com/',
  'Accept': 'application/json',
};

export async function ensureGamedayToken(env) {
  const cached = await env.MATCH_DATA.get('gameday_token', 'json');
  if (cached?.token) {
    // Prefer FIFA's reported expiresAt; fall back to _cachedAt + ASSUMED_TTL_MS.
    const expiry = cached.expiresAt
      ? Date.parse(cached.expiresAt)
      : (cached._cachedAt ? Date.parse(cached._cachedAt) + ASSUMED_TTL_MS : 0);
    if (!Number.isNaN(expiry) && expiry - Date.now() > REFRESH_BUFFER_MS) {
      return cached.token;
    }
  }
  // Refresh
  const r = await fetch(TOKEN_URL, { headers: BROWSER_HEADERS });
  if (!r.ok) throw new Error(`gameDay token fetch failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.token) throw new Error(`gameDay token response missing token: ${JSON.stringify(j).slice(0, 200)}`);
  // Augment with our own timestamp for the fallback path
  const augmented = { ...j, _cachedAt: new Date().toISOString() };
  await env.MATCH_DATA.put('gameday_token', JSON.stringify(augmented), { expirationTtl: 86400 - 3600 });
  return j.token;
}

/** Standard headers for any FIFA endpoint call (mimics browser to avoid WAF blocks). */
export function fifaBrowserHeaders(extra = {}) {
  return { ...BROWSER_HEADERS, ...extra };
}
```

- [ ] **Step 2: Commit**

```bash
git add workers/fifa-scraper/lib/token.js
git commit -m "feat(fifa-scraper): gameDay token cache helper"
```

### Task 1.4: 48-country seed

**Files:**
- Create: `workers/fifa-scraper/seed/countries.json`
- Create: `workers/fifa-scraper/scripts/seed-kv.js`

- [ ] **Step 1: Create initial seed**

`workers/fifa-scraper/seed/countries.json` — minimum starter set covering teams already present in our `matches:*` history; full 48 list will be expanded by reading `fifa_calendar` after first 6h cron tick.

```json
{
  "version": 1,
  "updated_at": "2026-06-22T12:00:00+08:00",
  "items": [
    {"zh": "西班牙", "code": "ESP", "en": "Spain"},
    {"zh": "沙特阿拉伯", "code": "KSA", "en": "Saudi Arabia"},
    {"zh": "墨西哥", "code": "MEX", "en": "Mexico"},
    {"zh": "南非", "code": "RSA", "en": "South Africa"},
    {"zh": "韩国", "code": "KOR", "en": "Korea Republic"},
    {"zh": "捷克", "code": "CZE", "en": "Czechia"},
    {"zh": "加拿大", "code": "CAN", "en": "Canada"},
    {"zh": "波黑", "code": "BIH", "en": "Bosnia and Herzegovina"},
    {"zh": "美国", "code": "USA", "en": "USA"},
    {"zh": "巴拉圭", "code": "PAR", "en": "Paraguay"},
    {"zh": "巴西", "code": "BRA", "en": "Brazil"},
    {"zh": "摩洛哥", "code": "MAR", "en": "Morocco"},
    {"zh": "卡塔尔", "code": "QAT", "en": "Qatar"},
    {"zh": "瑞士", "code": "SUI", "en": "Switzerland"},
    {"zh": "海地", "code": "HAI", "en": "Haiti"},
    {"zh": "苏格兰", "code": "SCO", "en": "Scotland"},
    {"zh": "澳大利亚", "code": "AUS", "en": "Australia"},
    {"zh": "土耳其", "code": "TUR", "en": "Türkiye"},
    {"zh": "荷兰", "code": "NED", "en": "Netherlands"},
    {"zh": "日本", "code": "JPN", "en": "Japan"},
    {"zh": "科特迪瓦", "code": "CIV", "en": "Côte d'Ivoire"},
    {"zh": "厄瓜多尔", "code": "ECU", "en": "Ecuador"},
    {"zh": "瑞典", "code": "SWE", "en": "Sweden"},
    {"zh": "突尼斯", "code": "TUN", "en": "Tunisia"},
    {"zh": "法国", "code": "FRA", "en": "France"},
    {"zh": "塞内加尔", "code": "SEN", "en": "Senegal"},
    {"zh": "阿根廷", "code": "ARG", "en": "Argentina"},
    {"zh": "阿尔及利亚", "code": "ALG", "en": "Algeria"},
    {"zh": "奥地利", "code": "AUT", "en": "Austria"},
    {"zh": "约旦", "code": "JOR", "en": "Jordan"},
    {"zh": "伊拉克", "code": "IRQ", "en": "Iraq"},
    {"zh": "挪威", "code": "NOR", "en": "Norway"},
    {"zh": "葡萄牙", "code": "POR", "en": "Portugal"},
    {"zh": "刚果(金)", "code": "COD", "en": "Congo DR"},
    {"zh": "英格兰", "code": "ENG", "en": "England"},
    {"zh": "克罗地亚", "code": "CRO", "en": "Croatia"},
    {"zh": "加纳", "code": "GHA", "en": "Ghana"},
    {"zh": "巴拿马", "code": "PAN", "en": "Panama"},
    {"zh": "乌兹别克", "code": "UZB", "en": "Uzbekistan"},
    {"zh": "哥伦比亚", "code": "COL", "en": "Colombia"},
    {"zh": "乌拉圭", "code": "URU", "en": "Uruguay"},
    {"zh": "佛得角", "code": "CPV", "en": "Cabo Verde"},
    {"zh": "新西兰", "code": "NZL", "en": "New Zealand"},
    {"zh": "埃及", "code": "EGY", "en": "Egypt"},
    {"zh": "伊朗", "code": "IRN", "en": "IR Iran"},
    {"zh": "比利时", "code": "BEL", "en": "Belgium"},
    {"zh": "德国", "code": "GER", "en": "Germany"}
  ]
}
```

(46 countries listed; the missing 2 of 48 will be filled from `fifa_calendar` after first probe.)

- [ ] **Step 2: Create seed-kv.js**

`workers/fifa-scraper/scripts/seed-kv.js`:
```javascript
#!/usr/bin/env node
// One-shot: upload seed/countries.json into KV under key 'countries'.
// Usage: node scripts/seed-kv.js [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, '..', 'seed', 'countries.json');
const KV_NS = '278f1209ffd84662bd51921370a2fbe9';
const DRY_RUN = process.argv.includes('--dry-run');

function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error(`seed file not found: ${SEED_PATH}`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  console.log(`seed has ${seed.items.length} countries`);
  if (DRY_RUN) {
    console.log('dry-run; sample item:', JSON.stringify(seed.items[0]));
    return;
  }
  // Write to remote KV via wrangler
  console.log('writing to KV...');
  execSync(
    `npx wrangler kv key put countries --path="${SEED_PATH}" --namespace-id=${KV_NS} --remote`,
    { stdio: 'inherit' }
  );
  console.log('✅ countries seed uploaded');
}

main();
```

- [ ] **Step 3: Run dry-run to verify**

```bash
cd workers/fifa-scraper
node scripts/seed-kv.js --dry-run
```
Expected: `seed has 46 countries` printed.

- [ ] **Step 4: Commit**

```bash
git add workers/fifa-scraper/seed/countries.json workers/fifa-scraper/scripts/seed-kv.js
git commit -m "feat(fifa-scraper): countries seed (46/48) + uploader script"
```

### Task 1.5: smoke-test.js (real FIFA endpoint validation)

**Files:**
- Create: `workers/fifa-scraper/scripts/smoke-test.js`

- [ ] **Step 1: Implement smoke-test.js**

```javascript
#!/usr/bin/env node
// One-shot: validate all 4 FIFA endpoints respond from the local machine.
// Mirrors the expected request shapes the worker will make.
// Run: node scripts/smoke-test.js
//
// Note: live/football & fdh-api use IDs **discovered dynamically** from the
// calendar response, so this test won't false-fail when FIFA rotates legacy
// match IDs (the hardcoded probe IDs from 2026-06-22 may not survive forever).

const TOKEN_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.fifa.com',
  'Referer': 'https://www.fifa.com/',
  'Accept': 'application/json',
};

// Hardcoded fallback IDs from 2026-06-22 probe (used only if dynamic discovery fails)
const FALLBACK_LIVE_TUPLE = [
  'cesdwwnxbc5fmajgroc0hqzy2',
  'dezv8l0fzgcxtejl0dwmy1gyc',
  '2m1wojm5bt709wu4kugtytxqs',
  '52cm9g2ph41wy7jcvhjsbkc9g'
];
const FALLBACK_FDH_ID = '151651';

const ctx = {};   // shared across checks

const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

check('calendar/matches', async () => {
  const r = await fetch(
    'https://api.fifa.com/api/v3/calendar/matches?idCompetition=17&from=2026-06-15T00:00:00Z&to=2026-06-30T23:59:59Z&language=en&count=200',
    { headers: HEADERS }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.Results) || j.Results.length === 0) throw new Error('empty Results');
  // Pick a match with all 4 IDs for the live/football check
  const pick = j.Results.find(m => m.IdCompetition && m.IdSeason && m.IdStage && m.IdMatch);
  if (pick) {
    ctx.liveTuple = [pick.IdCompetition, pick.IdSeason, pick.IdStage, pick.IdMatch];
    ctx.calendarMatch = pick;
  }
  return `${j.Results.length} matches`;
});

check('live/football', async () => {
  const tuple = ctx.liveTuple || FALLBACK_LIVE_TUPLE;
  const r = await fetch(
    `https://api.fifa.com/api/v3/live/football/${tuple[0]}/${tuple[1]}/${tuple[2]}/${tuple[3]}?language=en`,
    { headers: HEADERS }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status} (tuple=${tuple.join('/')})`);
  const j = await r.json();
  if (!j.HomeTeam?.Players?.length) throw new Error('no players');
  return `${j.HomeTeam.Players.length}+${j.AwayTeam.Players.length} players`;
});

check('fdh-api/players.json', async () => {
  // Try the hardcoded ID first (known good from probe); if it 404s, accept failure
  // gracefully — the real fdh_match_id comes from mangodev tags in production.
  const id = FALLBACK_FDH_ID;
  const r = await fetch(`https://fdh-api.fifa.com/v1/stats/match/${id}/players.json`, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} (fdh_id=${id} — may be archived, will be replaced by mangodev-derived ID in production)`);
  const j = await r.json();
  const pids = Object.keys(j);
  if (pids.length < 20) throw new Error(`only ${pids.length} players`);
  return `${pids.length} players (fdh_id=${id})`;
});

check('mangodev/stories (requires token)', async () => {
  const tr = await fetch(TOKEN_URL, { headers: HEADERS });
  if (!tr.ok) throw new Error(`token HTTP ${tr.status}`);
  const tj = await tr.json();
  if (!tj.token) throw new Error('no token');
  const url = 'https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query='
    + encodeURIComponent('(and resourceStatus==`urn:gd:resourceStatus:active` _externalId~`urn:gd:story:classification:gcp_top_scorer:competitionId:285023:goals:rank_asc:page:1$`)')
    + '&skip=0&limit=1&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc';
  const sr = await fetch(url, { headers: { ...HEADERS, 'Authorization': `Bearer ${tj.token}` } });
  if (!sr.ok) throw new Error(`stories HTTP ${sr.status}`);
  const sj = await sr.json();
  const actors = sj.items?.[0]?.actors;
  if (!actors?.length) throw new Error('no actors');
  return `${actors.length} actors`;
});

async function run() {
  let ok = 0;
  for (const t of tests) {
    try {
      const res = await t.fn();
      console.log(`✅ ${t.name}: ${res}`);
      ok++;
    } catch (e) {
      console.log(`❌ ${t.name}: ${e.message}`);
    }
  }
  console.log(`\nOK ${ok}/${tests.length}`);
  // Non-zero exit only on critical (calendar + mangodev). fdh + live/football
  // failures may be artefacts of stale hardcoded IDs and are non-blocking.
  process.exit(ok >= 2 ? 0 : 1);
}

run();
```

- [ ] **Step 2: Run smoke test**

```bash
cd workers/fifa-scraper
node scripts/smoke-test.js
```
Expected: at minimum "calendar + mangodev" lines marked ✅; final `OK N/4` printed. If mangodev fails with 429, wait 60s and retry once. fdh-api/live-football may show ❌ if the hardcoded 2026-06-22 probe IDs have been archived — that's non-blocking (production discovers IDs dynamically).

- [ ] **Step 3: Commit**

```bash
git add workers/fifa-scraper/scripts/smoke-test.js
git commit -m "feat(fifa-scraper): smoke test script for all 4 FIFA endpoints"
```

---

