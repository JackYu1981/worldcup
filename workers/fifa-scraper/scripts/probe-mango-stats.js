#!/usr/bin/env node
// Probe mangodev classifications + stat enum. Run from project root or anywhere.
// Saves dumps to /tmp/mango_probe/ for downstream Chunk 4 implementation.

import fs from 'node:fs';
import path from 'node:path';

const TOKEN_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token';
const MANGO = 'https://gameday-prod.fifa.mangodev.co.uk/1-0/stories';
const SEASON_ID = '285023';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.fifa.com',
  'Referer': 'https://www.fifa.com/',
  'Accept': 'application/json'
};

const OUTDIR = '/tmp/mango_probe';
fs.mkdirSync(OUTDIR, { recursive: true });

async function getToken() {
  const r = await fetch(TOKEN_URL, { headers: HEADERS });
  if (!r.ok) throw new Error(`token HTTP ${r.status}`);
  const j = await r.json();
  return j.token;
}

async function fetchStory(token, classification, stat, page = 1) {
  const query = `(and resourceStatus==\`urn:gd:resourceStatus:active\` _externalId~\`urn:gd:story:classification:${classification}:competitionId:${SEASON_ID}:${stat}:rank_asc:page:${page}$\`)`;
  const url = `${MANGO}?query=${encodeURIComponent(query)}&skip=0&limit=1&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc`;
  const r = await fetch(url, { headers: { ...HEADERS, 'Authorization': `Bearer ${token}` } });
  if (r.status === 429) {
    await new Promise(rr => setTimeout(rr, 3000));
    return fetchStory(token, classification, stat, page);
  }
  if (!r.ok) return { err: `HTTP ${r.status}` };
  return r.json();
}

const CANDIDATES = {
  'gcp_top_scorer': ['goals', 'assists', 'minutes_played', 'total_competition_minutes_played'],
  'gcp_attack': [
    'goals', 'assists', 'attempts_on_target', 'attempts_at_goal',
    'headed_attempts_at_goal', 'penalties_scored', 'xg'
  ],
  'gcp_discipline': [
    'fouls_for', 'fouls_against', 'yellow_cards', 'red_cards',
    'offsides', 'direct_red_cards', 'indirect_red_cards'
  ],
  'gcp_defending': ['tackles_won', 'interceptions', 'clearances'],
  'gcp_distribution': ['passes', 'passing_accuracy', 'crosses'],
};

async function main() {
  console.log('Fetching gameDay token...');
  const token = await getToken();
  console.log('Token OK\n');

  const findings = {};
  for (const [cls, stats] of Object.entries(CANDIDATES)) {
    findings[cls] = {};
    for (const stat of stats) {
      const r = await fetchStory(token, cls, stat);
      if (r.err) {
        findings[cls][stat] = `ERR: ${r.err}`;
        console.log(`  ❌ ${cls}/${stat}: ${r.err}`);
        continue;
      }
      const items = r.items || [];
      const has = items.length > 0;
      const actorCount = has ? (items[0].actors || []).length : 0;
      const pageCountTag = has ? (items[0].tags || []).find(t => t.name === 'urn:gd:tag:story:page_count') : null;
      const pageCount = pageCountTag?.value ?? null;
      findings[cls][stat] = { found: has, actors: actorCount, pages: pageCount };
      console.log(`  ${has ? '✅' : '⚠️ '} ${cls}/${stat}: actors=${actorCount} pages=${pageCount}`);

      // Dump first actor for downstream parsing reference
      if (has && actorCount > 0) {
        const dumpPath = path.join(OUTDIR, `${cls}__${stat}.json`);
        const actor = items[0].actors[0];
        fs.writeFileSync(dumpPath, JSON.stringify(actor, null, 2));
      }
      // Polite delay between requests
      await new Promise(rr => setTimeout(rr, 500));
    }
  }

  fs.writeFileSync(path.join(OUTDIR, '_findings.json'), JSON.stringify(findings, null, 2));
  console.log(`\nDone. Findings saved to ${OUTDIR}/_findings.json`);

  // Print stat tag enum from one dump (use top scorer first actor)
  const sampleFile = path.join(OUTDIR, 'gcp_top_scorer__goals.json');
  if (fs.existsSync(sampleFile)) {
    const actor = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
    const statTags = (actor.tags || []).filter(t => /football:stats:/.test(t.name));
    console.log(`\nStat tags found in sample actor (${statTags.length}):`);
    for (const t of statTags) console.log(`  ${t.name} = ${t.value}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
