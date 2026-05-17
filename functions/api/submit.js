import { verifyToken } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { json, error, options } from '../lib/response.js';

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) {
      return error('未登录或登录已过期', 401);
    }

    const body = await context.request.json();
    const { date, passphrase, source } = body;

    if (!date) {
      return error('缺少日期字段', 400);
    }

    body.submitted_by = user.username;
    body.submitted_at = new Date().toISOString();

    let filename, commitMsg;
    if (source === 'recommendation') {
      const ts = Date.now();
      filename = `picks/${date}-rec-${user.username}-${ts}.json`;
      commitMsg = `recommendation: ${date} by ${user.username}`;
    } else {
      if (!passphrase) {
        return error('方案需要口令', 400);
      }
      filename = `picks/${date}-${passphrase}.json`;
      commitMsg = `pick: ${date} ${passphrase} by ${user.username}`;
    }

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(body, null, 2))));

    const ghResp = await fetch(
      `https://api.github.com/repos/JackYu1981/worldcup/contents/${encodeURIComponent(filename)}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${context.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmoney-pages',
        },
        body: JSON.stringify({ message: commitMsg, content }),
      }
    );

    if (!ghResp.ok) {
      const err = await ghResp.text();
      return error(`GitHub写入失败: ${err}`);
    }

    // Immediately update KV cache (source of truth)
    const kv = context.env.MATCH_DATA;
    await updateKvPicks(kv, date, body);

    if (source === 'pending_plan') {
      await logger(kv, '方案', `预备方案提交: "${passphrase}" (${date}) by ${user.username}`);
    } else if (source === 'recommendation') {
      const legsCount = (body.legs || []).length;
      await logger(kv, '推荐', `推荐提交: ${legsCount}场组合 (${date}) by ${user.username}`);
    }

    return json({ success: true, file: filename });
  } catch (e) {
    return error(e.message);
  }
}

async function updateKvPicks(kv, date, newPick) {
  if (!kv) return;
  try {
    const key = `picks:${date}`;
    const existing = await kv.get(key, 'json');
    const picks = existing ? existing.picks : [];
    picks.push(newPick);
    await kv.put(key, JSON.stringify({ picks }), { expirationTtl: 86400 * 30 });
  } catch (e) {}
}

export function onRequestOptions() {
  return options();
}
