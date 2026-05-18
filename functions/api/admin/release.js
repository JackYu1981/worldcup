import { verifyToken } from '../../lib/auth.js';
import { json, error, options } from '../../lib/response.js';
import { logger } from '../../lib/logger.js';

const KV_CURRENT_VERSION = 'cr:current_version';

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user || user.role !== 'admin') return error('无权限', 401);

    const body = await context.request.json();
    const { version, date, summary } = body || {};
    if (!version || !date || !summary) return error('缺少 version/date/summary', 400);

    const kv = context.env.MATCH_DATA;
    await kv.put(KV_CURRENT_VERSION, JSON.stringify({ version, date, summary }));
    await logger(kv, '发版', `${user.username} 更新当前版本为 ${version}`);
    return json({ success: true });
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
