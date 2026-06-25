// gameDay token: 24h JWT from cxm-api.fifa.com, required by mangodev API.
// Cached in KV under key 'gameday_token'; refreshes when expiry < 10min away.
//
// VERIFIED 2026-06-22 (real probe output):
//   { "token": "eyJ...", "issuedAt": "2026-06-22T04:00:01+00:00",
//     "expiresAt": "2026-06-23T04:00:01+00:00" }
// We store the response verbatim plus a derived `_cachedAt` for defence-in-depth
// — if `expiresAt` is ever missing from a future FIFA response, the cache
// treats the entry as 23h-old after `_cachedAt` to force a re-fetch.

const TOKEN_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;   // refresh if less than 10min left
const ASSUMED_TTL_MS = 23 * 60 * 60 * 1000; // 23h fallback if expiresAt missing

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.fifa.com',
  'Referer': 'https://www.fifa.com/',
  'Accept': 'application/json',
};

export async function ensureGamedayToken(env) {
  const cached = await env.MATCH_DATA.get('gameday_token', 'json');
  if (cached?.token) {
    // Prefer FIFA's reported expiresAt; fall back to _cachedAt + ASSUMED_TTL_MS.
    const expiry = cached.expiresAt
      ? Date.parse(cached.expiresAt)
      : (cached._cachedAt ? Date.parse(cached._cachedAt) + ASSUMED_TTL_MS : 0);
    if (!Number.isNaN(expiry) && expiry - Date.now() > REFRESH_BUFFER_MS) {
      return cached.token;
    }
  }
  // Refresh
  const r = await fetch(TOKEN_URL, { headers: BROWSER_HEADERS });
  if (!r.ok) throw new Error(`gameDay token fetch failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.token) throw new Error(`gameDay token response missing token: ${JSON.stringify(j).slice(0, 200)}`);
  // Augment with our own timestamp for the fallback path
  const augmented = { ...j, _cachedAt: new Date().toISOString().replace(/Z$/, '+00:00') };
  await env.MATCH_DATA.put('gameday_token', JSON.stringify(augmented), { expirationTtl: 86400 - 3600 });
  return j.token;
}

/** Standard headers for any FIFA endpoint call (mimics browser to avoid WAF blocks). */
export function fifaBrowserHeaders(extra = {}) {
  return { ...BROWSER_HEADERS, ...extra };
}
