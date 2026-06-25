#!/usr/bin/env python3
"""
migrate-time-fields-iso.py — one-shot normalize all KV time fields to explicit
timezone (ISO 8601). Fixes two categories:

  1. Beijing wall-clock kickoff fields stored as bare 'YYYY-MM-DD HH:MM':
     - matches:{date}.kickoff                       → 'YYYY-MM-DDTHH:MM:00+08:00'
     - fixture_mapping:*.kickoff_local_beijing      → 'YYYY-MM-DDTHH:MM:00+08:00'

  2. UTC timestamps using the '.Z' suffix (forbidden per
     ~/.claude/.../feedback_timestamp_format.md):
     - recommendations/plans/pending_plans:{date}.items[*].submitted_at  → '+00:00'
     - aggregate:settled_plans.plans[*].submitted_at                     → '+00:00'
     - system:logs.logs[*].time                                          → '+00:00'

Pure-business date fields (matches.period, items.date — just 'YYYY-MM-DD')
are LEFT ALONE — no time component means no timezone ambiguity.

Usage:
  python3 scripts/migrate-time-fields-iso.py            # dry-run, list every change
  python3 scripts/migrate-time-fields-iso.py --apply    # actually write
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


# ----- normalization helpers -----

BEIJING_BARE_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$')
Z_SUFFIX_RE = re.compile(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$')


def to_beijing_iso(s):
    """'2026-06-26 04:00' → '2026-06-26T04:00:00+08:00'. Return None if not a match."""
    m = BEIJING_BARE_RE.match(s)
    if not m:
        return None
    y, mo, d, h, mi, sec = m.groups()
    sec = sec or '00'
    return f'{y}-{mo}-{d}T{h}:{mi}:{sec}+08:00'


def z_to_utc(s):
    """'2026-06-10T23:28:38.567Z' → '2026-06-10T23:28:38.567+00:00'."""
    m = Z_SUFFIX_RE.match(s)
    if not m:
        return None
    return m.group(1) + '+00:00'


# ----- per-schema migrators -----

def migrate_matches(key, val, log):
    """matches:{date}.matches[*].kickoff → ISO with +08:00."""
    if not isinstance(val, dict):
        return val, 0
    n = 0
    for m in val.get('matches', []):
        ko = m.get('kickoff')
        if isinstance(ko, str):
            new = to_beijing_iso(ko)
            if new and new != ko:
                log(f'  {key}  match.id={m.get("id")}  kickoff: {ko!r} -> {new!r}')
                m['kickoff'] = new
                n += 1
    return val, n


def migrate_fixture_mapping(key, val, log):
    """fixture_mapping:*.kickoff_local_beijing → ISO with +08:00."""
    if not isinstance(val, dict):
        return val, 0
    n = 0
    kl = val.get('kickoff_local_beijing')
    if isinstance(kl, str):
        new = to_beijing_iso(kl)
        if new and new != kl:
            log(f'  {key}  kickoff_local_beijing: {kl!r} -> {new!r}')
            val['kickoff_local_beijing'] = new
            n += 1
    return val, n


def migrate_items_submitted_at(key, val, log):
    """recommendations/plans/pending_plans:{date}.items[*].submitted_at: .Z → +00:00.
    Also fix items[*].settled_at if present."""
    if not isinstance(val, dict):
        return val, 0
    n = 0
    for it in val.get('items', []):
        for field in ('submitted_at', 'settled_at', 'created_at'):
            v = it.get(field)
            if isinstance(v, str):
                new = z_to_utc(v)
                if new and new != v:
                    log(f'  {key}  item.{field}: {v!r} -> {new!r}')
                    it[field] = new
                    n += 1
    return val, n


def migrate_aggregate_settled_plans(key, val, log):
    """aggregate:settled_plans.plans[*].submitted_at: .Z → +00:00."""
    if not isinstance(val, dict):
        return val, 0
    n = 0
    for p in val.get('plans', []):
        for field in ('submitted_at', 'settled_at', 'created_at'):
            v = p.get(field)
            if isinstance(v, str):
                new = z_to_utc(v)
                if new and new != v:
                    log(f'  {key}  plan.{field}: {v!r} -> {new!r}')
                    p[field] = new
                    n += 1
    return val, n


def migrate_system_logs(key, val, log):
    """system:logs.logs[*].time: .Z → +00:00."""
    if not isinstance(val, dict):
        return val, 0
    n = 0
    for entry in val.get('logs', []):
        v = entry.get('time')
        if isinstance(v, str):
            new = z_to_utc(v)
            if new and new != v:
                log(f'  {key}  logs[*].time: {v!r} -> {new!r}')
                entry['time'] = new
                n += 1
    return val, n


# ----- main scan -----

PLAN = [
    # (prefix, migrator)
    ('matches:',          migrate_matches),
    ('fixture_mapping:',  migrate_fixture_mapping),
    ('recommendations:',  migrate_items_submitted_at),
    ('plans:',            migrate_items_submitted_at),
    ('pending_plans:',    migrate_items_submitted_at),
]
# Singletons handled separately
SINGLETONS = [
    ('aggregate:settled_plans', migrate_aggregate_settled_plans),
    ('system:logs',             migrate_system_logs),
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    apply = args.apply

    total_keys = 0
    total_fields = 0
    written = 0

    def log(s):
        sys.stdout.write(s + '\n')

    print(f'mode: {"APPLY" if apply else "DRY-RUN"}')
    print()

    for prefix, migrator in PLAN:
        keys = kv_list(prefix)
        print(f'=== {prefix} ({len(keys)} keys) ===')
        for k in keys:
            name = k['name']
            val = kv_get(name)
            if val is None:
                continue
            total_keys += 1
            new_val, n = migrator(name, val, log)
            if n > 0:
                total_fields += n
                if apply:
                    kv_put(name, new_val)
                    written += 1

    for name, migrator in SINGLETONS:
        val = kv_get(name)
        if val is None:
            continue
        print(f'=== {name} ===')
        total_keys += 1
        new_val, n = migrator(name, val, log)
        if n > 0:
            total_fields += n
            if apply:
                kv_put(name, new_val)
                written += 1

    print()
    print(f'summary: scanned={total_keys} keys, '
          f'fields_to_change={total_fields}, kv_writes={written if apply else 0}')
    if not apply and total_fields > 0:
        print('re-run with --apply to commit.')


if __name__ == '__main__':
    main()
