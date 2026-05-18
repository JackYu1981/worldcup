import { json, error, options } from '../../lib/response.js';
import { verifyToken } from '../../lib/auth.js';
import { settlePendingPlans } from '../../lib/settle.js';

export async function onRequestPost(context) {
  try {
    const authed = await isAuthorized(context);
    if (!authed) return error('无权限', 401);

    const result = await settlePendingPlans(context.env.MATCH_DATA);
    return json({
      success: true,
      newly_settled: result.newlySettled.length,
      still_pending: result.stillPending.length,
    });
  } catch (e) {
    return error(e.message, 500);
  }
}

async function isAuthorized(context) {
  const scraperSecret = context.request.headers.get('X-Scraper-Secret');
  if (scraperSecret && context.env.SCRAPER_SECRET && scraperSecret === context.env.SCRAPER_SECRET) {
    return true;
  }
  const user = await verifyToken(context.request, context.env);
  return user && user.role === 'admin';
}

export function onRequestOptions() {
  return options();
}
