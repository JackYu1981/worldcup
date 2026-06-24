// Entry: dispatch cron triggers to the right handler.
//
// Single cron: */5 * * * *  — every 5 minutes:
//   1. calendarCron  → refresh fifa_calendar (hash-short-circuit, ≈1-3 writes/day)
//                       + retry unmatched fixture mappings
//   2. mainCron      → lineup poller for fixtures in FIFA-defined window
//                       (KO-90min → match_status=0 / KO+4h hard cap)
//                       + auto-triggers tournament-refresh on status 0→3 transition
//
// 5min cadence catches in-match events (goals/cards/subs) faster — was 10min;
// hash-short-circuit ensures we don't double the actual KV writes.
//
// Manual-trigger fetch routes are kept as ops backdoor:
//   GET /trigger/main      — force one main-cron pass
//   GET /trigger/calendar  — force refresh fifa_calendar in KV

import { calendarCron } from './lib/calendar-cron.js';
import { mainCron } from './lib/main-cron.js';

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    try {
      if (cron === '*/5 * * * *') {
        // calendar first — main-cron's window logic relies on up-to-date mapping
        try {
          const cal = await calendarCron(env);
          console.log(`[fifa-scraper] calendar tick:`, cal);
        } catch (e) {
          console.error(`[fifa-scraper] calendar cron error:`, e);
        }
        const r = await mainCron(env);
        console.log(`[fifa-scraper] main cron tick: done`, r);
      } else {
        console.warn(`[fifa-scraper] unknown cron: ${cron}`);
      }
    } catch (e) {
      console.error(`[fifa-scraper] cron error:`, e);
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
