#!/usr/bin/env python3
"""
backfill-tournament-refresh.py — sweep all finished matches that never got their
gctp tournament-stats refresh after going status=0, and run it now.

Why this exists:
  worker `tournament_refresh_done_at` marker (added 2026-06-25) is only stamped
  on the tick where status transitions 3→0. If that tick's gctp call FAILED
  (token expired, mango 5xx, CPU timeout), the marker never gets written and
  there's no retry path once the match falls out of the [KO-90min, KO+4h]
  cron window. Players for that match are stuck at "as of last live tick"
  rather than "final tournament accumulator".

Usage:
  python3 scripts/backfill-tournament-refresh.py                # dry-run: list affected matches
  python3 scripts/backfill-tournament-refresh.py --apply        # actually invoke gctp refresh
  python3 scripts/backfill-tournament-refresh.py --apply --fid f1359199  # one specific match

The actual gctp logic is reused by shelling out to team-v3-refresh.py — that
script already has working gctp_* fetch + hash-short-circuit + KV write logic
for arbitrary teams, and is the verbatim source the worker mirrors. We pass
each affected match's home+away country codes to it, and after success we
stamp `tournament_refresh_done_at` on the lineup record so this run is
recorded and future scans skip it.
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


def cf_token():
    r = subprocess.run(['security', 'find-generic-password',
                        '-s', 'cloudflare-api-token', '-w'],
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


CF_TOK = cf_token()


def cf_headers():
    return {'Authorization': f'Bearer {CF_TOK}'}


def kv_list(prefix):
    """Paginated key list. Returns list of {name, ...}."""
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


def find_affected_fixtures(only_fid=None):
    """Return list of {fid, home_code, away_code, fetched_at} for finished matches
    that have no tournament_refresh_done_at marker."""
    if only_fid:
        keys = [{'name': f'match_lineups:{only_fid}'}]
    else:
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
        affected.append({
            'fid': fid,
            'home_code': (rec.get('home') or {}).get('country_code'),
            'away_code': (rec.get('away') or {}).get('country_code'),
            'fetched_at': rec.get('fetched_at'),
            'match_time': rec.get('match_time'),
        })
    return affected


def run_team_refresh(codes, apply):
    """Invoke team-v3-refresh.py for a comma-separated list of country codes.
    Streams stdout in real-time so users can watch progress for the ~10-min run.
    Returns (exit_code, full_output_text)."""
    cmd = ['python3', 'scripts/team-v3-refresh.py', '--teams', ','.join(codes)]
    if apply:
        cmd.append('--apply')
    # Popen + line-buffered iteration → user sees `[N/48] team` progress as it
    # happens, rather than waiting for the full 10min then getting a wall of text.
    # capture_output blocks until exit; here we tee.
    captured = []
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,   # line-buffered
    )
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            captured.append(line)
    finally:
        rc = proc.wait()
    return rc, ''.join(captured)


def stamp_marker(fid):
    """Re-read the lineup record and write the done_at marker.
    Read-modify-write: tiny race window, acceptable for an ops script."""
    rec = kv_get(f'match_lineups:{fid}')
    if not rec:
        return False
    rec['tournament_refresh_done_at'] = (
        datetime.now(timezone.utc)
        .isoformat(timespec='seconds')
        .replace('+00:00', '+00:00')
    )
    kv_put(f'match_lineups:{fid}', rec)
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true',
                   help='Actually invoke gctp refresh + stamp markers (else dry-run).')
    p.add_argument('--fid', help='Restrict to one fixture id, e.g. f1359199.')
    args = p.parse_args()

    print(f'[scan] listing finished matches without tournament_refresh marker...')
    affected = find_affected_fixtures(only_fid=args.fid)
    if not affected:
        print('[scan] nothing to do — all finished matches have markers.')
        return

    print(f'[scan] found {len(affected)} affected match(es):')
    for a in affected:
        print(f'  {a["fid"]}  {a["home_code"]} vs {a["away_code"]}'
              f'  (match_time={a["match_time"]}  fetched_at={a["fetched_at"]})')

    # Collect unique country codes across all affected matches → refresh each
    # team ONCE, no matter how many of its matches are stuck. gctp is per-team
    # tournament accumulator, so refreshing team X once propagates to all its
    # past matches in players:{pid}.
    codes = sorted({a['home_code'] for a in affected if a['home_code']}
                   | {a['away_code'] for a in affected if a['away_code']})
    print(f'\n[plan] unique teams to refresh: {len(codes)} → {",".join(codes)}')

    if not args.apply:
        print('\n[dry-run] re-run with --apply to actually refresh + stamp markers.')
        return

    print(f'\n[apply] invoking team-v3-refresh.py --teams {",".join(codes)} --apply')
    rc, out = run_team_refresh(codes, apply=True)
    # Always show the child script's output — it has its own write counters
    print(out)
    if rc != 0:
        print(f'[apply] team-v3-refresh.py exited {rc} — NOT stamping markers'
              f' (re-run after fixing root cause).')
        sys.exit(rc)

    print(f'\n[apply] gctp refresh succeeded; stamping tournament_refresh_done_at'
          f' on {len(affected)} lineup records...')
    stamped = 0
    for a in affected:
        try:
            if stamp_marker(a['fid']):
                stamped += 1
                print(f'  stamped {a["fid"]} ({a["home_code"]} vs {a["away_code"]})')
        except Exception as e:
            print(f'  FAILED stamp {a["fid"]}: {e}')
    print(f'\n[done] stamped {stamped}/{len(affected)} lineup records.')


if __name__ == '__main__':
    main()
