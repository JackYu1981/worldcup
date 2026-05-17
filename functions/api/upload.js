import { verifyToken } from '../lib/auth.js';
import { json, error, options } from '../lib/response.js';

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) {
      return error('未登录或登录已过期', 401);
    }

    const body = await context.request.json();
    const { filename, content } = body;

    if (!content || !filename) {
      return error('缺少文件名或内容', 400);
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `uploads/${safeName}`;

    const repo = context.env.GITHUB_REPO || 'JackYu1981/worldcup';
    const ghResp = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${context.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmoney-pages',
        },
        body: JSON.stringify({
          message: `upload: ${safeName} by ${user.username}`,
          content,
        }),
      }
    );

    if (!ghResp.ok) {
      const err = await ghResp.text();
      return error(`GitHub写入失败: ${err}`);
    }

    const result = await ghResp.json();
    return json({
      success: true,
      path,
      url: result.content.download_url,
    });
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
