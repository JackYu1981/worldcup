import { verifyToken } from '../lib/auth.js';
import { json, error, options } from '../lib/response.js';

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) {
      return error('未登录或登录已过期', 401);
    }

    const body = await context.request.json();
    const { message, content, sha, filename: customFile } = body;

    if (!content) {
      return error('缺少内容', 400);
    }

    const allowedFiles = ['data/design-comments.json', 'data/change-requests.json'];
    const filename = allowedFiles.includes(customFile) ? customFile : 'data/design-comments.json';
    const ghBody = {
      message: message || `design feedback by ${user.username}`,
      content,
    };
    if (sha) ghBody.sha = sha;

    const ghResp = await fetch(
      `https://api.github.com/repos/JackYu1981/worldcup/contents/${filename}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${context.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmoney-pages',
        },
        body: JSON.stringify(ghBody),
      }
    );

    if (!ghResp.ok) {
      const err = await ghResp.text();
      return error(`GitHub写入失败: ${err}`);
    }

    return json({ success: true });
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
