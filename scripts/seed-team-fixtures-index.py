#!/usr/bin/env python3
"""
seed-team-fixtures-index.py — one-shot: build the team_fixtures:{country_code}
reverse index from existing fixture_mapping:* + fifa_calendar.

Use this:
  - Right after deploying the worker code that maintains this index (to pre-seed
    so the API has data immediately instead of waiting for next cron tick).
  - To debug index drift (compare against what cron would write).

Output is identical to what `calendar-cron.js` builds. Uses the same hash
short-circuit so a re-run after cron has caught up is a no-op.

Usage:
  python3 scripts/seed-team-fixtures-index.py            # dry-run
  python3 scripts/seed-team-fixtures-index.py --apply    # write to KV
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'

CF_TOK = subprocess.run(['security', 'find-generic-password',
                         '-s', 'cloudflare-api-token', '-w'],
                        capture_output=True, text=True, check=True).stdout.strip()


def cf_headers():
    return {'Authorization': f'Bearer {CF_TOK}'}


def kv_list(prefix):
    out, cursor = [], None
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
                time.sleep(2 * (attempt + 1)); continue
            raise


def kv_put(key, value):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    body = json.dumps(value).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={**cf_headers(), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def fnv1a(s):
    h = 0x811c9dc5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    # base36 to match JS Math.imul output
    return _base36(h)


def _base36(n):
    if n == 0: return '0'
    digits = []
    while n:
        n, r = divmod(n, 36)
        digits.append('0123456789abcdefghijklmnopqrstuvwxyz'[r])
    return ''.join(reversed(digits))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()

    print('[seed] loading fifa_calendar...')
    cal = kv_get('fifa_calendar')
    if not cal:
        sys.exit('fifa_calendar not in KV')
    fifa_by_match_id = {fm['id_match']: fm for fm in (cal.get('matches') or [])}
    print(f'[seed] {len(fifa_by_match_id)} fifa calendar matches')

    print('[seed] loading all fixture_mapping:* keys...')
    mapping_keys = kv_list('fixture_mapping:')
    print(f'[seed] {len(mapping_keys)} fixture_mapping keys')

    index_by_code = {}
    for k in mapping_keys:
        mp = kv_get(k['name'])
        if not mp: continue
        if mp.get('match_confidence') not in ('exact', 'time_skew_5min'): continue
        home, away = mp.get('home_code'), mp.get('away_code')
        if not home or not away: continue
        fix_id = k['name'].split(':', 1)[1]
        fm = fifa_by_match_id.get(mp.get('fifa_id_match'))
        date_utc = (fm or {}).get('date_utc') or mp.get('kickoff_utc')
        index_by_code.setdefault(home, []).append({
            'fixture_id': fix_id, 'date_utc': date_utc,
            'opp_code': away, 'is_home': True,
        })
        index_by_code.setdefault(away, []).append({
            'fixture_id': fix_id, 'date_utc': date_utc,
            'opp_code': home, 'is_home': False,
        })

    for code in index_by_code:
        index_by_code[code].sort(key=lambda e: e.get('date_utc') or '')

    print(f'[seed] built index for {len(index_by_code)} teams')
    for code in sorted(index_by_code.keys()):
        print(f'  {code}: {len(index_by_code[code])} fixtures')

    if not args.apply:
        print('\n[dry-run] re-run with --apply.')
        return

    written = 0
    for code, entries in index_by_code.items():
        sig = '\n'.join(f"{e['fixture_id']}|{e['date_utc']}|{e['opp_code']}|{e['is_home']}" for e in entries)
        new_hash = fnv1a(sig)
        existing = kv_get(f'team_fixtures:{code}')
        if existing and existing.get('_hash') == new_hash:
            continue
        rec = {'country_code': code, 'fixtures': entries, '_hash': new_hash}
        kv_put(f'team_fixtures:{code}', rec)
        written += 1

    print(f'\n[apply] wrote {written}/{len(index_by_code)} team_fixtures keys')


if __name__ == '__main__':
    main()
