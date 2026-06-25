// worldcup-asian-handicap-scraper
//
// Pulls bet365 asian handicap data from 500.com for upcoming WC fixtures.
// Single-page fetch: https://odds.500.com/?id={any_fid} returns one HTML doc
// whose embedded `var yapanList` JSON contains ALL today's fixtures' odds,
// keyed by fid. So one HTTP call covers every fixture.
//
// PoC verified bet365 cid = "3" (see scripts/asian-handicap-poc.js).
//
// KV schema:
//   asian_handicap:{f1359xxx} = {
//     current: { line, home_water, away_water },     // current (即时) bet365 row
//     open:    { line, home_water, away_water },     // opening (初盘) bet365 row
//     trend:   'rising' | 'falling' | 'stable',     // line[1] vs line[0]
//     fetched_at: '2026-06-25T19:30:00+00:00',
//     last_attempted_at: '...',                      // for cooldown
//     _hash: 'abc',                                  // current value hash for short-circuit
//   }
//
// Dynamic frequency (per-fixture cooldown, ticks run every 5min):
//   >2h before kickoff: 30min between fetches
//   ≤2h before kickoff: 10min between fetches
//   past kickoff:       skip entirely

const KO_LATE_WINDOW_MS = 2 * 60 * 60_000;       // 2h before kickoff
const REFRESH_LATE_MS   = 10 * 60_000;            // 10min cadence in late window
const REFRESH_EARLY_MS  = 30 * 60_000;            // 30min cadence pre-2h
const ODDS_URL_BASE     = 'https://odds.500.com/?id=';

// FNV-1a 32-bit for hash short-circuit (matches lineup.js / match-stats.js style).
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export default {
  async scheduled(event, env, ctx) {
    try {
      const r = await runScrape(env);
      console.log('[ah-scraper] tick:', r);
    } catch (e) {
      console.error('[ah-scraper] cron error:', e?.message, e?.stack);
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      try { return Response.json(await runScrape(env)); }
      catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
    }
    return new Response('worldcup-asian-handicap-scraper alive (use /trigger)', { status: 200 });
  },
};

async function runScrape(env) {
  const now = Date.now();
  const wcFixtures = await findWcFixturesInWindow(env, now);
  if (wcFixtures.length === 0) {
    return { in_window: 0, fetched: false };
  }

  // Decide which fixtures need an actual fetch this tick (apply per-fixture cooldown)
  const dueFixtures = [];
  const existingByFid = new Map();
  for (const fix of wcFixtures) {
    const existing = await env.MATCH_DATA.get(`asian_handicap:${fix.id}`, 'json');
    if (existing) existingByFid.set(fix.id, existing);
    const lastAttemptMs = Date.parse(existing?.last_attempted_at || '');
    const koMs = fix._ko_ms;
    const msToKickoff = koMs - now;
    const cooldown = msToKickoff <= KO_LATE_WINDOW_MS ? REFRESH_LATE_MS : REFRESH_EARLY_MS;
    if (!Number.isFinite(lastAttemptMs) || now - lastAttemptMs >= cooldown) {
      dueFixtures.push(fix);
    }
  }
  if (dueFixtures.length === 0) {
    return { in_window: wcFixtures.length, fetched: false, reason: 'cooldown' };
  }

  // Single fetch covers ALL fixtures on the page — pick any fid for the URL
  const probeFid = dueFixtures[0].id.replace(/^f/, '');
  const yapanList = await fetchYapanList(probeFid);
  if (!yapanList) {
    // Mark attempt even on failure so we don't hammer
    await markAttempts(env, dueFixtures, new Date().toISOString().replace(/Z$/, '+00:00'));
    return { in_window: wcFixtures.length, fetched: true, error: 'parse_failed' };
  }

  // For each due fixture, lookup yapanList[fid_no_prefix]['3'] = bet365 rows
  let writes = 0, skipped = 0, missing = 0;
  const nowIso = new Date().toISOString().replace(/Z$/, '+00:00');
  for (const fix of dueFixtures) {
    const fidNumeric = fix.id.replace(/^f/, '');
    const bet365Rows = yapanList[fidNumeric]?.['3'];
    if (!bet365Rows || bet365Rows.length < 2) {
      // Fixture not in this page's yapanList (different sales period / not yet odds)
      // Still mark attempt
      await env.MATCH_DATA.put(`asian_handicap:${fix.id}`, JSON.stringify({
        ...(existingByFid.get(fix.id) || {}),
        last_attempted_at: nowIso,
        last_attempt_status: 'no_data',
      }));
      missing++;
      continue;
    }
    const [openWaterHome, openLine, openWaterAway] = bet365Rows[0];
    const [curWaterHome, curLine, curWaterAway] = bet365Rows[1];
    const open = {
      home_water: parseFloat(openWaterHome),
      line:       parseFloat(openLine),
      away_water: parseFloat(openWaterAway),
    };
    const current = {
      home_water: parseFloat(curWaterHome),
      line:       parseFloat(curLine),
      away_water: parseFloat(curWaterAway),
    };
    // Trend: line moving toward 0 (e.g. -1.0 → -0.5) = 降盘 (falling).
    //        line moving away from 0 (e.g. -0.5 → -1.0) = 升盘 (rising).
    let trend = 'stable';
    if (Math.abs(current.line) > Math.abs(open.line) + 0.001) trend = 'rising';
    else if (Math.abs(current.line) < Math.abs(open.line) - 0.001) trend = 'falling';

    // Hash short-circuit: skip KV write if current snapshot unchanged
    const sig = `${current.line}|${current.home_water}|${current.away_water}|${trend}`;
    const newHash = fnv1a(sig);
    const existing = existingByFid.get(fix.id);
    if (existing?._hash === newHash) {
      // Still update last_attempted_at, but skip the full payload write — single small write
      await env.MATCH_DATA.put(`asian_handicap:${fix.id}`, JSON.stringify({
        ...existing,
        last_attempted_at: nowIso,
      }));
      skipped++;
      continue;
    }

    const record = {
      current,
      open,
      trend,
      fetched_at: nowIso,
      last_attempted_at: nowIso,
      bookmaker: 'bet365',
      _hash: newHash,
    };
    await env.MATCH_DATA.put(`asian_handicap:${fix.id}`, JSON.stringify(record));
    writes++;
  }
  return {
    in_window: wcFixtures.length,
    due: dueFixtures.length,
    writes,
    skipped,
    missing,
  };
}

/**
 * Fetch the 500.com odds page and extract yapanList JSON. Returns the parsed
 * object (fid_numeric → cid → [[open_home, open_line, open_away], [cur_home, cur_line, cur_away]])
 * or null on any parsing failure.
 *
 * GB2312 → UTF-8 conversion done via a TextDecoder in 'gbk' mode (CF Workers
 * supports common encodings via WHATWG TextDecoder).
 */
async function fetchYapanList(probeFidNumeric) {
  const url = ODDS_URL_BASE + probeFidNumeric;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  if (!r.ok) {
    console.warn('[ah-scraper] fetch failed:', r.status, url);
    return null;
  }
  const buf = await r.arrayBuffer();
  let html;
  try {
    // 500.com claims GB2312 but uses GBK (superset). TextDecoder supports 'gbk'.
    html = new TextDecoder('gbk').decode(buf);
  } catch (e) {
    console.warn('[ah-scraper] gbk decode failed; falling back to utf-8:', e?.message);
    html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  // Match `var yapanList = {...};` — minimal-ish regex with a json balance
  const m = html.match(/var\s+yapanList\s*=\s*(\{[\s\S]+?\})\s*;/);
  if (!m) {
    console.warn('[ah-scraper] yapanList regex no-match');
    return null;
  }
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    console.warn('[ah-scraper] yapanList JSON parse error:', e?.message);
    return null;
  }
}

async function findWcFixturesInWindow(env, now) {
  // Look at today's + tomorrow's matches buckets; we care about fixtures that
  // haven't kicked off yet. Past-kickoff WC fixtures are skipped (handicap stale).
  const buckets = await Promise.all([
    env.MATCH_DATA.get(`matches:${beijingDateStr(now)}`, 'json'),
    env.MATCH_DATA.get(`matches:${beijingDateStr(now + 86400_000)}`, 'json'),
    env.MATCH_DATA.get(`matches:${beijingDateStr(now + 2 * 86400_000)}`, 'json'),
  ]);
  const seen = new Set();
  const out = [];
  for (const bucket of buckets) {
    if (!bucket?.matches) continue;
    for (const m of bucket.matches) {
      if (!m.id || seen.has(m.id)) continue;
      if (m.league !== '世界杯') continue;
      seen.add(m.id);
      let ko;
      try { ko = parseKickoffBeijing(m).getTime(); } catch { continue; }
      if (ko <= now) continue;   // past kickoff — skip
      // Only scrape fixtures within next 48h (avoid scraping deep-future where bookmakers haven't priced)
      if (ko - now > 48 * 60 * 60_000) continue;
      m._ko_ms = ko;
      out.push(m);
    }
  }
  return out;
}

async function markAttempts(env, fixtures, isoNow) {
  for (const f of fixtures) {
    const ex = await env.MATCH_DATA.get(`asian_handicap:${f.id}`, 'json') || {};
    await env.MATCH_DATA.put(`asian_handicap:${f.id}`, JSON.stringify({
      ...ex,
      last_attempted_at: isoNow,
      last_attempt_status: 'failed',
    }));
  }
}

// === Time utils (inlined copy from workers/fifa-scraper/lib/time-utils.js,
//     to keep this worker self-contained) ===

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

function parseKickoffBeijing(fixture) {
  if (!fixture?.kickoff) throw new Error('no kickoff');
  const ko = fixture.kickoff.trim();
  let Y, M, D, h, m;
  const fullMatch = ko.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (fullMatch) {
    [, Y, M, D, h, m] = fullMatch;
  } else {
    if (!fixture.date) throw new Error('no date+kickoff');
    const ymd = fixture.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const hm = ko.match(/^(\d{2}):(\d{2})$/);
    if (!ymd || !hm) throw new Error('bad ko format');
    [, Y, M, D] = ymd; [, h, m] = hm;
  }
  const utcMs = Date.UTC(+Y, +M - 1, +D, +h, +m, 0) - BEIJING_OFFSET_MS;
  return new Date(utcMs);
}

function beijingDateStr(epochMs) {
  const d = new Date(epochMs + BEIJING_OFFSET_MS);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}
