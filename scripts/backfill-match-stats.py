#!/usr/bin/env python3
"""
Backfill match_stats:{500_id} for all finished WC matches.

For each finished match in KV (match_lineups.match_status == 0):
  1. Read fixture_mapping:{500_id} for fdh_match_id
  2. Fetch fdh-api/v1/stats/match/{fdh_id}/players.json
  3. Normalize → write match_stats:{500_id}

Hash short-circuit: if existing record matches, skip.

Usage:
    python3 scripts/backfill-match-stats.py            # dry-run
    python3 scripts/backfill-match-stats.py --apply
    python3 scripts/backfill-match-stats.py --apply --limit 5
    python3 scripts/backfill-match-stats.py --apply --budget 200

Env: CLOUDFLARE_API_TOKEN (or Keychain "cloudflare-api-token")
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'

# fdh-api field → our schema (mirrors workers/fifa-scraper/lib/match-stats.js)
FIELD_MAP = {
    'AttemptAtGoal':         'shots',
    'AttemptAtGoalOnTarget': 'shots_on_target',
    'FoulsFor':              'fouls_committed',
    'YellowCards':           'yellow_cards',
}


def get_cf_token():
    return subprocess.run(
        ['security', 'find-generic-password', '-s', 'cloudflare-api-token', '-w'],
        capture_output=True, text=True
    ).stdout.strip()


CF_TOK = None


def kv_get(key):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def kv_list(prefix, limit=1000):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse.quote(prefix)}&limit={limit}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return [k['name'] for k in json.loads(r.read())['result']]


def kv_put(key, value):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={'Authorization': f'Bearer {CF_TOK}',
                                          'Content-Type': 'application/octet-stream'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read())
                if not j.get('success'):
                    raise RuntimeError(f'KV put failed: {j}')
                return
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise RuntimeError(f'KV quota hit (429): {e.read().decode()[:200]}')
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def fnv1a_32(s):
    h = 0x811c9dc5
    for c in s:
        h ^= ord(c)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, 'x')


def canon_json(v):
    if v is None or not isinstance(v, (dict, list)):
        return json.dumps(v)
    if isinstance(v, list):
        return '[' + ','.join(canon_json(x) for x in v) + ']'
    keys = sorted(v.keys())
    return '{' + ','.join(f'{json.dumps(k)}:{canon_json(v[k])}' for k in keys) + '}'


def fetch_fdh_players(fdh_id):
    url = f'https://fdh-api.fifa.com/v1/stats/match/{fdh_id}/players.json'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def normalize(fdh_data):
    if not fdh_data: return {}
    out = {}
    for pid, raw in fdh_data.items():
        if pid == '-1' or not isinstance(raw, list): continue
        stats = {}
        has_any = False
        for tup in raw:
            if not isinstance(tup, list) or len(tup) < 2: continue
            k, v = tup[:2]
            m = FIELD_MAP.get(k)
            if not m: continue
            n = int(v) if isinstance(v, (int, float)) else 0
            stats[m] = n
            if n > 0: has_any = True
        if has_any:
            out[pid] = stats
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually write KV (default dry-run)')
    ap.add_argument('--budget', type=int, default=200, help='abort if writes exceed this')
    ap.add_argument('--limit', type=int, default=None, help='only process first N matches')
    ap.add_argument('--sleep', type=float, default=0.3, help='seconds between fdh-api calls')
    args = ap.parse_args()

    global CF_TOK
    CF_TOK = get_cf_token()
    if not CF_TOK:
        sys.exit('CLOUDFLARE_API_TOKEN missing')

    print(f'[backfill-match-stats] mode={"APPLY" if args.apply else "DRY-RUN"} budget={args.budget}', file=sys.stderr)

    lineup_keys = kv_list('match_lineups:')
    print(f'[backfill-match-stats] {len(lineup_keys)} match_lineups records', file=sys.stderr)

    targets = []
    for k in lineup_keys:
        fid_500 = k.split(':', 1)[1]
        lu = kv_get(k)
        if not lu or lu.get('match_status') != 0:
            continue
        targets.append((fid_500, lu))

    print(f'[backfill-match-stats] {len(targets)} finished matches to consider', file=sys.stderr)
    if args.limit:
        targets = targets[:args.limit]

    writes = 0
    skipped = 0
    fdh_missing = 0
    fdh_empty = 0
    errors = 0

    for i, (fid_500, lu) in enumerate(targets, 1):
        fmap = kv_get(f'fixture_mapping:{fid_500}')
        if not fmap or not fmap.get('fdh_match_id'):
            fdh_missing += 1
            print(f'  [{i:3d}/{len(targets)}] {fid_500}: no fdh_match_id, skip', file=sys.stderr)
            continue

        fdh_id = fmap['fdh_match_id']
        try:
            fdh_data = fetch_fdh_players(fdh_id)
        except Exception as e:
            errors += 1
            print(f'  [{i:3d}/{len(targets)}] {fid_500}: fdh fetch err {e}', file=sys.stderr)
            time.sleep(args.sleep)
            continue

        player_stats = normalize(fdh_data)
        if not player_stats:
            fdh_empty += 1
            print(f'  [{i:3d}/{len(targets)}] {fid_500}: fdh empty (no players with stats)', file=sys.stderr)
            time.sleep(args.sleep)
            continue

        new_hash = fnv1a_32(canon_json(player_stats))
        existing = kv_get(f'match_stats:{fid_500}')
        if existing and existing.get('_hash') == new_hash:
            skipped += 1
            print(f'  [{i:3d}/{len(targets)}] {fid_500}: unchanged, skip', file=sys.stderr)
            continue

        record = {
            'fifa_id_match': fmap.get('fifa_id_match'),
            'fdh_match_id':  fdh_id,
            'fetched_at':    datetime.now(timezone.utc).isoformat().replace('+00:00', '+00:00'),
            'match_status':  0,
            '_hash':         new_hash,
            'players':       player_stats,
        }

        home = lu.get('home', {}).get('country_code') or '?'
        away = lu.get('away', {}).get('country_code') or '?'

        if args.apply:
            try:
                kv_put(f'match_stats:{fid_500}', record)
                writes += 1
                print(f'  [{i:3d}/{len(targets)}] {fid_500} ({home}-{away}): WROTE ({len(player_stats)} players)', file=sys.stderr)
            except Exception as e:
                errors += 1
                print(f'  [{i:3d}/{len(targets)}] {fid_500}: write err {e}', file=sys.stderr)
        else:
            writes += 1
            print(f'  [{i:3d}/{len(targets)}] {fid_500} ({home}-{away}): would write ({len(player_stats)} players)', file=sys.stderr)

        if writes >= args.budget:
            print(f'\n[backfill-match-stats] BUDGET HIT ({writes} >= {args.budget}). Stopping.', file=sys.stderr)
            break

        time.sleep(args.sleep)

    print(f'\n[backfill-match-stats] DONE. {("APPLIED" if args.apply else "DRY-RUN")} | writes={writes} unchanged={skipped} fdh_missing={fdh_missing} fdh_empty={fdh_empty} errors={errors}', file=sys.stderr)


if __name__ == '__main__':
    main()
