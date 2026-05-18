# 比分手动修正 (Manual Score Fix) — 设计文档

**Date**: 2026-05-18
**Status**: Approved (用户确认)
**Target version**: v4.5

---

## 1. 背景与目标

抓取程序偶尔会写入错误的比分（半场误判为全场，或源站本身数据延迟错位）。
现状：发现错误后只能手工改 KV，没有 admin UI；且修复 KV 后**已 settled 的方案不会自动重算**（settlement 只对 `plans:pending` 生效）。

**目标**：admin 能在管理页直接修正某场比赛的 `score` / `score_ht`，并自动触发该 period 所有方案重算（包括已 settled 的方案 status 翻转）。

---

## 2. 功能边界

**做**：
- admin 选择 period → 列出该期所有 `status=finished` 比赛（含当前比分） → 编辑某场 → 保存
- 后端更新 `matches:{period}` 中目标 match 的 `score` 和 `score_ht`
- 后端重新评估该 period 内所有方案（pending + settled）
- status 变化的方案在 `plans:pending` / `plans:settled` 之间正确流转
- `system:logs` 写入一条比分修正日志 + 每个状态变化的方案一条日志

**不做**：
- 不批量修正（一场一保存，手动操作不引入额外复杂度）
- 不做修正历史撤销/回滚（日志即审计追溯）
- 不允许编辑 status 字段（保持职责单一：只改比分）
- 不允许编辑非 finished 的场次（避免被 worker 自动抓取覆盖造成困惑）
- 不动 GitHub repo（CR/版本是面向用户的元数据；比分修正不进 CR 流）
- 不针对单 leg 反向查找方案；按 A 方案重算"该 period 所有方案"（每期方案数个位数到十几个，重算成本可忽略）

---

## 3. 鉴权

- 整个 design.html 已是 admin gating（管理页的现有约束）
- 新折叠卡片不需要在前端单独做权限判断
- 后端 API 仍需校验 `user.role === 'admin'`，复用 login.js 现有 token 解析逻辑（防止直接调用 API）

---

## 4. 后端 API

### Endpoint
`POST /api/admin/fix-score`

### Headers
`Authorization: Bearer <token>` （走 `AUTH.headers()`）

### Request body
```json
{
  "period": "2026-05-18",
  "match_id": "f1234567",
  "code": "周一001",
  "score": "3-1",
  "score_ht": "1-0"
}
```

### 校验
| 字段 | 校验规则 | 失败响应 |
|------|----------|----------|
| period | `/^\d{4}-\d{2}-\d{2}$/` 且 `matches:{period}` 存在 | 400 / 404 |
| score | `/^\d+-\d+$/` | 400 "比分格式错误" |
| score_ht | `/^\d+-\d+$/` | 400 "比分格式错误" |
| match_id | 在 envelope.matches 中找到（先按 id，再 fallback code） | 400 "比赛不存在" |
| match.status | 必须为 `finished` | 400 "比赛不可编辑" |
| 新旧值 | 与原 score 和 score_ht 完全相同则拒绝 | 400 "比分未变化" |
| 鉴权 | 非 admin 用户 | 401 |

### 主流程

```
1. 校验入参 + 鉴权
2. 读 matches:{period} envelope
3. 在 envelope.matches 中定位目标 match (id → code fallback)
4. 校验 status=finished + 比分格式 + 新旧值不同
5. 记录 oldScore / oldScoreHt
6. 写入新值，put 回 matches:{period}
7. 读 plans:pending 和 plans:settled
8. 分两类处理：
   a. 对 plans:pending 中 plan.period === period 的方案：
      - 重跑 evaluatePlan(plan, updatedMatches)
      - 若 evaluated.status 变为 won/lost → 移到 settled
      - 若仍 pending → 留在 pending（用 evaluated 覆盖原对象，保持 leg 命中标记同步）
   b. 对 plans:settled 中 plan.period === period 的方案：
      - 重跑 evaluatePlan(plan, updatedMatches)
      - 若 evaluated.status 不变（won/lost 同前）→ 用 evaluated 覆盖原对象
      - 若 evaluated.status 翻转（won↔lost）→ 用 evaluated 覆盖原对象（保留 settled 队列归属）
      - 若 evaluated.status 变成 pending（不应发生，因 status 仍 finished；但兜底）→ 移回 pending
9. 写回 plans:pending 和 plans:settled
10. 写 system:logs：
    - 修正日志："比分修正" / "admin {username} 修正 {period} {code} {home}vs{away}：
      score {old}→{new}, score_ht {old}→{new}"
    - 每个 status 翻转的方案一条："开奖修正" /
      "\"{passphrase}\" {oldStatus}→{newStatus}（因{code}比分修正）"
11. 返回 success + 状态变化清单
```

### Response (success)
```json
{
  "success": true,
  "updated_match": {
    "code": "周一001",
    "score": "3-1",
    "score_ht": "1-0"
  },
  "plan_changes": [
    {"passphrase": "今晚吃鸡", "old": "lost", "new": "won"},
    {"passphrase": "梅西封神", "old": "won", "new": "lost"}
  ]
}
```

### Response (error)
```json
{ "error": "比分未变化" }
```

---

## 5. 前端 UI（design.html）

### 5.1 位置与触发
- 管理页底部新增一个折叠区块（与 CR/日志/版本并列），标题 `⚙️ 比分修正`
- 默认折叠；点击展开
- 展开时第一次需要用户输入 period 并点"加载"才拉数据（避免每次进管理页就调 API）

### 5.2 展开后结构

**a. period 选择行**
```
[输入: <input type="date" 默认=今日>]  [加载按钮]
```

**b. 比赛列表**
- 加载完调 `GET /api/matches?period={period}`，过滤 `status === 'finished'`
- 无 finished 比赛 → 占位 "该期暂无已开奖比赛"
- 每场一行紧凑卡片：
  ```
  [周一001] 曼联 vs 切尔西
  全场 [3] - [2]   半场 [1] - [0]    [💾 保存]
  ```
- 编辑两个 number input（min=0, max=99，宽度约 50px）
- 任一 input 变化 → 行背景变浅黄色（pending change 视觉）
- 保存按钮触发该行的提交流程

**c. 保存交互**
1. 点保存 → `confirm()` 弹窗，文字示例：
   `确定将 [周一001] 曼联vs切尔西 修改为：全场 3-2，半场 1-0？\n该期所有方案将重新结算。`
2. 用户确认 → POST `/api/admin/fix-score`，按钮变 disabled + 显示 "保存中..."
3. 成功 → toast `"已修正，N 个方案状态变化"`，重新加载该 period 列表（拉到 KV 最新值），所有行恢复未编辑态
4. 失败 → toast 错误信息（原样显示后端 error 字段），列表不变

---

## 6. 错误处理矩阵

| 场景 | 后端响应 | 前端展示 |
|------|----------|----------|
| 非 admin token | 401 | toast "无权限" |
| 缺少必填字段 | 400 | toast "参数错误" |
| period 格式不对 | 400 | toast "period 格式错误" |
| period 不存在 | 404 | toast "该期无数据" |
| match 不存在 | 400 | toast "比赛不存在" |
| match.status ≠ finished | 400 | toast "比赛不可编辑" |
| 比分格式不对 | 400 | toast "比分格式错误" |
| 新旧值相同 | 400 | toast "比分未变化" |
| KV 写入异常 | 500 | toast "保存失败，请重试" |

---

## 7. 日志格式

由 `lib/logger.js` 现有 `logger(kv, type, message)` 写入 `system:logs`。

**修正日志**（每次成功修正写一条）：
- type: `比分修正`
- message: `admin {username} 修正 {period} {code} {home}vs{away}：score {oldScore}→{newScore}, score_ht {oldScoreHt}→{newScoreHt}`

**状态变化日志**（每个 status 翻转的方案各写一条）：
- type: `开奖修正`
- message: `"{passphrase}" {oldStatus}→{newStatus}（因{code}比分修正）`

---

## 8. 数据流图

```
[design.html: ⚙️ 比分修正卡片]
   │
   │ POST /api/admin/fix-score
   ▼
[functions/api/admin/fix-score.js]
   │
   ├─ 1. 校验 admin token + 入参
   ├─ 2. 读 matches:{period}
   ├─ 3. 修改目标 match 的 score / score_ht
   ├─ 4. 写回 matches:{period}
   ├─ 5. 读 plans:pending + plans:settled
   ├─ 6. 重跑 evaluatePlan 对该 period 全部方案
   ├─ 7. 写回 plans:pending + plans:settled
   └─ 8. 写 system:logs
        │
        ▼
[design.html 日志区可见修正记录]
[index.html / result.html / dashboard 自动用最新数据]
```

---

## 9. 实现拆分（按落地顺序）

1. **后端 evaluatePlan 抽取**：当前 `evaluatePlan` 在 `functions/api/plans.js` 内部，需要 export 出来给新 API 复用（也可以共置到 `functions/api/lib/evaluate.js`）
2. **新增 `functions/api/admin/fix-score.js`**：实现完整流程
3. **design.html UI**：折叠卡片 + period 选择 + 比赛列表 + 保存交互
4. **联调测试**：用一个真实 period 测试 won↔lost 翻转
5. **更新 versions.json + change-requests.json + memory**

---

## 10. 验收清单

- [ ] admin 修正一场已 finished 比赛的比分，KV `matches:{period}` 中该场 score/score_ht 正确更新
- [ ] 该期内 settled 方案 status 正确翻转（won↔lost），并仍在 plans:settled 中
- [ ] 该期内 pending 方案如因比分变化达成 won/lost，正确移到 plans:settled
- [ ] system:logs 看到 1 条比分修正 + N 条状态变化日志
- [ ] result.html、index.html、dashboard.html 刷新后显示新比分和新方案状态
- [ ] 非 admin 调 API 返回 401
- [ ] 提交相同比分（未变化）返回 400
- [ ] 二次确认弹窗正常工作
