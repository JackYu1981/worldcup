#!/usr/bin/env python3
"""
Batch refresh all players to v3 schema.

Workflow:
1. Fetch 3 mangodev classifications (gcp_top_scorer, gcp_attack, gcp_discipline)
   with wildcard stat queries — each returns ~10-15 stories × 50 actors.
2. Aggregate by player_id (one player may appear in multiple classifications).
3. For each player:
   - Read existing players:{id} record
   - Build v3 tournament_stats from collected tags
   - Hash-compare; only PUT if changed
4. Print running write count; abort if > --budget.

Default dry-run; pass --apply to actually write.

KV write budget: ~500 (1 per changed player, ~0 for unchanged).

Env required:
    CLOUDFLARE_API_TOKEN (or from Keychain "cloudflare-api-token")
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
SEASON_ID = '285023'
DEFAULT_BUDGET = 500

CLASSIFICATIONS = ['gcp_top_scorer', 'gcp_attack', 'gcp_discipline']

# v3 schema bucket assignment (must match index.html STATS_CATEGORIES)
DISCIPLINE_KEYS = {'fouls_for', 'fouls_against', 'yellow_cards', 'red_cards', 'indirect_red_cards', 'offsides'}
TOP_LEVEL_MAP   = {'total_competition_minutes_played': 'minutes_played', 'matches_played': 'matches_played'}
# Everything else (goals, assists, attempt_at_*, xg, corners, headed_*, fdcp_top_scorer_rank,
# xg_goal_effiency_rate, ...) goes under attacking.


def get_cf_token():
    tok = subprocess.run(['security', 'find-generic-password', '-s', 'cloudflare-api-token', '-w'],
                         capture_output=True, text=True).stdout.strip()
    if not tok:
        sys.exit('CLOUDFLARE_API_TOKEN not in Keychain')
    return tok


CF_TOK = None


def cf_headers():
    return {'Authorization': f'Bearer {CF_TOK}'}


def fifa_headers(gameday_tok):
    return {
        'Authorization': f'Bearer {gameday_tok}',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.fifa.com',
        'Referer': 'https://www.fifa.com/',
        'Accept': 'application/json',
    }


def kv_get(key):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    req = urllib.request.Request(url, headers=cf_headers())
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def kv_put(key, value):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={**cf_headers(), 'Content-Type': 'application/octet-stream'})
    with urllib.request.urlopen(req, timeout=30) as r:
        envelope = json.loads(r.read())
        if not envelope.get('success'):
            raise RuntimeError(f'KV put failed: {envelope}')


def fetch_classification(gameday_tok, classification):
    """Return list of all stories for a classification (wildcard stat query).

    Mango accepts limit≤20 for wildcard queries (one-shot fetches all stat tables
    for a classification — 11-15 stories typical). Single 429 retry with 5s backoff."""
    q = (f'(and resourceStatus==`urn:gd:resourceStatus:active` '
         f'_externalId~`urn:gd:story:classification:{classification}:competitionId:{SEASON_ID}:(.*):rank_asc:page:1$`)')
    url = ('https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query='
           + urllib.parse.quote(q)
           + '&skip=0&limit=20'
           + '&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc')
    req = urllib.request.Request(url, headers=fifa_headers(gameday_tok))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()).get('items', [])
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 2:
                wait = 5 * (attempt + 1)
                print(f'    HTTP {e.code}, retry in {wait}s...', file=sys.stderr)
                time.sleep(wait)
                continue
            raise
    return []


def fnv1a_32(s):
    """FNV-1a 32-bit hash — same algo as workers/fifa-scraper/lib/lineup.js."""
    h = 0x811c9dc5
    for c in s:
        h ^= ord(c)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, 'x')


def aggregate_players(gameday_tok):
    """Return { player_id: { stats: dict, name_multilang: dict, photo_url, country_code, team_id } }."""
    by_pid = {}
    for cls in CLASSIFICATIONS:
        print(f'[fetch] {cls}...', file=sys.stderr, end=' ')
        stories = fetch_classification(gameday_tok, cls)
        stat_count_before = sum(len(p.get('stats', {})) for p in by_pid.values())
        actors_seen = 0
        for story in stories:
            for actor in story.get('actors', []):
                pid = actor.get('key', {}).get('_externalSportsPersonId')
                if not pid:
                    continue
                actors_seen += 1
                entry = by_pid.setdefault(pid, {
                    'stats': {}, 'name_multilang': {}, 'photo_url': None,
                    'country_code': None, 'team_id': None,
                })
                # Multi-lang name
                for k, v in (actor.get('name') or {}).items():
                    if v:
                        entry['name_multilang'][k] = v
                # Tags
                for t in actor.get('tags', []):
                    name = t.get('name', '')
                    value = t.get('value')
                    if name.startswith('urn:gd:tag:football:stats:'):
                        stat_key = name.split(':')[-1]
                        # null values exist in some classifications — keep as null only if no existing value
                        if value is None and stat_key in entry['stats']:
                            continue
                        entry['stats'][stat_key] = value
                    elif name == 'urn:gd:tag:story:staff:image' and not entry['photo_url']:
                        entry['photo_url'] = value
                    elif name == 'urn:gd:tag:story:team:abbreviation' and not entry['country_code']:
                        entry['country_code'] = value
                # team_id from key
                tid = actor.get('key', {}).get('_externalTeamId', '')
                if tid and not entry['team_id']:
                    entry['team_id'] = tid.split('_')[-1]
        stat_count_after = sum(len(p.get('stats', {})) for p in by_pid.values())
        print(f'{len(stories)} stories, {actors_seen} actor refs, +{stat_count_after - stat_count_before} stat fields', file=sys.stderr)
    return by_pid


def build_tournament_stats(stats_dict):
    """Bucket flat stats dict into v3 tournament_stats schema."""
    out_top = {}
    out_att = {}
    out_dis = {}
    for k, v in stats_dict.items():
        if k in DISCIPLINE_KEYS:
            out_dis[k] = v
        elif k in TOP_LEVEL_MAP:
            out_top[TOP_LEVEL_MAP[k]] = v
        else:
            out_att[k] = v
    return out_top, out_att, out_dis


def hash_record_payload(record):
    """Hash the user-visible payload of a player record. Excludes last_updated/fetched_at
    so re-runs with same data are idempotent."""
    ts = record.get('tournament_stats') or {}
    payload = {
        'country_code': record.get('country_code'),
        'team_id': record.get('team_id'),
        'photo_url': record.get('photo_url'),
        'name': record.get('name'),
        'name_default': record.get('name_default'),
        'minutes_played': ts.get('minutes_played'),
        'matches_played': ts.get('matches_played'),
        'attacking': ts.get('attacking'),
        'discipline': ts.get('discipline'),
    }
    return fnv1a_32(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually write KV (default dry-run)')
    ap.add_argument('--budget', type=int, default=DEFAULT_BUDGET, help='abort if writes would exceed this')
    ap.add_argument('--limit', type=int, default=None, help='only process first N players')
    ap.add_argument('--sleep', type=float, default=0.0, help='seconds to sleep between writes')
    args = ap.parse_args()

    global CF_TOK
    CF_TOK = get_cf_token()

    print(f'[batch] mode={"APPLY" if args.apply else "DRY-RUN"} budget={args.budget}\n', file=sys.stderr)

    gd_tok = kv_get('gameday_token')
    if not gd_tok:
        sys.exit('gameday_token not in KV')
    gameday_tok = gd_tok['token']

    # Step 1: aggregate
    by_pid = aggregate_players(gameday_tok)
    print(f'\n[aggregate] {len(by_pid)} unique players', file=sys.stderr)

    pids = sorted(by_pid.keys())
    if args.limit:
        pids = pids[:args.limit]
        print(f'[limit] processing first {len(pids)}', file=sys.stderr)

    # Step 2 + 3: read + merge + write
    written = 0
    unchanged = 0
    errored = 0
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', '+00:00')

    for i, pid in enumerate(pids, 1):
        agg = by_pid[pid]
        top, attacking, discipline = build_tournament_stats(agg['stats'])

        existing = kv_get(f'players:{pid}') or {}
        new_name = {**(existing.get('name') or {}), **agg['name_multilang']}
        new_record = {
            **existing,
            'id': pid,
            'country_code': agg['country_code'] or existing.get('country_code'),
            'team_id': agg['team_id'] or existing.get('team_id'),
            'photo_url': agg['photo_url'] or existing.get('photo_url'),
            'name': new_name,
            'name_default': new_name.get('eng') or existing.get('name_default') or f'Player {pid}',
            'tournament_stats': {
                'version': 3,
                'fetched_at': now,
                'source': 'mangodev_gcp',
                **top,
                'attacking': attacking,
                'discipline': discipline,
            },
            'last_updated': now,
        }
        # Strip v1/v2 stale top-level keys (clean migration)
        for stale in ('fdh_match_ids', 'last_match_id', '_lineup_hash'):
            new_record.pop(stale, None)

        # Hash check
        new_hash = hash_record_payload(new_record)
        new_record['_hash'] = new_hash
        if existing.get('_hash') == new_hash:
            unchanged += 1
            if i % 50 == 0:
                print(f'  [{i:4d}/{len(pids)}] unchanged: {agg["name_multilang"].get("eng") or pid} | total writes={written}', file=sys.stderr)
            continue

        if args.apply:
            try:
                kv_put(f'players:{pid}', new_record)
                written += 1
            except Exception as e:
                errored += 1
                print(f'  [{i:4d}/{len(pids)}] ERR {pid}: {e}', file=sys.stderr)
                continue
            if args.sleep:
                time.sleep(args.sleep)
        else:
            written += 1   # would write

        name = agg['name_multilang'].get('eng') or pid
        n_att = len(attacking)
        n_dis = len(discipline)
        if i % 20 == 0 or i == len(pids):
            print(f'  [{i:4d}/{len(pids)}] {("WROTE" if args.apply else "WOULD WRITE")} {pid} ({name}) | att={n_att} dis={n_dis} | total writes={written}', file=sys.stderr)

        if written >= args.budget:
            print(f'\n[batch] BUDGET HIT ({written} >= {args.budget}). Stopping.', file=sys.stderr)
            break

    print(f'\n[batch] DONE. {("APPLIED" if args.apply else "DRY-RUN")} | written={written} unchanged={unchanged} errored={errored} total={len(pids)}', file=sys.stderr)


if __name__ == '__main__':
    main()
