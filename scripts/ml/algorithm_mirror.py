"""
algorithm_mirror.py — pure-function Python mirror of
`workers/shot-recommender/index.js`.

Used for ML/backtest only. No KV calls, no I/O. Feed in:
  - players: list of dicts with tournament_stats + position + isStarter
  - handicap: dict with current.line + trend (+ open.line)
  - team_capacity: precomputed sum for each side (we delegate it because
    in the backtest we want to use "pre-match cumulative" stats, not
    the latest tournament_stats)
  - cfg: a Config dict that overrides the canonical Worker constants
Returns:
  picks: list of {pid, side, shots, score, is_starter}
plus a dict of intermediate decisions (strong_side, line_abs, distribution,
total_shots) useful for debugging.

Canonical constants are taken straight from index.js as of 2026-06-25. The
Config dict only carries the parameters we are tuning in the grid search.
"""
from __future__ import annotations
from typing import List, Dict, Any, Tuple

POSITION_SCORE: Dict[int, int] = {3: 100, 2: 60, 1: 20, 0: 0, 6: 30}

DEFAULT_CONFIG: Dict[str, Any] = {
    # ---- WEIGHTS ----
    "w_on_target":  0.45,
    "w_attempt":    0.20,
    "w_position":   0.15,
    "w_xg":         0.10,
    "w_starter":    0.03,
    "w_successor":  0.07,
    # ---- thresholds ----
    "SHOT_T1": 75,
    "SHOT_T2": 60,
    # ---- team capacity bonus threshold ----
    "TEAM_CAP_BONUS": 15,
    # ---- total shot budget ----
    "BASE_TOTAL_SHOTS": 6,
    # ---- distribution rules: list of (min_line_abs, strong_frac) sorted DESC by min ----
    "DISTRIBUTION_RULES": [
        (1.5, 1.0),         # 让 2 球以上 → 全压强方
        (1.0, 5.0 / 6.0),   # 让 1 球 → 5:1
        (0.25, 4.0 / 6.0),  # 让半球 → 4:2
        (0.0, 0.5),         # 平手 → 3:3
    ],
    # ---- trend bonus ----
    "TREND_BONUS": {"rising": 5, "falling": -5, "stable": 0, None: 0, "": 0},
}


def safe_div(a: float, b: float) -> float:
    return a / b if b else 0.0


# ---------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------
def score_player(player: Dict[str, Any], is_starter: bool, cfg: Dict[str, Any],
                 successor_norm: float = 0.0) -> Dict[str, Any]:
    """
    Pure mirror of scorePlayer() in index.js.

    `player` shape (dict-like; we accept either the KV shape or our SQL-flattened shape):
        - tournament_stats: { matches_played, minutes_played, attacking: {
            attempt_at_goal, attempt_at_goal_on_target, xg } }
        OR flat: tournament_matches_played, tournament_attempt_on_target,
                 tournament_attempt_at_goal, tournament_xg
        - position: int (0..3 or 6)

    Returns: {total, raw{...}}
    """
    if 'tournament_stats' in player and player['tournament_stats']:
        ts = player['tournament_stats']
        att = ts.get('attacking') or {}
        mp = ts.get('matches_played') or 0
        minutes = ts.get('minutes_played') or 0
        on_target = att.get('attempt_at_goal_on_target') or 0
        attempt = att.get('attempt_at_goal') or 0
        xg = att.get('xg') or 0
    else:
        mp = player.get('tournament_matches_played') or 0
        minutes = player.get('tournament_minutes_played') or 0
        on_target = player.get('tournament_attempt_on_target') or 0
        attempt = player.get('tournament_attempt_at_goal') or 0
        xg = player.get('tournament_xg') or 0

    on_target_per = safe_div(on_target, mp)
    attempt_per = safe_div(attempt, mp)
    xg_per = safe_div(xg, mp)
    on_target_norm = min(100.0, on_target_per * 15.0)
    attempt_norm = min(100.0, attempt_per * 10.0)
    xg_norm = min(100.0, xg_per * 30.0)
    pos = player.get('position')
    if pos is None:
        pos = 6
    position_norm = POSITION_SCORE.get(pos, 30)
    starter_norm = 100.0 if is_starter else 0.0
    eff_successor_norm = successor_norm if is_starter else 0.0

    total = (
        cfg['w_on_target']  * on_target_norm
        + cfg['w_attempt']  * attempt_norm
        + cfg['w_position'] * position_norm
        + cfg['w_xg']       * xg_norm
        + cfg['w_starter']  * starter_norm
        + cfg['w_successor'] * eff_successor_norm
    )

    return {
        'total': round(total * 100) / 100,
        'raw': {
            'on_target_per_match': round(on_target_per * 100) / 100,
            'attempt_per_match':   round(attempt_per * 100) / 100,
            'xg_per_match':        round(xg_per * 100) / 100,
            'matches_played':      mp,
            'minutes_played':      minutes,
            'is_starter':          is_starter,
            'position':            pos,
            'successor_norm':      round(eff_successor_norm * 10) / 10,
        },
    }


# ---------------------------------------------------------------------------
# strong-side / distribution
# ---------------------------------------------------------------------------
def decide_strong_side(handicap: Dict[str, Any]) -> Tuple[str, float, str]:
    """500.com Crown sign convention:
       line > 0  → AWAY is strong (home is being given the head start)
       line < 0  → HOME is strong (home is giving the head start)
       line == 0 → pick-em, default to home
    """
    cur = handicap.get('current') or handicap
    try:
        line = float(cur.get('line') or 0)
    except (TypeError, ValueError):
        line = 0.0
    trend = handicap.get('trend') or 'stable'
    if line > 0.01:
        return 'away', abs(line), trend
    if line < -0.01:
        return 'home', abs(line), trend
    return 'home', 0.0, trend


def decide_distribution(line_abs: float, total_shots: int,
                        rules: List[Tuple[float, float]]) -> Tuple[int, int]:
    """Pure mirror of decideDistribution().
    `rules` must be sorted DESC by min — first match wins."""
    strong_frac = None
    for min_, frac in rules:
        if line_abs >= min_:
            strong_frac = frac
            break
    if strong_frac is None:
        strong_frac = 0.5
    strong_count = round(total_shots * strong_frac)
    if strong_frac == 1.0:
        strong_count = total_shots
    weak_count = total_shots - strong_count
    if strong_count + weak_count != total_shots:
        weak_count = total_shots - strong_count
    return int(strong_count), int(weak_count)


def decide_total_shots(team_caps: Tuple[float, float], cfg: Dict[str, Any]) -> int:
    """Bump from BASE → BASE+1 if max(team_caps) >= TEAM_CAP_BONUS."""
    if max(team_caps) >= cfg['TEAM_CAP_BONUS']:
        return cfg['BASE_TOTAL_SHOTS'] + 1
    return cfg['BASE_TOTAL_SHOTS']


def pick_with_multi_shot(scored: List[Dict[str, Any]], quota: int,
                         trend_bonus: float, cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Pure mirror of pickWithMultiShot()."""
    if quota <= 0:
        return []
    sorted_scored = sorted(scored, key=lambda e: -e['score']['total'])
    out: List[Dict[str, Any]] = []
    remaining = quota
    for entry in sorted_scored:
        if remaining <= 0:
            break
        adj = entry['score']['total'] + trend_bonus
        if adj >= cfg['SHOT_T1']:
            shots = 3
        elif adj >= cfg['SHOT_T2']:
            shots = 2
        else:
            shots = 1
        shots = min(shots, remaining)
        out.append({**entry, 'shots': shots})
        remaining -= shots
    return out


# ---------------------------------------------------------------------------
# top-level: compute picks for one fixture
# ---------------------------------------------------------------------------
def compute_picks(handicap: Dict[str, Any],
                  home_pool: List[Dict[str, Any]],
                  away_pool: List[Dict[str, Any]],
                  team_caps: Tuple[float, float],
                  cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    home_pool / away_pool: list of {'player': dict, 'is_starter': bool}
    team_caps: (home_cap, away_cap) — precomputed by caller

    Returns: {
       picks: [...],
       strong_side, weak_side, line_abs, trend,
       distribution: (strong_count, weak_count),
       total_shots,
    }
    """
    cfg = {**DEFAULT_CONFIG, **(cfg or {})}
    strong_side, line_abs, trend = decide_strong_side(handicap)
    total_shots = decide_total_shots(team_caps, cfg)
    strong_count, weak_count = decide_distribution(line_abs, total_shots, cfg['DISTRIBUTION_RULES'])

    pools = {'home': home_pool, 'away': away_pool}
    scored = {
        side: [
            {'player': item['player'],
             'is_starter': item['is_starter'],
             'score': score_player(item['player'], item['is_starter'], cfg, 0.0)}
            for item in pools[side]
        ]
        for side in ('home', 'away')
    }
    weak_side = 'away' if strong_side == 'home' else 'home'
    trend_bonus = cfg['TREND_BONUS'].get(trend, 0)
    strong_picks = pick_with_multi_shot(scored[strong_side], strong_count, trend_bonus, cfg)
    weak_picks = pick_with_multi_shot(scored[weak_side], weak_count, 0, cfg)

    picks: List[Dict[str, Any]] = []
    for p in strong_picks:
        picks.append({
            'pid': str(p['player'].get('pid') or p['player'].get('id')),
            'side': strong_side,
            'shots': p['shots'],
            'score': p['score']['total'],
            'is_starter': p['is_starter'],
        })
    for p in weak_picks:
        picks.append({
            'pid': str(p['player'].get('pid') or p['player'].get('id')),
            'side': weak_side,
            'shots': p['shots'],
            'score': p['score']['total'],
            'is_starter': p['is_starter'],
        })

    return {
        'picks': picks,
        'strong_side': strong_side,
        'weak_side': weak_side,
        'line_abs': line_abs,
        'trend': trend,
        'distribution': (strong_count, weak_count),
        'total_shots': total_shots,
    }


def compute_team_capacity(players_with_weight: List[Tuple[Dict[str, Any], float]]) -> float:
    """Mirror of teamAttackCapacity() (post-DB extraction).
    players_with_weight: list of (player_dict, weight). Computes
    sum_i weight_i * on_target_per_match_i."""
    cap = 0.0
    for p, w in players_with_weight:
        if 'tournament_stats' in p and p['tournament_stats']:
            ts = p['tournament_stats']
            mp = ts.get('matches_played') or 0
            on_t = (ts.get('attacking') or {}).get('attempt_at_goal_on_target') or 0
        else:
            mp = p.get('tournament_matches_played') or 0
            on_t = p.get('tournament_attempt_on_target') or 0
        if not mp:
            continue
        cap += w * (on_t / mp)
    return cap
