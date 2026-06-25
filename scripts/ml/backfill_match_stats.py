#!/usr/bin/env python3
"""
backfill_match_stats.py — one-shot backfill of `match_stats:{fid}` KV records
for all finished WC fixtures whose data wasn't captured by the live cron.

Why this exists:
  The fifa-scraper Worker only processes fixtures within a [KO-90min, KO+4h]
  window. Matches that finished before the worker was deployed, or that the
  cron simply missed during a busy slot, end up without `match_stats:{fid}`.
  As of 2026-06-25 only 6/54 finished WC matches have ground-truth shot stats —
  ML backtesting is blocked until this is fixed.

What it does:
  1. List all `fixture_mapping:f1359*` keys (= every WC fixture we've mapped).
  2. For each one, check if `match_stats:{fid}` already exists; skip if yes.
  3. Fetch fdh-api players.json using mapping.fdh_match_id.
  4. Normalize using the same FIELD_MAP as workers/fifa-scraper/lib/match-stats.js.
  5. Write `match_stats:{fid}` to KV.

Usage:
  python3 scripts/ml/backfill_match_stats.py             # dry-run, prints diff
  python3 scripts/ml/backfill_match_stats.py --apply     # actually write KV

Output stats:
  - scanned: total finished fixtures with fdh_match_id
  - existing: already had match_stats
  - written: newly populated
  - empty_response: fdh API returned no player rows (rare)
  - failed: HTTP / parse error per fixture
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'

# Mirror of workers/fifa-scraper/lib/match-stats.js FIELD_MAP — keep these in sync
FIELD_MAP = {
    'AttemptAtGoal':         'shots',
    'AttemptAtGoalOnTarget': 'shots_on_target',
    'FoulsFor':              'fouls_committed',
    'YellowCards':           'yellow_cards',
    'RedCards':              'red_cards',
}


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
               f'/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse_quote(prefix) if hasattr(urllib, "parse_quote") else prefix}')
        if cursor:
            url += f'&cursor={cursor}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read())
        out.extend(j.get('result', []))
        cursor = (j.get('result_info') or {}).get('cursor')
        if not cursor: break
    return [r['name'] for r in out]


def kv_get(key):
    import urllib.parse
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
    import urllib.parse
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={'Authorization': f'Bearer {CF_TOK}',
                                          'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def fnv1a(s):
    """Mirror of workers/fifa-scraper/lib/match-stats.js fnv1a"""
    h = 0x811c9dc5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    # Convert to base-36 like JS
    if h == 0: return '0'
    digits = []
    while h:
        h, r = divmod(h, 36)
        digits.append('0123456789abcdefghijklmnopqrstuvwxyz'[r])
    return ''.join(reversed(digits))


def canon_json(v):
    """Mirror of canonJson in match-stats.js — sorted-keys JSON for hashing."""
    if v is None or not isinstance(v, (dict, list)):
        return json.dumps(v, separators=(',', ':'))
    if isinstance(v, list):
        return '[' + ','.join(canon_json(x) for x in v) + ']'
    keys = sorted(v.keys())
    return '{' + ','.join(json.dumps(k) + ':' + canon_json(v[k]) for k in keys) + '}'


def fetch_fdh_players(fdh_match_id):
    """Fetch FIFA fdh-api per-match player stats."""
    url = f'https://fdh-api.fifa.com/v1/stats/match/{fdh_match_id}/players.json'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if attempt < 2: time.sleep(2 + attempt); continue
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 2: time.sleep(2 + attempt); continue
            raise


def normalize_match_stats(fdh_data):
    """Mirror of normalizeMatchStats in match-stats.js."""
    if not isinstance(fdh_data, dict):
        return {}
    out = {}
    for pid, raw in fdh_data.items():
        if pid == '-1':
            continue
        if not isinstance(raw, list):
            continue
        stats = {}
        has_any = False
        for tup in raw:
            if not isinstance(tup, list) or len(tup) < 2:
                continue
            k, v = tup[0], tup[1]
            mapped = FIELD_MAP.get(k)
            if not mapped:
                continue
            num = int(v) if isinstance(v, (int, float)) else 0
            stats[mapped] = num
            if num > 0:
                has_any = True
        if has_any:
            out[pid] = stats
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true',
                    help='Actually write KV (default is dry-run)')
    ap.add_argument('--force', action='store_true',
                    help='Re-fetch even if match_stats already exists')
    ap.add_argument('--limit', type=int, default=None,
                    help='Limit to N fixtures (for testing)')
    args = ap.parse_args()

    print('[1/4] Listing fixture_mapping:f* keys...', file=sys.stderr)
    mapping_keys = kv_list('fixture_mapping:f')
    print(f'      found {len(mapping_keys)} mapping keys', file=sys.stderr)

    print('[2/4] Listing existing match_stats:* keys...', file=sys.stderr)
    existing_stats = set(k.split(':', 1)[1] for k in kv_list('match_stats:'))
    print(f'      found {len(existing_stats)} existing match_stats', file=sys.stderr)

    print('[3/4] Filtering to fixtures that need backfill...', file=sys.stderr)
    todo = []
    for k in mapping_keys:
        fid = k.split(':', 1)[1]
        if fid in existing_stats and not args.force:
            continue
        todo.append(fid)
    if args.limit:
        todo = todo[:args.limit]
    print(f'      {len(todo)} fixtures to process', file=sys.stderr)

    if not todo:
        print('Nothing to do.', file=sys.stderr)
        return

    print(f'[4/4] {"APPLY" if args.apply else "DRY-RUN"}: fetching fdh + writing KV...', file=sys.stderr)
    stats = {'scanned': 0, 'no_fdh_id': 0, 'no_lineup': 0, 'fdh_empty': 0, 'no_player_data': 0,
             'written': 0, 'failed': 0, 'skipped_existing': 0}

    for i, fid in enumerate(todo):
        stats['scanned'] += 1
        try:
            mapping = kv_get(f'fixture_mapping:{fid}')
            if not mapping or not mapping.get('fdh_match_id'):
                stats['no_fdh_id'] += 1
                print(f'  [{i+1}/{len(todo)}] {fid}  SKIP no fdh_match_id', file=sys.stderr)
                continue

            # Need lineup to know match_status for the record
            lineup = kv_get(f'match_lineups:{fid}')
            if not lineup:
                stats['no_lineup'] += 1
                print(f'  [{i+1}/{len(todo)}] {fid}  SKIP no lineup', file=sys.stderr)
                continue

            fdh_data = fetch_fdh_players(mapping['fdh_match_id'])
            if not fdh_data:
                stats['fdh_empty'] += 1
                print(f'  [{i+1}/{len(todo)}] {fid}  fdh empty', file=sys.stderr)
                continue

            player_stats = normalize_match_stats(fdh_data)
            if not player_stats:
                stats['no_player_data'] += 1
                print(f'  [{i+1}/{len(todo)}] {fid}  no players with shots', file=sys.stderr)
                continue

            new_hash = fnv1a(canon_json(player_stats))
            record = {
                'fifa_id_match': mapping.get('fifa_id_match'),
                'fdh_match_id':  mapping['fdh_match_id'],
                'fetched_at':    datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', '+00:00'),
                'match_status':  lineup.get('match_status'),
                '_hash':         new_hash,
                'players':       player_stats,
                '_source':       'backfill',
            }

            n_players = len(player_stats)
            top_shooter = max(player_stats.items(), key=lambda kv: kv[1].get('shots_on_target', 0))
            print(f'  [{i+1}/{len(todo)}] {fid}  fdh={mapping["fdh_match_id"]:>6}  '
                  f'players={n_players:2d}  top_pid={top_shooter[0]} on_target={top_shooter[1].get("shots_on_target")}',
                  file=sys.stderr)

            if args.apply:
                kv_put(f'match_stats:{fid}', record)
                stats['written'] += 1

            # Be polite to FIFA's API
            time.sleep(0.5)

        except Exception as e:
            stats['failed'] += 1
            print(f'  [{i+1}/{len(todo)}] {fid}  FAILED {e}', file=sys.stderr)

    print(f'\n[done] {"APPLIED" if args.apply else "DRY-RUN"}: {stats}', file=sys.stderr)


if __name__ == '__main__':
    main()
