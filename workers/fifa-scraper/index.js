// Entry: dispatch cron triggers to the right handler.
// All real logic lives in lib/*; this file stays thin so it's easy to read.
//
// Active cron: */10 * * * *  →  mainCron (lineup poller for fixtures in
// [KO-90min, KO_end+15min] window; lazy-loads fifa_calendar mapping on demand).
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
