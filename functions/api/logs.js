import { json, error, options } from '../lib/response.js';
import { logger } from '../lib/logger.js';

export async function onRequestGet(context) {
  const kv = context.env.MATCH_DATA;
  const url = new URL(context.request.url);
  const month = url.searchParams.get('month');

  if (month) {
    const shardData = await kv.get(`system:logs:${month}`, 'json');
    return json({ logs: shardData ? shardData.logs : [] });
  }

  const data = await kv.get('system:logs', 'json');
  return json({ logs: data ? data.logs : [] });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { type, message } = body;
    if (!type || !message) {
      return error('type and message required', 400);
    }

    const kv = context.env.MATCH_DATA;
    await logger(kv, type, message);
    return json({ ok: true });
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
