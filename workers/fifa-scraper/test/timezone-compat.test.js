// Quick compatibility test — verify all known kickoff readers accept BOTH
// the old bare-string format and the new ISO format.
// Run: node /tmp/test-tz-compat.js

const cases = [
  { name: 'old',  kickoff: '2026-06-26 04:00' },
  { name: 'new',  kickoff: '2026-06-26T04:00:00+08:00' },
];

// ---- 1) index.html parseKickoffMs (assumes Beijing) ----
function parseKickoffMs(kickoff) {
  if (!kickoff) return null;
  const m = kickoff.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const dt = new Date(`${m[1]}T${m[2]}:${m[3]}:00+08:00`);
  const ms = dt.getTime();
  return isNaN(ms) ? null : ms;
}

// ---- 2) worker time-utils parseKickoffBeijing ----
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
function parseKickoffBeijing(fixture) {
  const ko = fixture.kickoff.trim();
  const fullMatch = ko.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!fullMatch) throw new Error('no match');
  const [, Y, M, D, h, m] = fullMatch;
  const utcMs = Date.UTC(+Y, +M - 1, +D, +h, +m, 0) - BEIJING_OFFSET_MS;
  return new Date(utcMs);
}

// ---- 3) Sort lexicographic ----
function lexSort(items) {
  return items.slice().sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || ''));
}

// ---- run ----
const EXPECTED_UTC_MS = Date.UTC(2026, 5, 25, 20, 0, 0); // 2026-06-25T20:00Z = Beijing 06-26 04:00

let pass = true;
for (const c of cases) {
  const a = parseKickoffMs(c.kickoff);
  const b = parseKickoffBeijing({ kickoff: c.kickoff }).getTime();
  const okA = a === EXPECTED_UTC_MS;
  const okB = b === EXPECTED_UTC_MS;
  console.log(`[${c.name}] kickoff=${c.kickoff!==undefined?JSON.stringify(c.kickoff):'(undef)'}`);
  console.log(`        parseKickoffMs       = ${a}  ${okA ? '✅' : '❌'} (expected ${EXPECTED_UTC_MS})`);
  console.log(`        parseKickoffBeijing  = ${b}  ${okB ? '✅' : '❌'}`);
  if (!okA || !okB) pass = false;
}

// Sort across mixed: new value comes lexicographically AFTER old
// (because 'T' > ' ' in ASCII). So mixed-format sort would mis-order.
// But we expect post-migration ALL values are new format.
const mixed = [
  { kickoff: '2026-06-26 04:00' },
  { kickoff: '2026-06-26T04:00:00+08:00' },
];
const sorted = lexSort(mixed);
console.log(`\nmixed sort: [${sorted.map(x => JSON.stringify(x.kickoff)).join(', ')}]`);
console.log('NOTE: during the migration window (~seconds) sort may be unstable; after apply all uniform.');

// Submitted_at (.Z → +00:00): both formats parse identically
const ts_z = new Date('2026-06-10T23:28:38.567Z').getTime();
const ts_offset = new Date('2026-06-10T23:28:38.567+00:00').getTime();
console.log(`\nsubmitted_at parse: .Z=${ts_z}, +00:00=${ts_offset}, equal=${ts_z === ts_offset ? '✅' : '❌'}`);

// String compare: .Z vs +00:00
const a_z = '2026-06-10T23:28:38.567Z';
const a_offset = '2026-06-10T23:28:38.567+00:00';
console.log(`submitted_at lex compare: '${a_z}' vs '${a_offset}'`);
console.log(`  .Z < +00:00? ${a_z < a_offset} (would mis-order during migration window)`);

console.log(`\noverall: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
