// GET /api/fifa/photo/{uuid}/{filename}
// Proxies player photos from digitalhub.fifa.com — avoids client-side WAF/CDN
// blocks (e.g., corporate networks that filter digitalhub).
//
// FIFA photo URL: https://digitalhub.fifa.com/transform/{uuid}/{filename}
// Our proxy URL:  /api/fifa/photo/{uuid}/{filename}

export async function onRequestGet(context) {
  const { params, request } = context;
  const uuid = params.uuid;
  const filename = params.filename;
  if (!uuid || !filename) {
    return new Response('missing uuid or filename', { status: 400 });
  }

  // Forward any FIFA transform params (e.g. ?io=transform:crop,height:850)
  const url = new URL(request.url);
  const fifaUrl = `https://digitalhub.fifa.com/transform/${uuid}/${filename}${url.search || ''}`;

  try {
    const r = await fetch(fifaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; worldmoney-proxy)',
        'Accept': 'image/avif,image/webp,image/png,image/*'
      },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!r.ok) {
      return new Response('upstream error', { status: r.status });
    }
    // Stream the image bytes back with CDN-friendly cache headers
    return new Response(r.body, {
      status: 200,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=86400, immutable',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response(`proxy error: ${e.message}`, { status: 502 });
  }
}
