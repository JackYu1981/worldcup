#!/usr/bin/env python3
"""
One-shot cleanup of noise fields in players:* and players_by_country:* KV records.

Fields removed:
  players:{id}.tournament_stats.attacking.fdcp_top_scorer_rank   ← internal rank, not surfaced
  players:{id}.tournament_stats.attacking.xg_goal_effiency_rate  ← weird "Nx" string, not surfaced
  players:{id}.fdh_match_ids                                     ← v1 legacy
  players:{id}.last_match_id                                     ← v1 legacy (counters.js)
  players:{id}._lineup_hash                                      ← v1 legacy
  players_by_country:{code}.roster[].stats_summary               ← old seed field

Writes only when something actually changed (hash short-circuit).

Default dry-run; pass --apply to actually write.
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

CF_TOK = None


def get_cf_token():
    return subprocess.run(['security','find-generic-password','-s','cloudflare-api-token','-w'],
                          capture_output=True, text=True).stdout.strip()


def cf_headers():
    return {'Authorization': f'Bearer {CF_TOK}'}


def kv_list_prefix(prefix):
    all_keys = []
    cursor = None
    while True:
        url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/keys?limit=1000&prefix={urllib.parse.quote(prefix)}'
        if cursor:
            url += f'&cursor={urllib.parse.quote(cursor)}'
        req = urllib.request.Request(url, headers=cf_headers())
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read())
        all_keys += [k['name'] for k in d['result']]
        cursor = d.get('result_info',{}).get('cursor')
        if not cursor:
            break
    return all_keys


def kv_get(key):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    req = urllib.request.Request(url, headers=cf_headers())
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise


def kv_put(key, value):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={**cf_headers(), 'Content-Type': 'application/octet-stream'})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())
        if not j.get('success'):
            raise RuntimeError(f'KV put failed: {j}')


PLAYER_TOP_LEVEL_NOISE = ['fdh_match_ids', 'last_match_id', '_lineup_hash']
PLAYER_ATTACKING_NOISE = ['fdcp_top_scorer_rank', 'xg_goal_effiency_rate']


def clean_player(record):
    """Return (cleaned_record, changed_bool)."""
    changed = False
    for k in PLAYER_TOP_LEVEL_NOISE:
        if k in record:
            del record[k]
            changed = True
    ts = record.get('tournament_stats') or {}
    att = ts.get('attacking') or {}
    for k in PLAYER_ATTACKING_NOISE:
        if k in att:
            del att[k]
            changed = True
    return record, changed


def clean_country_roster(record):
    """Return (cleaned_record, changed_bool). Removes stats_summary from each roster entry."""
    changed = False
    roster = record.get('roster') or []
    for entry in roster:
        if 'stats_summary' in entry:
            del entry['stats_summary']
            changed = True
    return record, changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually write KV (default dry-run)')
    ap.add_argument('--budget', type=int, default=300)
    ap.add_argument('--sleep', type=float, default=0.05)
    ap.add_argument('--skip-players', action='store_true', help='skip players:* cleanup entirely')
    ap.add_argument('--skip-rosters', action='store_true', help='skip players_by_country:* cleanup')
    args = ap.parse_args()

    global CF_TOK
    CF_TOK = get_cf_token()
    if not CF_TOK:
        sys.exit('CLOUDFLARE_API_TOKEN missing')

    print(f'[cleanup] mode={"APPLY" if args.apply else "DRY-RUN"} budget={args.budget}\n', file=sys.stderr)

    # Players
    if args.skip_players:
        print('[cleanup] --skip-players set, skipping players:* scan', file=sys.stderr)
        p_changed = p_unchanged = p_written = p_err = 0
    else:
        player_keys = kv_list_prefix('players:')
        print(f'[cleanup] {len(player_keys)} players:* records to scan', file=sys.stderr)
        p_changed = 0
        p_unchanged = 0
        p_written = 0
        p_err = 0
        for i, k in enumerate(player_keys, 1):
            try:
                rec = kv_get(k)
            except Exception as e:
                print(f'  GET {k} ERR: {e}', file=sys.stderr)
                p_err += 1
                continue
            if not rec:
                continue
            cleaned, changed = clean_player(rec)
            if not changed:
                p_unchanged += 1
                continue
            p_changed += 1
            if args.apply:
                try:
                    kv_put(k, cleaned)
                    p_written += 1
                    if args.sleep:
                        time.sleep(args.sleep)
                except Exception as e:
                    print(f'  PUT {k} ERR: {e}', file=sys.stderr)
                    p_err += 1
            if i % 100 == 0 or (changed and p_changed <= 5):
                print(f'  [{i:4d}/{len(player_keys)}] changed={p_changed} unchanged={p_unchanged} written={p_written}', file=sys.stderr)
            if p_written >= args.budget:
                print(f'\n[cleanup] BUDGET HIT ({p_written} >= {args.budget}). Stopping players.', file=sys.stderr)
                break

    print(f'\n[cleanup] PLAYERS done: changed={p_changed} unchanged={p_unchanged} written={p_written} err={p_err}', file=sys.stderr)

    # Country rosters
    if args.skip_rosters:
        print('[cleanup] --skip-rosters set, skipping players_by_country:* scan', file=sys.stderr)
        c_changed = c_unchanged = c_written = c_err = 0
    else:
        country_keys = kv_list_prefix('players_by_country:')
        print(f'\n[cleanup] {len(country_keys)} players_by_country:* records to scan', file=sys.stderr)
        c_changed = 0
        c_unchanged = 0
        c_written = 0
        c_err = 0
        for k in country_keys:
            try:
                rec = kv_get(k)
            except Exception as e:
                print(f'  GET {k} ERR: {e}', file=sys.stderr)
                c_err += 1
                continue
            if not rec:
                continue
            cleaned, changed = clean_country_roster(rec)
            if not changed:
                c_unchanged += 1
                continue
            c_changed += 1
            if args.apply:
                try:
                    kv_put(k, cleaned)
                    c_written += 1
                except Exception as e:
                    print(f'  PUT {k} ERR: {e}', file=sys.stderr)
                    c_err += 1

    print(f'\n[cleanup] COUNTRY ROSTERS done: changed={c_changed} unchanged={c_unchanged} written={c_written} err={c_err}', file=sys.stderr)
    print(f'\n[cleanup] TOTAL writes: {p_written + c_written}', file=sys.stderr)


if __name__ == '__main__':
    main()
