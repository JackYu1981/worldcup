#!/usr/bin/env python3
"""
inference.py — production shot recommendation inference for a single fixture.

Loads the same v0 baseline scoring + reads from KV → writes `recommendation:{fid}`.
Schema matches what the frontend lineup-bot sheet expects:

  recommendation:f1359xxx = {
    fixture_id: 'f1359xxx',
    strong_side: 'home' | 'away',
    line_abs: float,
    distribution: [strong_count, weak_count],
    trend: 'rising' | 'falling' | 'stable',
    total_shots: 6,
    picks: [
      { pid, name, side: 'home'|'away', shots: 1|2|3, score: float, reason: str }
    ],
    model_version: 'v0-baseline',
    generated_at: '2026-06-25T21:30:00+08:00',
    inputs_snapshot: { ah_current, ah_open, lineup_available, ... }   # for traceability
  }

Usage:
  python3 scripts/shot_recommender/inference.py --fixture f1359214
  python3 scripts/shot_recommender/inference.py --fixture f1359214 --apply         # write KV
  python3 scripts/shot_recommender/inference.py --all-future            # all upcoming WC fixtures
  python3 scripts/shot_recommender/inference.py --all-future --apply
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'

# ============= Scoring config (v0.5; thresholds will be ML-tuned via backtest later) =============
# Weights sum to 1.0.
# successor_bonus replaces the previous "substitute_bonus" (which gave the sub
# himself extra points). The new model gives the STARTER extra points when his
# typical replacement on the bench has good shooting stats — captures the
# "替补保证" idea: if A is starting and B (who often replaces him) is also a
# threat, then A's effective shooting window for the match is longer/wider.
WEIGHTS = {
    'on_target_per_match': 0.45,
    'attempt_per_match':   0.20,
    'position_bonus':      0.15,
    'xg_per_match':        0.10,
    'starter_bonus':       0.03,
    'successor_bonus':     0.07,   # for starters only — derived from sub_chain
}
# Score-bucket thresholds for multi-shot allocation
SHOT_T1 = 75    # score ≥ T1 → 3 shots (elite shooter, can monopolize)
SHOT_T2 = 60    # score ≥ T2 → 2 shots
# Team-strength bonus: only ultra-attacking teams get an extra shot slot
TEAM_CAPACITY_BONUS_THRESHOLD = 15
BASE_TOTAL_SHOTS = 6
# successor_bonus magnitude cap (raw 0..100 scale before weight)
SUCCESSOR_BONUS_CAP = 100
POSITION_SCORE = {3: 100, 2: 60, 1: 20, 0: 0, 6: 30}
DISTRIBUTION = [
    (1.5, 6, 0),    # 让 2 球
    (1.0, 5, 1),    # 让 1 球
    (0.25, 4, 2),   # 让 0.5 球
    (0.0, 3, 3),    # 平手盘
]
TREND_BONUS = {'rising': 5, 'falling': -5, 'stable': 0, None: 0}
MODEL_VERSION = 'v0-baseline'

# ============= KV helpers =============
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
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if attempt < 2: time.sleep(1 + attempt); continue
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 2: time.sleep(1 + attempt); continue
            raise

def kv_put(key, value):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PUT',
                                 headers={'Authorization': f'Bearer {CF_TOK}',
                                          'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status

def kv_list(prefix):
    out, cursor = [], None
    while True:
        url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
               f'/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse.quote(prefix)}')
        if cursor:
            url += f'&cursor={urllib.parse.quote(cursor)}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read())
        out.extend(j.get('result', []))
        cursor = (j.get('result_info') or {}).get('cursor')
        if not cursor: break
    return out


# ============= Scoring =============
def safe_div(a, b):
    return a / b if b else 0

def score_player(player, is_starter, successor_norm=0):
    """Compute composite score (0..~100) for one player.

    is_starter=True   → on tonight's starting XI (verified via FIFA lineup)
    is_starter=False  → on the substitute bench
    successor_norm    → 0..100 normalized score derived from sub_chain
                        (only meaningful for starters; captures how strong the
                        typical replacement on the bench is — the "替补保证"
                        rule: if B usually replaces A and B is also a shooter,
                        A's total in-game shot window is bigger).
    """
    ts = player.get('tournament_stats') or {}
    att = ts.get('attacking') or {}
    mp = ts.get('matches_played') or 0
    minutes = ts.get('minutes_played') or 0

    on_target = safe_div(att.get('attempt_at_goal_on_target') or 0, mp)
    on_target_norm = min(100, on_target * 15)
    attempt = safe_div(att.get('attempt_at_goal') or 0, mp)
    attempt_norm = min(100, attempt * 10)
    pos = player.get('position') if player.get('position') is not None else 6
    position_norm = POSITION_SCORE.get(pos, 30)
    xg = safe_div(att.get('xg') or 0, mp)
    xg_norm = min(100, xg * 30)
    starter_norm = 100 if is_starter else 0
    # successor_bonus is starter-only — bench players don't get this layer
    eff_successor_norm = successor_norm if is_starter else 0

    total = (
        WEIGHTS['on_target_per_match'] * on_target_norm
        + WEIGHTS['attempt_per_match']   * attempt_norm
        + WEIGHTS['position_bonus']      * position_norm
        + WEIGHTS['xg_per_match']        * xg_norm
        + WEIGHTS['starter_bonus']       * starter_norm
        + WEIGHTS['successor_bonus']     * eff_successor_norm
    )
    return {
        'total': round(total, 2),
        'raw': {
            'on_target_per_match': round(on_target, 2),
            'attempt_per_match':   round(attempt, 2),
            'xg_per_match':        round(xg, 2),
            'matches_played':      mp,
            'minutes_played':      minutes,
            'is_starter':          is_starter,
            'position':            pos,
            'successor_norm':      round(eff_successor_norm, 1),
        },
    }

def multi_shot_count(rank, score, quota_remaining):
    """Multi-shot allocation — strong teams' elite shooters can MONOPOLIZE
    multiple shots in the same fixture (per user spec 2026-06-25):
    "强队的优秀射手可以独占两次甚至更高"

    rank=1 (top scorer):
      score > 90  → 4 shots  (truly elite — e.g. Mbappé, Haaland tier)
      score > 80  → 3 shots
      score > 65  → 2 shots
      else        → 1 shot
    rank=2:
      score > 75  → 2 shots
      else        → 1 shot
    rank>=3       → 1 shot each
    No artificial cap — if rank1 deserves the whole 6-shot quota, give it.
    """
    if rank == 1:
        if score > 90:   shots = 4
        elif score > 80: shots = 3
        elif score > 65: shots = 2
        else:            shots = 1
    elif rank == 2:
        shots = 2 if score > 75 else 1
    else:
        shots = 1
    return min(shots, quota_remaining)

def decide_strong_side(handicap):
    """500.com Crown (皇冠 cid=280) line sign convention (verified 2026-06-25 via yazhi page):
      line > 0  → AWAY team gives goals → AWAY is strong (favored)
                  text: "受X球" (home receives X goals)
      line < 0  → HOME team gives goals → HOME is strong (favored)
                  text: bare "X球" (home gives X goals, no 受 prefix)
      line == 0 → even / pick-em
    Example: 突尼斯 vs 荷兰 line=+2.5 → 荷兰让 (away) 2.5 球；荷兰是强队 ✓
             塞内加尔 vs 伊拉克 line=-1.75 → 塞内加尔让 (home) 1.75 球 ✓
    """
    if not handicap: return 'home', 0
    cur = handicap.get('current') or handicap
    line = float(cur.get('line', 0) or 0)
    if line > 0.01: return 'away', abs(line)
    if line < -0.01: return 'home', abs(line)
    return 'home', 0

def decide_distribution(line_abs):
    for threshold, strong, weak in DISTRIBUTION:
        if line_abs >= threshold:
            return strong, weak
    return 3, 3

def pick_with_multi_shot(scored, quota, trend_bonus=0):
    if quota == 0: return []
    sorted_pool = sorted(scored, key=lambda x: -x[1]['total'])
    picks = []
    shots_left = quota
    rank = 0
    for player, score in sorted_pool:
        if shots_left <= 0: break
        rank += 1
        adj = score['total'] + trend_bonus
        shots = multi_shot_count(rank, adj, shots_left)
        if shots == 0: continue
        picks.append((player, shots, score))
        shots_left -= shots
    # Pad remaining quota
    while shots_left > 0 and len(picks) < len(sorted_pool):
        player, score = sorted_pool[len(picks)]
        picks.append((player, 1, score))
        shots_left -= 1
    return picks

POS_LABEL = {0: '门将', 1: '后卫', 2: '中场', 3: '前锋', 6: '其他'}

def build_reason(player, shots, score, is_strong_side, line_abs, trend):
    name = player.get('name_default') or f"Player {player.get('id')}"
    pos_label = POS_LABEL.get(score['raw']['position'], '未知')
    country = player.get('country_zh') or player.get('country_code', '?')
    shirt = player.get('shirt_number')
    shirt_str = f' #{shirt}' if shirt is not None else ''

    parts = []
    if shots > 1:
        parts.append(f'顶级权重投 {shots} 次')
    raw = score['raw']
    if raw['on_target_per_match'] > 0:
        kpi = f'均场射正 {raw["on_target_per_match"]}、均场射门 {raw["attempt_per_match"]}'
        if raw['xg_per_match']:
            kpi += f'、xG {raw["xg_per_match"]}/场'
        parts.append(kpi)
    if raw['is_starter']:
        parts.append('首发')
    else:
        sub_norm = raw.get('sub_density_norm', 0)
        if sub_norm >= 40:
            parts.append(f'⏫ 替补保证（活跃射手，登场密度评分 {sub_norm:.0f}）')
        elif sub_norm > 0:
            parts.append(f'替补（本届有出场记录）')
        else:
            parts.append('替补')
    if is_strong_side:
        if line_abs >= 1.5:   parts.append(f'对手让 {line_abs} 球，进攻空间大')
        elif line_abs >= 1.0: parts.append(f'对手让 {line_abs} 球，机会多')
        elif line_abs >= 0.25:parts.append(f'对手让 {line_abs} 球，略胜')
        else:                 parts.append('平手盘，势均力敌')
        if trend == 'rising': parts.append('📈 升盘，庄家加码')
        elif trend == 'falling': parts.append('📉 降盘，强队信心动摇')
    else:
        parts.append(f'弱队进攻威胁（对手让 {line_abs}）')
    parts.append(f'综合 {score["total"]:.1f}/100')
    return ' · '.join(parts)


# ============= Main inference =============
def infer(fid):
    """Run v0 inference for one fixture. Returns the recommendation payload
    (or None if data is insufficient: no mapping, no AH, no roster)."""
    if not fid.startswith('f'): fid = f'f{fid}'
    mapping = kv_get(f'fixture_mapping:{fid}')
    if not mapping or not mapping.get('home_code'):
        return None, f'no fixture_mapping for {fid}'

    lineup = kv_get(f'match_lineups:{fid}')
    handicap = kv_get(f'asian_handicap:{fid}')

    # AH is the strong/weak signal. Without it we use pick-em fallback.
    if handicap and handicap.get('current'):
        strong_side, line_abs = decide_strong_side(handicap)
        trend = handicap.get('trend', 'stable')
    else:
        strong_side, line_abs = 'home', 0
        trend = None
    strong_count, weak_count = decide_distribution(line_abs)

    home_code, away_code = mapping['home_code'], mapping['away_code']

    # === HARD CONSTRAINT (per user 2026-06-25): ===
    # "生成推荐需要在得到fifa的首发阵容之后才可以"
    # Candidates MUST come from the published FIFA lineup. Pool = starting + substitutes
    # (substitutes are still in pool because the "替补保证" pattern matters — a sub
    # with proven shooting habit is a valid 4th-6th pick).
    if not (lineup and lineup.get('lineup_available')):
        return None, 'lineup not published yet (hard constraint: starting XI required)'

    pools = {'home': [], 'away': []}
    for side, team_key in [('home', 'home'), ('away', 'away')]:
        for grp_key, is_starter in [('starting', True), ('substitutes', False)]:
            for p_stub in (lineup[team_key].get(grp_key) or []):
                p = kv_get(f'players:{p_stub["player_id"]}')
                if p:
                    p['shirt_number'] = p_stub.get('shirt_number')
                    p['position'] = p_stub.get('position', p.get('position'))
                    pools[side].append((p, is_starter))

    if not pools['home'] or not pools['away']:
        return None, f'lineup empty ({len(pools["home"])} home / {len(pools["away"])} away)'

    # Score
    scored = {s: [(p, score_player(p, st)) for p, st in pool] for s, pool in pools.items()}
    strong_pool = scored[strong_side]
    weak_pool = scored['away' if strong_side == 'home' else 'home']

    # Pick
    strong_picks_raw = pick_with_multi_shot(strong_pool, strong_count, TREND_BONUS.get(trend, 0))
    weak_picks_raw = pick_with_multi_shot(weak_pool, weak_count, 0)

    # Compose final picks list — sorted by side then by rank within side
    picks = []
    for p, shots, score in strong_picks_raw:
        picks.append({
            'pid': str(p.get('id')),
            'name': p.get('name_default'),
            'side': strong_side,
            'shots': shots,
            'score': score['total'],
            'via': 'starting' if score['raw']['is_starter'] else 'substitute',
            'reason': build_reason(p, shots, score, True, line_abs, trend),
        })
    other_side = 'away' if strong_side == 'home' else 'home'
    for p, shots, score in weak_picks_raw:
        picks.append({
            'pid': str(p.get('id')),
            'name': p.get('name_default'),
            'side': other_side,
            'shots': shots,
            'score': score['total'],
            'via': 'starting' if score['raw']['is_starter'] else 'substitute',
            'reason': build_reason(p, shots, score, False, line_abs, trend),
        })

    total_shots = sum(p['shots'] for p in picks)
    now_iso = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds')

    payload = {
        'fixture_id': fid,
        'strong_side': strong_side,
        'line_abs': line_abs,
        'distribution': [strong_count, weak_count],
        'trend': trend,
        'total_shots': total_shots,
        'picks': picks,
        'model_version': MODEL_VERSION,
        'generated_at': now_iso,
        'inputs_snapshot': {
            'ah_current': (handicap or {}).get('current') if handicap else None,
            'ah_open': (handicap or {}).get('open') if handicap else None,
            'lineup_available': bool(lineup and lineup.get('lineup_available')),
            'home_pool_size': len(pools['home']),
            'away_pool_size': len(pools['away']),
        },
    }
    return payload, None


def list_future_wc_fixtures():
    """List upcoming WC fixtures (have fixture_mapping, KO not yet)."""
    today = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
    bucket_dates = [today]
    # Include next 3 days
    for i in range(1, 4):
        d = (datetime.now(timezone(timedelta(hours=8))) + timedelta(days=i)).strftime('%Y-%m-%d')
        bucket_dates.append(d)
    fids = set()
    for d in bucket_dates:
        bucket = kv_get(f'matches:{d}')
        if not bucket: continue
        for m in bucket.get('matches', []):
            if m.get('league') != '世界杯': continue
            if m.get('status') == 'finished': continue
            fids.add(m['id'])
    return sorted(fids)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fixture', help='Single fixture id like f1359214')
    ap.add_argument('--all-future', action='store_true', help='All upcoming WC fixtures')
    ap.add_argument('--apply', action='store_true', help='Write to KV (otherwise dry-run print)')
    args = ap.parse_args()

    if not args.fixture and not args.all_future:
        sys.exit('--fixture or --all-future required')

    targets = []
    if args.fixture:
        targets = [args.fixture if args.fixture.startswith('f') else f'f{args.fixture}']
    else:
        targets = list_future_wc_fixtures()
        print(f'[plan] {len(targets)} upcoming WC fixtures to score', file=sys.stderr)

    ok, skipped, errored = 0, 0, 0
    for fid in targets:
        payload, err = infer(fid)
        if payload is None:
            print(f'  {fid}  SKIP — {err}', file=sys.stderr)
            skipped += 1
            continue
        # Brief stdout summary
        ah = payload['inputs_snapshot'].get('ah_current') or {}
        ah_str = f'line={ah.get("line")} water={ah.get("home_water")}/{ah.get("away_water")} trend={payload["trend"]}' if ah else 'no AH'
        print(f'  {fid}  picks={len(payload["picks"])}  shots={payload["total_shots"]}  '
              f'strong={payload["strong_side"]}({payload["line_abs"]:.2f}, dist {payload["distribution"]})  '
              f'[{ah_str}]', file=sys.stderr)
        for p in payload['picks']:
            star = '⭐' if p['shots'] > 1 else ' '
            print(f'    {star} {p["side"][:1].upper()}  {p["name"][:24]:24s}  shots={p["shots"]}  score={p["score"]:.1f}', file=sys.stderr)

        if args.apply:
            try:
                kv_put(f'recommendation:{fid}', payload)
                ok += 1
                print(f'    → wrote recommendation:{fid}', file=sys.stderr)
            except Exception as e:
                print(f'    ✗ KV put failed: {e}', file=sys.stderr)
                errored += 1
        else:
            ok += 1
    print(f'\n[done] {("APPLIED" if args.apply else "DRY-RUN")}: ok={ok} skipped={skipped} errored={errored}', file=sys.stderr)


if __name__ == '__main__':
    main()
