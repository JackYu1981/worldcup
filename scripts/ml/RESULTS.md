# Backtest Results — 2026-06-25

## Pipeline summary
Pure local Python ML pipeline mirroring `workers/shot-recommender/index.js`.

Files:
- `snapshot_kv_to_sqlite.py` — dumps KV → `data/ml.db` (~857s, 1264 players)
- `algorithm_mirror.py` — pure-function port of the Worker scoring/picking logic
- `backtest_grid.py` — grid-search over 6480 configs against round-3 holdout

## First grid run

| Metric | Value |
|---|---|
| Configs evaluated | **6480** (after `T2 < T1` filter; nominal 6912) |
| Holdout fixtures | **6** round-3 finished WC matches |
| Snapshot time | 857.0 s |
| Backtest time | **2.3 s** |
| Distinct outcome buckets | **3** (parameter space heavily collapsed by small holdout) |

## Top-3 configs

All three top configs share the cluster `w_on_target=0.40, w_attempt=0.15, SHOT_T1=65, SHOT_T2=50, TEAM_CAP_BONUS=12, w_successor=0.0`. They differ only on `w_starter`:

| Rank | precision@N | hit_rate | ROI proxy @1.85 | predicted | correct | w_starter |
|---|---|---|---|---|---|---|
| 1 | 0.4444 | 1.000 | −17.8 % | 36 | 16 | 0.05 |
| 2 | 0.4167 | 1.000 | −22.9 % | 36 | 15 | 0.03 |
| 3 | 0.3889 | 1.000 | −28.1 % | 36 | 14 | 0.00 |

Across all 6480 configs the distribution collapsed into just three precision tiers (0.389 / 0.417 / 0.444) — a small holdout artifact: most threshold tweaks don't change which player wins each side's top slot.

## Data anomalies discovered

1. **`tournament_matches_played` is unreliable** — every top-scoring player in `players:*` has `matches_played = 1` despite 2-3 actual match records in `match_player_stats`. The Worker's per-match normalization therefore over-estimates rate stats. We side-stepped this by computing pre-match cumulative directly from `match_player_stats` (which is consistent).
2. **Crown AH only covers 12 upcoming fixtures.** All 60 finished fixtures fall back to the inline `handicap.line` from the `matches:{date}` bucket (`source='500'`). `trend` is unknown for these → defaults to `'stable'`, so `TREND_BONUS` is inert during backtest. Re-tuning the trend bonus needs historical Crown snapshots we don't have.
3. **xG is missing from per-match stats**, so the pre-match snapshot uses a heuristic `xg ≈ 0.4 × on_target_per_match`. Worker weights xG at 0.10 only, so impact is small.
4. **Holdout is tiny (6 matches).** Group stage round 3 only has 6/24 fixtures finished as of 2026-06-25. The grid is currently under-powered to discriminate config quality. Recommend re-running once the remaining 18 round-3 matches finish on 2026-06-26/27.

## Output

CSV: `scripts/ml/results/2026-06-25T23-38_grid.csv` (6480 rows, ranked by precision@N → hit_rate → roi_proxy).

## Headline takeaway

Best config achieves **44 % precision@N** (16 correct shots out of 36 predicted) with **hit_rate 1.0** but **ROI −17.8 %** at 1.85 odds — short of break-even, consistent with the global "ML eval mindset" note that 30-50 % precision at 1.85 is near (but below) the profit line. The grid favors **lower thresholds (T1=65, T2=50)** and **higher starter bonus (0.05)** — i.e., trust the lineup signal more and lean into multi-shot picks for medium-score shooters. The production defaults (T1=75, T2=60, w_starter=0.03) sit in the second tier.
