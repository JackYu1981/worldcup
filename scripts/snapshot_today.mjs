import { Adapter500 } from '/Users/I064337/ai/worldcup/lib/adapters/500.js';
import { createEnvelope } from '/Users/I064337/ai/worldcup/lib/schema.js';
import iconv from 'iconv-lite';

const adapter = new Adapter500();
const today = '2026-05-18';

async function fetchHtml(url, encoding) {
  const resp = await fetch(url, { headers: adapter.fetchHeaders });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return iconv.decode(buf, encoding || adapter.encoding);
}

const url = adapter.buildMatchesUrl({ date: today });
console.log('URL:', url);
const html = await fetchHtml(url);
console.log('HTML length:', html.length);

const allMatches = adapter.parseMatches(html);
console.log('Parsed:', allMatches.length);

const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
const dayIndex = new Date(today + 'T00:00:00+08:00').getDay();
const prefix = WEEKDAYS[dayIndex];
console.log('Prefix:', prefix);

const matches = allMatches.filter(m => m.code && m.code.startsWith(prefix));
console.log('Filtered:', matches.length);
matches.forEach(m => console.log(' -', m.code, m.home, 'vs', m.away, '@', m.kickoff));

const envelope = createEnvelope(today, adapter.name, matches);
console.log(JSON.stringify(envelope).length, 'bytes');

import fs from 'fs';
fs.writeFileSync('/tmp/today-matches.json', JSON.stringify(envelope));
console.log('Saved to /tmp/today-matches.json');
