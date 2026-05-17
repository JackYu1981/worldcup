import { json, error, options } from '../lib/response.js';
import { logger } from '../lib/logger.js';
import { verifyToken } from '../lib/auth.js';

export async function onRequestGet(context) {
  const user = await verifyToken(context.request, context.env);
  if (!user) {
    return error('未登录或登录已过期', 401);
  }

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
    const user = await verifyToken(context.request, context.env);
    if (!user) {
      return error('未登录或登录已过期', 401);
    }

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
