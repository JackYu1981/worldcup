#!/usr/bin/env python3
"""
backfill_asian_handicap.py — one-shot backfill of `asian_handicap:{fid}` KV for
finished WC fixtures by scraping 500.com's `yazhi-{fid}.shtml` page.

Why this exists:
  workers/asian-handicap-scraper only scrapes UPCOMING WC matches (filters by
  ko > now in a 48h window), so finished matches have NO AH data in KV. ML
  backtest needs round-1/2/3 historical AH to compute strong_side decisions
  on the holdout set. 500.com retains both 初盘 (open) and 即时盘 (close)
  permanently on the yazhi page, so we can fetch it post-match.

Algorithm mirror:
  - URL pattern, Crown row id="280", sign convention, ping/ying ↔ home/away
    based on line sign — all mirror workers/asian-handicap-scraper/index.js.
  - We use the SAME parsing logic so the data format is identical to live
    scrapes; downstream readers can't tell them apart except by `_source`.

Sign convention (verified 2026-06-25 via Crown yazhi cross-check):
    "受X球" prefix → home receives → line = +X (away strong)
    no "受" prefix  → home gives    → line = -X (home strong)
    "平手"         → 0
  Then map ping/ying → home_water/away_water based on line sign:
    line > 0 → home=下盘=ying, away=上盘=ping
    line ≤ 0 → home=上盘=ping, away=下盘=ying

Usage:
  python3 scripts/ml/backfill_asian_handicap.py             # dry-run
  python3 scripts/ml/backfill_asian_handicap.py --apply
  python3 scripts/ml/backfill_asian_handicap.py --apply --force
  python3 scripts/ml/backfill_asian_handicap.py --apply --limit 5
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'

YAZHI_URL = 'https://odds.500.com/fenxi/yazhi-{fid_numeric}.shtml'
CROWN_CID = '280'


def get_cf_token():
    r = subprocess.run(['security', 'find-generic-password',
                        '-s', 'cloudflare-api-token', '-w'],
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()

CF_TOK = get_cf_token()


def kv_list(prefix):
    out, cursor = [], None
    while True:
        url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
               f'/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse.quote(prefix)}')
        if cursor:
            url += f'&cursor={urllib.parse.quote(cursor)}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read())
        out.extend(j.get('result', []))
        cursor = (j.get('result_info') or {}).get('cursor')
        if not cursor: break
    return [r['name'] for r in out]


def kv_get(key):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if attempt < 2: time.sleep(1 + attempt); continue
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 2: time.sleep(1 + attempt); continue
            raise


def kv_put(key, value):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={'Authorization': f'Bearer {CF_TOK}',
                                          'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def fnv1a(s):
    h = 0x811c9dc5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    if h == 0: return '0'
    digits = []
    while h:
        h, r = divmod(h, 36)
        digits.append('0123456789abcdefghijklmnopqrstuvwxyz'[r])
    return ''.join(reversed(digits))


# ============= 500.com yazhi parser (Python mirror of asian-handicap-scraper) =============

def strip_html(s):
    return re.sub(r'<[^>]+>', '', s).strip()


def parse_single_term(t):
    """Chinese term → magnitude. Mirror of parseSingleTerm in JS."""
    if not t: return None
    if '平手' in t: return 0
    if '三球半' in t: return 3.5
    if '三球' in t: return 3.0
    if ('两球半' in t) or ('二球半' in t): return 2.5
    if ('两球' in t) or ('二球' in t): return 2.0
    if '一球半' in t: return 1.5
    if '球半' in t: return 1.5
    if '一球' in t: return 1.0
    if '半球' in t: return 0.5
    m = re.search(r'(\d+\.?\d*)', t)
    if m: return float(m.group(1))
    return None


def parse_line_magnitude_from_text(text):
    if not text: return None
    t = re.sub(r'^[受让]', '', text).strip()
    if '/' in t:
        parts = [s.strip() for s in t.split('/')]
        if len(parts) == 2:
            a, b = parse_single_term(parts[0]), parse_single_term(parts[1])
            if a is not None and b is not None:
                return (a + b) / 2
    return parse_single_term(t)


def parse_inner_table(table_html):
    """Parse one inner pl_table_data <table>: returns {line, home_water, away_water}.

    500.com yazhi inner table has TWO column layouts:
      Variant A (current rows with `class` set):
        td[0] class="ping" → 上盘水位
        td[1] ref="X"      → 让球
        td[2] class="ying" → 下盘水位
      Variant B (open rows + many finished rows, NO class):
        td[0]              → 下盘水位 (ying) ← REVERSED!
        td[1] ref="X"      → 让球
        td[2]              → 上盘水位 (ping)

    Detection: if either td0 has class="ping" or td2 has class="ying" → Variant A;
    otherwise fall back to Variant B (verified empirically 2026-06-25).

    Then map ping/ying → home/away by line sign:
      line > 0 (主队受让): 主=下盘=ying, 客=上盘=ping
      line ≤ 0 (主队让/平): 主=上盘=ping, 客=下盘=ying
    """
    if not table_html: return None
    # Capture optional ref + optional class + inner text
    tds = list(re.finditer(
        r'<td[^>]*?(?:ref="(-?[0-9.]+)")?[^>]*?(?:class="([^"]*)")?[^>]*>([\s\S]*?)</td>',
        table_html))
    if len(tds) < 3: return None

    def cls(td): return td.group(2) or ''
    def txt(td): return strip_html(td.group(3))
    def num(s):
        try: return float(re.sub(r'[↑↓]', '', s).strip())
        except: return None

    td0, td1, td2 = tds[0], tds[1], tds[2]
    td0_class = cls(td0)
    td2_class = cls(td2)
    td0_text  = txt(td0)
    td1_text  = txt(td1)
    td2_text  = txt(td2)

    # Layout detection
    if 'ping' in td0_class or 'ying' in td2_class:
        ping_val, ying_val = num(td0_text), num(td2_text)
    elif 'ying' in td0_class or 'ping' in td2_class:
        # Flipped class (rare)
        ying_val, ping_val = num(td0_text), num(td2_text)
    else:
        # No class — Variant B (open table / many finished matches)
        ying_val, ping_val = num(td0_text), num(td2_text)
    if ping_val is None or ying_val is None: return None

    # Line magnitude
    line_ref_str = td1.group(1)
    line_text = td1_text
    if line_ref_str is not None:
        line_abs = abs(float(line_ref_str))
        line_ref_signed = float(line_ref_str)
    else:
        line_abs = parse_line_magnitude_from_text(line_text)
        line_ref_signed = None
    if line_abs is None: return None

    # Sign
    if line_abs == 0 or '平手' in line_text:
        line = 0
    elif line_ref_signed is not None and line_ref_signed < 0:
        line = -line_abs       # ref signed negative = 主让
    else:
        line = line_abs if '受' in line_text else -line_abs

    # Map ping/ying → home/away by line sign
    if line > 0:
        home_water, away_water = ying_val, ping_val
    else:
        home_water, away_water = ping_val, ying_val

    return {'line': line, 'home_water': home_water, 'away_water': away_water}


def parse_crown_row(html):
    """Extract Crown (id=280) row, return {current, open} or None."""
    start_match = re.search(r'<tr[^>]*\bid="280"[^>]*>', html)
    if not start_match: return None
    start = start_match.end()

    # Track depth across nested <tr>
    depth = 1
    pos = start
    while depth > 0 and pos < len(html):
        open_idx = html.find('<tr', pos)
        close_idx = html.find('</tr>', pos)
        if close_idx == -1: return None
        if open_idx != -1 and open_idx < close_idx:
            depth += 1
            pos = open_idx + 3
        else:
            depth -= 1
            pos = close_idx + 5
    tr_body = html[start:pos - 5]

    # Two inner tables: [0] current, [1] open
    inner = list(re.finditer(r'<table[^>]*class="pl_table_data"[^>]*>([\s\S]*?)</table>', tr_body))
    if not inner: return None
    current = parse_inner_table(inner[0].group(1))
    opens = parse_inner_table(inner[1].group(1)) if len(inner) > 1 else None
    if not current: return None
    return {'current': current, 'open': opens}


def fetch_yazhi(fid_numeric):
    url = YAZHI_URL.format(fid_numeric=fid_numeric)
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                buf = r.read()
                # GBK encoding per 500.com
                return buf.decode('gbk', errors='replace')
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if attempt < 2: time.sleep(2 + attempt); continue
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 2: time.sleep(2 + attempt); continue
            raise


# ============= Main =============

def is_finished_wc_fixture(matches_buckets, fid):
    for bucket in matches_buckets.values():
        if not bucket: continue
        for m in bucket.get('matches', []):
            if m.get('id') == fid and m.get('league') == '世界杯' and m.get('status') == 'finished':
                return m
    return None


def list_finished_wc_fids():
    """Scan matches:* date buckets for finished WC fixtures."""
    bucket_keys = kv_list('matches:')
    fids = []
    for k in bucket_keys:
        date_str = k.split(':', 1)[1]
        # Only worry about WC date range
        if not date_str.startswith('2026-06') and not date_str.startswith('2026-07'):
            continue
        bucket = kv_get(k)
        if not bucket: continue
        for m in bucket.get('matches', []):
            if m.get('league') == '世界杯' and m.get('status') == 'finished' and m.get('id'):
                fids.append(m['id'])
    return sorted(set(fids))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--force', action='store_true',
                    help='Re-fetch even if asian_handicap:{fid} exists')
    ap.add_argument('--limit', type=int, default=None)
    args = ap.parse_args()

    print('[1/3] Listing finished WC fixtures from matches:* buckets...', file=sys.stderr)
    fids = list_finished_wc_fids()
    print(f'      found {len(fids)} finished WC fixtures', file=sys.stderr)

    print('[2/3] Filtering to those without asian_handicap KV...', file=sys.stderr)
    existing = set(k.split(':', 1)[1] for k in kv_list('asian_handicap:'))
    todo = [f for f in fids if f not in existing or args.force]
    if args.limit:
        todo = todo[:args.limit]
    print(f'      {len(todo)} fixtures to backfill ({len(existing)} already have AH)', file=sys.stderr)

    if not todo:
        print('Nothing to do.', file=sys.stderr)
        return

    print(f'[3/3] {"APPLY" if args.apply else "DRY-RUN"}: scraping 500.com yazhi pages...', file=sys.stderr)
    stats = {'scanned': 0, 'fetched': 0, 'parsed': 0, 'written': 0, 'unchanged': 0, 'failed': 0, 'no_data': 0}

    for i, fid in enumerate(todo):
        stats['scanned'] += 1
        fid_numeric = fid[1:] if fid.startswith('f') else fid
        try:
            html = fetch_yazhi(fid_numeric)
            if not html:
                stats['no_data'] += 1
                print(f'  [{i+1}/{len(todo)}] {fid}  no html', file=sys.stderr)
                continue
            stats['fetched'] += 1

            parsed = parse_crown_row(html)
            if not parsed:
                stats['no_data'] += 1
                print(f'  [{i+1}/{len(todo)}] {fid}  parse failed', file=sys.stderr)
                continue
            stats['parsed'] += 1

            current = parsed['current']
            opens = parsed.get('open') or current

            # trend
            cur_abs = abs(current['line'])
            open_abs = abs(opens['line'])
            if cur_abs > open_abs + 0.01: trend = 'rising'
            elif cur_abs < open_abs - 0.01: trend = 'falling'
            else: trend = 'stable'

            sig_input = f"{current['line']}|{current['home_water']}|{current['away_water']}|{trend}"
            new_hash = fnv1a(sig_input)

            now_iso = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', '+00:00')
            record = {
                'bookmaker': 'crown',
                'current': current,
                'open': opens,
                'trend': trend,
                'fetched_at': now_iso,
                'last_attempted_at': now_iso,
                '_hash': new_hash,
                '_source': 'backfill_historical',
            }

            existing_rec = kv_get(f'asian_handicap:{fid}') if not args.force else None
            if existing_rec and existing_rec.get('_hash') == new_hash:
                stats['unchanged'] += 1
                print(f'  [{i+1}/{len(todo)}] {fid}  unchanged (line={current["line"]:+.2f})', file=sys.stderr)
                continue

            sign = '+' if current['line'] > 0 else ('-' if current['line'] < 0 else '0')
            label = ('主受让' if current['line'] > 0 else ('主让' if current['line'] < 0 else '平手'))
            print(f'  [{i+1}/{len(todo)}] {fid}  {label} {abs(current["line"]):.2f}  '
                  f'water={current["home_water"]:.2f}/{current["away_water"]:.2f}  trend={trend}', file=sys.stderr)

            if args.apply:
                kv_put(f'asian_handicap:{fid}', record)
                stats['written'] += 1

            # Be polite to 500.com
            time.sleep(0.8)

        except Exception as e:
            stats['failed'] += 1
            print(f'  [{i+1}/{len(todo)}] {fid}  FAILED {e}', file=sys.stderr)

    print(f'\n[done] {"APPLIED" if args.apply else "DRY-RUN"}: {stats}', file=sys.stderr)


if __name__ == '__main__':
    main()
