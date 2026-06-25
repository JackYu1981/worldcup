#!/usr/bin/env python3
"""
stamp-tournament-markers.py — one-shot: stamp tournament_refresh_done_at on all
finished match_lineups that are missing it.

Use when: gctp tournament-stats refresh has already been done out-of-band (manual
team-v3-refresh.py run, or pre-marker-era worker), but match_lineups records
weren't stamped. This is a pure metadata fix — no FIFA/mango calls, no player
record writes; just 52 KV puts on the lineup records.

Usage:
  python3 scripts/stamp-tournament-markers.py            # dry-run: list
  python3 scripts/stamp-tournament-markers.py --apply    # actually stamp
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'
FINISHED = 0

CF_TOK = subprocess.run(['security', 'find-generic-password',
                         '-s', 'cloudflare-api-token', '-w'],
                        capture_output=True, text=True, check=True).stdout.strip()


def cf_headers():
    return {'Authorization': f'Bearer {CF_TOK}'}


def kv_list(prefix):
    out = []
    cursor = None
    while True:
        url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
               f'/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse.quote(prefix)}')
        if cursor:
            url += f'&cursor={urllib.parse.quote(cursor)}'
        req = urllib.request.Request(url, headers=cf_headers())
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read())
        out.extend(j.get('result', []))
        cursor = (j.get('result_info') or {}).get('cursor')
        if not cursor:
            break
    return out


def kv_get(key):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    req = urllib.request.Request(url, headers=cf_headers())
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def kv_put(key, value):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    body = json.dumps(value).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={**cf_headers(),
                                          'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()

    print('[scan] listing finished match_lineups without marker...')
    keys = kv_list('match_lineups:')
    affected = []
    for k in keys:
        fid = k['name'].split(':', 1)[1]
        rec = kv_get(k['name'])
        if not rec:
            continue
        if rec.get('match_status') != FINISHED:
            continue
        if rec.get('tournament_refresh_done_at'):
            continue
        affected.append((fid, rec))

    if not affected:
        print('[scan] all finished matches already stamped.')
        return

    print(f'[scan] found {len(affected)} unstamped:')
    for fid, rec in affected:
        home = (rec.get('home') or {}).get('country_code')
        away = (rec.get('away') or {}).get('country_code')
        print(f'  {fid}  {home} vs {away}')

    if not args.apply:
        print('\n[dry-run] re-run with --apply.')
        return

    stamp = (datetime.now(timezone.utc)
             .isoformat(timespec='seconds')
             .replace('+00:00', '+00:00'))
    print(f'\n[apply] stamping {len(affected)} records with done_at={stamp}')
    ok = 0
    fail = 0
    for fid, rec in affected:
        rec['tournament_refresh_done_at'] = stamp
        try:
            kv_put(f'match_lineups:{fid}', rec)
            ok += 1
            sys.stdout.write('.')
            sys.stdout.flush()
        except Exception as e:
            fail += 1
            print(f'\n  FAILED {fid}: {e}')
    print(f'\n[done] stamped {ok}/{len(affected)}  failed={fail}')


if __name__ == '__main__':
    main()
