import { json, error, options } from '../lib/response.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const period = url.searchParams.get('period');

  if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    return error('请提供period参数 (YYYY-MM-DD)', 400);
  }

  try {
    const data = await context.env.MATCH_DATA.get(`matches:${period}`, 'json');
    if (!data) {
      return json({ version: null }, 404);
    }
    const version = data.fetched_at || '';
    return json({ version }, 200, 0);
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
