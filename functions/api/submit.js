export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await context.request.json();
    const { date, passphrase, picks } = body;

    if (!date || !passphrase || !picks || picks.length === 0) {
      return new Response(JSON.stringify({ error: '缺少必填字段' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const filename = `picks/${date}-${passphrase}.json`;
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
          message: `pick: ${date} ${passphrase}`,
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
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
