// Entry: dispatch cron triggers to the right handler.
// All real logic lives in lib/*; this file stays thin so it's easy to read.

import { calendarCron } from './lib/calendar-cron.js';

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    try {
      if (cron === '*/2 * * * *') {
        console.log('[fifa-scraper] main cron tick (not yet implemented)');
      } else if (cron === '0 */6 * * *' || cron === '* * * * *') {
        // '* * * * *' is a temp testing override; '0 */6 * * *' is production.
        console.log(`[fifa-scraper] calendar cron tick (${cron}): start`);
        const r = await calendarCron(env);
        console.log(`[fifa-scraper] calendar cron tick: done`, r);
      } else if (cron === '0 17,21,1,5 * * *') {
        console.log('[fifa-scraper] tournament-wide cron tick (not yet implemented)');
      } else {
        console.warn(`[fifa-scraper] unknown cron: ${cron}`);
      }
    } catch (e) {
      console.error(`[fifa-scraper] cron error:`, e);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    // Manual trigger for ops / testing: /trigger/calendar
    if (url.pathname === '/trigger/calendar') {
      try {
        const r = await calendarCron(env);
        return Response.json(r);
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }
    return new Response('worldcup-fifa-scraper alive (use cron triggers or /trigger/calendar)', { status: 200 });
  },
};

