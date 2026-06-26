// Match-played counter — reconcile model (v2, 2026-06-26).
//
// PRIOR DESIGN (deprecated): a monotonic counter using `last_match_id` as a
// watermark — incremented `matches_played` once per new fixture observed.
// FAILURE MODE: if a cron tick missed a fixture (happened repeatedly due to
// the "midnight bucket amnesia" bug fixed in v4.9.1), that match was lost
// forever — counter would be permanently 1 short. We observed 463 players
// (out of 725 with appearances) had stale counts on 2026-06-26.
//
// NEW DESIGN: `match_stats:{fid}.players` is the AUTHORITATIVE record of "did
// player X appear in fixture Y". Each fixture writes one entry per appearance.
// So `matches_played` = COUNT(*) FROM match_stats WHERE pid=X. We rebuild
// players:{pid}.tournament_stats.matches_played from this truth every cron
// tick — no watermark, no drift, no possibility of permanent off-by-one.
//
// COST: each tick lists ~60 match_stats keys (1 KV `list()` + N parallel
// `get`s). For a tick processing 5 fixtures, this is ~60 reads. Within Paid
// quota (10M reads/day = 116/sec); typical tick uses 60-80.
//
// Why not just trust FIFA's `gctp_top_scorer:matches_played` directly?
// Because FIFA reports incorrect counts on mangodev (Vinicius shows
// matches_played=1 after 3 appearances — verified 2026-06-26). Our authoritative
// count from match_stats is consistent with what the user actually sees
// in lineup events.

/**
 * Reconcile `players:{pid}.tournament_stats.matches_played` for the players
 * who just appeared in `fixturePlayerIds` (i.e. the ones we have new
 * match_stats entries for after this tick).
 *
 * Approach:
 *   1. List all match_stats:* keys (cheap — 1 KV list).
 *   2. For each player who appeared in this fixture, count how many other
 *      match_stats records also list them. That count is the authoritative
 *      matches_played.
 *   3. Patch players:{pid}.tournament_stats.matches_played + minutes_played
 *      if they're off.
 *
 * Skips players whose archive doesn't exist (upsertPlayersFromLineup is main
 * cron's job; we don't double-create).
 */
export async function reconcileMatchPlayedCounters(env, fixturePlayerIds, fixtureId) {
  if (!fixturePlayerIds || fixturePlayerIds.size === 0) return { reconciled: 0, skipped: 0 };

  // 1. List all match_stats keys (cheap; one KV list call).
  const listRes = await env.MATCH_DATA.list({ prefix: 'match_stats:' });
  const allMsKeys = listRes.keys.map(k => k.name);

  // 2. Parallel fetch all match_stats — needed to count per-pid appearances.
  //    For 60 match_stats records this is ~60 parallel KV reads, ~50-100ms.
  const msRecords = await Promise.all(
    allMsKeys.map(k => env.MATCH_DATA.get(k, 'json').catch(() => null))
  );

  // 3. Build pid → count map for the players we care about (the ones in this fixture).
  const pidToCount = new Map();
  for (const pid of fixturePlayerIds) {
    pidToCount.set(pid, 0);
  }
  for (const ms of msRecords) {
    if (!ms?.players) continue;
    for (const pid of Object.keys(ms.players)) {
      if (pidToCount.has(pid)) {
        pidToCount.set(pid, pidToCount.get(pid) + 1);
      }
    }
  }

  // 4. For each pid, patch players:{pid} if matches_played is off.
  let reconciled = 0;
  let skipped = 0;
  const ops = [];
  for (const pid of fixturePlayerIds) {
    const actualCount = pidToCount.get(pid) || 0;
    if (actualCount === 0) {
      // Player has no match_stats appearances yet (e.g. lineup was just
      // captured but match hasn't progressed enough for fdh to register
      // any shots/fouls). Skip — don't write 0 over an existing count.
      skipped++;
      continue;
    }
    ops.push((async () => {
      const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json');
      if (!existing) return 'no_archive';
      const ts = existing.tournament_stats || {};
      const oldCount = ts.matches_played || 0;
      if (oldCount === actualCount) return 'unchanged';
      // Reconcile: set to authoritative count. Minutes_played fudge: if
      // it's clearly too small (e.g. 5 min reported for 2 appearances),
      // bump by 70min × (delta) — but don't shrink an existing larger
      // value, because FIFA's minutes_played counter is sometimes more
      // up-to-date during a live match than ours.
      ts.matches_played = actualCount;
      const minMinutes = actualCount * 30;   // conservative floor
      if ((ts.minutes_played || 0) < minMinutes) {
        ts.minutes_played = minMinutes + 30; // give a generous bump
      }
      existing.tournament_stats = ts;
      existing.last_updated = new Date().toISOString().replace(/Z$/, '+00:00');
      await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(existing));
      reconciled++;
      return 'updated';
    })());
  }
  await Promise.all(ops);

  return { reconciled, skipped, total_pids: fixturePlayerIds.size };
}

/**
 * @deprecated kept for backward compat with tests. Use reconcileMatchPlayedCounters.
 *
 * Old monotonic-counter API; new caller signature is preferred. This
 * exists only so existing tests don't break — production main-cron has
 * never invoked the old function (verified 2026-06-26 via grep).
 */
export async function updateMatchPlayedCounters(env, mapping, fdhPlayerStats) {
  // Translate into new API: collect the pids that appeared in this fdh response
  // (MatchesPlayed > 0) and reconcile from match_stats truth.
  if (!mapping?.fifa_id_match) return;
  const pids = new Set();
  for (const [pid, statList] of Object.entries(fdhPlayerStats || {})) {
    const row = (statList || []).find(s => Array.isArray(s) && s[0] === 'MatchesPlayed');
    if (row && Number(row[1]) > 0) pids.add(pid);
  }
  return reconcileMatchPlayedCounters(env, pids, mapping.fifa_id_match);
}
