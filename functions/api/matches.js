import { json, error, options } from '../lib/response.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date');

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return error('请提供date参数 (YYYY-MM-DD)', 400);
  }

  try {
    const data = await context.env.MATCH_DATA.get(`matches:${date}`, 'json');
    if (!data) {
      return error('该日期暂无数据', 404);
    }
    return json(data, 200, 300);
  } catch (e) {
    return error(e.message);
  }
}

export function onRequestOptions() {
  return options();
}
