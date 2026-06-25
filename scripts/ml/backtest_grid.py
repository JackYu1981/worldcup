#!/usr/bin/env python3
"""
backtest_grid.py — main grid-search backtest entry.

Pipeline:
  1. Load all finished round-3 fixtures from data/ml.db (the holdout set).
  2. For each fixture: build "pre-match" snapshot — players' cumulative
     on_target / shots / xg from rounds 1+2 ONLY (subtract this fixture's
     own contribution from the latest aggregate).
  3. For each Config in the grid, run algorithm_mirror.compute_picks().
  4. Score against match_player_stats (ground truth):
        * precision@N (weighted by predicted shots, capped by actual on_target)
        * hit_rate (% fixtures where ≥1 pick had actual on_target > 0)
        * avg_picks_correct (% predicted PIDs whose on_target > 0)
        * roi_proxy (assume 1.85 odds per shot prediction, payout if a pick
          had actual on_target >= predicted shots)
  5. Write ranked CSV: scripts/ml/results/{ISO}_grid.csv
  6. Print top-10 to stderr.

Hit definition (per task spec):
  A pick is a "hit" if actual_on_target[pid] >= predicted_shots[pid].
"""
from __future__ import annotations
import csv
import itertools
import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from typing import Any, Dict, List, Tuple

# Local import (relative)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from algorithm_mirror import (
    DEFAULT_CONFIG, compute_picks, compute_team_capacity
)

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, 'data', 'ml.db')
RESULTS_DIR = os.path.join(ROOT, 'results')

# Betting model assumption: each "shot" we predict is one "射正 ≥ 1" bet at 1.85.
ODDS = 1.85


def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] {msg}', file=sys.stderr, flush=True)


# ============================================================================
# Pre-match feature builder
# ============================================================================
def build_premaktch_player(conn: sqlite3.Connection, pid: str, exclude_fid: str
                            ) -> Dict[str, Any]:
    """Return a pseudo-player dict whose tournament_stats reflect cumulative
    stats from match_player_stats EXCLUDING `exclude_fid`. Falls back to
    zero stats if the player has no prior matches.

    We treat one row in match_player_stats as one "match played" for that
    player (since match_player_stats is per-match-per-player). xG is not
    in per-match stats, so we approximate xg ≈ 0.4 * on_target_per_match
    (a rough heuristic; the production scoring weighs xG at 0.10 only).
    """
    row = conn.execute("""
        SELECT name, country_code, position FROM players WHERE pid=?
    """, (pid,)).fetchone()
    if not row:
        return None
    name, cc, position = row

    agg = conn.execute("""
        SELECT
            COUNT(*) AS mp,
            COALESCE(SUM(shots), 0) AS att,
            COALESCE(SUM(shots_on_target), 0) AS on_t
        FROM match_player_stats
        WHERE pid=? AND fid<>?
    """, (pid, exclude_fid)).fetchone()
    mp, att, on_t = agg
    on_target_per = (on_t / mp) if mp else 0.0
    return {
        'pid': pid,
        'name': name,
        'country_code': cc,
        'position': position,
        # flat shape consumed by score_player()
        'tournament_matches_played': mp,
        'tournament_attempt_at_goal': att,
        'tournament_attempt_on_target': on_t,
        'tournament_xg': 0.4 * on_target_per * mp,  # crude xG proxy
        'tournament_minutes_played': 0,
    }


def get_lineup_pool(conn: sqlite3.Connection, fid: str, side: str,
                    exclude_fid: str = None) -> List[Dict[str, Any]]:
    """Build the candidate pool for a fixture's side (starters+subs)."""
    if exclude_fid is None:
        exclude_fid = fid  # by default, exclude self
    rows = conn.execute("""
        SELECT pid, role, position FROM lineups
        WHERE fid=? AND side=?
    """, (fid, side)).fetchall()
    pool = []
    for pid, role, pos in rows:
        p = build_premaktch_player(conn, pid, exclude_fid)
        if not p:
            continue
        # Lineup row's position is more authoritative than the player record's
        if pos is not None:
            p['position'] = pos
        pool.append({'player': p, 'is_starter': (role == 'starter')})
    return pool


def compute_caps(conn: sqlite3.Connection, fid: str) -> Tuple[float, float]:
    """Compute team_attack_capacity for both sides using lineup with
    pre-match-cumulative player stats."""
    caps = []
    for side in ('home', 'away'):
        rows = conn.execute("""
            SELECT pid, role FROM lineups WHERE fid=? AND side=?
        """, (fid, side)).fetchall()
        weighted = []
        for pid, role in rows:
            p = build_premaktch_player(conn, pid, fid)
            if not p:
                continue
            w = 1.0 if role == 'starter' else 0.5
            weighted.append((p, w))
        caps.append(compute_team_capacity(weighted))
    return tuple(caps)


# ============================================================================
# Backtest: load round-3 finished fixtures
# ============================================================================
def load_holdout(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Round-3 finished fixtures that also have lineups + match_player_stats."""
    rows = conn.execute("""
        SELECT f.fid, f.home_code, f.away_code, f.score, f.kickoff_beijing,
               ah.current_line, ah.open_line, ah.trend, ah.source
        FROM fixtures f
        JOIN asian_handicap ah ON ah.fid = f.fid
        WHERE f.round = 3 AND f.status = 'finished'
          AND EXISTS (SELECT 1 FROM lineups WHERE fid = f.fid)
          AND EXISTS (SELECT 1 FROM match_player_stats WHERE fid = f.fid)
        ORDER BY f.kickoff_beijing
    """).fetchall()
    out = []
    for fid, hc, ac, sc, ko, cur_l, op_l, tr, src in rows:
        out.append({
            'fid': fid, 'home_code': hc, 'away_code': ac, 'score': sc,
            'kickoff': ko,
            'handicap': {
                'current': {'line': cur_l},
                'open': {'line': op_l},
                'trend': tr or 'stable',
                'source': src,
            },
        })
    return out


def load_ground_truth(conn: sqlite3.Connection, fid: str) -> Dict[str, Dict[str, int]]:
    """Return {pid: {shots, shots_on_target}} for the fixture."""
    out = {}
    for pid, sh, on_t in conn.execute("""
        SELECT pid, shots, shots_on_target FROM match_player_stats WHERE fid=?
    """, (fid,)):
        out[pid] = {'shots': sh, 'shots_on_target': on_t}
    return out


# ============================================================================
# Per-fixture pre-computation cache (depends only on data, not config)
# ============================================================================
def precompute_fixture(conn: sqlite3.Connection, fix: Dict[str, Any]
                       ) -> Dict[str, Any]:
    """Heavy lifting that does not depend on Config. Returns dict consumed
    by score_for_config()."""
    fid = fix['fid']
    home_pool = get_lineup_pool(conn, fid, 'home')
    away_pool = get_lineup_pool(conn, fid, 'away')
    caps = compute_caps(conn, fid)
    gt = load_ground_truth(conn, fid)
    return {
        'fid': fid,
        'handicap': fix['handicap'],
        'home_pool': home_pool,
        'away_pool': away_pool,
        'team_caps': caps,
        'ground_truth': gt,
    }


# ============================================================================
# Scoring: given picks and ground truth, compute metrics for ONE fixture.
# ============================================================================
def score_fixture_metrics(picks: List[Dict[str, Any]],
                          ground_truth: Dict[str, Dict[str, int]]
                          ) -> Dict[str, float]:
    if not picks:
        return {
            'precision_at_n': 0.0, 'hit_count': 0,
            'predicted_total': 0, 'correct_total': 0,
            'roi_proxy': 0.0, 'hit_rate_fixture': 0.0,
        }
    predicted_total = sum(p['shots'] for p in picks)
    # precision_at_n: sum(min(predicted, actual_on_target)) / sum(predicted)
    capped_correct = 0
    n_hits = 0
    payout = 0.0
    cost = 0.0
    for p in picks:
        pid = p['pid']
        pred = p['shots']
        actual = ground_truth.get(pid, {}).get('shots_on_target', 0)
        capped_correct += min(pred, actual)
        # ROI: stake 1 unit per predicted shot. A "shot bet" pays 1.85 if
        # actual_on_target >= predicted (i.e., the over hit).
        cost += pred
        if actual >= pred and pred > 0:
            payout += pred * ODDS
            n_hits += pred
    precision = capped_correct / predicted_total if predicted_total else 0.0
    roi_proxy = (payout - cost) / cost if cost else 0.0
    return {
        'precision_at_n': precision,
        'hit_count': n_hits,
        'predicted_total': predicted_total,
        'correct_total': capped_correct,
        'roi_proxy': roi_proxy,
        'hit_rate_fixture': 1.0 if n_hits > 0 else 0.0,
    }


# ============================================================================
# Grid build + main loop
# ============================================================================
def build_grid() -> List[Dict[str, Any]]:
    w_on_target = [0.40, 0.45, 0.50, 0.55]
    w_attempt   = [0.15, 0.20, 0.25]
    w_starter   = [0.00, 0.03, 0.05]
    w_successor = [0.00, 0.05, 0.07, 0.10]
    shot_t1     = [65, 70, 75, 80]
    shot_t2     = [50, 55, 60, 65]
    team_cap    = [12, 15, 18]
    # Note: w_position / w_xg are NOT in the grid per the task spec; we keep
    # them at the production defaults so weights don't sum to anything funky.
    # (Algorithm weights aren't required to sum to 1 — scoring is additive.)
    grid = []
    for wo, wa, ws, wc, t1, t2, tc in itertools.product(
        w_on_target, w_attempt, w_starter, w_successor, shot_t1, shot_t2, team_cap
    ):
        if t2 >= t1:  # T2 must be strictly < T1 or the threshold logic degenerates
            continue
        cfg = {
            'w_on_target': wo,
            'w_attempt':   wa,
            'w_position':  DEFAULT_CONFIG['w_position'],
            'w_xg':        DEFAULT_CONFIG['w_xg'],
            'w_starter':   ws,
            'w_successor': wc,
            'SHOT_T1':     t1,
            'SHOT_T2':     t2,
            'TEAM_CAP_BONUS': tc,
            'BASE_TOTAL_SHOTS': DEFAULT_CONFIG['BASE_TOTAL_SHOTS'],
            'DISTRIBUTION_RULES': DEFAULT_CONFIG['DISTRIBUTION_RULES'],
            'TREND_BONUS': DEFAULT_CONFIG['TREND_BONUS'],
        }
        grid.append(cfg)
    return grid


def score_for_config(cfg: Dict[str, Any],
                     precomputed: List[Dict[str, Any]]
                     ) -> Dict[str, float]:
    sums = {'precision_at_n': 0.0, 'hit_rate_fixture': 0.0,
            'roi_payout': 0.0, 'roi_cost': 0.0,
            'predicted_total': 0, 'correct_total': 0,
            'fixtures_with_picks': 0, 'hits_total': 0}
    n = 0
    for pre in precomputed:
        if not pre['home_pool'] or not pre['away_pool']:
            continue
        try:
            r = compute_picks(pre['handicap'], pre['home_pool'], pre['away_pool'],
                              pre['team_caps'], cfg)
        except Exception:
            continue
        picks = r['picks']
        m = score_fixture_metrics(picks, pre['ground_truth'])
        sums['precision_at_n']   += m['precision_at_n']
        sums['hit_rate_fixture'] += m['hit_rate_fixture']
        sums['predicted_total']  += m['predicted_total']
        sums['correct_total']    += m['correct_total']
        sums['hits_total']       += m['hit_count']
        # Reconstruct cost/payout for ROI aggregation
        for p in picks:
            actual = pre['ground_truth'].get(p['pid'], {}).get('shots_on_target', 0)
            cost = p['shots']
            sums['roi_cost'] += cost
            if actual >= p['shots'] and cost > 0:
                sums['roi_payout'] += cost * ODDS
        if picks:
            sums['fixtures_with_picks'] += 1
        n += 1
    if n == 0:
        return {'precision_at_n': 0.0, 'hit_rate': 0.0, 'avg_picks_correct': 0.0,
                'roi_proxy': 0.0, 'fixtures': 0}
    return {
        'precision_at_n':     sums['precision_at_n'] / n,
        'hit_rate':           sums['hit_rate_fixture'] / n,
        'avg_picks_correct':  (sums['correct_total'] / sums['predicted_total']
                               if sums['predicted_total'] else 0.0),
        'roi_proxy':          ((sums['roi_payout'] - sums['roi_cost']) / sums['roi_cost']
                               if sums['roi_cost'] else 0.0),
        'fixtures': n,
        'hits_total': sums['hits_total'],
        'predicted_total': sums['predicted_total'],
        'correct_total': sums['correct_total'],
    }


def main():
    t0 = time.time()
    os.makedirs(RESULTS_DIR, exist_ok=True)
    log(f'Opening {DB_PATH}')
    conn = sqlite3.connect(DB_PATH)

    log('Loading holdout (round=3 finished, with lineups + stats)...')
    holdout = load_holdout(conn)
    log(f'  holdout: {len(holdout)} fixtures')
    for h in holdout:
        log(f'    {h["fid"]}  {h["home_code"]} vs {h["away_code"]}  score={h["score"]} '
            f'line={h["handicap"]["current"]["line"]} src={h["handicap"]["source"]}')

    if not holdout:
        log('No holdout fixtures — abort.')
        return

    log('Pre-computing per-fixture features (lineups + caps + ground truth)...')
    precomputed = []
    for h in holdout:
        pre = precompute_fixture(conn, h)
        precomputed.append(pre)
        log(f'    {h["fid"]}  home_pool={len(pre["home_pool"])} '
            f'away_pool={len(pre["away_pool"])} caps={pre["team_caps"]} '
            f'gt_players={len(pre["ground_truth"])}')

    conn.close()  # algorithm_mirror is pure; we don't need the DB anymore

    log('Building grid...')
    grid = build_grid()
    log(f'  grid size: {len(grid)} configs')

    log('Scoring configs...')
    results = []
    for i, cfg in enumerate(grid):
        m = score_for_config(cfg, precomputed)
        results.append({'cfg': cfg, **m})
        if (i + 1) % 500 == 0:
            elapsed = time.time() - t0
            eta = elapsed / (i + 1) * (len(grid) - i - 1)
            log(f'  {i+1}/{len(grid)} ({(i+1)/len(grid)*100:.1f}%)  '
                f'elapsed={elapsed:.0f}s  eta={eta:.0f}s')

    # Rank by precision_at_n, tiebreak by hit_rate then roi_proxy
    results.sort(key=lambda r: (r['precision_at_n'], r['hit_rate'], r['roi_proxy']),
                 reverse=True)

    iso = datetime.now().strftime('%Y-%m-%dT%H-%M')
    out_path = os.path.join(RESULTS_DIR, f'{iso}_grid.csv')
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow([
            'rank', 'config_json', 'precision_at_n', 'hit_rate',
            'avg_picks_correct', 'roi_proxy', 'fixtures',
            'predicted_total', 'correct_total', 'hits_total',
        ])
        for rank, r in enumerate(results, 1):
            # serialize a stable subset of cfg (strip the constants we didn't tune)
            cfg_keys = ('w_on_target', 'w_attempt', 'w_starter', 'w_successor',
                        'SHOT_T1', 'SHOT_T2', 'TEAM_CAP_BONUS')
            cfg_export = {k: r['cfg'][k] for k in cfg_keys}
            writer.writerow([
                rank,
                json.dumps(cfg_export, separators=(',', ':')),
                round(r['precision_at_n'], 4),
                round(r['hit_rate'], 4),
                round(r['avg_picks_correct'], 4),
                round(r['roi_proxy'], 4),
                r['fixtures'],
                r['predicted_total'],
                r['correct_total'],
                r['hits_total'],
            ])
    log(f'Wrote {len(results)} rows → {out_path}')

    # Print top-10 to stderr
    log('=== TOP 10 ===')
    for rank, r in enumerate(results[:10], 1):
        cfg = r['cfg']
        log(f'  #{rank}  prec={r["precision_at_n"]:.3f} hit={r["hit_rate"]:.3f} '
            f'roi={r["roi_proxy"]:+.3f}  '
            f'w_on_t={cfg["w_on_target"]} w_att={cfg["w_attempt"]} '
            f'w_str={cfg["w_starter"]} w_suc={cfg["w_successor"]} '
            f'T1={cfg["SHOT_T1"]} T2={cfg["SHOT_T2"]} TC={cfg["TEAM_CAP_BONUS"]}')

    log(f'TOTAL TIME: {time.time()-t0:.1f}s')
    # Return for write_results_md()
    return results, time.time() - t0, out_path


if __name__ == '__main__':
    main()
