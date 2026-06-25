#!/usr/bin/env python3
"""
v0_baseline.py — first-pass shot recommendation using hand-tuned weights.

This is a baseline meant to ship FAST (with no training data) and serve as
the floor against which v1 (LR) and v2 (GBT) will be benchmarked. The weights
here are pragmatic guesses based on user intuition; the backtest pipeline will
quantify how well it does once ground truth accumulates.

Algorithm:
  1. Determine strong/weak side from asian handicap line + water
  2. Score every available player using a weighted formula (see WEIGHTS)
  3. Allocate shot quota per side per the user-defined distribution table
  4. Pick top-scored players from each pool; top players get multi-shot
  5. Generate a Chinese-language reason string for each pick

Usage:
  python3 scripts/shot_recommender/v0_baseline.py --fixture f1359214
  python3 scripts/shot_recommender/v0_baseline.py --fixture f1359232  # finished match (smoke test)
  python3 scripts/shot_recommender/v0_baseline.py --fixture f1359214 --explain   # show all scoring
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'

# === SCORING WEIGHTS (v0 hand-tuned) ===
# Sum to 1.0; each component is normalized to [0, 100] before weighting.
WEIGHTS = {
    'on_target_per_match': 0.50,   # primary KPI — direct predictor
    'attempt_per_match':   0.20,   # raw shot volume — more chances
    'position_bonus':      0.15,   # FWD > MID > DEF > GK
    'xg_per_match':        0.10,   # quality of opportunity
    'starter_bonus':       0.05,   # subs are unlikely to accumulate shots
}

POSITION_SCORE = {
    3: 100,   # FWD
    2: 60,    # MID
    1: 20,    # DEF
    0: 0,     # GK
    6: 30,    # 其他 / unknown — middling
}

# Asian handicap → (strong_count, weak_count)
DISTRIBUTION = [
    # (line_abs_threshold, strong_quota, weak_quota)
    (1.5, 6, 0),    # 让 2 球 (|line| >= 1.5)
    (1.0, 5, 1),    # 让 1 球 (1.0 <= |line| < 1.5)
    (0.25, 4, 2),   # 让 0.5 球 (0.25 <= |line| < 1.0)
    (0.0, 3, 3),    # 平手 (|line| < 0.25)
]

# Trend adjustment: rising = strong side more confident (+5 to strong scores)
TREND_BONUS = {'rising': 5, 'falling': -5, 'stable': 0, None: 0}

# Multi-shot rules — top N players can be assigned >1 shot.
# Quota-aware so we don't dump all shots onto one star and starve the rest.
def multi_shot_count(rank, score, quota_remaining):
    """How many shots to assign to a player given their rank in pool and
    how much quota is left. Caps shots so at least 2 distinct players are
    represented when quota >= 3 (better risk diversification + UI nuance)."""
    if rank == 1:
        if score > 90: shots = 3
        elif score > 75: shots = 2
        else: shots = 1
    elif rank == 2:
        shots = 2 if score > 80 else 1
    else:
        shots = 1
    # Leave at least 1 quota for the next rank when there is more quota & pool
    if rank == 1 and shots >= quota_remaining and quota_remaining >= 2:
        shots = quota_remaining - 1
    return min(shots, quota_remaining)


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
    import time
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError, json.JSONDecodeError):
            if attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise
    return None


def safe_div(a, b, default=0):
    return a / b if b else default


def score_player(player, is_starter):
    """Return a 0-100 composite score from this player's tournament_stats."""
    ts = player.get('tournament_stats') or {}
    att = ts.get('attacking') or {}
    mp = ts.get('matches_played') or 0

    # Normalize each component to roughly [0, 100]
    # on_target_per_match — VINI shows 8/1=8 (great); typical FWD might be 2-4
    on_target = safe_div(att.get('attempt_at_goal_on_target') or 0, mp)
    on_target_norm = min(100, on_target * 15)  # 6.67 on_target/match → 100

    attempt = safe_div(att.get('attempt_at_goal') or 0, mp)
    attempt_norm = min(100, attempt * 10)  # 10 attempts/match → 100

    pos = player.get('position') if player.get('position') is not None else 6
    position_norm = POSITION_SCORE.get(pos, 30)

    xg = safe_div(att.get('xg') or 0, mp)
    xg_norm = min(100, xg * 30)  # 3.33 xG/match → 100 (top scorers)

    starter_norm = 100 if is_starter else 0

    score = (
        WEIGHTS['on_target_per_match'] * on_target_norm
        + WEIGHTS['attempt_per_match']   * attempt_norm
        + WEIGHTS['position_bonus']      * position_norm
        + WEIGHTS['xg_per_match']        * xg_norm
        + WEIGHTS['starter_bonus']       * starter_norm
    )
    return {
        'total': round(score, 2),
        'parts': {
            'on_target': round(on_target_norm * WEIGHTS['on_target_per_match'], 2),
            'attempt':   round(attempt_norm   * WEIGHTS['attempt_per_match'],   2),
            'position':  round(position_norm  * WEIGHTS['position_bonus'],      2),
            'xg':        round(xg_norm        * WEIGHTS['xg_per_match'],        2),
            'starter':   round(starter_norm   * WEIGHTS['starter_bonus'],       2),
        },
        'raw': {
            'on_target_per_match': round(on_target, 2),
            'attempt_per_match':   round(attempt, 2),
            'xg_per_match':        round(xg, 2),
            'is_starter':          is_starter,
            'position':            pos,
        },
    }


def determine_distribution(line_abs):
    for threshold, strong, weak in DISTRIBUTION:
        if line_abs >= threshold:
            return strong, weak
    return 3, 3


def determine_strong_side(handicap):
    """Return ('home'|'away', |line|) from a single bet365 record.
    line > 0 → home gives goals → home is strong. line < 0 → away strong."""
    if not handicap: return None, 0
    line = float(handicap.get('line', 0))
    if line > 0.01: return 'home', abs(line)
    if line < -0.01: return 'away', abs(line)
    return 'home', 0   # pick-em — default to home, weak distinction


def pick_with_multi_shot(scored_pool, quota, trend_bonus=0):
    """scored_pool: list of (player, score_obj) tuples. Returns list of
    (player, shots, score_obj) totaling `quota` shots."""
    if quota == 0: return []
    sorted_pool = sorted(scored_pool, key=lambda x: -x[1]['total'])
    picks = []
    shots_left = quota
    rank = 0
    for player, score in sorted_pool:
        if shots_left <= 0: break
        rank += 1
        adjusted_score = score['total'] + trend_bonus
        shots = multi_shot_count(rank, adjusted_score, shots_left)
        if shots == 0: continue
        picks.append((player, shots, score))
        shots_left -= shots
    # If we still have quota left (e.g. quota=6, top picks summed to 5), add 1 to next
    while shots_left > 0 and len(picks) < len(sorted_pool):
        player, score = sorted_pool[len(picks)]
        picks.append((player, 1, score))
        shots_left -= 1
    return picks


# === Reason generation (parameter-driven Chinese) ===

def build_reason(player, shots, score, handicap_view, is_strong_side, line_abs, trend):
    """Plain-text Chinese explanation for a pick."""
    name = player.get('name_default') or f"Player {player.get('id')}"
    pos_label = {0: '门将', 1: '后卫', 2: '中场', 3: '前锋', 6: '其他'}.get(score['raw']['position'], '未知')
    country = player.get('country_zh') or player.get('country_code', '?')
    shirt = player.get('shirt_number')
    shirt_str = f' #{shirt}' if shirt is not None else ''

    lines = []
    lines.append(f"{name} {country}{shirt_str} · {pos_label}")
    if shots > 1:
        lines.append(f"⭐ 顶级权重：投 {shots} 次射中")

    # KPI line
    raw = score['raw']
    if raw['on_target_per_match'] > 0:
        lines.append(f"均场射正 {raw['on_target_per_match']} 次 · 均场射门 {raw['attempt_per_match']} 次"
                     + (f" · xG {raw['xg_per_match']}/场" if raw['xg_per_match'] else ''))

    # Starter / sub
    if raw['is_starter']:
        lines.append("首发出场，全场参与")
    else:
        lines.append("替补：出场时间不确定，权重降低")

    # Asian handicap context (only relevant for strong/weak distinction commentary)
    if is_strong_side:
        if line_abs >= 1.5: ctx = f"对手让 {line_abs} 球，强队进攻空间大"
        elif line_abs >= 1.0: ctx = f"对手让 {line_abs} 球，进攻机会多"
        elif line_abs >= 0.25: ctx = f"对手让 {line_abs} 球，略胜一筹"
        else: ctx = "平手盘，势均力敌"
        lines.append(ctx)
        if trend == 'rising':
            lines.append("📈 亚盘升盘：庄家进一步看好本队")
        elif trend == 'falling':
            lines.append("📉 亚盘降盘：庄家信心动摇")
    else:
        lines.append(f"作为弱队的进攻威胁，对手 |让 {line_abs}|")

    lines.append(f"评分：{score['total']:.1f}/100  "
                 f"(射正 {score['parts']['on_target']:.0f} · 射门 {score['parts']['attempt']:.0f} · "
                 f"位置 {score['parts']['position']:.0f} · xG {score['parts']['xg']:.0f})")
    return '\n  '.join(lines)


def recommend(fid_no_prefix, explain=False, mock_handicap=None, emit_json=False):
    """Main entry. fid_no_prefix can be e.g. '1359214' or 'f1359214'.
    If emit_json: print machine-readable picks at end (for backtest consumption)."""
    fid = fid_no_prefix if fid_no_prefix.startswith('f') else f'f{fid_no_prefix}'

    # 1. Load fixture context
    mapping = kv_get(f'fixture_mapping:{fid}')
    if not mapping:
        sys.exit(f'No fixture_mapping for {fid}')
    lineup = kv_get(f'match_lineups:{fid}')
    home_code, away_code = mapping['home_code'], mapping['away_code']

    # 2. Get handicap — for now allow --mock-handicap "-1.0" to simulate
    handicap = mock_handicap or kv_get(f'asian_handicap:{fid}')
    if not handicap:
        # Default to pick-em for demo when no scraped data yet
        handicap = {'line': 0, 'home_water': 0.95, 'away_water': 0.95}
        print(f'  [warn] no asian_handicap:{fid} in KV — defaulting to pick-em', file=sys.stderr)

    strong_side, line_abs = determine_strong_side(handicap)
    trend = handicap.get('trend') if isinstance(handicap, dict) else None
    strong_count, weak_count = determine_distribution(line_abs)

    # 3. Build player pools (must have lineup; if not, fall back to all players_by_country)
    pools = {'home': [], 'away': []}
    if lineup and lineup.get('lineup_available'):
        for side, team_key in [('home', 'home'), ('away', 'away')]:
            for grp_key, is_starter in [('starting', True), ('substitutes', False)]:
                for p_stub in (lineup[team_key].get(grp_key) or []):
                    full = kv_get(f'players:{p_stub["player_id"]}')
                    if full:
                        full['shirt_number'] = p_stub.get('shirt_number')
                        full['position'] = p_stub.get('position', full.get('position'))
                        pools[side].append((full, is_starter))
    else:
        # No lineup yet — pull entire country roster as candidate pool.
        # players_by_country:{code}.roster = [{player_id, name, shirt_number, position}, ...]
        # We pre-stamp shirt/position from the roster stub and merge full player record.
        for side, code in [('home', home_code), ('away', away_code)]:
            roster_kv = kv_get(f'players_by_country:{code}')
            if not roster_kv: continue
            for stub in (roster_kv.get('roster') or []):
                pid = stub.get('player_id')
                if not pid: continue
                p = kv_get(f'players:{pid}')
                if not p: continue
                p['shirt_number'] = stub.get('shirt_number', p.get('shirt_number'))
                p['position'] = stub.get('position', p.get('position'))
                pools[side].append((p, False))   # no starter info pre-lineup

    # 4. Score
    scored = {
        side: [(p, score_player(p, starter)) for p, starter in pool]
        for side, pool in pools.items()
    }

    # 5. Strong/weak distribution
    strong_pool = scored[strong_side]
    weak_pool   = scored['away' if strong_side == 'home' else 'home']

    strong_picks = pick_with_multi_shot(strong_pool, strong_count, TREND_BONUS.get(trend, 0))
    weak_picks   = pick_with_multi_shot(weak_pool, weak_count, 0)

    # 6. Report
    print('=' * 70)
    print(f'比赛: {home_code} vs {away_code}  (fid={fid})')
    print(f'亚盘: line={handicap.get("line")} home_water={handicap.get("home_water")} away_water={handicap.get("away_water")} trend={trend}')
    print(f'强队: {strong_side.upper()}  |line|={line_abs}  分配: 强{strong_count}-弱{weak_count}')
    print()

    total_shots = 0
    print(f'🟦 强队 {strong_side.upper()} ({"主队" if strong_side == "home" else "客队"}) — {strong_count} 次射中')
    for i, (p, shots, score) in enumerate(strong_picks, 1):
        print(f'\n  #{i}  {build_reason(p, shots, score, handicap, True, line_abs, trend)}')
        total_shots += shots

    if weak_picks:
        weak_side = 'away' if strong_side == 'home' else 'home'
        print(f'\n🟥 弱队 {weak_side.upper()} ({"主队" if weak_side == "home" else "客队"}) — {weak_count} 次射中')
        for i, (p, shots, score) in enumerate(weak_picks, 1):
            print(f'\n  #{i}  {build_reason(p, shots, score, handicap, False, line_abs, trend)}')
            total_shots += shots

    print(f'\n总射中数: {total_shots} ({"✓" if total_shots == 6 else "✗ should be 6"})')
    print('=' * 70)

    if explain:
        print('\n[--explain] All-scores breakdown:')
        for side, scored_pool in scored.items():
            print(f'\n  {side} ({len(scored_pool)} players):')
            for p, score in sorted(scored_pool, key=lambda x: -x[1]['total'])[:10]:
                print(f'    {p.get("name_default") or p.get("id"):30s} score={score["total"]:.1f}'
                      f'  raw={score["raw"]}')

    if emit_json:
        # Machine-readable output for backtest. Emitted as a single JSON line
        # with a sentinel prefix so parsers can grep it deterministically.
        payload = {
            'fixture_id': fid,
            'strong_side': strong_side,
            'line_abs': line_abs,
            'distribution': [strong_count, weak_count],
            'trend': trend,
            'picks': [
                {
                    'pid': str(p.get('id')),
                    'name': p.get('name_default'),
                    'side': strong_side,
                    'shots': shots,
                    'score': score['total'],
                }
                for p, shots, score in strong_picks
            ] + [
                {
                    'pid': str(p.get('id')),
                    'name': p.get('name_default'),
                    'side': 'away' if strong_side == 'home' else 'home',
                    'shots': shots,
                    'score': score['total'],
                }
                for p, shots, score in weak_picks
            ],
            'total_shots': total_shots,
        }
        print('PICKS_JSON ' + json.dumps(payload, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description='v0 shot recommendation baseline')
    ap.add_argument('--fixture', required=True, help='Fixture id, e.g. f1359214 or 1359214')
    ap.add_argument('--explain', action='store_true', help='Show full scoring table')
    ap.add_argument('--mock-handicap', help='JSON like {"line":-1.0,"home_water":0.85,"away_water":0.95,"trend":"rising"} to override missing data')
    ap.add_argument('--emit-json', action='store_true', help='Append a machine-readable PICKS_JSON line for backtest consumption')
    args = ap.parse_args()
    mock = None
    if args.mock_handicap:
        mock = json.loads(args.mock_handicap)
    recommend(args.fixture, explain=args.explain, mock_handicap=mock, emit_json=args.emit_json)


if __name__ == '__main__':
    main()
