export async function verifyToken(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }

  const token = auth.slice(7);
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  try {
    const payloadStr = atob(parts[0]);
    const payload = JSON.parse(payloadStr);

    if (payload.exp && payload.exp < Date.now()) return null;

    const secret = env.AUTH_SECRET || 'worldcup2026';
    const expectedSig = await sign(payloadStr, secret);

    if (parts[1] !== expectedSig) return null;

    return payload;
  } catch (e) {
    return null;
  }
}

async function sign(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
