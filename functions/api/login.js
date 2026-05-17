import { json, error, options } from '../lib/response.js';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { username, password } = body;

    if (!username || !password) {
      return error('请输入用户名和密码', 400);
    }

    const users = JSON.parse(context.env.USERS || '{}');
    const user = users[username];

    if (!user || user.password !== password) {
      return error('用户名或密码错误', 401);
    }

    const secret = context.env.AUTH_SECRET || 'worldcup2026';
    const payload = { username, role: user.role || 'member', exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
    const token = btoa(JSON.stringify(payload)) + '.' + await sign(JSON.stringify(payload), secret);

    return json({ success: true, token, user: { username, role: user.role || 'member' } });
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}

async function sign(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
