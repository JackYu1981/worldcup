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

    let fileSha = sha;
    const repo = context.env.GITHUB_REPO || 'JackYu1981/worldcup';
    const apiBase = `https://api.github.com/repos/${repo}/contents/${filename}`;
    const ghHeaders = {
      'Authorization': `token ${context.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmoney-pages',
    };

    if (!fileSha) {
      try {
        const existing = await fetch(apiBase, { headers: ghHeaders });
        if (existing.ok) {
          const data = await existing.json();
          fileSha = data.sha;
        }
      } catch(e) {}
    }

    const ghBody = {
      message: message || `design feedback by ${user.username}`,
      content,
    };
    if (fileSha) ghBody.sha = fileSha;

    const ghResp = await fetch(apiBase, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(ghBody),
    });

    if (!ghResp.ok) {
      const err = await ghResp.text();
      if (ghResp.status === 409) {
        return error('数据冲突，请刷新后重试', 409);
      }
      return error(`GitHub写入失败: ${err}`);
    }

    const result = await ghResp.json();
    return json({ success: true, sha: result.content?.sha || null });
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
