#!/usr/bin/env python3
"""
Per-team v3 player refresh — clean replacement of batch-v3-player-refresh.py.

Uses gctp_* classifications (FIFA's team-filtered endpoints) which return ALL ~26
players of a team in one call, with no top-50 truncation.

For each team:
  1. fetch gctp_top_scorer    → goals, assists, total_competition_minutes_played
  2. fetch gctp_attack        → attempt_at_goal_*, xg, corners, possession, etc.
  3. fetch gctp_discipline    → fouls_for, fouls_against, yellow_cards, red_cards,
                                 indirect_red_cards, offsides
  4. merge by player_id, build v3 tournament_stats, hash-compare, PUT if changed.

KV writes: 1 per changed player; hash short-circuit when unchanged. Source tag
"mangodev_gctp" — easy to audit later.

Usage:
    python3 scripts/team-v3-refresh.py --teams ARG,ESP            # dry-run
    python3 scripts/team-v3-refresh.py --teams POR,UZB --apply    # actually write
    python3 scripts/team-v3-refresh.py --all-teams --apply        # all 48
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

CLASSIFICATIONS = ['gctp_top_scorer', 'gctp_attack', 'gctp_discipline', 'gctp_goalkeeping']

# v3 bucket assignment (matches index.html STATS_CATEGORIES)
DISCIPLINE_KEYS = {'fouls_for', 'fouls_against', 'yellow_cards', 'red_cards', 'indirect_red_cards', 'offsides'}
# Goalkeeping slugs added 2026-06-26 after probe confirmed gctp_goalkeeping
# returns 3 fields. `goals_conceded` reclassified here too — FIFA serves it on
# gctp_attack but conceptually it's keeper data; routing it to `goalkeeping`
# aligns the schema with the UI grouping.
GOALKEEPING_KEYS = {
    'goalkeeper_saves',
    'goalkeeper_defensive_actions_inside_penalty_area',
    'goalkeeper_defensive_actions_outside_penalty_area',
    'goals_conceded',
}
TOP_LEVEL_MAP   = {'total_competition_minutes_played': 'minutes_played',
                   'matches_played': 'matches_played',
                   'total_competition_matches_played': 'matches_played'}
# Everything else → attacking bucket.


CF_TOK = None
GAMEDAY_TOK = None


def get_cf_token():
    return subprocess.run(['security','find-generic-password','-s','cloudflare-api-token','-w'],
                          capture_output=True, text=True).stdout.strip()


def cf_headers():  return {'Authorization': f'Bearer {CF_TOK}'}
def fifa_headers():
    return {
        'Authorization': f'Bearer {GAMEDAY_TOK}',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.fifa.com',
        'Referer': 'https://www.fifa.com/',
        'Accept': 'application/json',
    }


def kv_get(key):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    req = urllib.request.Request(url, headers=cf_headers())
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError) as e:
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def kv_put(key, value):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={**cf_headers(), 'Content-Type': 'application/octet-stream'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read())
                if not j.get('success'):
                    raise RuntimeError(f'KV put failed: {j}')
                return
        except (urllib.error.URLError, ConnectionResetError, TimeoutError) as e:
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def fetch_teams():
    """Get list of all 48 teams in this competition.

    mango caps limit≤~20 per request (returns "Pagination limit threshold breached"
    above that), so we paginate via skip."""
    teams = []
    skip = 0
    PAGE = 20
    while True:
        q = '_externalCompetitionId==`{}`'.format(SEASON_ID)
        url = ('https://gameday-prod.fifa.mangodev.co.uk/1-0/teams?query='
               + urllib.parse.quote(q)
               + f'&skip={skip}&limit={PAGE}')
        req = urllib.request.Request(url, headers=fifa_headers())
        # retry on transient 429
        page_items = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.loads(r.read())
                page_items = d.get('items', [])
                break
            except urllib.error.HTTPError as e:
                if e.code in (429, 503) and attempt < 3:
                    wait = 15 * (attempt + 1)
                    print(f'  fetch_teams HTTP {e.code} skip={skip}, retry in {wait}s...', file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise
        if not page_items:
            break
        teams.extend(page_items)
        if len(page_items) < PAGE:
            break
        skip += len(page_items)
        time.sleep(0.4)
    return teams


def fetch_team_classification(team_external_id, classification):
    """Fetch one classification's wildcard story for a single team."""
    q = (f'(and resourceStatus==`urn:gd:resourceStatus:active` '
         f'_externalId~`urn:gd:story:classification:{classification}:competitionId:{SEASON_ID}:teamId:{team_external_id}:(.*):rank_asc:page:1$`)')
    url = ('https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query='
           + urllib.parse.quote(q)
           + '&skip=0&limit=20'
           + '&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc')
    req = urllib.request.Request(url, headers=fifa_headers())
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()).get('items', [])
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3:
                wait = 15 * (attempt + 1)
                print(f'    HTTP {e.code}, retry in {wait}s...', file=sys.stderr)
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError) as e:
            if attempt < 3:
                wait = 3 * (attempt + 1)
                print(f'    network {type(e).__name__}, retry in {wait}s...', file=sys.stderr)
                time.sleep(wait)
                continue
            raise


def _story_primary_stat(story):
    """Extract the 'stat' name from a story's _externalId."""
    eid = story.get('_externalId', '') or ''
    parts = eid.split(':')
    for i, p in enumerate(parts):
        if p in ('rank_asc', 'rank_desc'):
            if i >= 1:
                return parts[i - 1]
    return None


# Authoritative classification per stat field.
# DISCOVERED BUG (2026-06-24, post-POR-UZB match):
#   `gctp_top_scorer:goals` story says Ronaldo goals=2 (correct)
#   `gctp_attack:goals` story says Ronaldo goals=0 (STALE — possibly "open play goals"
#   or a different definition)
# So `goals` and `assists` MUST come from `gctp_top_scorer`. Attack-detail fields
# (attempts, xg, corners) come from `gctp_attack`. Discipline from `gctp_discipline`.
# If a stat is recorded in multiple classifications, the one listed here wins.
AUTHORITATIVE_CLS = {
    # gctp_top_scorer — accumulated tournament totals
    'goals': 'gctp_top_scorer',
    'assists': 'gctp_top_scorer',
    'total_competition_minutes_played': 'gctp_top_scorer',
    'total_competition_matches_played': 'gctp_top_scorer',
    'fdcp_top_scorer_rank': 'gctp_top_scorer',
    # gctp_attack — attacking detail
    'attempt_at_goal': 'gctp_attack',
    'attempt_at_goal_on_target': 'gctp_attack',
    'attempt_at_goal_on_target_rate': 'gctp_attack',
    'attempt_at_goal_conversion_rate': 'gctp_attack',
    'attempt_at_goal_inside_the_penalty_area': 'gctp_attack',
    'attempt_at_goal_outside_the_penalty_area': 'gctp_attack',
    'headed_attempt_at_goal': 'gctp_attack',
    'number_of_shot_ending_sequences': 'gctp_attack',
    'goals_conceded': 'gctp_attack',
    'corners': 'gctp_attack',
    'xg': 'gctp_attack',
    'xg_goal_effiency_rate': 'gctp_attack',
    'possession': 'gctp_attack',
    # gctp_discipline — discipline fields
    'fouls_for': 'gctp_discipline',
    'fouls_against': 'gctp_discipline',
    'yellow_cards': 'gctp_discipline',
    'red_cards': 'gctp_discipline',
    'indirect_red_cards': 'gctp_discipline',
    'offsides': 'gctp_discipline',
    # gctp_goalkeeping — added 2026-06-26
    'goalkeeper_saves': 'gctp_goalkeeping',
    'goalkeeper_defensive_actions_inside_penalty_area': 'gctp_goalkeeping',
    'goalkeeper_defensive_actions_outside_penalty_area': 'gctp_goalkeeping',
}


def extract_players_from_stories(stories, classification):
    """Return {player_id: {stats: {}, name_multilang: {}, photo_url, country_code, team_id}}.

    CRITICAL: mangodev returns the same stat field across multiple classifications/stories
    with inconsistent values (some stale). Use AUTHORITATIVE_CLS to lock each stat to ONE
    classification. Within a classification, use only the story's primary stat.
    """
    by_pid = {}
    for story in stories:
        primary_stat = _story_primary_stat(story)
        for actor in story.get('actors', []):
            pid = actor.get('key',{}).get('_externalSportsPersonId')
            if not pid: continue
            entry = by_pid.setdefault(pid, {
                'stats': {}, 'name_multilang': {}, 'photo_url': None,
                'country_code': None, 'team_id': None,
            })
            for k, v in (actor.get('name') or {}).items():
                if v: entry['name_multilang'][k] = v
            for t in actor.get('tags',[]):
                n = t.get('name','')
                value = t.get('value')
                if n.startswith('urn:gd:tag:football:stats:'):
                    stat = n.split(':')[-1]
                    # Two-level gating:
                    # 1. only adopt this story's primary stat (intra-classification dedup)
                    # 2. only adopt the stat from its authoritative classification (inter-classification truth)
                    if primary_stat is not None and stat != primary_stat:
                        continue
                    auth = AUTHORITATIVE_CLS.get(stat)
                    if auth is not None and auth != classification:
                        continue
                    if value is None and stat in entry['stats']: continue
                    entry['stats'][stat] = value
                elif n == 'urn:gd:tag:story:staff:image' and not entry['photo_url']:
                    entry['photo_url'] = value
                elif n == 'urn:gd:tag:story:team:abbreviation' and not entry['country_code']:
                    entry['country_code'] = value
            tid = actor.get('key',{}).get('_externalTeamId','')
            if tid and not entry['team_id']:
                entry['team_id'] = tid.split('_')[-1]
    return by_pid


def fnv1a_32(s):
    h = 0x811c9dc5
    for c in s:
        h ^= ord(c)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, 'x')


def build_tournament_stats(stats_dict):
    top, att, dis, gk = {}, {}, {}, {}
    for k, v in stats_dict.items():
        if k in DISCIPLINE_KEYS:
            dis[k] = v
        elif k in GOALKEEPING_KEYS:
            gk[k] = v
        elif k in TOP_LEVEL_MAP:
            top[TOP_LEVEL_MAP[k]] = v
        else:
            att[k] = v
    return top, att, dis, gk


def hash_record_payload(record):
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
        'goalkeeping': ts.get('goalkeeping'),
    }
    return fnv1a_32(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')))


def refresh_team(team_meta, dry_run, countries_lookup=None, max_cls_workers=3, max_kv_workers=8):
    """Refresh all players in a single team. Returns (written_count, unchanged_count, errors).

    Parallelism:
      - 3 classifications fetched concurrently (max_cls_workers, default 3 = all)
      - 26 player KV get+put done concurrently (max_kv_workers, default 8)
    These two pools run sequentially relative to each other (classifications must
    complete before per-player merge+write), but each pool is fully parallel.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    team_eid = team_meta['_externalId']           # e.g. "285023_43922"
    team_id  = team_eid.split('_')[-1]
    team_name = team_meta.get('name',{}).get('eng','?')
    # 3-letter country code from shortName — authoritative fallback when actor tags miss it.
    team_country_code = (team_meta.get('shortName') or {}).get('eng', '').upper() or None
    team_country_zh = (countries_lookup or {}).get(team_country_code) if team_country_code else None

    # Stage 1: fetch all 3 classifications in PARALLEL
    merged_players = {}
    with ThreadPoolExecutor(max_workers=max_cls_workers) as pool:
        futs = {pool.submit(fetch_team_classification, team_eid, cls): cls for cls in CLASSIFICATIONS}
        for fut in as_completed(futs):
            cls = futs[fut]
            try:
                stories = fut.result()
            except Exception as e:
                print(f'  [{team_name}] {cls} fetch err: {e}', file=sys.stderr)
                return 0, 0, 1
            cls_players = extract_players_from_stories(stories, cls)
            # Merge into merged_players (single-threaded merge — safe)
            for pid, info in cls_players.items():
                tgt = merged_players.setdefault(pid, {
                    'stats': {}, 'name_multilang': {}, 'photo_url': None,
                    'country_code': None, 'team_id': None,
                })
                tgt['stats'].update(info['stats'])
                tgt['name_multilang'].update(info['name_multilang'])
                tgt['photo_url']    = tgt['photo_url'] or info['photo_url']
                tgt['country_code'] = tgt['country_code'] or info['country_code']
                tgt['team_id']      = tgt['team_id'] or info['team_id']

    print(f'  [{team_name} / {team_id}] {len(merged_players)} players from {len(CLASSIFICATIONS)} classifications', file=sys.stderr)

    now = datetime.now(timezone.utc).isoformat().replace('+00:00', '+00:00')

    # Stage 2: per-player KV get+put in PARALLEL.
    # Each player needs: kv_get(existing) → build record → hash compare → kv_put (maybe).
    # All three steps are independent across pids, so we run the full pipeline in
    # a thread pool. KV ops are I/O bound; threading is the right tool.
    def process_player(pid_agg):
        pid, agg = pid_agg
        top, attacking, discipline, goalkeeping = build_tournament_stats(agg['stats'])
        for noise_key in ('fdcp_top_scorer_rank', 'xg_goal_effiency_rate'):
            attacking.pop(noise_key, None)
        existing = kv_get(f'players:{pid}') or {}
        new_name = {**(existing.get('name') or {}), **agg['name_multilang']}
        country_code = agg['country_code'] or existing.get('country_code') or team_country_code
        country_zh = (countries_lookup or {}).get(country_code) if country_code else None
        new_record = {
            **existing,
            'id': pid,
            'country_code': country_code,
            'country_zh': country_zh or existing.get('country_zh'),
            'team_id': agg['team_id'] or existing.get('team_id') or team_id,
            'photo_url': agg['photo_url'] or existing.get('photo_url'),
            'name': new_name,
            'name_default': new_name.get('eng') or existing.get('name_default') or f'Player {pid}',
            'tournament_stats': {
                'version': 3,
                'fetched_at': now,
                'source': 'mangodev_gctp',
                **top,
                'attacking': attacking,
                'discipline': discipline,
                'goalkeeping': goalkeeping,
            },
            'last_updated': now,
        }
        for stale in ('fdh_match_ids', 'last_match_id', '_lineup_hash'):
            new_record.pop(stale, None)
        new_hash = hash_record_payload(new_record)
        new_record['_hash'] = new_hash
        if existing.get('_hash') == new_hash:
            return ('unchanged', pid, None)
        if dry_run:
            return ('would_write', pid, None)
        try:
            kv_put(f'players:{pid}', new_record)
            return ('written', pid, None)
        except Exception as e:
            return ('error', pid, str(e))

    written = unchanged = errored = 0
    with ThreadPoolExecutor(max_workers=max_kv_workers) as pool:
        for outcome, pid, err in pool.map(process_player, merged_players.items()):
            if outcome == 'written' or outcome == 'would_write':
                written += 1
            elif outcome == 'unchanged':
                unchanged += 1
            else:
                print(f'    ERR {pid}: {err}', file=sys.stderr)
                errored += 1

    print(f'  [{team_name}] {("would write" if dry_run else "wrote")}={written} unchanged={unchanged} errors={errored}', file=sys.stderr)
    return written, unchanged, errored


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--teams', help='comma-separated 3-letter country codes, e.g. POR,UZB,ENG')
    g.add_argument('--all-teams', action='store_true', help='refresh all 48 teams')
    ap.add_argument('--apply', action='store_true', help='actually write KV')
    ap.add_argument('--budget', type=int, default=DEFAULT_BUDGET)
    ap.add_argument('--workers', type=int, default=6,
                    help='Concurrent team refreshes (default 6). Each team also internally parallelizes 3 classifications + 8 player KV ops.')
    ap.add_argument('--sleep-team', type=float, default=0,
                    help='[deprecated] Inter-team delay — has no effect now that teams run in parallel; kept for arg compat.')
    args = ap.parse_args()

    global CF_TOK, GAMEDAY_TOK
    CF_TOK = get_cf_token()
    if not CF_TOK:
        sys.exit('CLOUDFLARE_API_TOKEN missing')
    gd = kv_get('gameday_token')
    if not gd: sys.exit('gameday_token not in KV')
    GAMEDAY_TOK = gd['token']

    print(f'[team-refresh] mode={"APPLY" if args.apply else "DRY-RUN"} budget={args.budget}', file=sys.stderr)

    # Load countries seed once so each refresh_team can fill country_zh consistently
    countries_kv = kv_get('countries') or {}
    countries_lookup = {c['code']: c.get('zh') for c in (countries_kv.get('items') or [])}
    print(f'[team-refresh] {len(countries_lookup)} countries in seed', file=sys.stderr)

    all_teams = fetch_teams()
    if not all_teams:
        sys.exit('no teams returned')
    print(f'[team-refresh] competition has {len(all_teams)} teams', file=sys.stderr)

    if args.all_teams:
        targets = all_teams
    else:
        wanted = {c.strip().upper() for c in args.teams.split(',')}
        targets = []
        # Match strictly by shortName.eng (FIFA's 3-letter code), no fuzzy substring.
        # Map shortName → team
        by_short = {}
        for t in all_teams:
            short = (t.get('shortName',{}).get('eng','') or '').upper()
            if short:
                by_short.setdefault(short, []).append(t)
        unmatched = set()
        for w in wanted:
            hits = by_short.get(w, [])
            if not hits:
                unmatched.add(w)
                continue
            targets.extend(hits)
        if unmatched:
            print(f'[team-refresh] WARNING — unmatched: {unmatched}', file=sys.stderr)
            print('Available shortNames:', sorted(by_short.keys()), file=sys.stderr)
            sys.exit(1)

    print(f'[team-refresh] refreshing {len(targets)} teams', file=sys.stderr)

    # Teams refresh in PARALLEL too (default 6 concurrent). Each team internally
    # runs 3 classifications + 26 player KV ops in their own thread pools, so
    # the effective IO concurrency is ~6 × (3 + 8) = ~66 in-flight requests, well
    # within CF KV's per-account limits. Tuned via --workers.
    from concurrent.futures import ThreadPoolExecutor, as_completed
    total_written = 0
    total_unchanged = 0
    total_errored = 0
    budget_hit = False
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(refresh_team, team, not args.apply, countries_lookup=countries_lookup): team
                for team in targets}
        i = 0
        for fut in as_completed(futs):
            i += 1
            team = futs[fut]
            team_short = (team.get('shortName',{}).get('eng','') or '?').upper()
            try:
                w, u, e = fut.result()
            except Exception as exc:
                print(f'\n[{i}/{len(targets)}] {team_short} CRASH: {exc}', file=sys.stderr)
                total_errored += 1
                continue
            total_written += w
            total_unchanged += u
            total_errored += e
            print(f'[{i}/{len(targets)}] {team_short} done', file=sys.stderr)
            if total_written >= args.budget:
                print(f'\n[team-refresh] BUDGET HIT ({total_written} >= {args.budget}). Letting in-flight finish, no new teams.', file=sys.stderr)
                # Best-effort cancel — pool.map / submit don't support clean cancel
                # of running futures, but we can avoid printing more "done" beyond
                # the budget message. The in-flight teams will still finish their own work.
                budget_hit = True

    print(f'\n[team-refresh] DONE. {("APPLIED" if args.apply else "DRY-RUN")} | written={total_written} unchanged={total_unchanged} errored={total_errored}{" (budget hit)" if budget_hit else ""}', file=sys.stderr)


if __name__ == '__main__':
    main()
