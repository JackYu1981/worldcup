// GET /api/fifa/lineup/{fixture_id}
// Returns the match_lineups:{500_id} KV record, augmented with country_zh
// from the countries seed (so frontend doesn't need a separate lookup).

import { json, error, options } from '../../../lib/response.js';

export async function onRequestGet(context) {
  const { params, env } = context;
  const fixtureId = params.fixture_id;
  if (!fixtureId) return error('missing fixture_id', 400);

  try {
    const lineup = await env.MATCH_DATA.get(`match_lineups:${fixtureId}`, 'json');
    if (!lineup) {
      // Differentiate "no mapping yet" vs "mapping but no lineup published"
      const mapping = await env.MATCH_DATA.get(`fixture_mapping:${fixtureId}`, 'json');
      if (!mapping) {
        return json({
          lineup_available: false,
          reason: 'fixture_not_mapped',
          note: 'FIFA mapping not yet computed for this 500.com fixture'
        });
      }
      if (mapping.match_confidence !== 'exact' && mapping.match_confidence !== 'time_skew_5min') {
        return json({
          lineup_available: false,
          reason: 'fixture_unmatched',
          note: mapping.match_note || 'No matching FIFA fixture found'
        });
      }
      return json({
        lineup_available: false,
        reason: 'not_yet_published_by_fifa',
        note: 'FIFA will publish lineup ~60-90min before kickoff'
      });
    }

    // Augment with country_zh from countries seed
    const countries = await env.MATCH_DATA.get('countries', 'json');
    const codeToZh = countries?.items
      ? Object.fromEntries(countries.items.map(c => [c.code, c.zh]))
      : {};
    lineup.home.country_zh = codeToZh[lineup.home.country_code] || lineup.home.country_code;
    lineup.away.country_zh = codeToZh[lineup.away.country_code] || lineup.away.country_code;

    return json(lineup, 200, 30);   // cache 30s
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
