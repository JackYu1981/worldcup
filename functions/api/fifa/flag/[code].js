// GET /api/fifa/flag/{code}
// Proxies country flag images from api.fifa.com/api/v3/picture/flags-sq-4/{CODE}.
// Edge-cached 7 days (flags never change).
//
// {code} should be the 3-letter FIFA country code (e.g. "ESP", "KSA").

export async function onRequestGet(context) {
  const { params } = context;
  const code = (params.code || '').toUpperCase().slice(0, 3);
  if (!/^[A-Z]{3}$/.test(code)) {
    return new Response('invalid code', { status: 400 });
  }

  const fifaUrl = `https://api.fifa.com/api/v3/picture/flags-sq-4/${code}`;
  try {
    const r = await fetch(fifaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; worldmoney-proxy)',
        'Accept': 'image/png,image/*'
      },
      cf: { cacheTtl: 86400 * 7, cacheEverything: true }
    });
    if (!r.ok) {
      return new Response('upstream error', { status: r.status });
    }
    return new Response(r.body, {
      status: 200,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response(`proxy error: ${e.message}`, { status: 502 });
  }
}
