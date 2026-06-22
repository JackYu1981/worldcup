#!/usr/bin/env node
// One-shot seed script — fetches all mangodev tournament-wide stats and writes
// baseline player profiles + tournament_stats.attacking/discipline to KV.
//
// Run once before go-live (and after major roster changes). Per-match incremental
// refresh in main-cron.js keeps the data fresh for fixtures in the active scrape
// window.
//
// Usage:
//   node scripts/seed-tournament-stats.js [--dry-run]
//
// No CF Worker CPU limit applies since we run locally + write via `wrangler kv put`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import {
  extractProfileFromActor,
  parseStatValue,
  CLASSIFICATION_RANK_BY,
  CLASSIFICATION_STAT_KEYS
} from '../lib/players.js';
import { fetchMangoStoryPage } from '../lib/fifa-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KV_NS = '278f1209ffd84662bd51921370a2fbe9';
const SEASON_ID = '285023';
const MAX_PAGES = 30;
const DRY_RUN = process.argv.includes('--dry-run');

const TOKEN_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.fifa.com',
  'Referer': 'https://www.fifa.com/',
  'Accept': 'application/json'
};

const ATTACKING_BUCKET_KEYS = new Set([
  'goals', 'assists', 'attempt_at_goal', 'attempt_at_goal_on_target',
  'attempt_at_goal_off_target', 'attempt_at_goal_conversion_rate',
  'attempt_at_goal_inside_the_penalty_area', 'attempt_at_goal_outside_the_penalty_area',
  'headed_attempt_at_goal', 'xg', 'xg_goal_effiency_rate', 'corners',
  'total_competition_minutes_played'
]);
const DISCIPLINE_BUCKET_KEYS = new Set([
  'fouls_for', 'fouls_against', 'yellow_cards', 'red_cards',
  'indirect_red_cards', 'offsides'
]);

async function getToken() {
  const r = await fetch(TOKEN_URL, { headers: HEADERS });
  if (!r.ok) throw new Error(`token HTTP ${r.status}`);
  return (await r.json()).token;
}

async function main() {
  console.log(`[seed] ${DRY_RUN ? 'DRY-RUN' : 'LIVE'} — fetching gameDay token...`);
  const token = await getToken();

  const acc = {};
  let totalActors = 0;
  let totalPages = 0;
  const t0 = Date.now();

  for (const [classification, rankStat] of Object.entries(CLASSIFICATION_RANK_BY)) {
    const bucketKeys = CLASSIFICATION_STAT_KEYS[classification] || [];
    console.log(`[seed] fetching ${classification} (rank by ${rankStat})...`);
    let page = 1;
    while (page <= MAX_PAGES) {
      const { story, err } = await fetchMangoStoryPage(token, SEASON_ID, classification, rankStat, page);
      if (err === 'HTTP 404') break;
      if (err) { console.error(`  page ${page}: ${err}`); break; }
      if (!story || !story.actors?.length) break;
      totalPages++;
      for (const actor of story.actors) {
        const pid = actor.key?._externalSportsPersonId;
        if (!pid) continue;
        if (!acc[pid]) {
          acc[pid] = { profile: extractProfileFromActor(actor), attacking: {}, discipline: {} };
        }
        const newProfile = extractProfileFromActor(actor);
        acc[pid].profile = {
          ...acc[pid].profile,
          ...newProfile,
          name_multilang: { ...acc[pid].profile.name_multilang, ...newProfile.name_multilang }
        };
        for (const k of bucketKeys) {
          const v = parseStatValue(actor, k);
          if (ATTACKING_BUCKET_KEYS.has(k)) acc[pid].attacking[k] = v;
          if (DISCIPLINE_BUCKET_KEYS.has(k)) acc[pid].discipline[k] = v;
        }
        totalActors++;
      }
      page++;
    }
    console.log(`  ✓ ${classification}: ${page - 1} pages, ${Object.keys(acc).length} unique players so far`);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[seed] fetched ${totalActors} actor records / ${Object.keys(acc).length} unique players in ${dt}s`);

  if (DRY_RUN) {
    console.log('\n=== sample player ===');
    const samplePid = Object.keys(acc)[0];
    console.log(samplePid, JSON.stringify(acc[samplePid], null, 2).slice(0, 800));
    return;
  }

  // Commit to KV — use `wrangler kv bulk put` for ~10000x speedup over per-key put
  console.log('\n[seed] committing players to KV (bulk put)...');
  const fetchedAt = new Date().toISOString().replace(/Z$/, '+00:00');
  const pids = Object.keys(acc);

  // FIRST RUN: write fresh — don't bother bulk-reading. Main cron later upserts
  // its own fields (last_match_id / shirt_number / position numeric) on top.
  // If re-running seed: counters.js fields (matches_played / minutes_played) live
  // in tournament_stats.matches_played which we set to null here; counters' first
  // tick after seed will see null and bootstrap them.
  const bulkPayload = pids.map(pid => {
    const agg = acc[pid];
    const updated = {
      id: pid,
      country_code: agg.profile.country_code,
      country_zh: agg.profile.country_zh,
      team_id: agg.profile.team_id,
      photo_url: agg.profile.photo_url || null,
      position_label: agg.profile.position_label || null,
      name: agg.profile.name_multilang,
      name_default: agg.profile.name_eng || `Player ${pid}`,
      fdh_match_ids: agg.profile.fdh_match_ids || [],
      tournament_stats: {
        version: 1,
        fetched_at: fetchedAt,
        source: 'mangodev_seed',
        matches_played: null,
        minutes_played: null,
        attacking: agg.attacking,
        discipline: agg.discipline
      },
      last_updated: fetchedAt
    };
    return { key: `players:${pid}`, value: JSON.stringify(updated) };
  });

  const bulkPath = `/tmp/seed_bulk_players.json`;
  fs.writeFileSync(bulkPath, JSON.stringify(bulkPayload));
  console.log(`  bulk file: ${bulkPath} (${(fs.statSync(bulkPath).size / 1024).toFixed(1)} KB)`);

  const tBulk = Date.now();
  execSync(
    `npx wrangler kv bulk put "${bulkPath}" --namespace-id=${KV_NS} --remote`,
    { stdio: 'inherit' }
  );
  fs.unlinkSync(bulkPath);

  const bulkDt = ((Date.now() - tBulk) / 1000).toFixed(1);
  console.log(`\n[seed] ✅ ${bulkPayload.length} players committed in ${bulkDt}s`);
}

function safeExecCapture(args) {
  try {
    return execSync(args.join(' '), { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { return null; }
}

main().catch(e => { console.error(e); process.exit(1); });
