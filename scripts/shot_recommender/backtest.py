#!/usr/bin/env python3
"""
backtest.py — walk-forward time-series cross-validation for shot recommender.

For each finished WC match (in chronological order), we:
  1. Generate v0 recommendations using only data available BEFORE that match
     (i.e. excluding this match's stats from the player accumulator)
  2. Compare against ground truth from match_stats:{fid} (each player's actual
     shots_on_target in this match)
  3. Compute precision@6 and other metrics
  4. Aggregate across all matches → overall baseline accuracy

THIS IS A SCAFFOLD — runnable, but until we add proper time-series rewind of
tournament_stats (TODO), it uses CURRENT KV stats which is *training data leakage*.
Output metrics from this naive version are upper-bound estimates only.

Future TODOs (encoded in inline comments):
  T1 — Time-series rewind: reconstruct each player's pre-match stats by walking
       match_stats:* in chronological order; current KV stats are *post-tournament*
  T2 — Asian-handicap historical snapshot: we don't have asian_handicap:{fid}
       yet, so all backtest runs default to pick-em (line=0). Once handicap KV
       is populated this should pull the snapshot closest to but BEFORE kickoff
  T3 — Multi-model: backtest framework should accept a `recommender` callable
       and run v1 (LR) / v2 (GBT) through the same pipeline for A/B comparison

Usage:
  python3 scripts/shot_recommender/backtest.py
  python3 scripts/shot_recommender/backtest.py --explain  # per-match breakdown
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'

CF_TOK = subprocess.run(['security', 'find-generic-password',
                         '-s', 'cloudflare-api-token', '-w'],
                        capture_output=True, text=True, check=True).stdout.strip()


def kv_get(key):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise


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


# === Ground truth & evaluation ===

def get_ground_truth(fid):
    """Return {player_id: shots_on_target} from match_stats:{fid}."""
    rec = kv_get(f'match_stats:{fid}')
    if not rec or 'players' not in rec: return {}
    return {pid: p.get('shots_on_target', 0) for pid, p in rec['players'].items()}


def evaluate(picks, ground_truth):
    """Compute MATCH-LEVEL hit metrics for a single match.

    A "match-level hit" means the recommender successfully predicts enough
    shots that the entire 6-pick stake "wins" — the betting analogy is
    each match is one ticket, and the ticket wins if our 6 picks line up
    well enough against actuals.

    Two thresholds (per user spec):
      - strict_hit:  recommender_hits == 6   (perfect 6/6)
      - lenient_hit: recommender_hits >= 5   (at least 5/6)

    picks: list of (player_id, shots_recommended) totaling 6
    ground_truth: {player_id: actual_shots_on_target}
    """
    total_recommended = sum(s for _, s in picks)
    if total_recommended == 0:
        return None

    recommender_hits = 0
    details = []
    for pid, shots in picks:
        actual = ground_truth.get(pid, 0)
        h = min(shots, actual)
        recommender_hits += h
        details.append({
            'pid': pid, 'recommended': shots,
            'actual_on_target': actual, 'hits': h,
        })

    return {
        'recommender_hits': recommender_hits,   # 0..6
        'recommended':      total_recommended,
        'strict_hit':       recommender_hits >= 6,   # 6/6 (perfect)
        'lenient_hit':      recommender_hits >= 5,   # 5/6 or better (acceptable)
        'partial_hit_4':    recommender_hits >= 4,   # informational
        'pick_details':     details,
    }


# === Run v0 recommender as a black box ===

def run_v0_recommender(fid, mock_handicap):
    """Invoke v0_baseline.py with --emit-json and parse PICKS_JSON line.
    Returns list of (player_id, shots) tuples."""
    cmd = [
        'python3', 'scripts/shot_recommender/v0_baseline.py',
        '--fixture', fid,
        '--mock-handicap', json.dumps(mock_handicap),
        '--emit-json',
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f'[v0 failed] {fid}: {r.stderr[:200]}', file=sys.stderr)
        return []
    for line in r.stdout.splitlines():
        if line.startswith('PICKS_JSON '):
            payload = json.loads(line[len('PICKS_JSON '):])
            return [(p['pid'], p['shots']) for p in payload.get('picks', [])]
    return []


def list_finished_wc_matches():
    """Return [fid, ...] of finished WC matches with both match_stats and match_lineups."""
    keys = kv_list('match_lineups:')
    out = []
    for k in keys:
        fid = k['name'].split(':', 1)[1]
        lu = kv_get(k['name'])
        if not lu: continue
        if lu.get('match_status') != 0: continue   # only finished
        if not lu.get('lineup_available'): continue
        # match_stats is required for ground truth
        if not kv_get(f'match_stats:{fid}'): continue
        out.append(fid)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--explain', action='store_true', help='Per-match breakdown')
    ap.add_argument('--limit', type=int, default=None, help='Only test first N matches')
    args = ap.parse_args()

    print('[scan] enumerating finished WC matches with match_stats...')
    finished = list_finished_wc_matches()
    if args.limit:
        finished = finished[:args.limit]
    print(f'[scan] found {len(finished)} eligible matches')

    if len(finished) == 0:
        print('\n⚠️  No finished WC matches with both lineup + match_stats yet.')
        print('    This is expected pre-tournament. Backtest framework is ready.')
        print()
        print('Pre-flight check summary:')
        all_lu = kv_list('match_lineups:')
        all_ms = kv_list('match_stats:')
        print(f'  match_lineups:* keys = {len(all_lu)}')
        print(f'  match_stats:* keys   = {len(all_ms)}')
        print()
        print('Next steps to make backtest meaningful:')
        print('  1. (T1) Implement time-series rewind in v0 — avoid leakage')
        print('  2. (T2) Backfill match_stats for older finished matches')
        print('  3. (T3) Wire v0 stdout → JSON picks (T4) so we can compute precision@6')
        sys.exit(0)

    print('[run] running v0 on each match with mock pick-em (no handicap KV yet)...')
    agg = {
        'matches': 0,
        'strict_hits': 0,     # 6/6 perfect tickets
        'lenient_hits': 0,    # 5/6+ acceptable tickets
        'partial_4_hits': 0,  # 4/6+ informational
        'total_pick_hits': 0, # sum of recommender_hits across matches
    }
    by_match = []
    for fid in finished:
        # TODO T2: replace with asian_handicap snapshot pre-kickoff once available
        mock_handicap = {'line': 0, 'home_water': 0.85, 'away_water': 0.85, 'trend': 'stable'}
        picks = run_v0_recommender(fid, mock_handicap)
        if not picks:
            if args.explain:
                print(f'  [{fid}] (skip — v0 picks failed, see stderr)')
            continue
        truth = get_ground_truth(fid)
        eval_ = evaluate(picks, truth)
        if eval_ is None:
            continue
        agg['matches']        += 1
        agg['strict_hits']    += 1 if eval_['strict_hit'] else 0
        agg['lenient_hits']   += 1 if eval_['lenient_hit'] else 0
        agg['partial_4_hits'] += 1 if eval_['partial_hit_4'] else 0
        agg['total_pick_hits'] += eval_['recommender_hits']
        by_match.append((fid, eval_))
        if args.explain:
            tag = '🎯6/6' if eval_['strict_hit'] else ('✅5/6' if eval_['lenient_hit'] else ('🟡4/6' if eval_['partial_hit_4'] else '❌'))
            print(f'\n  [{fid}] {tag}  hits={eval_["recommender_hits"]}/6')
            for d in eval_['pick_details']:
                marker = '✓' if d['hits'] > 0 else '·'
                print(f'    {marker} pid={d["pid"]} rec={d["recommended"]} actual={d["actual_on_target"]} hits={d["hits"]}')

    if agg['matches'] == 0:
        print('\n⚠️  No matches evaluated.')
        return

    n = agg['matches']
    strict_rate  = agg['strict_hits']    / n
    lenient_rate = agg['lenient_hits']   / n
    partial_rate = agg['partial_4_hits'] / n
    mean_pick    = agg['total_pick_hits'] / n   # informational (single-pick precision)

    print()
    print('=== Match-Level Hit Rates (the betting analogy) ===')
    print(f'  Matches evaluated: {n}')
    print()
    print(f'  🎯 严格中奖率 (6/6 perfect):       {agg["strict_hits"]:>2}/{n}  = {strict_rate:.1%}')
    print(f'  ✅ 宽松中奖率 (≥5/6 acceptable):   {agg["lenient_hits"]:>2}/{n}  = {lenient_rate:.1%}')
    print(f'  🟡 部分命中率 (≥4/6 informational):{agg["partial_4_hits"]:>2}/{n}  = {partial_rate:.1%}')
    print()
    print(f'  Mean picks-hit per match: {mean_pick:.2f}/6 (informational granular precision)')
    print()
    print('Target thresholds (per user spec):')
    print(f'  - strict (6/6) ≥ 30% = good model    → currently {"PASS ✅" if strict_rate >= 0.30 else "FAIL ❌"} ({strict_rate:.1%})')
    print(f'  - lenient (≥5/6) ≥ 50% = good model  → currently {"PASS ✅" if lenient_rate >= 0.50 else "FAIL ❌"} ({lenient_rate:.1%})')


if __name__ == '__main__':
    main()
