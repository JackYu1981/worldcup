#!/usr/bin/env python3
"""
v3 single-player validation — probe Messi (229397) across 3 gcp_* classifications.

Fetches each classification with a wildcard stat query, finds Messi by externalSportsPersonId,
extracts ALL football:stats:* tags, then assembles them into v3 schema and writes
ONLY players:229397. No batch refresh yet.

KV writes budget: 1.
"""
import base64
import json
import subprocess
import urllib.request
import urllib.parse
from datetime import datetime, timezone

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'
PID = '229397'  # Lionel Messi

CLASSIFICATIONS = [
    'gcp_top_scorer',
    'gcp_attack',
    'gcp_discipline',
]
SEASON_ID = '285023'

# Common headers
def cf_headers():
    tok = subprocess.run(['security','find-generic-password','-s','cloudflare-api-token','-w'],
                         capture_output=True, text=True).stdout.strip()
    return {'Authorization': f'Bearer {tok}'}

def fifa_headers(gameday_tok):
    return {
        'Authorization': f'Bearer {gameday_tok}',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.fifa.com',
        'Referer': 'https://www.fifa.com/',
        'Accept': 'application/json',
    }

# ---------- KV ----------
def kv_get(key):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{key}'
    req = urllib.request.Request(url, headers=cf_headers())
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise

def kv_put(key, value):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{key}'
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={**cf_headers(), 'Content-Type': 'application/octet-stream'})
    with urllib.request.urlopen(req) as r:
        j = json.loads(r.read())
        if not j.get('success'):
            raise RuntimeError(f'put failed: {j}')

# ---------- Mango fetch ----------
def fetch_classification(gameday_tok, classification):
    """Fetch a classification's wildcard story page. Returns list of stories."""
    q = f'(and resourceStatus==`urn:gd:resourceStatus:active` _externalId~`urn:gd:story:classification:{classification}:competitionId:{SEASON_ID}:(.*):rank_asc:page:1$`)'
    url = ('https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query=' + urllib.parse.quote(q)
           + '&skip=0&limit=20'
           + '&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc')
    req = urllib.request.Request(url, headers=fifa_headers(gameday_tok))
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read()).get('items', [])

def extract_player_stats(stories, pid):
    """From a list of stories, find actor with given pid and merge all football:stats:* tags."""
    merged = {}
    name_multilang = {}
    photo_url = None
    country_code = None
    team_id = None
    for s in stories:
        for actor in s.get('actors', []):
            if actor.get('key',{}).get('_externalSportsPersonId') != pid:
                continue
            # Merge names
            for k, v in (actor.get('name') or {}).items():
                if v: name_multilang[k] = v
            # Merge tags
            for t in actor.get('tags', []):
                name = t.get('name','')
                value = t.get('value')
                if name.startswith('urn:gd:tag:football:stats:'):
                    stat_key = name.split(':')[-1]
                    merged[stat_key] = value
                elif name == 'urn:gd:tag:story:staff:image' and not photo_url:
                    photo_url = value
                elif name == 'urn:gd:tag:story:team:abbreviation' and not country_code:
                    country_code = value
            # Get team_id from key
            tid = actor.get('key',{}).get('_externalTeamId','')
            if tid and not team_id:
                # team_id format: "285023_43922" → 43922
                team_id = tid.split('_')[-1]
    return merged, name_multilang, photo_url, country_code, team_id

# ---------- Main ----------
def main():
    print(f'=== v3 single-player probe: Messi ({PID}) ===\n')

    # Step 1: Get gameday token
    gameday_tok = kv_get('gameday_token')['token']
    print(f'Got gameday token (len {len(gameday_tok)})')

    # Step 2: Fetch each classification
    all_stats = {}    # stat_key -> value
    name_ml = {}
    photo = None
    country = None
    team_id = None
    for cls in CLASSIFICATIONS:
        print(f'\nFetching {cls}...')
        stories = fetch_classification(gameday_tok, cls)
        actor_counts = [len(s.get('actors',[])) for s in stories]
        print(f'  stories: {len(stories)}, actor counts: {actor_counts}')
        stats, nm, ph, cc, tid = extract_player_stats(stories, PID)
        if stats:
            print(f'  Messi found! {len(stats)} stat fields:')
            for k, v in sorted(stats.items()):
                print(f'    {k}: {v}')
            all_stats.update(stats)
            name_ml.update(nm)
            if ph: photo = photo or ph
            if cc: country = country or cc
            if tid: team_id = team_id or tid
        else:
            print(f'  Messi NOT found in {cls}')

    print(f'\n=== Aggregated ===')
    print(f'  total stat fields: {len(all_stats)}')
    print(f'  name langs: {list(name_ml.keys())}')
    print(f'  photo: {photo}')
    print(f'  country: {country}, team_id: {team_id}')

    # Step 3: Classify stats into v3 schema buckets
    # gcp_top_scorer fields: goals, assists, total_competition_minutes_played, matches_played (TBD)
    # gcp_attack fields: attempt_at_goal_on_target, attempt_at_goal, attempt_at_goal_conversion_rate,
    #                   attempt_at_goal_inside_the_penalty_area, attempt_at_goal_outside_the_penalty_area,
    #                   headed_attempt_at_goal, xg, xg_goal_effiency_rate, corners, possession
    # gcp_discipline fields: fouls_for, fouls_against, yellow_cards, red_cards, indirect_red_cards, offsides
    GOLDEN_BOOT_KEYS  = {'goals', 'assists', 'total_competition_minutes_played'}
    DISCIPLINE_KEYS   = {'fouls_for','fouls_against','yellow_cards','red_cards','indirect_red_cards','offsides'}
    # Everything else under "attacking"
    attacking = {}
    discipline = {}
    top_level = {}
    for k, v in all_stats.items():
        if k in DISCIPLINE_KEYS:
            discipline[k] = v
        elif k == 'total_competition_minutes_played':
            top_level['minutes_played'] = v
            # also keep in attacking for backwards compat? no — keep clean
        elif k == 'matches_played':
            top_level['matches_played'] = v
        else:
            # goals, assists, attempt_at_*, xg, corners, etc. — all attacking
            attacking[k] = v

    now = datetime.now(timezone.utc).isoformat().replace('+00:00', '+00:00')

    # Step 4: Read existing record, merge
    existing = kv_get(f'players:{PID}') or {}
    new_record = {
        **existing,
        'id': PID,
        'country_code': country or existing.get('country_code'),
        'country_zh': existing.get('country_zh'),
        'team_id': team_id or existing.get('team_id'),
        'photo_url': photo or existing.get('photo_url'),
        'name': {**(existing.get('name') or {}), **name_ml},
        'name_default': name_ml.get('eng') or existing.get('name_default') or f'Player {PID}',
        'tournament_stats': {
            'version': 3,
            'fetched_at': now,
            'source': 'mangodev_gcp',
            **top_level,
            'attacking': attacking,
            'discipline': discipline,
        },
        'last_updated': now,
    }

    print(f'\n=== New tournament_stats (v3) ===')
    print(json.dumps(new_record['tournament_stats'], ensure_ascii=False, indent=2))

    # Step 5: Write KV (1 write)
    kv_put(f'players:{PID}', new_record)
    print(f'\n✅ WROTE players:{PID}')

if __name__ == '__main__':
    main()
