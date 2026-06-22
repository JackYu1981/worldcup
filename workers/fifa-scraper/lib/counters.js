// Match-played counter accumulator with watermark idempotency.
//
// Problem: main cron runs every 2 min and pulls fdh-api/players.json for each
// fixture in window. During a 90-min match it pulls ~45 times. We must NOT
// increment players:{id}.tournament_stats.matches_played 45 times.
//
// Solution: players:{id}.last_match_id acts as a "this player's most-recent match"
// watermark. When we see a new match_id, +=1 and reset the temp accumulator.
// When same match repeats, OVERLAY current-match minutes (subtract previous
// in-match value, add new) so minutes_played stays accurate at any poll instant.
//
// fdh-api players.json shape: { player_id: [["StatName", value, flag], ...] }

function statValue(statList, name) {
  const row = (statList || []).find(s => Array.isArray(s) && s[0] === name);
  return row ? Number(row[1]) || 0 : 0;
}

export async function updateMatchPlayedCounters(env, mapping, fdhPlayerStats) {
  const currentMatchId = mapping.fifa_id_match;
  if (!currentMatchId) return;

  for (const [pid, statList] of Object.entries(fdhPlayerStats || {})) {
    const matchesPlayedRaw = statValue(statList, 'MatchesPlayed');
    const timePlayedRaw = statValue(statList, 'TimePlayed');
    if (matchesPlayedRaw === 0) continue;   // player did not feature

    const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json');
    if (!existing) continue;   // archive not yet created (upsertPlayersFromLineup is main cron's job)

    const ts = existing.tournament_stats || {
      matches_played: 0,
      minutes_played: 0,
      attacking: {},
      discipline: {}
    };

    const isNewMatch = existing.last_match_id !== currentMatchId;
    if (isNewMatch) {
      // Different match (or first ever): bump counter, seed temp accumulator with current poll's minutes.
      ts.matches_played = (ts.matches_played || 0) + 1;
      ts.minutes_played = (ts.minutes_played || 0) + timePlayedRaw;
      ts._current_match_minutes = timePlayedRaw;
      existing.last_match_id = currentMatchId;
    } else {
      // Same match polled again: overlay — subtract previous current-match minutes, add fresh.
      const prevCurrent = ts._current_match_minutes || 0;
      ts.minutes_played = (ts.minutes_played || 0) - prevCurrent + timePlayedRaw;
      ts._current_match_minutes = timePlayedRaw;
    }

    existing.tournament_stats = ts;
    existing.last_updated = new Date().toISOString().replace(/Z$/, '+00:00');
    await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(existing));
  }
}
