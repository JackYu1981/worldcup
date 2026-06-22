// SLA log writer — appends entries to fifa_sla_logs:{YYYY-MM-DD}:{HH} (hourly shard).
// Caps info items at 300 per shard; warn/error always preserved.
// TTL: 7 days per shard.

import { beijingDateStr, beijingHour } from './time-utils.js';

const INFO_CAP = 300;
const TTL_SECONDS = 86400 * 7;

/**
 * Append one entry to the current hour's SLA log shard.
 * entry = { level: 'info'|'warn'|'error', fixture?, event?, ... }
 * (`ts` is added automatically with the current ISO timestamp.)
 */
export async function logSla(env, entry) {
  const now = Date.now();
  const dateStr = beijingDateStr(now);
  const hour = String(beijingHour(now)).padStart(2, '0');
  const key = `fifa_sla_logs:${dateStr}:${hour}`;

  const existing = await env.MATCH_DATA.get(key, 'json') || {
    date: dateStr,
    hour: parseInt(hour, 10),
    items: []
  };

  // toISOString returns Z-form; convert to +00:00 per project timestamp rules.
  const ts = new Date(now).toISOString().replace(/Z$/, '+00:00');
  existing.items.push({ ts, ...entry });

  // Cap info items at INFO_CAP (most recent N); always keep all warn/error.
  // Sort by parsed timestamp so mixed-offset ts strings (+00:00 vs +08:00) order correctly.
  const warnsErrors = existing.items.filter(i => i.level !== 'info');
  const infos = existing.items.filter(i => i.level === 'info').slice(-INFO_CAP);
  existing.items = [...warnsErrors, ...infos].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  await env.MATCH_DATA.put(key, JSON.stringify(existing), { expirationTtl: TTL_SECONDS });
}
