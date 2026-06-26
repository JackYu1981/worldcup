#!/usr/bin/env python3
"""
tune_metric_b.py — search hyperparameters to maximize PASS rate (Metric B).

Metric B is binary "all-or-nothing": a fixture PASSes iff every recommended
player's actual_st >= assigned shots. Different optimization signal than
Metric A — favors fewer assigned shots per player (safer parlay).

Search axes:
  • C (SVM regularization)
  • penalty (l1 / l2)
  • multi_shot_strategy: greedy_3cap (current) vs all_ones (1 shot each, more
    players) vs cap_2 (no triple allocations) — different risk profiles.
"""
import csv, json, os, sys
from collections import defaultdict

import numpy as np
from sklearn.svm import LinearSVC
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import CalibratedClassifierCV

sys.path.insert(0, os.path.dirname(__file__))
from allocator import (
    decide_budget, quota_split, hits_count, BUDGET_TO_PLAYERS,
)

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')


def load_samples():
    with open(os.path.join(DATA_DIR, 'samples.csv'), encoding='utf-8') as f:
        return list(csv.DictReader(f))


def fid_order_keys(rows):
    seen, ss = [], set()
    for r in rows:
        if r['fid'] not in ss:
            seen.append(r['fid']); ss.add(r['fid'])
    return seen


def feature_matrix(rows, feature_keys):
    X = np.array([[float(r[k]) for k in feature_keys] for r in rows], dtype=np.float64)
    y = np.array([int(r['y']) for r in rows], dtype=np.int32)
    return X, y


def allocate_capped(scored_players, quota, max_players, shots_cap):
    """Round-robin allocation with configurable per-player cap.

    shots_cap = 1: spread 1 shot each, force max_players coverage
    shots_cap = 2: at most 2 shots per player (safer than 3)
    shots_cap = 3: current behavior (elite can get 3)
    """
    if quota <= 0 or not scored_players:
        return []
    pool = scored_players[:max_players]
    alloc = [[p, 0] for p, _ in pool]
    remaining = quota
    while remaining > 0:
        progress = False
        for e in alloc:
            if remaining <= 0: break
            if e[1] < shots_cap:
                e[1] += 1; remaining -= 1; progress = True
        if not progress: break
    return [(p, s) for p, s in alloc if s > 0]


def backtest(rows, by_fid, fid_order, feature_keys, C, penalty, shots_cap):
    min_train = 30
    metric_a, metric_b = [], []
    for k, fid in enumerate(fid_order):
        train_rows = [r for j, f in enumerate(fid_order) if j < k for r in by_fid[f]]
        test_rows = by_fid[fid]
        if len(train_rows) < min_train: continue
        n_pos = sum(1 for r in train_rows if int(r['y']) == 1)
        n_neg = len(train_rows) - n_pos
        if n_pos < 5 or n_neg < 5 or not test_rows: continue
        X_train, y_train = feature_matrix(train_rows, feature_keys)
        X_test, _ = feature_matrix(test_rows, feature_keys)
        scaler = StandardScaler(); X_train_s = scaler.fit_transform(X_train)
        X_test_s = scaler.transform(X_test)
        try:
            base = LinearSVC(C=C, penalty=penalty, class_weight='balanced',
                             max_iter=5000, dual='auto' if penalty=='l2' else False)
            clf = CalibratedClassifierCV(base, method='sigmoid', cv=3)
            clf.fit(X_train_s, y_train)
            probs = clf.predict_proba(X_test_s)[:, 1]
        except Exception:
            continue

        home_rows = [(i, r) for i, r in enumerate(test_rows) if r['side'] == 'home']
        away_rows = [(i, r) for i, r in enumerate(test_rows) if r['side'] == 'away']
        if not home_rows or not away_rows: continue
        home_fav = float(home_rows[0][1]['team_favoredness'])
        away_fav = float(away_rows[0][1]['team_favoredness'])
        if home_fav >= away_fav:
            strong_rows, weak_rows, strong_fav = home_rows, away_rows, home_fav
        else:
            strong_rows, weak_rows, strong_fav = away_rows, home_rows, away_fav
        home_cap = sum(max(0, float(r['ot_overall'])) for _, r in home_rows)
        away_cap = sum(max(0, float(r['ot_overall'])) for _, r in away_rows)
        budget = decide_budget(home_cap, away_cap, strong_fav, side_is_home_strong=(home_fav >= away_fav))
        max_p = BUDGET_TO_PLAYERS[budget]
        sq, wq = quota_split(budget, strong_fav)
        smp = max(1, round(max_p * sq / budget)) if sq > 0 else 0
        wmp = max_p - smp
        if wq == 0: wmp = 0
        def pool(side_rows):
            arr = [(r, float(probs[i])) for i, r in side_rows]
            arr.sort(key=lambda x: x[1], reverse=True)
            return arr
        alloc = (allocate_capped(pool(strong_rows), sq, smp, shots_cap)
                 + allocate_capped(pool(weak_rows), wq, wmp, shots_cap))
        actual = {r['pid']: int(r['shots_on_target_actual']) for r in test_rows}
        hits = hits_count(alloc, actual)
        passed = all(actual.get(str(p['pid']), 0) >= s for p, s in alloc)
        metric_a.append(hits / budget)
        metric_b.append(1 if passed else 0)
    return metric_a, metric_b


def main():
    rows = load_samples()
    with open(os.path.join(DATA_DIR, 'meta.json')) as f:
        meta = json.load(f)
    feature_keys = meta['features_x']
    by_fid = defaultdict(list)
    for r in rows: by_fid[r['fid']].append(r)
    fid_order = fid_order_keys(rows)

    print(f'\n=== Hyperparameter search for Metric B (PASS rate) ===\n')
    print(f'{"C":>10s} {"penalty":>7s} {"cap":>3s}   '
          f'{"Metric A":>10s} {"Metric B":>10s}  notes')
    print('-' * 70)

    grid = []
    for C in [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1.0, 10.0]:
        for penalty in ['l2', 'l1']:
            for cap in [1, 2, 3]:
                try:
                    a, b = backtest(rows, by_fid, fid_order, feature_keys, C, penalty, cap)
                except Exception as e:
                    continue
                if not a: continue
                ma = sum(a)/len(a)
                mb = sum(b)/len(b)
                grid.append((C, penalty, cap, ma, mb, sum(b), len(b)))
                print(f'{C:>10.5g} {penalty:>7s} {cap:>3d}   {ma*100:>8.2f}%   {mb*100:>8.2f}%  ({sum(b)}/{len(b)})')

    print(f'\n=== Top 5 by Metric B (PASS rate) ===')
    for C, pen, cap, ma, mb, b_sum, b_n in sorted(grid, key=lambda x: -x[4])[:5]:
        print(f'  Metric B {mb*100:.2f}% ({b_sum}/{b_n})  Metric A {ma*100:.2f}%  | C={C}, pen={pen}, cap={cap}')

    print(f'\n=== Top 5 by Metric A (partial precision) ===')
    for C, pen, cap, ma, mb, b_sum, b_n in sorted(grid, key=lambda x: -x[3])[:5]:
        print(f'  Metric A {ma*100:.2f}%  Metric B {mb*100:.2f}% ({b_sum}/{b_n})  | C={C}, pen={pen}, cap={cap}')


if __name__ == '__main__':
    main()
