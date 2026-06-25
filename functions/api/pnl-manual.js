// /api/pnl-manual — per-user manual daily P&L entries.
//
// KV schema:
//   pnl_manual:{username} = {
//     entries: { 'YYYY-MM-DD': number, ... }   // amount in CNY, can be negative
//     updated_at: '2026-06-25T13:54:00+08:00'
//   }
//
// GET   → returns the calling user's full entries object
// PUT   → body { date: 'YYYY-MM-DD', amount: number } upserts one day
//         body { date: 'YYYY-MM-DD', amount: null }   deletes one day
//
// Each user's record is isolated under their username — no cross-user reads.
// All other dashboard math (累计余额) is purely client-side, just sum the
// entries for visible days and add to plan-derived profit per day.

import { verifyToken } from '../lib/auth.js';
import { json, error, options } from '../lib/response.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestGet(context) {
  const user = await verifyToken(context.request, context.env);
  if (!user) return error('未登录或登录已过期', 401);

  const key = `pnl_manual:${user.username}`;
  const rec = await context.env.MATCH_DATA.get(key, 'json');
  return json(rec || { entries: {} });
}

export async function onRequestPut(context) {
  const user = await verifyToken(context.request, context.env);
  if (!user) return error('未登录或登录已过期', 401);

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return error('请求体非 JSON', 400);
  }

  const { date, amount } = body;
  if (!date || !DATE_RE.test(date)) {
    return error('date 必须为 YYYY-MM-DD', 400);
  }
  if (amount !== null && typeof amount !== 'number') {
    return error('amount 必须为数字或 null（删除）', 400);
  }
  if (typeof amount === 'number' && !Number.isFinite(amount)) {
    return error('amount 必须为有限数字', 400);
  }

  const key = `pnl_manual:${user.username}`;
  const rec = (await context.env.MATCH_DATA.get(key, 'json')) || { entries: {} };

  if (amount === null) {
    delete rec.entries[date];
  } else {
    // Round to 2 decimals to avoid float drift accumulating in totals
    rec.entries[date] = Math.round(amount * 100) / 100;
  }
  rec.updated_at = new Date().toISOString().replace(/Z$/, '+00:00');

  await context.env.MATCH_DATA.put(key, JSON.stringify(rec));
  return json({ ok: true, entries: rec.entries });
}

export function onRequestOptions() {
  return options();
}
