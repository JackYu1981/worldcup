// Players module — parses mangodev story.actors into our player schema.
//
// All field positions verified by Chunk 4.1 probe (real data dumps in
// /tmp/mango_probe/). Each actor.tags carries ALL stats within its classification,
// so we only need ONE fetch per classification to populate the full data set.

export const STAT_TAG_PREFIX = 'urn:gd:tag:football:stats:';

/**
 * Which stat name to rank by for each classification (used by the cron URL).
 * Verified working (Chunk 4.1):
 *   - gcp_top_scorer → 'goals' (assists / minutes also valid)
 *   - gcp_attack → 'xg' (the only safe one; goals/attempts_* return 404 here)
 *   - gcp_discipline → 'yellow_cards'
 *   - gcp_distribution → 'passes'
 */
export const CLASSIFICATION_RANK_BY = {
  gcp_top_scorer: 'goals',
  gcp_attack: 'xg',
  gcp_discipline: 'yellow_cards',
  gcp_distribution: 'passes'
};

/**
 * Stats actually present in each classification's actor.tags (verified by probe).
 * The cron writes these into players:{id}.tournament_stats.{bucket}.{key}.
 */
export const CLASSIFICATION_STAT_KEYS = {
  gcp_top_scorer: [
    'goals',
    'assists',
    'total_competition_minutes_played'
  ],
  gcp_attack: [
    'assists',                                  // duplicated from top_scorer, that's OK — both classifications carry it
    'attempt_at_goal',
    'attempt_at_goal_on_target',
    'attempt_at_goal_conversion_rate',
    'attempt_at_goal_inside_the_penalty_area',
    'attempt_at_goal_outside_the_penalty_area',
    'headed_attempt_at_goal',
    'xg',
    'xg_goal_effiency_rate',
    'corners'
  ],
  gcp_discipline: [
    'fouls_for',
    'fouls_against',
    'yellow_cards',
    'red_cards',
    'indirect_red_cards',
    'offsides'
  ],
  gcp_distribution: [
    'passes',
    'passing_accuracy_rate',
    'crosses',
    'crossing_accuracy_rate',
    'linebreaks_attempted_defensive_line',
    'linebreak_attempted_defensive_line_rate',
    'attempted_switches_of_play',
    'switches_of_play_rate'
  ]
};

/**
 * Extract player profile fields from a mangodev story actor.
 *
 * Sources:
 *   actor.key._externalSportsPersonId   → player_id (6-digit)
 *   actor.key._externalTeamId           → "{seasonId}_{teamId}" — split for team_id
 *   actor.name                          → 12-language name map (eng key as primary)
 *   actor.tags                          → photo_url, country_code, country_zh,
 *                                          position_label, fdh_match_ids
 */
export function extractProfileFromActor(actor) {
  const tagMap = Object.fromEntries((actor.tags || []).map(t => [t.name, t.value]));
  const externalTeamId = actor.key?._externalTeamId || '';
  const teamIdParts = externalTeamId.split('_');
  // _externalTeamId is "seasonId_teamId" — we want the last segment
  const teamId = teamIdParts.length >= 2 ? teamIdParts[teamIdParts.length - 1] : null;

  return {
    player_id: actor.key?._externalSportsPersonId || null,
    team_id: teamId,
    country_code: tagMap['urn:gd:tag:story:team:abbreviation'] || null,
    country_zh: tagMap['urn:gd:tag:story:team:name:zho'] || null,
    position_label: tagMap['urn:gd:tag:story:staff:position'] || null,
    photo_url: tagMap['urn:gd:tag:story:staff:image'] || null,
    name_eng: actor.name?.eng || null,
    name_multilang: actor.name || {},
    fdh_match_ids: tagMap['urn:gd:tag:story:staff:match_squad:match_id'] || []
  };
}

/**
 * Read a numeric stat value from actor.tags.
 *
 * statKey is the bare stat name (e.g. 'goals', 'yellow_cards'); we prepend
 * STAT_TAG_PREFIX to find the tag.
 *
 * Returns 0 when tag absent (semantic: stat doesn't apply to this player or
 * they haven't accumulated any). Some tags carry strings with units
 * (e.g. '1.43x' for xg_goal_effiency_rate) — parseFloat handles those.
 */
export function parseStatValue(actor, statKey) {
  const fullName = STAT_TAG_PREFIX + statKey;
  const tag = (actor.tags || []).find(t => t.name === fullName);
  if (!tag || tag.value === undefined || tag.value === null) return 0;
  const raw = tag.value;
  if (typeof raw === 'number') return raw;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}
