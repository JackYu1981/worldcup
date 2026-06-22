import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProfileFromActor,
  parseStatValue,
  STAT_TAG_PREFIX,
  CLASSIFICATION_STAT_KEYS,
  CLASSIFICATION_RANK_BY
} from '../lib/players.js';

// Minimal real-shape actor (extracted from Chunk 4.1 probe of Deniz Undav, top scorer page 1)
function topScorerActor() {
  return {
    key: {
      keyType: 'staff',
      _externalSportsPersonId: '484851',
      _externalSportsPersonIdScope: 'fifa',
      _externalTeamId: '285023_43948',
      _externalTeamIdScope: 'fifa'
    },
    number: 1,
    name: {
      eng: 'Deniz Undav',
      spa: 'Deniz Undav',
      fra: 'Deniz Undav',
      deu: 'Deniz Undav',
      ara: 'دينيز أونداف',
      zho: '德尼兹·乌恩达夫',
      jpn: 'デニズ・ウンダヴ'
    },
    tags: [
      { name: 'urn:gd:tag:story:staff:image', value: 'https://digitalhub.fifa.com/transform/UNDAV-Deniz_484851' },
      { name: 'urn:gd:tag:story:staff:match_squad:match_id', value: ['151631', '151634'] },
      { name: 'urn:gd:tag:story:staff:position', value: 'FW' },
      { name: 'urn:gd:tag:story:team:abbreviation', value: 'GER' },
      { name: 'urn:gd:tag:story:team:name:eng', value: 'Germany' },
      { name: 'urn:gd:tag:story:team:name:zho', value: '德国' },
      { name: 'urn:gd:tag:story:team:name:jpn', value: 'ドイツ' },
      { name: 'urn:gd:tag:football:stats:goals', value: 3 },
      { name: 'urn:gd:tag:football:stats:assists', value: 2 },
      { name: 'urn:gd:tag:football:stats:total_competition_minutes_played', value: 69 }
    ]
  };
}

function disciplineActor() {
  return {
    key: { _externalSportsPersonId: '999001', _externalTeamId: '285023_43900' },
    name: { eng: 'Foul Master' },
    tags: [
      { name: 'urn:gd:tag:story:staff:image', value: 'https://digitalhub.fifa.com/transform/FOULER_999001' },
      { name: 'urn:gd:tag:story:staff:position', value: 'MF' },
      { name: 'urn:gd:tag:story:team:abbreviation', value: 'ITA' },
      { name: 'urn:gd:tag:story:team:name:eng', value: 'Italy' },
      { name: 'urn:gd:tag:story:team:name:zho', value: '意大利' },
      { name: 'urn:gd:tag:football:stats:fouls_for', value: 7 },
      { name: 'urn:gd:tag:football:stats:fouls_against', value: 2 },
      { name: 'urn:gd:tag:football:stats:yellow_cards', value: 2 },
      { name: 'urn:gd:tag:football:stats:red_cards', value: 0 },
      { name: 'urn:gd:tag:football:stats:indirect_red_cards', value: 0 },
      { name: 'urn:gd:tag:football:stats:offsides', value: 0 }
    ]
  };
}

test('extractProfileFromActor: pulls player_id, name, country, position, photo from tags', () => {
  const p = extractProfileFromActor(topScorerActor());
  assert.equal(p.player_id, '484851');
  assert.equal(p.team_id, '43948');
  assert.equal(p.country_code, 'GER');
  assert.equal(p.country_zh, '德国');
  assert.equal(p.position_label, 'FW');
  assert.equal(p.photo_url, 'https://digitalhub.fifa.com/transform/UNDAV-Deniz_484851');
  assert.equal(p.name_eng, 'Deniz Undav');
  // 12-language name map preserved
  assert.equal(p.name_multilang.eng, 'Deniz Undav');
  assert.equal(p.name_multilang.zho, '德尼兹·乌恩达夫');
  // fdh_match_ids extracted from match_squad:match_id tag
  assert.deepEqual(p.fdh_match_ids, ['151631', '151634']);
});

test('extractProfileFromActor: handles missing photo / position gracefully', () => {
  const a = {
    key: { _externalSportsPersonId: '1', _externalTeamId: '285023_99' },
    name: { eng: 'X' },
    tags: [
      { name: 'urn:gd:tag:story:team:abbreviation', value: 'ABC' }
    ]
  };
  const p = extractProfileFromActor(a);
  assert.equal(p.player_id, '1');
  assert.equal(p.country_code, 'ABC');
  assert.equal(p.photo_url, null);
  assert.equal(p.position_label, null);
  assert.equal(p.country_zh, null);
});

test('extractProfileFromActor: missing _externalTeamId yields team_id null', () => {
  const p = extractProfileFromActor({
    key: { _externalSportsPersonId: '1' },
    name: {}, tags: []
  });
  assert.equal(p.team_id, null);
});

test('parseStatValue: reads numeric value from urn:gd:tag:football:stats:{name}', () => {
  const a = topScorerActor();
  assert.equal(parseStatValue(a, 'goals'), 3);
  assert.equal(parseStatValue(a, 'assists'), 2);
  assert.equal(parseStatValue(a, 'total_competition_minutes_played'), 69);
});

test('parseStatValue: returns 0 when tag absent', () => {
  const a = topScorerActor();
  assert.equal(parseStatValue(a, 'nonexistent_stat'), 0);
});

test('parseStatValue: handles non-numeric values (e.g. "1.43x")', () => {
  const a = {
    tags: [
      { name: 'urn:gd:tag:football:stats:xg_goal_effiency_rate', value: '1.43x' },
      { name: 'urn:gd:tag:football:stats:xg', value: 2.1 }
    ]
  };
  // "1.43x" → parseFloat 1.43
  assert.equal(parseStatValue(a, 'xg_goal_effiency_rate'), 1.43);
  // numeric stays numeric
  assert.equal(parseStatValue(a, 'xg'), 2.1);
});

test('STAT_TAG_PREFIX is what mango actually uses', () => {
  assert.equal(STAT_TAG_PREFIX, 'urn:gd:tag:football:stats:');
});

test('CLASSIFICATION_STAT_KEYS lists which stats live in each classification', () => {
  // Verified from Chunk 4.1 probe — each classification's actor.tags carry these
  assert.ok(CLASSIFICATION_STAT_KEYS.gcp_top_scorer.includes('goals'));
  assert.ok(CLASSIFICATION_STAT_KEYS.gcp_top_scorer.includes('assists'));
  assert.ok(CLASSIFICATION_STAT_KEYS.gcp_attack.includes('attempt_at_goal'));
  assert.ok(CLASSIFICATION_STAT_KEYS.gcp_attack.includes('attempt_at_goal_on_target'));
  assert.ok(CLASSIFICATION_STAT_KEYS.gcp_attack.includes('xg'));
  assert.ok(CLASSIFICATION_STAT_KEYS.gcp_discipline.includes('yellow_cards'));
  assert.ok(CLASSIFICATION_STAT_KEYS.gcp_discipline.includes('fouls_for'));
});

test('CLASSIFICATION_RANK_BY tells the cron which stat to rank by per classification', () => {
  // Only need ONE stat per classification since actor.tags contains all stats
  assert.equal(CLASSIFICATION_RANK_BY.gcp_top_scorer, 'goals');
  assert.equal(CLASSIFICATION_RANK_BY.gcp_attack, 'xg');
  assert.equal(CLASSIFICATION_RANK_BY.gcp_discipline, 'yellow_cards');
});

test('discipline actor: full extract round-trips correctly', () => {
  const a = disciplineActor();
  const p = extractProfileFromActor(a);
  assert.equal(p.player_id, '999001');
  assert.equal(p.country_code, 'ITA');
  assert.equal(p.country_zh, '意大利');
  assert.equal(p.position_label, 'MF');
  assert.equal(parseStatValue(a, 'fouls_for'), 7);
  assert.equal(parseStatValue(a, 'yellow_cards'), 2);
});
