#!/usr/bin/env python3
"""
train_v2.py — non-linear model comparison: RBF SVM vs GBT vs v1.1 linear baseline.

Same walk-forward backtest + same allocator rules as train.py. The point is to
see whether non-linear models pick up patterns linear SVM missed (e.g. interaction
between team_favoredness and is_FW that's hard to capture with linear weights).

Reports per-model results side-by-side so we can pick a winner before wiring
worker production.
"""

import csv, json, os, sys, time
from collections import defaultdict
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
from sklearn.svm import LinearSVC, SVC
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import CalibratedClassifierCV
from allocator import (
    decide_budget, quota_split, allocate_multi_shot,
    hits_count, BUDGET_TO_PLAYERS,
)

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
REPORTS_DIR = os.path.join(os.path.dirname(__file__), 'reports')


def load_samples():
    csv_path = os.path.join(DATA_DIR, 'samples.csv')
    with open(csv_path, encoding='utf-8') as f:
        return list(csv.DictReader(f))


def v0_score(row):
    ot = float(row['ot_overall']) if float(row['ot_overall']) >= 0 else 0
    att = float(row['att_overall'])
    pos = int(row['position'])
    pos_norm = {3: 100, 2: 60, 1: 20, 0: 0}.get(pos, 30)
    ot_norm = min(100, ot * 15)
    att_norm = min(100, att * 10)
    return 0.50 * ot_norm + 0.20 * att_norm + 0.15 * pos_norm + 0.05 * 100


def feature_matrix(rows, feature_keys):
    X = np.array([[float(r[k]) for k in feature_keys] for r in rows], dtype=np.float64)
    y = np.array([int(r['y']) for r in rows], dtype=np.int32)
    return X, y


def fid_order_keys(rows):
    seen, seen_set = [], set()
    for r in rows:
        if r['fid'] not in seen_set:
            seen.append(r['fid'])
            seen_set.add(r['fid'])
    return seen


def build_models(linear_C=0.0001):
    """Return list of (name, sklearn_estimator) — each fits a binary classifier."""
    return [
        ('v1.1_linear_C=0.0001',
         CalibratedClassifierCV(
             LinearSVC(C=linear_C, penalty='l2', class_weight='balanced',
                       max_iter=5000, dual='auto'),
             method='sigmoid', cv=3)),
        ('v2_rbf_C=1_gamma=auto',
         CalibratedClassifierCV(
             SVC(C=1.0, kernel='rbf', gamma='scale', class_weight='balanced',
                 max_iter=20000, probability=False),
             method='sigmoid', cv=3)),
        ('v2_gbt_d3_n100',
         GradientBoostingClassifier(n_estimators=100, max_depth=3,
                                    learning_rate=0.05, random_state=0)),
    ]


def backtest_one_model(rows, by_fid, fid_order, feature_keys, model_factory, name):
    """Run walk-forward for a single model. Returns list of per-fixture precisions."""
    precisions = []
    detailed = []
    min_train = 30
    for k, fid in enumerate(fid_order):
        train_rows = [r for j, f in enumerate(fid_order) if j < k for r in by_fid[f]]
        test_rows = by_fid[fid]
        if len(train_rows) < min_train:
            continue
        n_pos = sum(1 for r in train_rows if int(r['y']) == 1)
        n_neg = len(train_rows) - n_pos
        if n_pos < 5 or n_neg < 5 or len(test_rows) == 0:
            continue

        X_train, y_train = feature_matrix(train_rows, feature_keys)
        X_test, y_test = feature_matrix(test_rows, feature_keys)
        scaler = StandardScaler()
        X_train_s = scaler.fit_transform(X_train)
        X_test_s = scaler.transform(X_test)

        try:
            clf = model_factory()
            clf.fit(X_train_s, y_train)
            probs = clf.predict_proba(X_test_s)[:, 1]
        except Exception as e:
            print(f'  [{name}] fid={fid} fail: {e}')
            continue

        # Allocator-aware evaluation (mirrors train.py)
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
        strong_q, weak_q = quota_split(budget, strong_fav)
        strong_max_p = max(1, round(max_p * strong_q / budget)) if strong_q > 0 else 0
        weak_max_p = max_p - strong_max_p
        if weak_q == 0: weak_max_p = 0

        def pool(side_rows):
            arr = [(r, float(probs[i])) for i, r in side_rows]
            arr.sort(key=lambda x: x[1], reverse=True)
            return arr
        alloc = (allocate_multi_shot(pool(strong_rows), strong_q, strong_max_p)
                 + allocate_multi_shot(pool(weak_rows), weak_q, weak_max_p))
        actual_by_pid = {r['pid']: int(r['shots_on_target_actual']) for r in test_rows}
        hits = hits_count(alloc, actual_by_pid)
        precisions.append(hits / budget)
        detailed.append({'fid': fid, 'hits': hits, 'budget': budget})
    return precisions, detailed


def v0_backtest(rows, by_fid, fid_order):
    """Same allocator-aware framework but score by v0 hand-tuned formula."""
    precisions = []
    for k, fid in enumerate(fid_order):
        train_rows = [r for j, f in enumerate(fid_order) if j < k for r in by_fid[f]]
        test_rows = by_fid[fid]
        if len(train_rows) < 30 or len(test_rows) == 0: continue
        n_pos = sum(1 for r in train_rows if int(r['y']) == 1)
        if n_pos < 5 or len(train_rows) - n_pos < 5: continue

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
        strong_q, weak_q = quota_split(budget, strong_fav)
        strong_max_p = max(1, round(max_p * strong_q / budget)) if strong_q > 0 else 0
        weak_max_p = max_p - strong_max_p
        if weak_q == 0: weak_max_p = 0
        def pool(side_rows):
            arr = [(r, v0_score(r)) for _, r in side_rows]
            arr.sort(key=lambda x: x[1], reverse=True)
            return arr
        alloc = (allocate_multi_shot(pool(strong_rows), strong_q, strong_max_p)
                 + allocate_multi_shot(pool(weak_rows), weak_q, weak_max_p))
        actual_by_pid = {r['pid']: int(r['shots_on_target_actual']) for r in test_rows}
        hits = hits_count(alloc, actual_by_pid)
        precisions.append(hits / budget)
    return precisions


def main():
    rows = load_samples()
    with open(os.path.join(DATA_DIR, 'meta.json')) as f:
        meta = json.load(f)
    feature_keys = meta['features_x']
    by_fid = defaultdict(list)
    for r in rows: by_fid[r['fid']].append(r)
    fid_order = fid_order_keys(rows)

    print(f'\n=== Backtest comparison (allocator-aware, walk-forward) ===\n')
    print(f'Samples: {len(rows)}, fixtures: {len(fid_order)}, features: {len(feature_keys)}\n')

    # 0) v0 baseline
    v0_p = v0_backtest(rows, by_fid, fid_order)
    print(f'  v0 hand-tuned                 : {sum(v0_p)/len(v0_p)*100:.2f}%  ({len(v0_p)} fixtures)')

    # 1-N: each model
    factories = [
        ('v1.1 linear (C=1e-4 L2)',
         lambda: CalibratedClassifierCV(
             LinearSVC(C=0.0001, penalty='l2', class_weight='balanced',
                       max_iter=5000, dual='auto'),
             method='sigmoid', cv=3)),
        ('v2.RBF (C=1, gamma=scale)',
         lambda: CalibratedClassifierCV(
             SVC(C=1.0, kernel='rbf', gamma='scale', class_weight='balanced'),
             method='sigmoid', cv=3)),
        ('v2.RBF (C=0.5)',
         lambda: CalibratedClassifierCV(
             SVC(C=0.5, kernel='rbf', gamma='scale', class_weight='balanced'),
             method='sigmoid', cv=3)),
        ('v2.RBF (C=2)',
         lambda: CalibratedClassifierCV(
             SVC(C=2.0, kernel='rbf', gamma='scale', class_weight='balanced'),
             method='sigmoid', cv=3)),
        ('v2.GBT (d=3, n=100, lr=0.05)',
         lambda: GradientBoostingClassifier(
             n_estimators=100, max_depth=3, learning_rate=0.05, random_state=0)),
        ('v2.GBT (d=2, n=200, lr=0.03)',
         lambda: GradientBoostingClassifier(
             n_estimators=200, max_depth=2, learning_rate=0.03, random_state=0)),
        ('v2.GBT (d=4, n=50, lr=0.1)',
         lambda: GradientBoostingClassifier(
             n_estimators=50, max_depth=4, learning_rate=0.1, random_state=0)),
    ]

    results = []
    for name, fac in factories:
        ps, _ = backtest_one_model(rows, by_fid, fid_order, feature_keys, fac, name)
        if ps:
            mean = sum(ps)/len(ps)*100
            results.append((name, mean, len(ps)))
            print(f'  {name:32s}: {mean:.2f}%  ({len(ps)} fixtures)')

    print(f'\n=== Ranking (vs v0={sum(v0_p)/len(v0_p)*100:.2f}%) ===')
    v0_mean = sum(v0_p)/len(v0_p)*100
    for name, mean, n in sorted(results, key=lambda x: -x[1]):
        delta = mean - v0_mean
        sign = '+' if delta >= 0 else ''
        print(f'  {mean:.2f}%  {sign}{delta:+.2f}pp  {name}')


if __name__ == '__main__':
    main()
