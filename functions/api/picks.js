const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const date = url.searchParams.get('date');

    const ghResp = await fetch(
      'https://api.github.com/repos/JackYu1981/worldcup/contents/picks',
      {
        headers: {
          'Authorization': `token ${context.env.GITHUB_TOKEN}`,
          'User-Agent': 'worldmoney-pages',
        },
      }
    );

    if (!ghResp.ok) {
      return new Response(JSON.stringify({ picks: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let files = await ghResp.json();
    if (date) {
      files = files.filter(f => f.name.startsWith(date));
    }
    files = files.filter(f => f.name.endsWith('.json'));

    const picks = await Promise.all(files.map(async f => {
      const r = await fetch(f.download_url);
      return r.json();
    }));

    return new Response(JSON.stringify({ picks }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ picks: [], error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}
