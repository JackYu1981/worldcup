# ML 方案构思 v2（2026-06-26 凌晨）

> 待明日 review。当前 worker 用 v0.5-preview 算法（简单加权）继续生产；
> 此文记录"为什么 v0.5 不够好"和"v0.6 / v1 怎么走"。

## 一、当前 v0.5 算法的局限

```
score = 0.45×on_target_per_match
      + 0.20×attempt_per_match
      + 0.15×position
      + 0.10×xg
      + 0.03×starter
      + 0.07×successor_bonus  (替补保证, 待实现)
```

**已知问题**（按严重度排序）：

| # | 问题 | 影响 |
|---|---|---|
| 1 | **静态特征**：用本届至今 cumulative rate，**忽略趋势**（一个 4 场 2-1-0-3 射门的人和一个 4-4-4-4 平均都是 2.75/场，但状态完全不同）| ★★★★ |
| 2 | **对手强弱没建模**：Mbappé 对秘鲁均场 6 射门 vs 对德国均场 3 射门——cumulative 平均掉了对手信息 | ★★★★ |
| 3 | **位置粒度太粗**：position=3 (前锋) 一律 100 分，但 9 号中锋 vs 边锋 vs 攻击型中场射门模式天差地别 | ★★★ |
| 4 | **starter 跟 successor 互斥设计反直觉**：成熟模板"首发 + 强力替补 = A 更值得投"我们用 successor_bonus，但**真实信号还是缺**（需要替补登场比例 × 替补射门率乘积）| ★★★ |
| 5 | **xG 用 heuristic 估算**：FIFA fdh 不给逐场 xG，目前 backtest 用 `0.4 × on_target_per_match`——本质上跟主特征 leak | ★★ |
| 6 | **没考虑伤停/红黄停赛**：FIFA `events.bookings` 有 booking 数据，2 张黄就 ban 下场，但 worker 不读 | ★★ |
| 7 | **盘口移动信号弱**：用了 line.abs 决定 strong/weak 切分，但没用「初盘 vs 即时盘」的差值/方向（盘口大幅变化往往揭示市场信息）| ★★★ |

## 二、v0.6 增量改造（保守可上线）

**目标**：在 v0.5 框架内加 2-3 个新特征，不重构。

```
score = 0.30×on_target_per_match     ↓ from 0.45
      + 0.15×attempt_per_match       ↓ from 0.20
      + 0.10×position
      + 0.10×xg
      + 0.03×starter
      + 0.07×successor_bonus
      + 0.15×form_trend              ← 新：最近 3 场加权移动平均
      + 0.05×opp_strength_adj        ← 新：对手让球级别×位置 (前锋强=对手让 1.5→+15, 弱=对手让 0.5→-10)
      + 0.05×line_move_lift          ← 新：盘口加注=+5, 缩水=-5
```

**form_trend 公式**：
```
recent_3 = last 3 matches in tournament (kickoff DESC)
form = 0.5×match[-1].on_target_per_match + 0.3×match[-2] + 0.2×match[-3]
     - mean(on_target_per_match across all matches)
form_norm = clamp(form * 30 + 50, 0, 100)
```

样本不足时（≤1 场）回退到 cumulative。

## 三、v1 模型路线（机器学习真模型）

**目标**：用 XGBoost / Logistic Regression 在 sqlite 上训练。

**特征工程（≥ 30 维）**：
```
Per-player static:
  - position (one-hot)
  - shirt_number band (1-9 / 10-19 / 20-30)  # 9号 / 中前场惯例
  - country_tier (FIFA ranking bucket)

Per-player rolling (last N games):
  - rolling_on_target_per_match (N=2/3/5)
  - rolling_attempt_per_match
  - rolling_minutes_played
  - rolling_replaced_at_minute (是否经常被早换下)
  
Per-match dynamic:
  - opponent_def_rating (opponent's allowed shots/match)
  - line_abs (asian handicap magnitude)
  - line_move_signed (current - open)
  - water_diff (home_water - away_water 反映强弱不对称)
  - trend (rising/falling/stable)
  - team_attack_capacity (Σ teammates on_target/match)
  - is_home (主场)
  - rest_days_since_last_match
  
Per-player meta:
  - prev_match_shots (上场射门数 — direct momentum)
  - prev_match_was_starter (boolean)
  - days_since_last_appearance
```

**Label 设计**：
- 二元：is_shots_on_target_ge_1 (球员该场是否射正 ≥ 1)
- 数值：实际 on_target_count（用 Poisson regression）

**训练数据**：
- 用 finished WC matches，每场每球员一行（≈ 1100 行 finished）
- 每场都做 walk-forward：用「该场之前的所有数据」算特征，**目标 = 这场实际 on_target**

**评估**：
- 主指标：precision@6（推荐 6 注里命中数 / 6）
- ROI proxy @1.85 odds
- 跟 v0.5 baseline 对比 lift

## 四、需要先解决的数据问题（已识别）

| 问题 | 修复方案 |
|---|---|
| `tournament_matches_played` 全报 1 | fifa-scraper 修 — 但暂时 ML 端用 sqlite `actual_matches_played` 绕过 |
| Round-3 只有 6 场 finished | 2026-06-27 自然补齐 24 场 |
| 历史 xG 缺失 | 接受用 0.4×on_target heuristic，或考虑彻底移除 xG 特征 |
| 替补登场关系数据稀疏 | sub_chain 等淘汰赛后期再启用，小组赛样本太薄 |

## 五、明天的具体动作

1. **早上 review 此文档**——你确认 v0.6 → v1 路线 OK 后开工
2. **等 6/27 round-3 全踢完**（24 场 holdout）→ 重新 snapshot sqlite
3. 实现 v0.6 三个新特征（form_trend / opp_strength / line_move）
4. 重跑 backtest，看新特征下 grid 是否能拉开配置间 precision 差距（之前收敛到 3 档说明信号太弱）
5. 如果 v0.6 能让 holdout precision > 0.5 → 烧回 worker；否则进 v1 训练

## 六、长期方向（v2+）

- **每球员独立模型**（针对顶级射手，如 Mbappé/Vinicius 专门 fit）
- **赔率反推 prior**：博彩公司大盘 → 球员 over/under 1.5 射正赔率 implies probability，作为 prior
- **半场后续推**：基于上半场实际表现，重新发布二次推荐
