// Entry: dispatch cron triggers to the right handler.
// All real logic lives in lib/*; this file stays thin so it's easy to read.

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    try {
      if (cron === '*/2 * * * *') {
        console.log('[fifa-scraper] main cron tick (not yet implemented)');
      } else if (cron === '0 */6 * * *') {
        console.log('[fifa-scraper] calendar cron tick (not yet implemented)');
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
    return new Response('worldcup-fifa-scraper alive (use cron triggers)', { status: 200 });
  },
};
