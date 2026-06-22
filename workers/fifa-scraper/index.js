// Entry: dispatch cron triggers to the right handler.
// All real logic lives in lib/*; this file stays thin so it's easy to read.

import { calendarCron } from './lib/calendar-cron.js';
import { mainCron } from './lib/main-cron.js';
import { tournamentWideCron } from './lib/tournament-cron.js';

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    try {
      if (cron === '*/2 * * * *') {
        const r = await mainCron(env);
        console.log(`[fifa-scraper] main cron tick: done`, r);
      } else if (cron === '0 */6 * * *' || cron === '* * * * *') {
        // '* * * * *' is a temp testing override; '0 */6 * * *' is production.
        console.log(`[fifa-scraper] calendar cron tick (${cron}): start`);
        const r = await calendarCron(env);
        console.log(`[fifa-scraper] calendar cron tick: done`, r);
      } else if (cron === '0 17,21,1,5 * * *') {
        console.log('[fifa-scraper] tournament-wide cron tick: start');
        const r = await tournamentWideCron(env);
        console.log(`[fifa-scraper] tournament-wide cron tick: done`, r);
      } else {
        console.warn(`[fifa-scraper] unknown cron: ${cron}`);
      }
    } catch (e) {
      console.error(`[fifa-scraper] cron error:`, e);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger/calendar') {
      try { return Response.json(await calendarCron(env)); }
      catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
    }
    if (url.pathname === '/trigger/main') {
      try { return Response.json(await mainCron(env)); }
      catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
    }
    if (url.pathname === '/trigger/tournament') {
      try { return Response.json(await tournamentWideCron(env)); }
      catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
    }
    return new Response('worldcup-fifa-scraper alive (cron triggers + /trigger/{calendar,main,tournament})', { status: 200 });
  },
};

