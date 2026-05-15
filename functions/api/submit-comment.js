import { verifyToken } from '../lib/auth.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequestPost(context) {
  try {
    const user = await verifyToken(context.request, context.env);
    if (!user) {
      return new Response(JSON.stringify({ error: '未登录或登录已过期' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await context.request.json();
    const { message, content, sha } = body;

    if (!content) {
      return new Response(JSON.stringify({ error: '缺少内容' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const filename = 'data/design-comments.json';
    const ghBody = {
      message: message || `design feedback by ${user.username}`,
      content: content,
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
      return new Response(JSON.stringify({ error: 'GitHub写入失败', detail: err }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}
