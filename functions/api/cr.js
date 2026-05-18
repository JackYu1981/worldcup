import { verifyToken } from '../lib/auth.js';
import { json, error, options } from '../lib/response.js';

const KV_CR = 'cr:requests';

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) return error('未登录或登录已过期', 401);

    const body = await context.request.json();
    const { requests } = body || {};
    if (!Array.isArray(requests)) return error('requests 必须是数组', 400);

    const kv = context.env.MATCH_DATA;
    await kv.put(KV_CR, JSON.stringify({ requests }));
    return json({ success: true, count: requests.length });
  } catch (e) {
    return error(e.message);
  }
}

export async function onRequestGet(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) return error('未登录', 401);

    const kv = context.env.MATCH_DATA;
    const data = await kv.get(KV_CR, 'json');
    return json({ requests: data ? (data.requests || []) : [] });
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
