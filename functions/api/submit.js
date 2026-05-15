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
    const { date, passphrase, source } = body;

    if (!date) {
      return new Response(JSON.stringify({ error: '缺少日期字段' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    body.submitted_by = user.username;

    let filename, commitMsg;
    if (source === 'recommendation') {
      const ts = Date.now();
      filename = `picks/${date}-rec-${user.username}-${ts}.json`;
      commitMsg = `recommendation: ${date} by ${user.username}`;
    } else {
      if (!passphrase) {
        return new Response(JSON.stringify({ error: '方案需要口令' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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
        body: JSON.stringify({
          message: commitMsg,
          content: content,
        }),
      }
    );

    if (!ghResp.ok) {
      const err = await ghResp.text();
      return new Response(JSON.stringify({ error: 'GitHub写入失败', detail: err }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, file: filename }), {
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
