// Entry: dispatch cron triggers to the right handler.
//
// Single cron: */10 * * * *  — every 10 minutes:
//   1. calendarCron  → refresh fifa_calendar (hash-short-circuit, ≈1-3 writes/day)
//                       + retry unmatched fixture mappings
//   2. mainCron      → lineup poller for fixtures in [KO-90min, KO_end+15min]
//                       + auto-triggers tournament-refresh on status 0→3 transition
//
// Calendar fetch is cheap (~1 HTTP call) and writes are short-circuited, so doing
// it on every tick replaces the old daily cron without bloating KV writes.
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
      if (cron === '*/10 * * * *') {
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
