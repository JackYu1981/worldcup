# 2026世界杯AI投注策略方案

## 项目目标

利用AI辅助制定基于概率的世界杯投注策略，通过复式串关组合投注，以较小投入获取较高回报。

**核心参数：**
- 每日投注本金：100元
- 目标回报：1000-2000元（10-20倍）
  目标回报有三种类型，保守型，进取型和激进型，保守型为5-10倍，进取型为10-20倍，激进型为20倍以上
- 选取比赛数：3场/日
- 投注方式：仅限于三串一，不把资金拆散进行复式投注

---

## 技术架构

### 整体流程

```
┌─────────────────────────────────────────────────────────────┐
│                GitHub Pages 前端 (手机友好)                    │
├──────────────┬───────────────────┬──────────────────────────┤
│ 选择页面      │ 投注结果页面       │ 数据看板                  │
│ 赛程+赔率     │ AI计算的组合方案   │ 累计收益曲线              │
│ 复选框点选    │ 100元本金分配      │ 每日盈亏日历              │
└──────┬───────┴───────────────────┴──────────────────────────┘
       │ 用户点选提交
       ▼
┌──────────────┐          ┌──────────────────┐
│ Cloudflare   │ 写入JSON  │  GitHub Repo     │
│ Worker       │─────────▶│  picks/*.json    │
│ (中转API)    │          │  results/*.json  │
└──────────────┘          │  data/*.json     │
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │ Claude Code      │
                          │ 读取选择 →       │
                          │ 计算赔率组合 →    │
                          │ push投注方案     │
                          └──────────────────┘
```

### 口令机制

每次提交选择时，用户需输入一个**口令短语**（任意中文短语，如"今晚吃鸡"、"梅西封神"等）。口令用于在session中快速定位对应的picks文件，避免日期/序号沟通出错。

**流程：**
1. 合伙人在前端选择比赛时，输入口令 → 提交
2. 文件以口令命名存入仓库：`picks/2026-06-15-今晚吃鸡.json`
3. 你在Claude Code session中说出口令（如"今晚吃鸡"）
4. Claude Code执行：pull → 搜索匹配口令的文件 → 计算 → push结果

**优势：**
- 每日可多次提交（不同口令对应不同批次）
- 沟通零歧义，一个词即可触发
- 口令随意取，轻松好记

### 工作流详细步骤

1. **数据采集**：Claude Code获取当日赛程+赔率 → 写入 `data/matches/YYYY-MM-DD.json` → push
2. **前端展示**：GitHub Pages读取JSON，渲染为手机友好的选择页面
3. **用户选择**：合伙人微信打开链接 → 勾选比赛结果 → 输入口令 → 点提交
4. **数据中转**：Cloudflare Worker接收提交 → 通过GitHub API写入 `picks/YYYY-MM-DD-{口令}.json`
5. **AI计算**：你告诉Claude Code口令 → pull → 找到匹配文件 → 计算最优组合 → 写入 `results/YYYY-MM-DD-{口令}.json` → push
6. **结果展示**：前端读取results，展示投注方案
7. **赛后记录**：录入比赛结果 → 更新收益数据 → 曲线/日历自动刷新

### 技术栈

| 组件 | 技术选择 | 说明 |
|------|----------|------|
| 前端 | HTML + Vue3 (CDN) + Chart.js | 单页应用，手机适配，GitHub Pages托管 |
| 中转API | Cloudflare Worker | 免费，接收前端提交写入GitHub |
| 数据存储 | GitHub Repo (JSON文件) | 零成本，版本可追溯 |
| 数据采集 | Python (requests) | 本地运行，获取赔率数据 |
| AI计算 | Claude Code (本session) | 读取选择，计算组合方案 |
| 图表 | Chart.js (收益曲线) + 自定义日历组件 | 轻量前端渲染 |

### 数据结构

#### 赛程赔率文件 `data/matches/2026-06-15.json`
```json
{
  "date": "2026-06-15",
  "matches": [
    {
      "id": "m001",
      "home": "巴西",
      "away": "德国",
      "kickoff": "20:00",
      "group": "A",
      "odds": {
        "home_win": 1.85,
        "draw": 3.40,
        "away_win": 4.20
      }
    }
  ]
}
```

#### 用户选择文件 `picks/2026-06-15-今晚吃鸡.json`
```json
{
  "date": "2026-06-15",
  "passphrase": "今晚吃鸡",
  "submitted_by": "partner_a",
  "submitted_at": "2026-06-15T18:30:00+08:00",
  "picks": [
    {
      "match_id": "m001",
      "selections": ["home_win"]
    },
    {
      "match_id": "m002",
      "selections": ["home_win", "draw"]
    }
  ]
}
```

#### 投注方案文件 `results/2026-06-15-今晚吃鸡.json`
```json
{
  "date": "2026-06-15",
  "budget": 100,
  "combinations": [
    {
      "combo_id": 1,
      "legs": [
        {"match_id": "m001", "pick": "home_win", "odds": 1.85},
        {"match_id": "m002", "pick": "home_win", "odds": 1.45},
        {"match_id": "m003", "pick": "away_win", "odds": 3.20}
      ],
      "combined_odds": 8.58,
      "stake": 50,
      "potential_return": 429
    },
    {
      "combo_id": 2,
      "legs": [
        {"match_id": "m001", "pick": "home_win", "odds": 1.85},
        {"match_id": "m002", "pick": "draw", "odds": 4.50},
        {"match_id": "m003", "pick": "away_win", "odds": 3.20}
      ],
      "combined_odds": 26.64,
      "stake": 50,
      "potential_return": 1332
    }
  ],
  "total_stake": 100,
  "expected_return_range": "429 - 1332"
}
```

#### 收益记录 `data/ledger.json`
```json
{
  "records": [
    {
      "date": "2026-06-15",
      "stake": 100,
      "return": 1332,
      "profit": 1232,
      "hit_combo": 2,
      "status": "won"
    },
    {
      "date": "2026-06-16",
      "stake": 100,
      "return": 0,
      "profit": -100,
      "hit_combo": null,
      "status": "lost"
    }
  ],
  "summary": {
    "total_invested": 200,
    "total_return": 1332,
    "net_profit": 1132,
    "win_rate": "50%"
  }
}
```

### 前端页面规划

| 页面 | 功能 | 说明 |
|------|------|------|
| `/` | 首页/看板 | 累计收益曲线 + 每日盈亏日历 |
| `/pick` | 选择页 | 当日赛程赔率，复选框交互，提交按钮 |
| `/result` | 结果页 | 当日投注方案明细 |
| `/history` | 历史记录 | 按日期查看历史方案和结果 |

### Cloudflare Worker 职责

1. 接收前端POST请求（用户选择）
2. 校验数据格式
3. 通过GitHub API将选择写入仓库 `picks/` 目录
4. 返回成功/失败状态

---

## 数据来源

### 赛程数据
- **Football-Data.org** (免费API)
  - 覆盖世界杯全部赛程
  - 提供赛程、比分、积分榜
  - 免费额度：10次/分钟
  - 文档：https://www.football-data.org/documentation/api

### 赔率数据
- **The Odds API** (主要来源)
  - 40+家博彩公司实时赔率对比
  - 覆盖欧赔(1X2)、让球盘、大小球
  - 免费额度：500次/月
  - Sport Key: `soccer_fifa_world_cup`
  - 文档：https://the-odds-api.com/liveapi/guides/v4/

- **500彩票网** (补充来源，贴近竞彩赔率)
  - JSON接口：`https://odds.500.com/fenxi/json/ouzhi.php?fid={MATCH_ID}`
  - 无需认证，返回多家公司赔率变化历史
  - 覆盖欧赔、亚盘、大小球
目前需要在选择页面对每场比赛加入让球胜平负的选项以及赔率，并且选择赔率要加入这些
当前的模拟实现是复试投注，把100块资金拆散成若干份，然后进行不同的三串一。后期要改为推荐三种类型的投注，分别为保守型进取型和激进型，根据三串一（胜平负和让球胜平负）计算响应赔率，根据赔率来看属于哪个类型
每天的推荐要分别有三种类型，保守型（5倍-10倍）、进取型（10倍-20倍）、激进型（20倍+）可供选择，我们从三种类型中选取一单进行下单，初期进取，如果三天不中，倾向转换到保守，如果中了，酌情下单激进。 每日推荐的结果保存下来，根据比赛结果来判定最后是哪个中奖，并且赔率多少。 在结果页面显示中的赔率曲线。

因为要从这个计算的多种赔率组合中选取一个，所以要记录当天选取哪个组合进行投注，以此来计算获利曲线以及获利金额。

由于世界杯6月12日才开始，之前如果想进行测试，那就可以现在就抓取500彩票网的竞彩数据进行测试，生成每日赔率以及推荐，通过推荐假装选取某一个赔率进行测试，并计算结果以及保存数据。由于当前竞彩比赛每天可能多于四场，会产生更多的结果，所以测试阶段只选取竞彩的比赛编码001-004进行。

## 投注策略框架

### 1. 比赛筛选

每日从当天比赛中筛选3-4场**价值投注**场次，筛选标准：

- **赔率价值分析**：对比多家博彩公司赔率，寻找赔率偏差（市场未充分反映的概率）
- **凯利公式**：计算各结果的期望价值(EV)，筛选正EV场次
- **赛事重要性**：小组赛末轮、淘汰赛等关键场次的动机分析

### 2. 概率建模

将博彩赔率转化为隐含概率，结合以下因素修正：

```
隐含概率 = 1 / 赔率
真实概率 ≈ 隐含概率 - 庄家margin
```

修正因子：
- 球队实力（FIFA排名、近期战绩）
- 比赛场地（主客场/中立场）
- 伤停情况
- 历史交锋记录
- 战意分析（是否已出线/已淘汰）

### 3. 组合投注方案

#### 方案A：纯串关（高赔少注）
- 选3-4场比赛各1个结果
- 赔率相乘，目标总赔率10-20倍
- 优点：投入少，回报高
- 缺点：命中率低（约5-10%）

#### 方案B：复式串关（中赔多注）
- 每场比赛选1-2个结果
- 生成多种组合，每注均摊资金
- 优点：命中率显著提高（15-25%）
- 缺点：单注金额分散，总投入可能超过100

#### 方案C：混合过关（推荐）
- 3-4场比赛混合胜平负 + 大小球/让球
- 部分场次选双重保险（如主胜+平）
- 核心：1-2场高置信场次用单选锁定赔率，1-2场中等置信场次用双选覆盖
- 目标：总注数控制在4-8注，单注12-25元

### 4. 资金管理

- **每日预算上限**：100元（固定）
- **凯利公式辅助**：根据置信度分配注额
- **止损机制**：连续3日未中，次日降低投注额至50元
- **止盈复投**：中奖后次日仍按100元本金投注，盈利存入独立账户

---

## 待讨论事项（与合伙人）

> 以下问题需要和合伙人讨论后确定：

1. **投注平台选择**：竞彩， 当前只有胜平负数据，需要包含竞彩的另一种玩法，即让球胜平负玩法
2. **复式方案倾向**：纯串关(高风险高回报) 并且每天只选一单三串一，所以当前推荐页面也根据赔率选出各种可能得三串一
3. **自动化程度**：手动参考建议后自行投注
4. **是否需要回测**：用近期的500彩票网中国体育彩票竞彩数据来测试该程序是否按期待运行

---

## 部署清单

- [ ] 注册 The Odds API Key
- [ ] 注册 Football-Data.org API Key
- [ ] 注册 Cloudflare 账号，创建 Worker
- [ ] GitHub Pages 开启（仓库Settings → Pages）
- [ ] 合伙人加入GitHub Collaborator
- [ ] 前端页面开发
- [ ] Cloudflare Worker开发
- [ ] 数据采集脚本开发
- [ ] 收益看板开发
- [ ] 端到端测试

---

## 风险提示

- 任何投注策略都无法保证盈利，本方案旨在提高概率判断的科学性
- 10-20倍回报对应的串关命中率约5-15%，需要做好连续不中的心理准备
- 建议设定总投入上限（如整个世界杯期间不超过3000元）
- 长期期望值取决于能否持续发现正EV投注机会

---

# 第二部分：当前实际架构（v4.x，持续更新）

> 本节是系统的"活文档"，与代码同步更新。前面的初始设计仅作历史参考，**系统实际状态以本节为准**。

## 当前架构概览

```
┌─────────────────────────────────────────────────────────────┐
│ 前端：Cloudflare Pages (worldmoney.pages.dev)                │
│  - index.html (赛程)                                         │
│  - recommend.html (推荐 + AI优化卡)                          │
│  - result.html (开奖方案)                                    │
│  - dashboard.html (收益看板)                                 │
│  - design.html (管理：CR/版本/日志)                          │
└─────────────────┬───────────────────────────────────────────┘
                  │ Pages Functions (/api/*)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ 后端：Cloudflare Pages Functions                              │
│  - /api/login            认证                                 │
│  - /api/matches          读取赛程（公开）                     │
│  - /api/picks            推荐查询（需登录）                   │
│  - /api/plans            方案查询（需登录，只读）             │
│  - /api/submit           生成预备方案                         │
│  - /api/cr               升级请求读写（KV）                   │
│  - /api/upload           GitHub上传文件                       │
│  - /api/logs             系统日志（admin）                    │
│  - /api/design-data      管理页CR/版本聚合                    │
│  - /api/period-version   比赛数据版本号（缓存失效用）         │
│  - /api/admin/fix-score  比分修正（admin）                    │
│  - /api/admin/release    发版（admin）                        │
│  - /api/admin/settle     触发开奖结算（admin / scraper secret）│
└──────────┬──────────────────────────────────────┬───────────┘
           │                                       │
           ▼                                       ▼
   ┌───────────────┐                      ┌──────────────┐
   │ Cloudflare KV │                      │ GitHub Repo  │
   │ MATCH_DATA    │                      │ (CR/版本JSON) │
   │ (主存储)      │                      └──────────────┘
   │ - matches:    │
   │ - picks:      │
   │ - plans:      │
   │ - system:logs │
   └───────────────┘
           ▲
           │
   ┌───────────────┐
   │ Worker        │
   │ worldcup-     │
   │ scraper       │
   │ cron 11:01    │
   │ cron */30min  │
   └───────────────┘
```

## 数据存储

**主存储：Cloudflare KV (MATCH_DATA, namespace 278f1209ffd84662bd51921370a2fbe9)**

> **核心模型 v4.2：period（彩票期号）= 开奖日 YYYY-MM-DD**，等同 500.com `kaijiang.php?date=X` 中的 X，是赛程/推荐/方案/开奖之间的稳定关联键。一期可能跨日（周日期含 5/17 全天 + 5/18 凌晨比赛），但 period 始终为开奖日。

KV键命名（key 即 period 值）：
- `matches:{period}` — 当期赛程envelope，envelope和每场match都带 `period` 字段
- `picks:{period}` — 用户推荐数组（每条带 period）
- `plans:{period}` — 当期所有方案明细（按提交时间累积）
- `aggregate:unsettled_plans` — 全局待结算方案队列
- `aggregate:settled_plans` — 全局已结算方案（won/lost）
- `system:logs` — 系统日志（环形）
- `system:logs:YYYY-MM` — 月度归档

**比分字段语义**：
- `score` — 90分钟全场比分（竞彩开奖唯一权威值）
- `score_ht` — 半场比分（竞猜半场玩法用，括号内值）

**比赛时间字段语义（v4.3）**：
- `period` — 竞彩期次（YYYY-MM-DD，开奖日），与跨日的实际比赛时间无关
- `kickoff` — 比赛开赛时间（"YYYY-MM-DD HH:MM" 北京时间），单一字段同时含日期与时间
- `date` — @deprecated，新数据不再写入；历史KV数据仍含此字段，前端通过fallback兼容

**GitHub Repo (JackYu1981/worldcup) 仅存：**
- `data/change-requests.json` — CR追踪
- `data/versions.json` — 版本记录
- 设计文档与代码

> 历史上 picks/results 也存过 GitHub，已迁移至 KV。

## 数据采集（Worker: worldcup-scraper）

- **域名**：`worldcup-scraper.yujuntao1981.workers.dev`（**注意：用户公司笔记本无法访问 workers.dev 子域名，由防火墙SSL拦截**）
- **赛程源**：500.com `https://trade.500.com/jczq/?playtype=1&date=YYYY-MM-DD`（GBK编码）
- **比分源（v4.2 切换为唯一权威源）**：`https://zx.500.com/jczq/kaijiang.php?date={period}` — 开奖页只列已开奖比赛，含半场+全场比分，按 `code`（"周日NNN"）匹配。
  - **已删除** `live.500.com/zqdc.php` 抓取 —— 它是实时数据，红字td会误把半场比分当成终场。
  - **已删除** jczq `data-isend=1` 备用源 —— 同样可能在 isend 设置时点不准确。
- **Cron**：
  - `1 3 * * *` (UTC) → 北京 11:01 抓当期赛程，写入 `matches:{period}`，period=today
  - `*/30 * * * *` 每30分钟更新比分；有比分变化时 POST `https://worldmoney.pages.dev/api/admin/settle`（带 `X-Scraper-Secret` 头）触发结算。`/api/admin/settle` 调用 `lib/settle.js` 的 `settlePendingPlans(kv)`，把已决出胜负的方案搬到 `aggregate:settled_plans`。
- **关键过滤**：按 code 前缀（"周X"）过滤 — 因为 500.com 一期可能跨日
- **覆盖式更新**：开奖页比分更新会覆盖任何已存储记录（包括 status=finished 的旧错误数据），任何比分变化都会修正。

## AI 投注优化算法 v2.0（2026-05-18 晚 — 经数学review重构）

详见 `memory/project_ai_betting_algorithm.md`，核心要点：

**版本沿革**：
- v1.0：100元本金 / 18元AI预算 / [600,1800] 窗口
- v1.1：本金 100→150，AI预算 18→30，窗口 [600,1800]→[900,2700]（倍数 6-18× 不变），允许 ±4 元浮动
- **v2.0**：经数学review重构——不引入 EV 维度（小样本下不可靠），主目标精确化为 P(有效命中)，次目标改为 ω 覆盖数最大化（鲁棒性优于期望最大化），用户勾选改软约束

**固定参数（v2.0）**：
- 总本金 150 元（受 2 元最小单位约束允许 ±4 元浮动，实际总投入 ∈ [146,154]）
- AI 自主预算 ≤ 30 元
- 目标收益窗口 [900, 2700]（6-18 倍）
- 最小注 2 元

**核心哲学**：
- 不依赖 EV 维度（世界杯小样本下 p 估计不稳定）
- 让收益落在概率与奖金的中间地带
- 在 P(有效命中) 相同时，优先选择覆盖更多世界状态的方案
- **不要求用户量化胜率**：通过"信心放大因子 c（默认 0.6）"从赔率反推 + 用户勾选信号合成 p_user，避免量化运气感的认知负担

**信心放大因子 c 的数学含义**：
- 用户勾选某结果时：p_user(勾选) = c·1 + (1-c)·p_market_norm(勾选)（市场反推 + 去 margin）
- 未勾选结果按市场比例分配剩余概率
- c = 0：完全信任市场；c = 1：100% 押勾选（极端，禁用）；c = 0.6（默认）：用户判断 60% 权重 + 市场 40% 权重
- 用户可在生成方案时显式指定 c（如"生成方案，口令：XXXX，c=0.5"）

**算法流程**：
1. 枚举候选 3串1（用户原选 U + AI 候选单场切换 A）
2. 窗口剔除：F(c) = { x ∈ {2,4,6,...} : 900 ≤ x·odds_c ≤ 2700, x ≤ 剩余预算 }，剔除 F(c)=∅ 的组合
3. 世界状态枚举：ω 包括 1x2 和让球两个 market 维度，|Ω| ≤ 3^6 = 729 种；P(ω) = ∏ p_user
4. 整数线性规划（三优先级目标 + 简化约束）：
   - **主目标**：max P_eff(x) = ∑_ω P(ω) · 𝟙[Payoff(ω,x) ∈ [900,2700]]
   - **次目标**：在主目标最大解集中，max N_cov(x) = |{ω : P(ω)>0 ∧ Payoff(ω,x)∈[900,2700]}|
   - **第三优先级（软偏好）**：在 P_eff 和 N_cov 都最优的解集中，max N_user = 覆盖的用户勾选 leg 数
   - 约束：∑x_c ∈ [146,154]，∑x_c (c∈A) ≤ 30，格点约束
   - **注意**：取消了"用户必保 ≥2 元"硬约束（实践中常导致几何不可行）。AI 可自由舍弃用户勾选，但需在报告中明示
5. 自救：用户组合不可行时 AI 在 30 元预算内枚举更多 A 候选；仍不可行则 fail 并提示用户调整
6. 输出：每注金额/赔率/概率，P_eff，N_cov，N_user，E[收益] vs E_naive，被舍弃的勾选+理由

**UI 入口**：recommend.html 的"🤖 AI 优化方案"卡片可点击，弹出算法详情。标注 "Powered by Claude Opus 4.7"。

## 部署与运维

- **部署方式**：必须用 wrangler CLI（GitHub自动部署不可靠，曾出现>4分钟未生效）
  - Pages: `npx wrangler pages deploy . --project-name=worldmoney --branch=main --commit-dirty=true`
  - Worker: 在 `workers/scraper/` 目录下 `npx wrangler deploy`
- **每次发版后必须做的**：
  1. 更新 `data/change-requests.json` 把已解决的CR标记为 adopted
  2. 更新 `data/versions.json` 添加新版本（design.html 当前方案要点）
  3. git commit + push
  4. wrangler 部署到 Pages（如改了 functions/）和 Worker（如改了 scraper/）

## 已知问题与待优化

### 抓取可靠性（待实施）
**问题**：worker cron 偶发不触发，用户公司防火墙无法访问 workers.dev 子域名手动触发。

**方案A（推荐，待实施）**：在 `/api/matches` 中加入"按需自救"——当请求今日数据但KV为空时，由 Pages Functions 同步抓取并写入KV。这条路径走 `pages.dev` 域名，不被防火墙拦截。

**方案B（已规划）**：cron 多次冗余 `1,16,31,46 3 * * *`，第一次失败后自动重试（已有 `existing.matches.length>0` 的跳过逻辑保证幂等）。

### 历史已修复
- **比分半场误判（v4.2）**：之前抓 live.500.com 的红字 td 误把半场比分当终场存入 score。已切换为开奖页 `kaijiang.php` 单一权威源，按 code 匹配。`score_ft` 字段误名（实际为半场）已重命名为 `score_ht`。5/17 19场错分已修复。
- **结算skip-when-finished bug（v4.2）**：原 `updateScores` 用 `allDone` 跳过已finished记录，导致错分无法修正。新版改为开奖页覆盖式比对，任何比分变化都会写回。
- **缺少期次稳定关联（v4.2）**：通过引入 `period` 字段（=开奖日），matches/picks/plans 全部按 period 关联，结算按 `plan.period` 加载对应期 matches，跨日比赛归属明确。
- 比分错误：原 `parseScores` 不检查 status，把进行中比分当作终场。已改为只取 status=3/4。
- jczq vs live 双源：jczq `isend=1` 提供90分钟比分（开奖用），live 提供 `score_ft` 终场比分。
- 浏览器缓存：`/api/picks` 的 `Cache-Control` + JS层 `picksCache` 双重缓存导致提交后看到旧数据。已加 `_t` 时间戳和缓存清除。
- 管理页限流：design.html 直调 GitHub API 受 60次/小时 限制。已改走 `/api/design-data` 后端聚合。

## 设计哲学

1. **投注助手不替用户做赌博性决策** — AI 只在明确边界内优化，用户保留最终选择权
2. **运气与概率协调** — 用户用胜率估计输入"运气感"，AI 在概率空间内优化
3. **可解释、可复现** — 算法每次输出必须可解释，相同输入产生相同输出
4. **900-2700 窗口不可妥协** — 这是策略灵魂，对应"中间地带"的投注哲学（v2.0：本金 150 元±4浮动，倍数 6-18× 不变；不引入 EV 维度，主目标 P(有效命中) + 次目标 ω 覆盖数）

