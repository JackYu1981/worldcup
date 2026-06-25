// GET /api/recommend/shots/{fixture_id}
// Returns the precomputed shot recommendation payload from KV
// `recommendation:{f1359xxx}`. Populated by Python engine (scripts/shot_recommender/inference.py).
//
// 404 when the engine hasn't computed this fixture yet (UI shows placeholder).
// Public read (no auth) — same as other lineup data.
//
// Cache 60s — recommendation re-runs are 10-30min apart (engine pace).

import { json, error, options } from '../../../lib/response.js';

export async function onRequestGet(context) {
  const { params, env } = context;
  const fid = params.fixture_id;
  if (!fid) return error('missing fixture_id', 400);

  try {
    const rec = await env.MATCH_DATA.get(`recommendation:${fid}`, 'json');
    if (!rec) {
      return error('No recommendation computed for this fixture yet', 404);
    }
    return json(rec, 200, 60);
  } catch (e) {
    return error(e.message, 500);
  }
}

export function onRequestOptions() { return options(); }
