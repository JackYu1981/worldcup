"""
allocator.py — shared allocation rules for shot-recommender backtest + production.

Single source of truth for:
  • Total shot budget (6 / 7 / 8) based on team attacking capacity
  • Strong/weak side quota split based on AH line (6-0 / 5-1 / 4-2 / 3-3)
  • Player count cap (4 / 5 / 5) corresponding to budget
  • Multi-shot allocation: distribute quota across capped players by prob

User-defined hard rules (2026-06-26):
  | budget | players |
  |--------|---------|
  | 6      | 4       |
  | 7      | 5       |
  | 8      | 5       |

The Python implementation here is what train.py uses to evaluate backtest;
workers/shot-recommender/lib/allocator.js will mirror it for production.
"""

# Strong-side share of total budget based on AH line magnitude (own-team
# favoredness from the strong side's perspective).
DISTRIBUTION_RULES = [
    # (min_own_favoredness, strong_fraction)
    (1.5,  1.0),     # 让 ≥1.5 球 → 强队全包
    (1.0,  5/6),     # 让 1 球   → 5:1
    (0.25, 4/6),     # 让半球    → 4:2
    (0,    0.5),     # 平手      → 3:3
]

# Budget → max player count
BUDGET_TO_PLAYERS = {6: 4, 7: 5, 8: 5}

# Capacity threshold for upgrading 6 → 7 → 8 budget
# (sum of starting players' on_target_per_match for one team)
CAPACITY_THRESHOLD_7 = 15.0
CAPACITY_THRESHOLD_8 = 22.0     # both teams need to exceed this for budget=8


def decide_budget(home_capacity, away_capacity, ah_line, side_is_home_strong):
    """Compute total shot budget based on team capacities + AH line.

    Budget=8 is the extreme case: both teams strong + AH line near 0
    (i.e. evenly matched powerhouses, expected high-scoring shootout).
    """
    line_magnitude = abs(ah_line) if ah_line is not None else 0
    both_strong = (home_capacity >= CAPACITY_THRESHOLD_8 and
                   away_capacity >= CAPACITY_THRESHOLD_8)
    if both_strong and line_magnitude < 0.5:
        return 8
    any_strong = (max(home_capacity, away_capacity) >= CAPACITY_THRESHOLD_7)
    if any_strong:
        return 7
    return 6


def quota_split(budget, own_favoredness_strong_side):
    """Given budget total and the AH line magnitude, return (strong_quota, weak_quota).

    own_favoredness_strong_side is positive: the larger it is, the more lopsided.
    """
    abs_line = abs(own_favoredness_strong_side)
    frac = 0.5  # default
    for min_line, strong_frac in DISTRIBUTION_RULES:
        if abs_line >= min_line:
            frac = strong_frac
            break
    strong = round(budget * frac)
    weak = budget - strong
    return strong, weak


def allocate_multi_shot(scored_players, quota, max_players):
    """Distribute `quota` shots across at most `max_players` players.

    scored_players: list of (player_dict, prob) sorted desc by prob.
    Algorithm: greedy round-robin among top max_players to spread quota,
    with cap of 3 shots per player (so a single elite shooter can monopolize
    a 3-shot bucket).

    Returns: list of (player_dict, shots) tuples.
    """
    if quota <= 0 or not scored_players:
        return []
    pool = scored_players[:max_players]
    allocations = [[p, 0] for p, _ in pool]
    remaining = quota
    # Round-robin: each pass adds 1 shot to next-best player (capped at 3)
    while remaining > 0:
        progress = False
        for entry in allocations:
            if remaining <= 0:
                break
            if entry[1] < 3:
                entry[1] += 1
                remaining -= 1
                progress = True
        if not progress:
            # All players capped at 3 already and still have quota — shouldn't
            # happen with max_players=4/5 and quota ≤8, but guard against
            # silent loops.
            break
    return [(p, s) for p, s in allocations if s > 0]


def hits_count(allocations, actual_shots_on_target_by_pid):
    """Given allocations (list of (player, shots_assigned)) and a dict of
    pid → actual shots_on_target, return integer "hits" = sum over players of
    min(shots_assigned, actual).
    """
    hits = 0
    for p, shots in allocations:
        pid = str(p.get('pid') or p.get('player_id') or '')
        actual = actual_shots_on_target_by_pid.get(pid, 0)
        hits += min(shots, actual)
    return hits


def precision_per_match(allocations, actual_shots_on_target_by_pid):
    """Hits divided by total shots assigned. 0.0 - 1.0."""
    total_shots = sum(s for _, s in allocations)
    if total_shots == 0:
        return 0.0
    return hits_count(allocations, actual_shots_on_target_by_pid) / total_shots
