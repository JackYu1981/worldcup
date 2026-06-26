#!/usr/bin/env python3
"""
backfill_player_zho.py — fetch Chinese (and other locale) names from FIFA
mangodev `gctp_*` classification stories for ALL WC teams + classifications,
dump to local JSON. PHASE 1: NO KV WRITES.

Why this exists:
  KV `players:{pid}.name.zho` covers only ~30-50% of WC squad rosters because
  the fifa-scraper worker only fetches 3 gctp_* classifications (top_scorer,
  attack, discipline) on a per-match basis. Bench / goalkeeping / defensive
  players who never make those classifications miss out on multilingual names.

What this does:
  - Read `fifa_team_external_ids` from KV (32 WC teams → mangodev externalId)
  - For each team, fetch 6 gctp_* classifications (3 existing + 3 new):
    * gctp_top_scorer (verified)
    * gctp_attack (verified)
    * gctp_discipline (verified)
    * gctp_defense (PROBE)
    * gctp_goalkeeping (PROBE)
    * gctp_distribution (PROBE)
  - Extract every `actor.name.zho` (+ other locales as bonus)
  - Compare against KV `players:{pid}.name.zho`
  - Output: scripts/data/player_zho_backfill.json with:
    * { pid: { current_zho, found_zho, name_default, country_code,
               sources: [classification ids], diff_type: 'new'|'updated'|'same'|'kv_only' } }
  - Also output coverage stats

ZERO KV WRITES. Run with `--apply` only after user reviews the output.

Usage:
  python3 scripts/backfill_player_zho.py                # fetch + dry-run
  python3 scripts/backfill_player_zho.py --probe-only   # just try 3 new classifications
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'
SEASON_ID = '285023'

CLASSIFICATIONS_VERIFIED = [
    'gctp_top_scorer',
    'gctp_attack',
    'gctp_discipline',
]
CLASSIFICATIONS_PROBE = [
    # 'gctp_defense',  # 404 — removed after probe
    'gctp_goalkeeping',
    'gctp_distribution',
]

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), 'data', 'player_zho_backfill.json')


def get_cf_token():
    r = subprocess.run(['security', 'find-generic-password',
                        '-s', 'cloudflare-api-token', '-w'],
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


CF_TOK = get_cf_token()


def kv_get(key):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise
        except Exception:
            if attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise


# ============= FIFA gameday token =============

TOKEN_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token'
BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
    'Origin': 'https://www.fifa.com',
    'Referer': 'https://www.fifa.com/',
    'Accept': 'application/json',
}


def fetch_gameday_token():
    """Mirrors workers/fifa-scraper/lib/token.js ensureGamedayToken. We don't
    cache locally — one-shot script invokes once."""
    req = urllib.request.Request(TOKEN_URL, headers=BROWSER_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())
    if not j.get('token'):
        raise RuntimeError(f'gameday token missing: {str(j)[:200]}')
    return j['token']


def fetch_team_classification(token, team_external_id, classification):
    """Mirror of fetchTeamClassification in lib/tournament-refresh.js."""
    q = (
        '(and resourceStatus==`urn:gd:resourceStatus:active` '
        '_externalId~`urn:gd:story:classification:' + classification +
        ':competitionId:' + SEASON_ID + ':teamId:' + team_external_id +
        ':(.*):rank_asc:page:1$`)'
    )
    url = ('https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query='
           + urllib.parse.quote(q)
           + '&skip=0&limit=20'
           + '&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc')
    headers = {**BROWSER_HEADERS, 'Authorization': f'Bearer {token}'}
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read())
            return j.get('items', [])
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f'{classification} HTTP {e.code}')
        except Exception:
            if attempt < 2:
                time.sleep(2 + attempt)
                continue
            raise


def extract_players_from_stories(stories):
    """Mirror of extractPlayersFromStories. Returns dict{pid: {name_multilang, photo_url}}."""
    by_pid = {}
    for story in stories:
        for actor in (story.get('actors') or []):
            pid = (actor.get('key') or {}).get('_externalSportsPersonId')
            if not pid:
                continue
            entry = by_pid.setdefault(pid, {
                'name_multilang': {},
                'photo_url': None,
                'country_code': None,
            })
            for k, v in (actor.get('name') or {}).items():
                if v:
                    entry['name_multilang'][k] = v
            # Photo url (might be useful diagnostic, not required for zho)
            pic = actor.get('picture') or actor.get('mainPicture')
            if isinstance(pic, dict) and not entry['photo_url']:
                entry['photo_url'] = pic.get('url')
    return by_pid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe-only', action='store_true',
                    help='Only probe the 3 NEW classifications + 1 team, exit')
    args = ap.parse_args()

    print('[1/4] Fetching FIFA gameday token...', file=sys.stderr)
    token = fetch_gameday_token()
    print(f'  token OK ({token[:30]}...)', file=sys.stderr)

    print('[2/4] Loading fifa_team_external_ids from KV...', file=sys.stderr)
    team_ids = kv_get('fifa_team_external_ids') or {}
    print(f'  loaded {len(team_ids)} team mappings', file=sys.stderr)

    if args.probe_only:
        # Probe: pick 1 team (the first one), try each NEW classification, print result
        probe_team_cc, probe_team_id = next(iter(team_ids.items()))
        print(f'\n[PROBE] Using team {probe_team_cc} → externalId {probe_team_id}', file=sys.stderr)
        for cls in CLASSIFICATIONS_PROBE:
            try:
                stories = fetch_team_classification(token, probe_team_id, cls)
                if stories:
                    extracted = extract_players_from_stories(stories)
                    sample = next(iter(extracted.values()), {})
                    print(f'  ✅ {cls}: {len(stories)} stories, {len(extracted)} unique players, sample name: {sample.get("name_multilang",{}).get("eng","?")}', file=sys.stderr)
                else:
                    print(f'  ⚠️ {cls}: 0 stories returned', file=sys.stderr)
            except Exception as e:
                print(f'  ❌ {cls}: {e}', file=sys.stderr)
        return

    # Full fetch
    classifications = CLASSIFICATIONS_VERIFIED + CLASSIFICATIONS_PROBE
    print(f'\n[3/4] Fetching {len(team_ids)} teams × {len(classifications)} classifications...', file=sys.stderr)
    all_players = {}  # pid → {name_multilang, photo_url, sources: [cc/cls...]}
    failed = []
    total_requests = 0
    for cc, team_external_id in team_ids.items():
        for cls in classifications:
            total_requests += 1
            try:
                stories = fetch_team_classification(token, team_external_id, cls)
                extracted = extract_players_from_stories(stories)
                for pid, info in extracted.items():
                    rec = all_players.setdefault(pid, {
                        'name_multilang': {},
                        'photo_url': None,
                        'country_code': cc,
                        'sources': [],
                    })
                    rec['name_multilang'].update(info['name_multilang'])
                    if not rec['photo_url'] and info['photo_url']:
                        rec['photo_url'] = info['photo_url']
                    src_tag = f'{cls}@{cc}'
                    if src_tag not in rec['sources']:
                        rec['sources'].append(src_tag)
                # polite throttle
                time.sleep(0.15)
            except Exception as e:
                failed.append((cc, cls, str(e)))
                print(f'  ✗ {cc}/{cls}: {e}', file=sys.stderr)
        if (total_requests % 12) == 0:
            print(f'    progress: {total_requests}/{len(team_ids)*len(classifications)} requests, {len(all_players)} unique players', file=sys.stderr)

    print(f'  done: {total_requests} requests, {len(failed)} failures, {len(all_players)} unique players', file=sys.stderr)

    print(f'\n[4/4] Categorizing players (KV compare SKIPPED — fetch-only mode)...', file=sys.stderr)
    # PHASE 1 mode: skip the KV compare entirely. Just emit what mangodev gave us
    # so user can review coverage. KV diff/write happens in a separate phase.
    out = {}
    for pid, rec in all_players.items():
        found_zho = rec['name_multilang'].get('zho')
        name_eng = rec['name_multilang'].get('eng', '?')
        out[pid] = {
            'name_default': name_eng,
            'country_code': rec['country_code'],
            'found_zho': found_zho,
            'sources': rec['sources'],
            'all_locales_found': sorted(list(rec['name_multilang'].keys())),
        }

    stats = {
        'total_scraped': len(out),
        'has_zho': sum(1 for v in out.values() if v['found_zho']),
        'no_zho': sum(1 for v in out.values() if not v['found_zho']),
    }

    # Coverage by country
    by_country_stats = {}
    for pid, info in out.items():
        cc = info['country_code']
        s = by_country_stats.setdefault(cc, {'total': 0, 'has_zho': 0})
        s['total'] += 1
        if info['found_zho']:
            s['has_zho'] += 1

    # Write output
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump({
            'meta': {
                'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S+08:00', time.localtime()),
                'classifications_used': classifications,
                'total_teams': len(team_ids),
                'total_requests': total_requests,
                'failed_requests': failed,
            },
            'stats': stats,
            'by_country': by_country_stats,
            'players': out,
        }, f, ensure_ascii=False, indent=2)
    print(f'\n[DONE] dumped to {OUTPUT_PATH}', file=sys.stderr)
    print(f'  Total players scraped: {len(out)}', file=sys.stderr)
    print(f'  Stats: {stats}', file=sys.stderr)
    print(f'\n  Coverage by country:', file=sys.stderr)
    for cc in sorted(by_country_stats.keys()):
        s = by_country_stats[cc]
        rate = (s['has_zho'] / s['total'] * 100) if s['total'] else 0
        marker = ''  # KV compare deferred to phase 2
        print(f'    {cc}: {s["has_zho"]}/{s["total"]} ({rate:.0f}%){marker}', file=sys.stderr)


if __name__ == '__main__':
    main()
