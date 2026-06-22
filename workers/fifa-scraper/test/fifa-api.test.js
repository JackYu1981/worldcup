import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCalendarResponse } from '../lib/fifa-api.js';

test('normalizeCalendarResponse: maps FIFA Results to our match schema', () => {
  const raw = {
    Results: [
      {
        IdCompetition: 'c1',
        IdSeason: 's1',
        IdStage: 'st1',
        IdMatch: 'm1',
        Date: '2026-06-15T02:00:00Z',
        Home: { IdCountry: 'SWE', TeamName: [{ Locale: 'en-gb', Description: 'Sweden' }] },
        Away: { IdCountry: 'TUN', TeamName: [{ Locale: 'en-gb', Description: 'Tunisia' }] },
        MatchStatus: 0,
        StageName: [{ Locale: 'en-gb', Description: 'Group Stage' }]
      }
    ]
  };
  const out = normalizeCalendarResponse(raw, 17, '2026-06-15T00:00:00Z', '2026-06-30T23:59:59Z');
  assert.equal(out.competition_id, 17);
  assert.equal(out.from_utc, '2026-06-15T00:00:00Z');
  assert.equal(out.to_utc, '2026-06-30T23:59:59Z');
  assert.match(out.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(out.matches.length, 1);
  const m = out.matches[0];
  assert.equal(m.id_match, 'm1');
  assert.equal(m.id_competition, 'c1');
  assert.equal(m.id_season, 's1');
  assert.equal(m.id_stage, 'st1');
  assert.equal(m.date_utc, '2026-06-15T02:00:00Z');
  assert.equal(m.home_code, 'SWE');
  assert.equal(m.away_code, 'TUN');
  assert.equal(m.home_name_en, 'Sweden');
  assert.equal(m.away_name_en, 'Tunisia');
  assert.equal(m.match_status, 0);
  assert.equal(m.stage_name, 'Group Stage');
});

test('normalizeCalendarResponse: handles missing TeamName / StageName gracefully', () => {
  const raw = {
    Results: [{
      IdCompetition: 'c1', IdSeason: 's1', IdStage: 'st1', IdMatch: 'm1',
      Date: '2026-06-15T02:00:00Z',
      Home: { IdCountry: 'ENG' },   // no TeamName
      Away: { IdCountry: 'CRO' },
      MatchStatus: 0
      // no StageName
    }]
  };
  const out = normalizeCalendarResponse(raw, 17, 'x', 'y');
  const m = out.matches[0];
  assert.equal(m.home_code, 'ENG');
  assert.equal(m.home_name_en, null);
  assert.equal(m.stage_name, null);
});

test('normalizeCalendarResponse: skips entries without Home/Away country codes', () => {
  const raw = {
    Results: [
      { IdCompetition: 'c', IdSeason: 's', IdStage: 'st', IdMatch: 'm1',
        Date: 'x', Home: { IdCountry: 'ENG' }, Away: { IdCountry: 'CRO' }, MatchStatus: 0 },
      // placeholder / TBD entry (e.g. knockout bracket not decided yet)
      { IdCompetition: 'c', IdSeason: 's', IdStage: 'st', IdMatch: 'm2',
        Date: 'x', Home: { IdCountry: null }, Away: { IdCountry: null }, MatchStatus: 0 }
    ]
  };
  const out = normalizeCalendarResponse(raw, 17, 'x', 'y');
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].id_match, 'm1');
});

test('normalizeCalendarResponse: extracts fdh_match_id from Properties.IdIFES', () => {
  const raw = {
    Results: [{
      IdCompetition: 'c1', IdSeason: 's1', IdStage: 'st1', IdMatch: '400021474',
      Date: '2026-06-15T02:00:00Z',
      Home: { IdCountry: 'SWE' }, Away: { IdCountry: 'TUN' },
      MatchStatus: 0,
      Properties: { IdIFES: '151637' }
    }]
  };
  const out = normalizeCalendarResponse(raw, 17, 'x', 'y');
  assert.equal(out.matches[0].fdh_match_id, '151637');
  assert.equal(out.matches[0].id_match, '400021474');
});

test('normalizeCalendarResponse: fdh_match_id null when Properties missing', () => {
  const raw = {
    Results: [{
      IdCompetition: 'c1', IdSeason: 's1', IdStage: 'st1', IdMatch: 'm1',
      Date: 'x', Home: { IdCountry: 'A' }, Away: { IdCountry: 'B' }, MatchStatus: 0
    }]
  };
  const out = normalizeCalendarResponse(raw, 17, 'x', 'y');
  assert.equal(out.matches[0].fdh_match_id, null);
});

test('normalizeCalendarResponse: empty Results yields empty matches', () => {
  const out = normalizeCalendarResponse({ Results: [] }, 17, 'x', 'y');
  assert.equal(out.matches.length, 0);
});
