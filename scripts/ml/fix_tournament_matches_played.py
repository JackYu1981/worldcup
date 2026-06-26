#!/usr/bin/env python3
"""
fix_tournament_matches_played.py — one-shot fix for players:{pid}.tournament_matches_played

The fifa-scraper writes `tournament_matches_played` into `players:{pid}` from
fdh's aggregate stats endpoint, but for many top scorers it reports `1` even
when they've actually played 2-3 matches. This breaks the worker's per-match
rate calculation (`on_target / matches_played` ends up as cumulative).

Authoritative source: `match_stats:{fid}.players` — each row = one actual
appearance. Count rows per pid → that's the real matches_played.

Strategy:
  1. List all match_stats:* keys
  2. Build pid → actual_count map by counting appearances
  3. For each player with mismatch, fetch players:{pid}, update
     tournament_matches_played, write back

Usage:
  python3 scripts/ml/fix_tournament_matches_played.py             # dry-run
  python3 scripts/ml/fix_tournament_matches_played.py --apply
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

def get_cf_token():
    r = subprocess.run(['security','find-generic-password','-s','cloudflare-api-token','-w'],
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()
CF_TOK = get_cf_token()

def kv_list(prefix):
    out, cursor = [], None
    while True:
        url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
               f'/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse.quote(prefix)}')
        if cursor: url += f'&cursor={urllib.parse.quote(cursor)}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read())
        out.extend(d.get('result',[]))
        cursor = (d.get('result_info') or {}).get('cursor')
        if not cursor: break
    return [r['name'] for r in out]

def kv_get(key):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if attempt < 2: time.sleep(1+attempt); continue
            raise
        except Exception:
            if attempt < 2: time.sleep(1+attempt); continue
            raise

def kv_put(key, value):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={'Authorization': f'Bearer {CF_TOK}',
                                          'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    print('[1/3] Listing all match_stats:* and counting per-pid appearances...', file=sys.stderr)
    ms_keys = kv_list('match_stats:')
    print(f'  {len(ms_keys)} match_stats records', file=sys.stderr)

    pid_to_count = {}     # pid → actual matches_played
    pid_to_minutes = {}   # pid → estimated minutes (90 per appearance)
    pid_to_shots = {}     # pid → total shots
    pid_to_on_target = {}
    for k in ms_keys:
        ms = kv_get(k)
        if not ms: continue
        for pid, s in (ms.get('players') or {}).items():
            pid_to_count[pid] = pid_to_count.get(pid, 0) + 1
            pid_to_shots[pid] = pid_to_shots.get(pid, 0) + (s.get('shots') or 0)
            pid_to_on_target[pid] = pid_to_on_target.get(pid, 0) + (s.get('shots_on_target') or 0)
    print(f'  unique players appeared: {len(pid_to_count)}', file=sys.stderr)

    print('[2/3] Comparing to players:{pid}.tournament_matches_played + planning updates...', file=sys.stderr)
    updates = []   # list of (pid, old_mp, new_mp, name)
    skipped_already_correct = 0
    skipped_no_record = 0
    for pid, actual in pid_to_count.items():
        rec = kv_get(f'players:{pid}')
        if not rec:
            skipped_no_record += 1
            continue
        ts = rec.get('tournament_stats') or {}
        old_mp = ts.get('matches_played') or 0
        if old_mp == actual:
            skipped_already_correct += 1
            continue
        # Plan update — set matches_played + bump minutes_played to a reasonable
        # estimate if it's also too small.
        old_minutes = ts.get('minutes_played') or 0
        # Conservative minutes estimate: existing + (actual - old_mp) * 70 (avg
        # WC outfield player gets ~70-80 minutes when playing)
        est_extra_minutes = max(0, (actual - old_mp) * 70)
        new_minutes = old_minutes + est_extra_minutes
        updates.append({
            'pid': pid,
            'name': rec.get('name_default', '?'),
            'old_mp': old_mp,
            'new_mp': actual,
            'old_minutes': old_minutes,
            'new_minutes': new_minutes,
        })

    print(f'  skipped (already correct): {skipped_already_correct}', file=sys.stderr)
    print(f'  skipped (no players record): {skipped_no_record}', file=sys.stderr)
    print(f'  to update: {len(updates)}', file=sys.stderr)

    # Show top 10 most-played to verify (high-value stars should be in here)
    print('\n  Top 15 to update (by actual matches):', file=sys.stderr)
    for u in sorted(updates, key=lambda x: -x['new_mp'])[:15]:
        print(f"    {u['pid']:>7}  {u['name'][:28]:28}  {u['old_mp']} → {u['new_mp']} matches", file=sys.stderr)

    if not args.apply:
        print('\n[DRY-RUN] use --apply to write KV', file=sys.stderr)
        return

    print(f'\n[3/3] APPLYING — writing {len(updates)} player records...', file=sys.stderr)
    ok, err = 0, 0
    for i, u in enumerate(updates):
        try:
            rec = kv_get(f'players:{u["pid"]}')
            if not rec: continue
            ts = rec.get('tournament_stats') or {}
            ts['matches_played'] = u['new_mp']
            if (ts.get('minutes_played') or 0) < u['new_minutes']:
                ts['minutes_played'] = u['new_minutes']
            rec['tournament_stats'] = ts
            kv_put(f'players:{u["pid"]}', rec)
            ok += 1
            if (i+1) % 50 == 0:
                print(f'  [{i+1}/{len(updates)}] ok={ok} err={err}', file=sys.stderr)
        except Exception as e:
            err += 1
            print(f'  fail {u["pid"]}: {e}', file=sys.stderr)
    print(f'\n[DONE] ok={ok} err={err}', file=sys.stderr)


if __name__ == '__main__':
    main()
