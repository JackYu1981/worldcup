#!/usr/bin/env python3
"""
build_dataset.py — walk-forward feature/label extraction for SVM v1.

Same source-of-truth as the production worker (Cloudflare KV). Iterates 60 finished
WC2026 fixtures in kickoff order, maintains incremental cumulative tables for each
player and each team, and emits one sample per starter per match.

Causal guarantee: features for a match come from cumulative tables BEFORE that
match's own contribution is added. No data leakage.

Outputs:
  scripts/shot_recommender/v1_svm/data/samples.csv  — one row per starter-match
  scripts/shot_recommender/v1_svm/data/meta.json    — feature names + label counts

Usage:
  python3 scripts/shot_recommender/v1_svm/build_dataset.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'
HEADERS = {'Authorization': 'Bearer ' + subprocess.run(
    ['security','find-generic-password','-s','cloudflare-api-token','-w'],
    capture_output=True, text=True, check=True).stdout.strip()}

OUT_DIR = os.path.join(os.path.dirname(__file__), 'data')
os.makedirs(OUT_DIR, exist_ok=True)

# Position FWD/MID/DEF/GK → ordinal "attack tier"
POSITION_SCORE = {3: 3, 2: 2, 1: 1, 0: 0, 6: 1}   # FWD=3, MID=2, DEF=1, GK=0


def kv_get(key, retries=3):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
        except Exception:
            time.sleep(1 + i)
    return None


def kv_list_all(prefix):
    keys, cursor = [], ''
    while True:
        url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse.quote(prefix)}&limit=1000'
        if cursor: url += f'&cursor={cursor}'
        for i in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                    j = json.loads(r.read()); break
            except Exception:
                time.sleep(1 + i)
        keys += [k['name'] for k in j['result']]
        cursor = (j.get('result_info') or {}).get('cursor') or ''
        if not cursor: break
    return keys


def parse_ah_line(ah):
    """Extract bet365 line from asian_handicap KV blob.

    KV shape (from workers/asian-handicap-scraper):
      { current: { line, home_water, away_water }, open: {...}, trend, ... }
    `line` is the home-team-perspective line (negative = home gives goals,
    e.g. -1.5 means home is favored to win by 1.5).
    """
    if not ah: return None
    cur = ah.get('current') or {}
    h = cur.get('line')
    if h is None: return None
    try:
        return float(h)
    except (ValueError, TypeError):
        return None


def is_weak_opponent(ah_line, side_is_home):
    """Opponent is 'weak' iff THIS MATCH's AH line is at least 2.0 in our favor.

    Domain rule (用户 2026-06-26): "协议球" scenarios exist — even against a
    historically weak opponent, if our team has already qualified for KO stage
    the AH line stays modest (e.g. -0.5) because we won't go full effort.
    Using only opponent's historical goals_conceded would mistake "协议球 vs
    weak team" for a normal "powerhouse vs weak team" — completely different
    expected shot output. Market AH is the only signal that captures effort
    intensity per match.
    """
    if ah_line is None: return False
    own_fav = -ah_line if side_is_home else ah_line
    return own_fav >= 2.0

def is_strong_opponent(ah_line, side_is_home):
    """Opponent is 'strong' iff THIS MATCH's AH line is at least 0.5 against us."""
    if ah_line is None: return False
    own_fav = -ah_line if side_is_home else ah_line
    return own_fav <= -0.5


def main():
    # 1) Gather all fixtures we have lineup+match_stats+asian_handicap for.
    print('Step 1: enumerate fixtures with full data triple', flush=True)
    lu_keys = kv_list_all('match_lineups:')
    ms_keys = set(k.split(':',1)[1] for k in kv_list_all('match_stats:'))
    ah_keys = set(k.split(':',1)[1] for k in kv_list_all('asian_handicap:'))

    # Build fid → kickoff map from matches:{date} daily buckets (kickoff is in +08:00).
    # This is the ground truth for temporal ordering; lineup.fetched_at is NOT
    # reliable because some lineups were backfilled out-of-order.
    print('  building fid→kickoff map from matches:* daily buckets', flush=True)
    fid_kickoff = {}
    for dk in kv_list_all('matches:'):
        bucket = kv_get(dk)
        if not bucket: continue
        for m in (bucket.get('matches') or bucket.get('items') or []):
            mid = m.get('id'); ko = m.get('kickoff')
            if mid and ko: fid_kickoff[mid] = ko
    print(f'  collected {len(fid_kickoff)} fid→kickoff entries', flush=True)

    fixtures = []
    for lk in lu_keys:
        fid = lk.split(':',1)[1]
        if fid not in ms_keys or fid not in ah_keys: continue
        lu = kv_get(lk)
        if not lu: continue
        if lu.get('match_status_label') != 'finished': continue
        ko = fid_kickoff.get(fid)
        if not ko: continue   # without kickoff we can't temporally order
        fixtures.append({'fid': fid, 'lineup': lu, 'kickoff': ko})

    fixtures.sort(key=lambda x: x['kickoff'])
    print(f'  {len(fixtures)} finished fixtures with full data triple + kickoff', flush=True)
    if len(fixtures) < 5:
        print('  not enough data — abort')
        sys.exit(1)

    # 2) Walk-forward: maintain cumulative tables; emit samples per match.
    print('\nStep 2: walk-forward feature extraction', flush=True)
    # Player cumulative table — split by opponent strength so we can compute
    # vs_weak vs vs_strong averages separately. Each bucket tracks (matches,
    # on_target, attempts) so the consumer can compute per-match averages.
    # Schema: pid → {
    #   'overall':    {matches, on_target, attempts},
    #   'vs_weak':    {matches, on_target, attempts},
    #   'vs_strong':  {matches, on_target, attempts},
    #   'vs_medium':  {matches, on_target, attempts},
    # }
    player_cum = {}
    team_cum   = {}   # cc → {matches, goals_conceded}

    def _empty_bucket():
        return {'matches':0, 'on_target':0, 'attempts':0}

    def _empty_player():
        return {'overall':_empty_bucket(), 'vs_weak':_empty_bucket(),
                'vs_strong':_empty_bucket(), 'vs_medium':_empty_bucket()}

    samples = []
    skipped_cold = 0

    for idx, fx in enumerate(fixtures):
        fid = fx['fid']
        lu = fx['lineup']
        ms = kv_get(f'match_stats:{fid}')
        ah = kv_get(f'asian_handicap:{fid}')

        home = lu.get('home') or {}
        away = lu.get('away') or {}
        home_cc, away_cc = home.get('country_code'), away.get('country_code')
        if not home_cc or not away_cc: continue

        ah_line = parse_ah_line(ah)   # home-perspective

        # --- Per-side iteration: emit one sample per starter, using PRE-MATCH state ---
        for side_name, side, opp_cc, side_is_home in [
            ('home', home, away_cc, True),
            ('away', away, home_cc, False),
        ]:
            starters = side.get('starting') or []
            opp_state = team_cum.get(opp_cc, {})
            opp_matches = opp_state.get('matches', 0)

            for p in starters:
                pid = str(p.get('player_id') or '')
                if not pid: continue
                ppre_check = player_cum.get(pid) or _empty_player()
                p_matches_check = ppre_check['overall']['matches']

                # Cold-start gate: drop sample if player or opponent has < 1 prior match.
                # (Loosely interpreted "drop first 2 rounds": once both have at least 1
                #  prior game we have a usable signal.)
                if p_matches_check < 1 or opp_matches < 1:
                    skipped_cold += 1
                    continue

                # === Features ===
                # Pre-match cumulative buckets — separated by opponent strength
                # in the historical match (not this match).
                ppre = player_cum.get(pid) or _empty_player()
                ov = ppre['overall']
                vw = ppre['vs_weak']
                vs = ppre['vs_strong']
                vm = ppre['vs_medium']
                p_matches = ov['matches']
                # Per-match ot averages within each bucket; -1 sentinel when bucket empty
                # so SVM can distinguish "0.0 average from 3 matches" vs "no data yet".
                def avg_or_neg1(b):
                    return round(b['on_target'] / b['matches'], 3) if b['matches'] > 0 else -1.0

                ot_overall    = avg_or_neg1(ov)
                ot_vs_weak    = avg_or_neg1(vw)
                ot_vs_strong  = avg_or_neg1(vs)
                ot_vs_medium  = avg_or_neg1(vm)
                att_overall   = round(ov['attempts'] / ov['matches'], 3) if ov['matches'] > 0 else 0
                # Position one-hot (replaces ordinal position_score). Lets SVM
                # learn per-position effects independently — important because
                # DF's historical ot is NOT predictive of next match (defenders'
                # shots are situational/set-piece, not pattern). FW's is.
                pos = p.get('position')
                is_FW = 1 if pos == 3 else 0
                is_MF = 1 if pos == 2 else 0
                is_DF = 1 if pos == 1 else 0
                is_GK = 1 if pos == 0 else 0
                # Key interaction terms: how much weight to give a player's
                # historical vs-strong record, conditioned on their position.
                # Use 0 (not -1) when bucket is empty so the interaction is
                # neutral instead of misleadingly negative.
                ot_vs_strong_clean = ot_vs_strong if ot_vs_strong >= 0 else 0
                ot_x_FW = ot_vs_strong_clean * is_FW
                ot_x_DF = ot_vs_strong_clean * is_DF
                # Opponent weakness from history (not for bucketing — that comes from AH)
                opp_gc_per_match = opp_state.get('goals_conceded', 0) / max(1, opp_matches)
                # Own-team favoredness from AH (this match)
                if ah_line is None:
                    own_team_favoredness = 0
                else:
                    own_team_favoredness = -ah_line if side_is_home else ah_line

                # === Label ===
                p_ms = (ms.get('players') or {}).get(pid) if ms else None
                shots_on_target_this_match = (p_ms or {}).get('shots_on_target', 0) if p_ms else 0
                y = 1 if shots_on_target_this_match >= 1 else 0

                samples.append({
                    'fid': fid,
                    'pid': pid,
                    'side': side_name,
                    'cc': side.get('country_code'),
                    'opp_cc': opp_cc,
                    'name': p.get('name'),
                    'position': pos,
                    # features — cumulative split by opponent strength
                    'ot_overall':         ot_overall,
                    'ot_vs_weak':         ot_vs_weak,
                    'ot_vs_strong':       ot_vs_strong,
                    'ot_vs_medium':       ot_vs_medium,
                    'att_overall':        att_overall,
                    'matches_played':     p_matches,
                    'n_vs_weak':          vw['matches'],
                    'n_vs_strong':        vs['matches'],
                    'n_vs_medium':        vm['matches'],
                    # features — position one-hot
                    'is_FW':              is_FW,
                    'is_MF':              is_MF,
                    'is_DF':              is_DF,
                    'is_GK':              is_GK,
                    # features — interactions (position × strong opponent history)
                    'ot_x_FW':            round(ot_x_FW, 3),
                    'ot_x_DF':            round(ot_x_DF, 3),
                    # features — context
                    'opp_gc_per_match':   round(opp_gc_per_match, 3),
                    'team_favoredness':   own_team_favoredness,
                    # label
                    'shots_on_target_actual': shots_on_target_this_match,
                    'y': y,
                })

        # --- After emitting samples, fold THIS match's data into cumulative tables ---
        # For each side, the player's opponent strength is determined from THIS
        # match's AH line + side_is_home. Then per-match shots fold into the
        # matching bucket (vs_weak / vs_strong / vs_medium) AND the overall bucket.
        for side_name, side, side_is_home in [('home', home, True), ('away', away, False)]:
            if is_weak_opponent(ah_line, side_is_home):
                bucket_name = 'vs_weak'
            elif is_strong_opponent(ah_line, side_is_home):
                bucket_name = 'vs_strong'
            else:
                bucket_name = 'vs_medium'

            for p in (side.get('starting') or []) + (side.get('substitutes') or []):
                pid = str(p.get('player_id') or '')
                if not pid: continue
                p_ms = (ms.get('players') or {}).get(pid) if ms else None
                if not p_ms: continue
                # Player accumulator: increment matches by 1 only if they actually played
                # (match_stats lists everyone with shots/fouls tracked, including subs that came on)
                appeared = bool(
                    (p_ms.get('shots') or 0) > 0 or
                    (p_ms.get('shots_on_target') or 0) > 0 or
                    (p_ms.get('fouls_committed') or 0) > 0 or
                    p in (side.get('starting') or [])
                )
                if not appeared: continue
                pc = player_cum.setdefault(pid, _empty_player())
                ot = p_ms.get('shots_on_target', 0) or 0
                att = p_ms.get('shots', 0) or 0
                pc['overall']['matches']   += 1
                pc['overall']['on_target'] += ot
                pc['overall']['attempts']  += att
                pc[bucket_name]['matches']   += 1
                pc[bucket_name]['on_target'] += ot
                pc[bucket_name]['attempts']  += att

        # Team accumulator
        # lineup.{side}.score is occasionally null even for finished matches
        # (FIFA Score quirk; lineup.js has a fallback that counts events.goals).
        # Replicate that fallback here so cumulative team tables are correct.
        events_goals = (lu.get('events') or {}).get('goals') or []
        home_score = home.get('score')
        away_score = away.get('score')
        if home_score is None:
            home_score = sum(1 for g in events_goals if g.get('side')=='home')
        if away_score is None:
            away_score = sum(1 for g in events_goals if g.get('side')=='away')
        hc = team_cum.setdefault(home_cc, {'matches':0,'goals_conceded':0,'saves':0})
        ac = team_cum.setdefault(away_cc, {'matches':0,'goals_conceded':0,'saves':0})
        hc['matches'] += 1; hc['goals_conceded'] += away_score
        ac['matches'] += 1; ac['goals_conceded'] += home_score
        # saves: we don't have per-match saves in match_stats; leave 0 for now (V2 add)

        if (idx+1) % 10 == 0:
            print(f'  ...{idx+1}/{len(fixtures)} fixtures processed, {len(samples)} samples', flush=True)

    print(f'\n  total samples: {len(samples)}; skipped (cold-start): {skipped_cold}', flush=True)
    pos_cnt = sum(1 for s in samples if s['y']==1)
    print(f'  label distribution: y=1 {pos_cnt} / y=0 {len(samples)-pos_cnt}  ({100*pos_cnt/len(samples):.1f}% positive)', flush=True)

    # 3) Write CSV
    print('\nStep 3: writing CSV', flush=True)
    import csv
    csv_path = os.path.join(OUT_DIR, 'samples.csv')
    keys = ['fid','pid','side','cc','opp_cc','name','position',
            'ot_overall','ot_vs_weak','ot_vs_strong','ot_vs_medium',
            'att_overall','matches_played','n_vs_weak','n_vs_strong','n_vs_medium',
            'is_FW','is_MF','is_DF','is_GK',
            'ot_x_FW','ot_x_DF',
            'opp_gc_per_match','team_favoredness',
            'shots_on_target_actual','y']
    with open(csv_path,'w',newline='',encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for s in samples: w.writerow(s)
    print(f'  wrote {csv_path}')

    meta = {
        'n_samples': len(samples),
        'positive_rate': pos_cnt / len(samples) if samples else 0,
        'features_x': ['ot_overall','ot_vs_weak','ot_vs_strong','ot_vs_medium',
                       'att_overall','matches_played','n_vs_weak','n_vs_strong','n_vs_medium',
                       'is_FW','is_MF','is_DF','is_GK',
                       'ot_x_FW','ot_x_DF',
                       'opp_gc_per_match','team_favoredness'],
        'label_y': 'shots_on_target_actual >= 1',
        'cold_start_dropped': skipped_cold,
        'fixtures_used': len(fixtures),
        'opponent_definition': {
            'weak': 'this-match AH own-favoredness >= 2.0',
            'strong': 'this-match AH own-favoredness <= -0.5',
            'medium': 'everything else (incl. AH missing)',
        },
        'note': 'ot_vs_* uses -1 as "no historical data" sentinel; n_vs_* gives sample count',
    }
    with open(os.path.join(OUT_DIR, 'meta.json'),'w',encoding='utf-8') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print(f'  wrote meta.json')

if __name__ == '__main__':
    main()
