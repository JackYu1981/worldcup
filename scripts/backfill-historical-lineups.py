#!/usr/bin/env python3
"""
Backfill historical lineup data for finished World Cup matches.

Runs locally, calls FIFA api directly, writes KV via Cloudflare REST API.
Replicates the same schema as workers/fifa-scraper/lib/lineup.js produces.

Usage:
    python3 scripts/backfill-historical-lineups.py            # dry-run: list what would be done
    python3 scripts/backfill-historical-lineups.py --apply    # actually write KV
    python3 scripts/backfill-historical-lineups.py --apply --limit 5    # only first 5 matches
    python3 scripts/backfill-historical-lineups.py --apply --since 2026-06-22  # only matches on/after date

KV write budget: each match writes
    1 × match_lineups:{500_id}
    up to 52 × players:{id}      (existing player + same lineup_hash → skipped)
    up to 2  × players_by_country:{code}  (same roster_sig → skipped)

Realistically ~10-30 writes per match. 40 matches → 400-1200 writes worst case.
The script prints running total and aborts if it would exceed --budget (default 900).

Env required:
    CLOUDFLARE_API_TOKEN   (or read from Keychain "cloudflare-api-token")
    CLOUDFLARE_ACCOUNT_ID  (default 0bf8afedf1e0b911f3c1733e93546b71)
    KV_NAMESPACE_ID        (default 278f1209ffd84662bd51921370a2fbe9)
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

import urllib.request
import urllib.error


# ---------- Config ----------
ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '0bf8afedf1e0b911f3c1733e93546b71')
KV_NS_ID = os.environ.get('KV_NAMESPACE_ID', '278f1209ffd84662bd51921370a2fbe9')
DEFAULT_BUDGET = 900


def get_cf_token():
    tok = os.environ.get('CLOUDFLARE_API_TOKEN')
    if tok:
        return tok
    r = subprocess.run(['security', 'find-generic-password', '-s', 'cloudflare-api-token', '-w'],
                       capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        sys.exit('CLOUDFLARE_API_TOKEN not in env and Keychain lookup failed')
    return r.stdout.strip()


CF_TOKEN = None


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8'), r.status


def cf_kv_get(key):
    """Return parsed JSON, or None if 404."""
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{KV_NS_ID}/values/{quote(key, safe="")}'
    try:
        body, _ = http_get(url, headers={'Authorization': f'Bearer {CF_TOKEN}'})
        # CF returns raw value, not envelope
        try:
            return json.loads(body)
        except Exception:
            return body
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def cf_kv_put(key, value):
    """Put a value (auto JSON-encoded). Returns True on success."""
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{KV_NS_ID}/values/{quote(key, safe="")}'
    body = json.dumps(value, ensure_ascii=False).encode('utf-8') if not isinstance(value, (str, bytes)) else (
        value.encode('utf-8') if isinstance(value, str) else value
    )
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={'Authorization': f'Bearer {CF_TOKEN}',
                                          'Content-Type': 'application/octet-stream'})
    with urllib.request.urlopen(req, timeout=30) as r:
        envelope = json.loads(r.read().decode('utf-8'))
        if not envelope.get('success'):
            raise RuntimeError(f'KV put failed: {envelope}')
    return True


# ---------- FIFA fetch ----------
def fetch_fifa_calendar():
    cal = cf_kv_get('fifa_calendar')
    if not cal:
        sys.exit('fifa_calendar not in KV — run main-cron once or /trigger/calendar')
    return cal


def fetch_live_football(m):
    """m comes from fifa_calendar.matches[]; we need IdCompetition/Season/Stage/Match."""
    c, s, st, mid = m['id_competition'], m['id_season'], m['id_stage'], m['id_match']
    url = f'https://api.fifa.com/api/v3/live/football/{c}/{s}/{st}/{mid}?language=en'
    body, _ = http_get(url, headers={'User-Agent': 'Mozilla/5.0 worldmoney-backfill'})
    return json.loads(body)


# ---------- Normalize (replicates lib/lineup.js exactly) ----------
STATUS_STARTER = 1
STATUS_SUBSTITUTE = 2
MATCH_STATUS_LABELS = {0: 'finished', 1: 'scheduled', 2: 'postponed', 3: 'live', 4: 'halftime'}


def pick_english(localized):
    if not isinstance(localized, list) or not localized:
        return None
    for x in localized:
        if (x.get('Locale') or '').lower().startswith('en'):
            return x.get('Description')
    return localized[0].get('Description')


def split_players_by_status(raw_players):
    starting, substitutes = [], []
    for p in raw_players or []:
        entry = {
            'player_id': p.get('IdPlayer'),
            'name': pick_english(p.get('PlayerName')) or pick_english(p.get('ShortName')) or f"Player {p.get('IdPlayer')}",
            'shirt_number': p.get('ShirtNumber'),
            'position': p.get('Position'),
            'captain': bool(p.get('Captain')),
            'photo_url': (p.get('PlayerPicture') or {}).get('PictureUrl'),
            'lineup_x': p.get('LineupX'),
            'lineup_y': p.get('LineupY'),
        }
        if p.get('Status') == STATUS_STARTER:
            starting.append(entry)
        elif p.get('Status') == STATUS_SUBSTITUTE:
            substitutes.append(entry)
    return starting, substitutes


def normalize_events(side, team):
    goals = [{
        'side': side, 'player_id': g.get('IdPlayer'),
        'assist_player_id': g.get('IdAssistPlayer'),
        'minute': g.get('Minute'), 'period': g.get('Period'),
        'type': g.get('Type'),
    } for g in (team.get('Goals') or [])]
    bookings = [{
        'side': side, 'player_id': b.get('IdPlayer'),
        'minute': b.get('Minute'), 'period': b.get('Period'),
        'card': b.get('Card'), 'reason': b.get('Reason'),
    } for b in (team.get('Bookings') or [])]
    subs = [{
        'side': side,
        'off_player_id': s.get('IdPlayerOff'), 'on_player_id': s.get('IdPlayerOn'),
        'minute': s.get('Minute'), 'period': s.get('Period'),
        'reason': s.get('Reason'),
    } for s in (team.get('Substitutions') or [])]
    return goals, bookings, subs


def normalize_lineup(live_data, mapping):
    home_team = live_data.get('HomeTeam') or {}
    away_team = live_data.get('AwayTeam') or {}
    home_start, home_sub = split_players_by_status(home_team.get('Players'))
    away_start, away_sub = split_players_by_status(away_team.get('Players'))
    lineup_available = bool(home_start) and bool(away_start)
    fixture_locked = len(home_start) == 11 and len(away_start) == 11

    h_g, h_b, h_s = normalize_events('home', home_team)
    a_g, a_b, a_s = normalize_events('away', away_team)

    return {
        'fifa_id_match': mapping.get('fifa_id_match') or live_data.get('IdMatch'),
        'fetched_at': datetime.now(timezone.utc).isoformat().replace('+00:00', '+00:00'),
        'lineup_available': lineup_available,
        'fixture_locked': fixture_locked,
        'match_status': live_data.get('MatchStatus'),
        'match_status_label': MATCH_STATUS_LABELS.get(live_data.get('MatchStatus'), 'unknown'),
        'period': live_data.get('Period'),
        'match_time': live_data.get('MatchTime'),
        'home': {
            'country_code': mapping.get('home_code') or home_team.get('IdCountry'),
            'team_id': home_team.get('IdTeam'),
            'team_name_en': pick_english(home_team.get('TeamName')),
            'tactics': home_team.get('Tactics'),
            'starting': home_start,
            'substitutes': home_sub,
        },
        'away': {
            'country_code': mapping.get('away_code') or away_team.get('IdCountry'),
            'team_id': away_team.get('IdTeam'),
            'team_name_en': pick_english(away_team.get('TeamName')),
            'tactics': away_team.get('Tactics'),
            'starting': away_start,
            'substitutes': away_sub,
        },
        'events': {
            'goals': h_g + a_g,
            'bookings': h_b + a_b,
            'substitutions': h_s + a_s,
        }
    }


# ---------- Hash helpers (mirror lineup.js) ----------
def lineup_fields_hash(obj):
    """FNV-1a 32-bit on the JSON serialization of obj. Matches lineup.js exactly."""
    s = json.dumps(obj, separators=(',', ':'), ensure_ascii=False)
    h = 0x811c9dc5
    for c in s:
        h ^= ord(c)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, 'x')


def roster_sig(roster):
    sorted_r = sorted(roster, key=lambda r: str(r.get('player_id', '')))
    return '|'.join(f"{r.get('player_id')}#{r.get('name')}#{r.get('shirt_number')}#{r.get('position')}" for r in sorted_r)


# ---------- Upsert (mirrors lineup.js upsertPlayersFromLineup, hash-deduped) ----------
def upsert_players(live_data, mapping, country_zh_lookup, dry_run, write_log, skip_player_records=True):
    """Returns (players_written, players_skipped, countries_written, countries_skipped).

    skip_player_records=True (default for backfill): do NOT write to players:{id}.
    v3 tournament_stats is the source of truth for player data; lineup-derived
    fields (shirt_number, position) are picked up from match_lineups itself
    by the frontend. Avoiding players:{id} writes here keeps the team-refresh
    hash chain intact (won't trigger redundant rewrites later).
    """
    sides = [
        (live_data.get('HomeTeam') or {}, mapping.get('home_code')),
        (live_data.get('AwayTeam') or {}, mapping.get('away_code')),
    ]
    country_patch = {}   # code -> [roster entries]
    p_written, p_skipped = 0, 0

    for team, country_code in sides:
        if not country_code:
            continue
        country_patch[country_code] = []
        for p in team.get('Players') or []:
            pid = p.get('IdPlayer')
            if not pid:
                continue
            en_name = pick_english(p.get('PlayerName')) or pick_english(p.get('ShortName'))
            country_patch[country_code].append({
                'player_id': pid,
                'name': en_name or f'Player {pid}',
                'shirt_number': p.get('ShirtNumber'),
                'position': p.get('Position'),
                '_team_id': team.get('IdTeam'),
            })
            if skip_player_records:
                p_skipped += 1
                continue
            # Fallback path (only if skip_player_records=False) — keep original logic
            existing = cf_kv_get(f'players:{pid}') or {}
            lineup_hash = lineup_fields_hash({
                'country_code': country_code,
                'team_id': team.get('IdTeam'),
                'position': p.get('Position'),
                'shirt_number': p.get('ShirtNumber'),
                'eng': en_name or '',
            })
            if existing.get('_lineup_hash') == lineup_hash:
                p_skipped += 1
                continue
            updated = {
                **existing,
                'id': pid,
                'country_code': country_code,
                'country_zh': existing.get('country_zh') or country_zh_lookup.get(country_code),
                'team_id': team.get('IdTeam'),
                'position': p.get('Position') if p.get('Position') is not None else existing.get('position'),
                'shirt_number': p.get('ShirtNumber') if p.get('ShirtNumber') is not None else existing.get('shirt_number'),
                'name': {**(existing.get('name') or {}), **({'eng': en_name} if en_name else {})},
                'name_default': en_name or existing.get('name_default') or f'Player {pid}',
                '_lineup_hash': lineup_hash,
                'last_updated': datetime.now(timezone.utc).isoformat().replace('+00:00', '+00:00'),
            }
            if dry_run:
                write_log.append(('PUT', f'players:{pid}', f'{en_name or pid} [{country_code}]'))
            else:
                cf_kv_put(f'players:{pid}', updated)
                write_log.append(('PUT', f'players:{pid}', f'{en_name or pid} [{country_code}]'))
            p_written += 1

    c_written, c_skipped = 0, 0
    for code, new_entries in country_patch.items():
        if not new_entries:
            continue
        existing = cf_kv_get(f'players_by_country:{code}') or {
            'country_code': code, 'country_zh': country_zh_lookup.get(code),
            'team_id': None, 'roster': []
        }
        by_id = {r['player_id']: r for r in existing.get('roster') or []}
        for e in new_entries:
            cur = by_id.get(e['player_id']) or {}
            by_id[e['player_id']] = {
                'player_id': e['player_id'],
                'name': e['name'],
                'shirt_number': e['shirt_number'],
                'position': e['position'],
                'stats_summary': cur.get('stats_summary'),
            }
        new_roster = list(by_id.values())
        new_sig = roster_sig(new_roster)
        old_sig = roster_sig(existing.get('roster') or [])
        if new_sig == old_sig and existing.get('team_id'):
            c_skipped += 1
            continue
        existing['roster'] = new_roster
        existing['team_id'] = existing.get('team_id') or (new_entries[0].get('_team_id'))
        existing['country_zh'] = existing.get('country_zh') or country_zh_lookup.get(code)
        existing['updated_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00', '+00:00')
        if dry_run:
            write_log.append(('PUT', f'players_by_country:{code}', f'{len(new_roster)} players'))
        else:
            cf_kv_put(f'players_by_country:{code}', existing)
            write_log.append(('PUT', f'players_by_country:{code}', f'{len(new_roster)} players'))
        c_written += 1

    return p_written, p_skipped, c_written, c_skipped


# ---------- Find work ----------
def find_finished_matches(fifa_cal, since=None):
    """Returns list of dicts: each match from fifa_cal that is finished (status==0)."""
    matches = []
    for m in fifa_cal.get('matches') or []:
        if m.get('match_status') != 0:
            continue
        if since and (m.get('date_utc') or '')[:10] < since:
            continue
        matches.append(m)
    matches.sort(key=lambda m: m.get('date_utc') or '')
    return matches


def fifa_match_to_mapping(fifa_match, fixture_mapping_by_fifa_id, all_500_fixtures):
    """Return the 500.com fixture_id this FIFA match maps to, by reusing fixture_mapping.

    Falls back to scanning fixture_mapping:* KV records if not already in our index.
    """
    fifa_id = fifa_match.get('id_match')
    return fixture_mapping_by_fifa_id.get(str(fifa_id))


def build_fixture_mapping_index():
    """Scan all fixture_mapping:* KV records once, return {fifa_id_match: mapping_dict}."""
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{KV_NS_ID}/keys?prefix=fixture_mapping:&limit=1000'
    body, _ = http_get(url, headers={'Authorization': f'Bearer {CF_TOKEN}'})
    keys = json.loads(body).get('result', [])
    index = {}
    print(f'Loading {len(keys)} fixture_mapping records...', file=sys.stderr)
    for k in keys:
        m = cf_kv_get(k['name'])
        if not m:
            continue
        fid = str(m.get('fifa_id_match') or '')
        if fid:
            index[fid] = {
                'fifa_id_match': m.get('fifa_id_match'),
                # fixture_mapping records use fifa_id_* prefix consistently.
                'id_competition': m.get('fifa_id_competition') or m.get('id_competition'),
                'id_season':      m.get('fifa_id_season')      or m.get('id_season'),
                'id_stage':       m.get('fifa_id_stage')       or m.get('id_stage'),
                'home_code': m.get('home_code'),
                'away_code': m.get('away_code'),
                'fixture_500_id': k['name'].split(':', 1)[1],
                'match_confidence': m.get('match_confidence'),
            }
    return index


def find_finished_500_matches(since=None):
    """Find finished WC matches from 500.com matches:* buckets.

    Returns list of (date_str, match_dict). More reliable than fifa_calendar.match_status
    which is a frozen snapshot (calendar isn't auto-refreshed)."""
    out = []
    import datetime
    for offset in range(0, 50):
        d = (datetime.date(2026, 6, 1) + datetime.timedelta(days=offset)).isoformat()
        if since and d < since: continue
        bucket = cf_kv_get(f'matches:{d}')
        if not bucket: continue
        for m in bucket.get('matches', []):
            if m.get('league') != '世界杯': continue
            if m.get('status') != 'finished': continue
            out.append((d, m))
    return out


def load_countries_lookup():
    countries = cf_kv_get('countries') or {}
    items = countries.get('items') or []
    return {c['code']: c.get('zh') for c in items}


# ---------- Main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually write KV (default dry-run)')
    ap.add_argument('--limit', type=int, default=None, help='max matches to process')
    ap.add_argument('--since', type=str, default=None, help='only matches on/after YYYY-MM-DD')
    ap.add_argument('--budget', type=int, default=DEFAULT_BUDGET, help='abort if writes would exceed this')
    ap.add_argument('--sleep', type=float, default=0.5, help='sleep seconds between matches (FIFA rate-limit)')
    args = ap.parse_args()

    global CF_TOKEN
    CF_TOKEN = get_cf_token()

    print(f'[backfill] mode={"APPLY" if args.apply else "DRY-RUN"} budget={args.budget}', file=sys.stderr)

    # Use 500.com matches:* (status=finished) as the source of truth — fifa_calendar's
    # match_status field is a frozen snapshot that may lag behind reality. The 500
    # scraper updates status='finished' as kaijiang results come in.
    finished_500 = find_finished_500_matches(since=args.since)
    print(f'[backfill] {len(finished_500)} finished WC matches in 500.com matches:*', file=sys.stderr)
    if args.limit:
        finished_500 = finished_500[: args.limit]
        print(f'[backfill] limited to first {len(finished_500)}', file=sys.stderr)

    mapping_index_by_500_id = {}
    for date_str, m in finished_500:
        fid_500 = m['id']
        fmap = cf_kv_get(f'fixture_mapping:{fid_500}')
        if fmap:
            mapping_index_by_500_id[fid_500] = {
                'fifa_id_match':  fmap.get('fifa_id_match'),
                'id_competition': fmap.get('fifa_id_competition') or fmap.get('id_competition'),
                'id_season':      fmap.get('fifa_id_season')      or fmap.get('id_season'),
                'id_stage':       fmap.get('fifa_id_stage')       or fmap.get('id_stage'),
                'home_code':      fmap.get('home_code'),
                'away_code':      fmap.get('away_code'),
                'fixture_500_id': fid_500,
                'match_confidence': fmap.get('match_confidence'),
            }
    countries_lookup = load_countries_lookup()
    print(f'[backfill] {len(mapping_index_by_500_id)} fixture_mapping found, {len(countries_lookup)} countries', file=sys.stderr)

    grand_total_writes = 0
    matches_done = 0
    matches_skipped_no_mapping = 0
    matches_skipped_already_have_lineup = 0

    for i, (date_str, m500) in enumerate(finished_500, 1):
        fixture_500_id = m500['id']
        mapping = mapping_index_by_500_id.get(fixture_500_id)
        if not mapping:
            matches_skipped_no_mapping += 1
            print(f'  [{i:2d}/{len(finished_500)}] {fixture_500_id} ({m500.get("home")} v {m500.get("away")}) — NO fixture_mapping, skip', file=sys.stderr)
            continue
        if mapping['match_confidence'] not in ('exact', 'time_skew_5min'):
            matches_skipped_no_mapping += 1
            print(f'  [{i:2d}/{len(finished_500)}] {fixture_500_id} mapping confidence={mapping["match_confidence"]}, skip', file=sys.stderr)
            continue

        lineup_key = f'match_lineups:{fixture_500_id}'
        existing_lineup = cf_kv_get(lineup_key)
        # CRITICAL: only skip if existing lineup is BOTH match_status=0 AND has starters.
        # A scheduled-state placeholder (match_status=1, empty starting) must NOT be
        # considered "already finished" — it's exactly the state we need to overwrite.
        if existing_lineup and existing_lineup.get('match_status') == 0 \
                and len((existing_lineup.get('home') or {}).get('starting') or []) > 0:
            matches_skipped_already_have_lineup += 1
            print(f'  [{i:2d}/{len(finished_500)}] {fixture_500_id} ({mapping["home_code"]} v {mapping["away_code"]}) — already has finished lineup, skip', file=sys.stderr)
            continue

        # Fetch + normalize
        try:
            live_data = fetch_live_football({
                'id_competition': mapping['id_competition'],
                'id_season': mapping['id_season'],
                'id_stage': mapping['id_stage'],
                'id_match': mapping['fifa_id_match'],
            })
        except Exception as e:
            print(f'  [{i:2d}/{len(finished_500)}] {fixture_500_id} FIFA fetch failed: {e}', file=sys.stderr)
            continue

        lineup = normalize_lineup(live_data, mapping)
        write_log = []

        # First: the lineup record itself
        if args.apply:
            cf_kv_put(lineup_key, lineup)
        write_log.append(('PUT', lineup_key, f'status={lineup["match_status_label"]} starters={len(lineup["home"]["starting"])}/{len(lineup["away"]["starting"])} events={len(lineup["events"]["goals"])}g+{len(lineup["events"]["bookings"])}b+{len(lineup["events"]["substitutions"])}s'))

        # Then: player + country roster upserts
        p_w, p_s, c_w, c_s = upsert_players(live_data, mapping, countries_lookup, not args.apply, write_log)

        match_writes = 1 + p_w + c_w
        grand_total_writes += match_writes
        matches_done += 1
        print(f'  [{i:2d}/{len(finished_500)}] {fixture_500_id} ({mapping["home_code"]} v {mapping["away_code"]}) — writes={match_writes} (lineup:1 + players:{p_w}/{p_w+p_s} + country:{c_w}/{c_w+c_s})  cumulative={grand_total_writes}', file=sys.stderr)

        if grand_total_writes >= args.budget:
            print(f'\n[backfill] BUDGET HIT ({grand_total_writes} >= {args.budget}). Stopping. Resume tomorrow with --since {date_str}', file=sys.stderr)
            break

        time.sleep(args.sleep)

    print(f'\n[backfill] DONE. matches_processed={matches_done} no_mapping={matches_skipped_no_mapping} already_have={matches_skipped_already_have_lineup} total_writes={grand_total_writes}', file=sys.stderr)


if __name__ == '__main__':
    main()
