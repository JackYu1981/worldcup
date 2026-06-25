// Entry: dispatch cron triggers to the right handler.
//
// Single cron: * * * * *  — every 1 minute (Workers Paid required for sustained KV writes):
//   1. calendarCron  → refresh fifa_calendar (hash-short-circuit, ≈1-3 writes/day)
//                       + retry unmatched fixture mappings
//   2. mainCron      → lineup poller for fixtures in FIFA-defined window
//                       (KO-90min → match_status=0 / KO+4h hard cap)
//                       + auto-triggers tournament-refresh on status 0→3 transition
//
// 1min cadence catches in-match events (goals/cards/subs) near-realtime;
// hash-short-circuit ensures we don't bloat KV writes.
//
// Manual-trigger fetch routes are kept as ops backdoor:
//   GET /trigger/main      — force one main-cron pass
//   GET /trigger/calendar  — force refresh fifa_calendar in KV

import { calendarCron } from './lib/calendar-cron.js';
import { mainCron } from './lib/main-cron.js';
import { logSla } from './lib/sla.js';

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const tickStart = Date.now();
    try {
      if (cron === '* * * * *') {
        // Diagnostic: log every tick start so we can see in SLA whether worker
        // is alive when analytics shows err=1. If even this log doesn't appear,
        // the failure is before scheduled() returns (CF runtime issue).
        await logSla(env, { level: 'info', event: 'tick_start', cron });

        // Run calendar + main in PARALLEL — they don't share state until KV
        // commits land. mainCron reads fifa_calendar from KV which is updated
        // by calendarCron; one tick of staleness (≤1min) is fine since lineup
        // fetches use fixture_mapping directly (also in KV).
        const [calRes, mainRes] = await Promise.allSettled([
          calendarCron(env),
          mainCron(env),
        ]);
        if (calRes.status === 'rejected') {
          console.error(`[fifa-scraper] calendar cron error:`, calRes.reason);
          await logSla(env, { level: 'error', event: 'calendar_cron_threw',
            error: String(calRes.reason?.message || calRes.reason),
            stack: String(calRes.reason?.stack || '').slice(0, 500) });
        } else {
          console.log(`[fifa-scraper] calendar tick:`, calRes.value);
        }
        if (mainRes.status === 'rejected') {
          console.error(`[fifa-scraper] main cron error:`, mainRes.reason);
          await logSla(env, { level: 'error', event: 'main_cron_threw',
            error: String(mainRes.reason?.message || mainRes.reason),
            stack: String(mainRes.reason?.stack || '').slice(0, 500) });
        } else {
          console.log(`[fifa-scraper] main cron tick: done`, mainRes.value);
        }

        await logSla(env, { level: 'info', event: 'tick_done', duration_ms: Date.now() - tickStart });
      } else {
        console.warn(`[fifa-scraper] unknown cron: ${cron}`);
      }
    } catch (e) {
      console.error(`[fifa-scraper] outer cron error:`, e);
      try {
        const key = `fifa_sla_logs:emergency_${Date.now()}`;
        await env.MATCH_DATA.put(key, JSON.stringify({
          ts: new Date().toISOString().replace(/Z$/, '+00:00'),
          event: 'outer_cron_threw',
          error: String(e?.message || e),
          stack: String(e?.stack || '').slice(0, 500),
        }));
      } catch (_) {}
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger/main') {
      try { return Response.json(await mainCron(env)); }
      catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
    }
    if (url.pathname === '/trigger/calendar') {
      try { return Response.json(await calendarCron(env)); }
      catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
    }
    return new Response('worldcup-fifa-scraper alive (cron + /trigger/{main,calendar})', { status: 200 });
  },
};
