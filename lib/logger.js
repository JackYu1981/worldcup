export async function logger(kv, type, message) {
  if (!kv) return;
  try {
    const now = new Date().toISOString();
    const entry = { type, message, time: now };
    const month = now.slice(0, 7); // "2026-05"

    // Write to recent (hot cache, last 500)
    const recentData = await kv.get('system:logs', 'json');
    const recent = recentData ? recentData.logs : [];
    recent.unshift(entry);
    if (recent.length > 500) recent.length = 500;
    await kv.put('system:logs', JSON.stringify({ logs: recent }));

    // Write to monthly shard (archive)
    const shardKey = `system:logs:${month}`;
    const shardData = await kv.get(shardKey, 'json');
    const shard = shardData ? shardData.logs : [];
    shard.unshift(entry);
    await kv.put(shardKey, JSON.stringify({ logs: shard }), { expirationTtl: 86400 * 180 });
  } catch (e) {}
}
