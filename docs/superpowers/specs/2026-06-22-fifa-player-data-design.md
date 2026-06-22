# 球员数据模块设计文档

**Status**: v4（incorporates 2026-06-22 pre-implementation probe findings）
**Date**: 2026-06-22
**Findings reference**: [2026-06-22-fifa-data-source-findings.md](./2026-06-22-fifa-data-source-findings.md)

## 0. v4 实施前 probe 校正（必读）

2026-06-22 实施前对 FIFA 真实 endpoint 做了实际 curl 验证，发现 v3 几处假设需修正：

| spec v3 假设 | v4 真实情况 | 影响 |
|---|---|---|
| mangodev 裸调 OK | **403 Forbidden 必须用 gameDay token** | tournament-wide cron 强制 token 流程 |
| `Properties.IdStatsPerform` = fdh_match_id | **不是！** 它 = IdMatch（同 25 字符哈希） | fdh_match_id 真实来源 = mangodev `actor.tags["urn:gd:tag:story:staff:match_squad:match_id"]`（6 位数字数组） |
| `parseStatValue` 待 probe | ✅ 已确认：`actor.tags["urn:gd:tag:football:stats:{stat_name}"]` 直接含数值 | 见 §4.4 实现 |
| stat 名 `attempts_on_target` | 真实命名规则 = `urn:gd:tag:football:stats:{snake_case_name}`，正确的几个：`goals`、`assists`、`total_competition_minutes_played`、`fdcp_top_scorer_rank`（其他待首轮跑后枚举） | STAT_KEY_MAP 真实键名 |
| `page_size`=未知 | ✅ 真实值：**1 story = 50 actor**，每 stat 共 **25 page**，`limit` URL 参数应保持 **1**（一 story 一 page） | 见 §4.4 实现 |
| `mangodev limit` | `limit=50` → 429 `Pagination limit threshold breached`，`limit=1`/`limit=2` OK | 用 `limit=1` |
| `FieldStatus` 0=替补/1=首发/2=未上场 | **真实：1=首发，2=替补，无 0** | logSlaForLineup 改判断；match_lineups 拆 starting/substitutes 逻辑沿用 |
| `Position` 0/1/2/3 待 probe | ✅ 真实：**0=GK / 1=DF / 2=MF / 3=FW / 6=其他**（实际从首发 11 人推断） | 增加 6 enum，前端 mapping 时处理 |
| profile 字段（country_code / position / photo） 必须 live/football 拿 | **mangodev actor.tags 全自带**：`team:abbreviation` (GER) / `staff:position` (FW) / `staff:image` (digitalhub URL) / `team:name:zho` (德国) | tournament-wide cron 可直接补充这些字段，减少对 live/football 的依赖 |
| `country_zh` 靠 KV `countries` 表反查 | mangodev actor 自带 12 国语言名（含 zho） | `countries` 仍维护"500 中文名 ↔ FIFA 大写码"，但 player 档案的 `country_zh` 直接取 actor.tags |

### v4 因此修订的关键模块
- §3.0 矩阵：mangodev cron 写入字段集合扩展（country_code/country_zh/position 都可以由 mangodev 写，因为它有更丰富的 metadata）；主 cron 仍是该球员所在场次时的 lineup 信息权威源（shirt_number / last_match_id / captain / starting-vs-substitute），但全局 profile（country_code / position）改为 mangodev 主、主 cron 兜底
- §4.4：mangodev cron 必须先取 gameDay token；URL `limit=1`；解析 actor.tags 标准化键名
- §4.5：fdh_match_id 不再走 `extractFdhMatchId(liveData)`；改为 mangodev cron 中从 `actor.tags["urn:gd:tag:story:staff:match_squad:match_id"]` 解出该球员参与的 fdh_match_id 数组，存到 `players:{id}.fdh_match_ids`；主 cron 查询本场 fdh_match_id 时，从 lineup 中任一球员的 `fdh_match_ids` 中找最大值（最新场），或从 mapping 沉淀的 `fdh_match_id` 列表中按时间窗口选

## 1. 目标与范围

### 1.1 目标
为现有世界杯投注项目新增「球员数据查询」模块，让用户在赛前能查看：
- 当场比赛 FIFA 官方公布的首发 + 替补名单
- 每个球员本届世界杯累计 attacking / discipline stats
- 自动定时 + 手动按需刷新

### 1.2 核心 SLA
**用户在 kickoff − 60min 时打开页面，必须看到 FIFA 官方公布的准确首发 lineup。**

实现承诺：
- FIFA 官方一般在 KO−90~60min 公布 lineup
- scraper 在 [KO−90, KO−45] 窗口加密为 **每 2 分钟一次**，确保最迟 KO−58min 写入 KV
- KO−60min 时若 KV 仍无 lineup，API 返回 `{"lineup_available": false, "reason": "not_yet_published_by_fifa", "next_attempt_in_seconds": N}`，前端按提示渲染"等待中"状态

### 1.3 范围内
- 从 FIFA 多个 endpoint 抓取数据，写入 Cloudflare KV
- 自动把 500.com 的 fixture 映射到 FIFA match
- 维护球员档案（按 ID 一人一 key，按国家索引）
- 维护当场 lineup 数据
- 预留前端读取的 GET API 端点
- 预留「生成方案」占位端点

### 1.4 范围外（不做）
- UI 设计与实现（第二阶段，待用户提供截图）
- 投注算法（FIFA 数据仅作信息参考，不参与决策）
- 赔率获取（FIFA 不提供赔率，500.com 也不提供单球员玩法）
- 实时事件流（黄牌/进球的 WebSocket 推送，本期改用 5min 轮询）

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                       Cloudflare Pages                            │
│  ┌──────────┐  ┌──────────────────┐  ┌─────────────────────────┐ │
│  │ players  │  │  result.html     │  │  /api/fifa/*            │ │
│  │  .html   │  │  (待扩展)         │  │                         │ │
│  │ (后期做) │  │                  │  │                         │ │
│  └──────────┘  └──────────────────┘  └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              ↓ KV 读写
┌──────────────────────────────────────────────────────────────────┐
│                  Cloudflare KV (MATCH_DATA)                       │
│   players:* / players_by_country:* / match_lineups:*              │
│   fixture_mapping:* / fifa_calendar / countries                   │
│   fifa_sla_logs:* (hourly shard)                                  │
└──────────────────────────────────────────────────────────────────┘
                              ↑ 写入
┌──────────────────────────────────────────────────────────────────┐
│              Cloudflare Worker: worldcup-fifa-scraper             │
│                                                                   │
│  cron */2 * * * *    →  per-match window 抓取（lineup + stats）  │
│  cron 0 */6 * * *    →  刷 fifa_calendar + auto mapping          │
│  cron 0 17,21,1,5 * * *  →  tournament-wide stats (4 次/天)      │
└──────────────────────────────────────────────────────────────────┘
                              ↓ 拉取
┌──────────────────────────────────────────────────────────────────┐
│                        FIFA 三大数据源                             │
│  api.fifa.com/api/v3/...      (calendar + live/football)         │
│  fdh-api.fifa.com/v1/...      (单场 player stats)                │
│  gameday-prod.fifa.mangodev.co.uk/1-0/...  (tournament-wide)    │
└──────────────────────────────────────────────────────────────────┘
```

新增 worker：`workers/fifa-scraper/`，独立于现有 `workers/scraper/`（500.com 抓取）。

### 2.1 与现有 500.com scraper 的接口
fifa-scraper 通过现有 KV key `matches:{YYYY-MM-DD}` 读取 500.com fixture：
- value 形态：`{date, source: "500.com", matches: [{id, code, home, away, kickoff, date, status, ...}]}`（与 `workers/scraper/index.js` 写出的 envelope 一致）
- fifa-scraper 不修改这些 key，只读

## 3. 数据模型

### 3.0 数据源责任矩阵（关键，避免 cron 间相互覆盖）

各 KV 字段的**写入权威源**严格分离，cron 之间不得交叉写。**这是 KV 并发写入安全的硬约束。**

| 字段 | 权威源 | 由哪个 cron 写 | 不可被谁写 |
|---|---|---|---|
| `players:{id}.id` / `name` / `name_default` | live/football lineup | 主 cron `*/2 *` | mangodev cron 仅补名字翻译 |
| `players:{id}.country_code` / `country_zh` / `team_id` | live/football lineup | 主 cron | mangodev cron 不写 |
| `players:{id}.position` / `shirt_number` | live/football lineup | 主 cron | mangodev cron 不写 |
| `players:{id}.photo_url` | mangodev stories actor (`tags.staff:image`) | tournament-wide cron | 主 cron 不写 |
| `players:{id}.name.{lang}` 各语言翻译 | mangodev stories actor (`name` dict) | tournament-wide cron | 主 cron 仅写 `name.eng` |
| `players:{id}.tournament_stats.attacking/discipline` | mangodev stories | tournament-wide cron | 主 cron 不写 |
| `players:{id}.tournament_stats.matches_played` / `minutes_played` | 主 cron 累加（用 `last_match_id` 作 watermark） | 主 cron | mangodev cron 不写 |
| `players:{id}.last_match_id` | live/football | 主 cron | mangodev cron 不写 |
| `players:{id}.last_updated` | 任何 cron 写完后更新自己时间戳 | 任何 cron | — |
| `players_by_country:{C}.roster[]` | live/football lineups 累积 + mangodev `teams` endpoint 兜底 | 主 cron（增量）+ tournament-wide cron（rebuild） | — |
| `players_by_country:{C}.roster[].stats_summary` | mangodev stories | tournament-wide cron | 主 cron 不写 |
| `match_lineups:{500_id}` 全部 | live/football | 主 cron | — |
| `fixture_mapping:{500_id}` 全部 | 主 cron + calendar cron | 两个 cron 都写 | — |
| `fifa_calendar` | FIFA calendar/matches | calendar cron | — |

**两个 cron 写同一 key 时的合并约定**：
- 主 cron 写 `players:{id}` 前：`GET → 仅修改本表"主 cron 列"列出的字段 → PUT`
- tournament-wide cron 写 `players:{id}` 前：`GET → 仅修改本表"tournament-wide cron 列"列出的字段 → PUT`
- 字段集不相交，**最坏情况是两次 PUT 互相延迟覆盖某次更新，但不会产生不一致状态**（因为每个字段都只有一个权威源）


### 3.1 KV 键空间

所有 key 共用现有 `MATCH_DATA` namespace（id=`278f1209ffd84662bd51921370a2fbe9`）。新增以下前缀：

| Key | Value 形态 | 写入方 | TTL |
|---|---|---|---|
| `countries` | 国家码对照表 | admin（含 seed 默认） | 无 |
| `fifa_calendar` | FIFA 全 WC fixture list 缓存 | fifa-scraper（6h cron） | 无 |
| `fixture_mapping:{500_id}` | 单场 500↔FIFA ID 映射 | fifa-scraper（自动） | 无 |
| `players:{player_id}` | 球员档案 + tournament_stats | fifa-scraper | 无 |
| `players_by_country:{COUNTRY_CODE}` | 国家球员索引（含 stats 摘要） | fifa-scraper | 无 |
| `match_lineups:{500_id}` | 当场首发+替补名单+事件 | fifa-scraper | 无 |
| `fifa_sla_logs:{YYYY-MM-DD}:{HH}` | SLA 监控日志（**按小时分片**） | fifa-scraper | 86400×7 秒 |

### 3.2 详细 schema

#### `countries`
```json
{
  "version": 1,
  "updated_at": "2026-06-22T12:00:00+08:00",
  "items": [
    {"zh": "西班牙", "code": "ESP", "en": "Spain"},
    {"zh": "沙特阿拉伯", "code": "KSA", "en": "Saudi Arabia"},
    {"zh": "墨西哥", "code": "MEX", "en": "Mexico"},
    {"zh": "刚果(金)", "code": "COD", "en": "Congo DR"},
    ... 48 国
  ]
}
```

**实现约定**：
- `code` 统一存大写 3 字母（FIFA live/football API 用大写）
- 任何需要 mangodev 小写 `nation_id` 的地方，**代码内 `code.toLowerCase()` 派生**，不在数据里冗余存
- `zh` 必须与 500.com 抓取的 home/away 名字精确匹配（含全角括号"刚果(金)"等特殊形态）
- admin 页可编辑此 key
- 系统启动时如 KV 不存在则用代码内 seed 初始化（seed 见 §9.1）

#### `fifa_calendar`
```json
{
  "fetched_at": "2026-06-22T12:00:00+08:00",
  "from_utc": "2026-06-15T00:00:00Z",
  "to_utc": "2026-07-20T23:59:59Z",
  "competition_id": 17,
  "matches": [
    {
      "id_match": "<25 char hash>",
      "id_competition": "<25 char hash>",
      "id_season": "<25 char hash>",
      "id_stage": "<25 char hash>",
      "date_utc": "2026-06-15T02:00:00Z",
      "home_code": "SWE",
      "away_code": "TUN",
      "home_name_en": "Sweden",
      "away_name_en": "Tunisia",
      "match_status": 0,
      "stage_name": "Group Stage"
    },
    ... 67 场
  ]
}
```

#### `fixture_mapping:{500_id}`
```json
{
  "fifa_id_match": "<25 char hash>",
  "fifa_id_season": "<25 char hash>",
  "fifa_id_stage": "<25 char hash>",
  "fifa_id_competition": "<25 char hash>",
  "fdh_match_id": "151651",
  "home_code": "ESP",
  "away_code": "KSA",
  "kickoff_utc": "2026-06-21T16:00:00Z",
  "kickoff_local_beijing": "2026-06-22 00:00",
  "matched_at": "2026-06-22T11:00:00+08:00",
  "match_confidence": "exact",
  "match_note": null,
  "unmatched_retry_after": null
}
```

- `match_confidence`: `exact` | `time_skew_5min` | `unmatched`
- **`unmatched` 也持久化到 KV**（连同 `unmatched_retry_after = matched_at + 1h`），主 cron 看到 `unmatched` 且未到 retry_after 时跳过，到点后才重试。避免每 2min cron 都重做大量 country→code 查表 + calendar 扫描。
- `fdh_match_id` 写入时机（v4 修订）：
  1. 初次 mapping 时 = null
  2. tournament-wide cron 处理 mangodev story 时，从 actor.tags 拿到该球员参与的所有 `fdh_match_ids`，存入 `players:{id}.fdh_match_ids`
  3. 主 cron 处理本场抓取时，**反查**：从本场 lineup 的任一已建档球员的 `fdh_match_ids` 列表中找新近一场（按是否在 `[KO−1d, KO+1d]` 时间窗内估计），赋值到 mapping.fdh_match_id；若无任何球员有 fdh_match_ids（赛季初），跳过 fdh-api 链，每 2min 重试
  4. **fallback**：mapping.fdh_match_id 仍为 null 时，admin endpoint 可手动注入该值（`PUT /api/fifa/mapping/:500_id`），保证升级路径

#### `players:{player_id}`
```json
{
  "id": "447853",
  "name": {
    "eng": "David RAYA",
    "spa": "David Raya",
    "zho": "戴维·拉亚"
  },
  "name_default": "David RAYA",
  "country_code": "ESP",
  "country_zh": "西班牙",
  "team_id": "43969",
  "position": 0,
  "position_label": "GK",
  "shirt_number": 1,
  "photo_url": "https://digitalhub.fifa.com/transform/.../RAYA-David_447853?...",
  "fdh_match_ids": ["151631", "151634"],
  "tournament_stats": {
    "version": 1,
    "fetched_at": "2026-06-22T03:00:00+08:00",
    "source": "mangodev",
    "matches_played": 2,
    "minutes_played": 180,
    "attacking": {
      "AttemptAtGoal": 5,
      "AttemptAtGoalOnTarget": 2,
      "AttemptAtGoalOffTarget": 2,
      "AttemptAtGoalBlocked": 1,
      "AttemptAtGoalInsideThePenaltyArea": 3,
      "AttemptAtGoalOutsideThePenaltyArea": 2,
      "AttemptAtGoalFromPenalty": 0,
      "AttemptAtGoalFromFreeKicks": 1,
      "AttemptAtGoalFromCorner": 0,
      "HeadedAttemptAtGoal": 1,
      "Goals": 1,
      "Assists": 0,
      "XG": 0.45
    },
    "discipline": {
      "FoulsAgainst": 4,
      "FoulsFor": 3,
      "YellowCards": 1,
      "RedCards": 0,
      "DirectRedCards": 0,
      "IndirectRedCards": 0,
      "Offsides": 1
    }
  },
  "last_match_id": "<25 char fifa hash>",
  "last_updated": "2026-06-22T03:00:00+08:00"
}
```

**字段来源**（详见 §3.0 矩阵）：
- 主 cron（live/football）写入：id / name.eng / name_default / country_code / country_zh / team_id / position / shirt_number / last_match_id / matches_played / minutes_played
- tournament-wide cron（mangodev）写入：name.{12 国语言} / photo_url / tournament_stats.attacking / tournament_stats.discipline

**`name_default` fallback 链**（写入时计算）：
1. `name.eng`（mangodev story actor `name.eng` 或 live/football `PlayerName[].Description` Locale=en-GB）
2. live/football `PlayerName[0].Description`（任何语言）
3. `"Player {id}"`

**`tournament_stats.matches_played` / `minutes_played` 累加协议**：
- 主 cron 每轮 2min 拉 fdh-api 单场 stats 时，从该球员的 `MatchesPlayed` 字段（fdh-api 单场即整数 1 表示参加该场）读取
- **idempotency**：用 `players:{id}.last_match_id` 作 watermark
  - 若 `last_match_id == mapping.fifa_id_match` → 同一场重复抓，**不累加**，只覆盖更新 `last_match_*` 字段
  - 若 `last_match_id != mapping.fifa_id_match` → 新场次：先把上一场的 `minutes_played` 提交到累计（`matches_played += 1`），再更新 watermark
- 此协议保证 2min cron 在比赛进行中重复抓数十次，`matches_played` 只 +1

**Tournament_stats 并发写入安全**：
- mangodev 拉取按 (classification, stat, page) 三重循环。**实施约束**：先在内存中按 player_id 聚合**整轮**所有 stat 值，再每个 player 一次性 `KV.put` 覆盖整段 `tournament_stats.attacking` 和 `tournament_stats.discipline`。**禁止**每个 stat 单独读-改-写。
- partial-write 风险（拉到一半失败）：当整轮 mangodev 抓取 **全部 stat 成功**后才 commit；失败一半就废弃本轮聚合结果，保留旧 `tournament_stats`。
- 与主 cron 的并发：严格按 §3.0 矩阵字段分离写入，两个 cron 写不同字段子集，最坏 last-write-wins 也不会破坏一致性。

#### `players_by_country:{COUNTRY_CODE}`
```json
{
  "country_code": "ESP",
  "country_zh": "西班牙",
  "team_id": "43969",
  "updated_at": "2026-06-22T03:00:00+08:00",
  "roster": [
    {
      "player_id": "447853",
      "name": "David RAYA",
      "shirt_number": 1,
      "position": 0,
      "stats_summary": {
        "goals": 0,
        "assists": 0,
        "attempts_on_target": 2,
        "fouls_for": 3,
        "yellow_cards": 1
      }
    },
    ... 26 人左右
  ]
}
```

**新增**：`stats_summary` 是 attacking + discipline 中前端最常用的 5 字段冗余存储，避免前端列表渲染时 N+1 query（26 个 `/api/fifa/players/{id}`）。详细 stats 仍走 `players:{id}` 单查。

**roster 来源**（解决 mangodev stories 只露排行榜 top-N 的局限）：
- **主路径**：主 cron 每次抓 live/football 后，把该场 `HomeTeam.Players` / `AwayTeam.Players` 中的所有球员 id 并入对应 `players_by_country:{COUNTRY_CODE}.roster`（**union upsert**，按 player_id 去重；新球员追加，已存在的球员更新 shirt_number / position 等基础字段）
- **兜底**：tournament-wide cron 调 mangodev `teams?query=_externalCompetitionId==\`{seasonId}\`` 获取 48 国 team_id；如果某国 roster 还是空（赛季开始前/还未抓到 live/football），就只用此兜底建立 country 框架（无球员列表，前端展示"等待开赛"）
- **stats_summary 填充**：tournament-wide cron 整轮聚合完成后，遍历每个国家的 roster，从内存的 `playerStatsAccumulator[player_id]` 中提取 5 个常用 stat 写入 `roster[].stats_summary`。未在排行榜出现的球员 `stats_summary` 字段全为 0（语义：本届暂无该 stat 累计或排名靠后）

#### `match_lineups:{500_id}`
```json
{
  "fifa_id_match": "<25 char hash>",
  "fetched_at": "2026-06-22T15:30:00+08:00",
  "lineup_available": true,
  "fixture_locked": true,
  "match_status": 0,
  "match_status_label": "scheduled",
  "period": null,
  "match_time": null,
  "home": {
    "country_code": "ESP",
    "team_id": "43969",
    "team_name_en": "Spain",
    "team_name_zh": "西班牙",
    "tactics": "4-3-3",
    "starting": [
      {
        "player_id": "447853",
        "name": "David RAYA",
        "shirt_number": 1,
        "position": 0,
        "position_label": "Goalkeeper",
        "captain": false,
        "lineup_x": null,
        "lineup_y": null
      }, ... 11 人
    ],
    "substitutes": [ ... 15 人左右 ]
  },
  "away": { /* 同 home */ },
  "events": {
    "goals": [
      {"side": "home", "player_id": "447853", "minute": 23, "type": "regular"}
    ],
    "bookings": [
      {"side": "away", "player_id": "474973", "minute": 41, "card": "yellow", "reason": null}
    ],
    "substitutions": [
      {"side": "home", "off_player_id": "447853", "on_player_id": "447854", "minute": 65}
    ]
  }
}
```

**字段来源**：直接来自 live/football endpoint：
- `home.starting` / `home.substitutes`：按 `FieldStatus` 拆分（**待验证**：实测假设 `FieldStatus=1` 为首发，`0` 为替补，其他为未上场；首次抓到数据时 scraper 应写一次 debug log 验证）
- `events.goals/bookings/substitutions`：分别来自 `HomeTeam.Goals` / `Bookings` / `Substitutions` 数组，每事件保留以下字段：
  - goals: `IdPlayer` → `player_id`, `Minute` → `minute`, `Type` → `type`
  - bookings: `IdPlayer`, `Minute`, `Card` (1=yellow / 2=red 待验证) → `card`, `Reason` → `reason`
  - substitutions: `IdPlayerOff` / `IdPlayerOn` / `Minute`
- 详细 enum（FIFA 真实数据 dump 出来）首次实施时记 log 校验，发现枚举不符即更新本设计

#### `fifa_sla_logs:{YYYY-MM-DD}:{HH}`
按小时分片，避免单 key 无限增长。

```json
{
  "date": "2026-06-22",
  "hour": 15,
  "items": [
    {
      "ts": "2026-06-22T15:30:00+08:00",
      "level": "info",
      "fixture": "f1359210",
      "event": "lineup_fetched",
      "lineup_locked": true,
      "minutes_to_kickoff": 90
    },
    {
      "ts": "2026-06-22T15:58:00+08:00",
      "level": "warn",
      "fixture": "f1359210",
      "event": "lineup_not_yet_published",
      "minutes_to_kickoff": 60,
      "note": "SLA at risk"
    }
  ]
}
```

- 单 key 软上限 500 条目（超过开始覆盖最旧 info-level 条目，warn/error 永保留）
- TTL 7 天
- 写入时 read-modify-write，但因小时分片每 key 平均 < 100 条，KV value 控制在 50KB 以内

## 4. 抓取逻辑（fifa-scraper worker）

### 4.1 三个 cron

```toml
# workers/fifa-scraper/wrangler.toml
[triggers]
crons = [
  "*/2 * * * *",       # 每 2min: per-match window 抓取
  "0 */6 * * *",       # 每 6h:  刷 fifa_calendar + auto mapping
  "0 17,21,1,5 * * *"  # UTC 17/21/01/05 (北京 01/05/09/13): tournament-wide stats
]
```

tournament-wide 一日 4 次（间隔 4h），保证赛前 90min 触发时 `tournament_stats` 不会超过 4h 旧。这比每场单独刷一次的复杂度低，且 mangodev 拉一轮约 1-2 分钟，可以容忍。

### 4.2 主 cron：`*/2 * * * *`

```javascript
async function mainCron(env) {
  const NOW = Date.now()
  const inWindowRaw = await findFixturesInWindow(env, NOW)
  // 去重（防止同 fixture 在 today/yesterday/tomorrow 桶里都出现）
  const seen = new Set()
  const inWindow = inWindowRaw.filter(f => seen.has(f.id) ? false : (seen.add(f.id), true))

  for (const fixture of inWindow) {
    let mapping = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json')

    // 1. 处理 mapping
    if (!mapping || (mapping.match_confidence === 'unmatched' && Date.now() > Date.parse(mapping.unmatched_retry_after))) {
      mapping = await tryAutoMap(fixture, env)
      await env.MATCH_DATA.put(`fixture_mapping:${fixture.id}`, JSON.stringify(mapping))
    }
    if (!mapping || mapping.match_confidence !== 'exact') continue

    // 2. 拉 live/football → 更新 match_lineups
    const liveData = await fetchLiveFootball(mapping)
    if (!liveData) {
      await logSla(env, { fixture: fixture.id, event: 'live_fetch_failed', level: 'warn' })
      continue
    }
    await updateLineupKV(env, fixture, mapping, liveData)
    await logSlaForLineup(env, fixture, liveData)

    // 3. 把 lineup Players[] 并入 players:{id} 档案 + players_by_country roster
    await upsertPlayersFromLineup(env, mapping, liveData)

    // 4. 反查 fdh_match_id（v4 修订：不再从 liveData 提取，改从已建档球员的 fdh_match_ids 找）
    if (!mapping.fdh_match_id) {
      const fdhId = await reverseLookupFdhMatchId(env, liveData, fixture)
      if (fdhId) {
        mapping.fdh_match_id = fdhId
        await env.MATCH_DATA.put(`fixture_mapping:${fixture.id}`, JSON.stringify(mapping))
      }
    }

    // 5. 拉 fdh-api/players.json → 累加 matches_played/minutes_played
    if (mapping.fdh_match_id) {
      const fdhStats = await fetchFdhPlayers(mapping.fdh_match_id)
      if (fdhStats) await updateMatchPlayedCounters(env, mapping, fdhStats)
    }
  }
}

// 把 live/football 的 26+26 球员并入 players:{id} 档案
async function upsertPlayersFromLineup(env, mapping, liveData) {
  const sides = [
    { team: liveData.HomeTeam, country_code: mapping.home_code },
    { team: liveData.AwayTeam, country_code: mapping.away_code }
  ]
  const countryRosterPatch = {}  // { country_code: [{player_id, name, ...}] }

  for (const { team, country_code } of sides) {
    countryRosterPatch[country_code] = []
    for (const p of team.Players || []) {
      const pid = p.IdPlayer
      const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json') || {}
      // 严格按 §3.0 矩阵：主 cron 只写自己的列
      const updated = {
        ...existing,
        id: pid,
        country_code,
        country_zh: lookupCountryZh(env, country_code),
        team_id: team.IdTeam,
        position: p.Position,
        shirt_number: p.ShirtNumber,
        last_match_id: mapping.fifa_id_match,
        name: {
          ...(existing.name || {}),
          eng: (p.PlayerName?.find(n => n.Locale === 'en-GB') || p.PlayerName?.[0])?.Description
        },
        name_default: deriveNameDefault(existing, p),
        // 矩阵中主 cron 不写的字段保持 existing 原值
        last_updated: new Date().toISOString()
      }
      await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(updated))
      countryRosterPatch[country_code].push({
        player_id: pid,
        name: updated.name_default,
        shirt_number: p.ShirtNumber,
        position: p.Position
      })
    }
  }

  // union upsert 到 players_by_country
  for (const [code, newEntries] of Object.entries(countryRosterPatch)) {
    const existing = await env.MATCH_DATA.get(`players_by_country:${code}`, 'json') || {
      country_code: code, country_zh: lookupCountryZh(env, code), team_id: null, roster: []
    }
    const byId = new Map(existing.roster.map(r => [r.player_id, r]))
    for (const e of newEntries) {
      const cur = byId.get(e.player_id) || {}
      // 保留 tournament-wide cron 写入的 stats_summary 不动
      byId.set(e.player_id, { ...cur, ...e, stats_summary: cur.stats_summary })
    }
    existing.roster = Array.from(byId.values())
    existing.team_id = existing.team_id || (newEntries[0] ? (await env.MATCH_DATA.get(`players:${newEntries[0].player_id}`, 'json'))?.team_id : null)
    existing.updated_at = new Date().toISOString()
    await env.MATCH_DATA.put(`players_by_country:${code}`, JSON.stringify(existing))
  }
}

// 按场次累加 matches_played / minutes_played，用 last_match_id 作 watermark
async function updateMatchPlayedCounters(env, mapping, fdhStats) {
  for (const [pid, statList] of Object.entries(fdhStats)) {
    const matchesPlayedRaw = statList.find(s => s[0] === 'MatchesPlayed')?.[1] || 0
    const timePlayedRaw = statList.find(s => s[0] === 'TimePlayed')?.[1] || 0
    if (matchesPlayedRaw === 0) continue   // 该球员没上场，不动

    const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json')
    if (!existing) continue   // 应当先被 upsertPlayersFromLineup 创建

    const isNewMatch = existing.last_match_id !== mapping.fifa_id_match
    const ts = existing.tournament_stats || { matches_played: 0, minutes_played: 0, attacking: {}, discipline: {} }

    if (isNewMatch) {
      // 新场次：累加并更新 watermark
      ts.matches_played = (ts.matches_played || 0) + matchesPlayedRaw
      ts.minutes_played = (ts.minutes_played || 0) + timePlayedRaw
      existing.last_match_id = mapping.fifa_id_match
    } else {
      // 同场次重复抓：minutes_played 用 watermark 之前值 + 本场最新值
      // 简化实现：本轮抓到的 timePlayedRaw 就是本场截至此刻总时间，需要替换而不是累加
      // 所以我们记一个 _current_match_minutes 临时字段
      const prevCurrent = ts._current_match_minutes || 0
      ts.minutes_played = (ts.minutes_played || 0) - prevCurrent + timePlayedRaw
      ts._current_match_minutes = timePlayedRaw
    }
    // 跨新场次时重置 _current_match_minutes
    if (isNewMatch) ts._current_match_minutes = timePlayedRaw

    existing.tournament_stats = ts
    existing.last_updated = new Date().toISOString()
    await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(existing))
  }
}

async function findFixturesInWindow(env, now) {
  const today = beijingDateStr(now)
  const yesterday = beijingDateStr(now - 86400_000)
  const tomorrow = beijingDateStr(now + 86400_000)
  const buckets = await Promise.all([
    env.MATCH_DATA.get(`matches:${today}`, 'json'),
    env.MATCH_DATA.get(`matches:${yesterday}`, 'json'),
    env.MATCH_DATA.get(`matches:${tomorrow}`, 'json')
  ])
  const all = buckets.flatMap(b => (b?.matches || []))

  return all.filter(m => {
    const ko = parseKickoffBeijing(m).getTime()
    const koEnd = ko + matchDurationMs(env, m)
    return now >= ko - 90 * 60_000 && now <= koEnd + 15 * 60_000
  })
}

// 通过 mapping 反查 stage 信息
async function matchDurationMs(env, fixture) {
  const mapping = await env.MATCH_DATA.get(`fixture_mapping:${fixture.id}`, 'json')
  if (!mapping || !mapping.fifa_id_stage) return 105 * 60_000   // 默认小组赛
  const cal = await env.MATCH_DATA.get('fifa_calendar', 'json')
  const fm = cal?.matches.find(x => x.id_match === mapping.fifa_id_match)
  const stageName = fm?.stage_name || ''
  // 淘汰赛可能加时：165min（90 + 30 + 15 + 缓冲）
  return /knockout|round of|quarter|semi|final/i.test(stageName)
    ? 165 * 60_000
    : 105 * 60_000
}
```

// 反查 fdh_match_id：基于已建档球员的 fdh_match_ids 列表交集 + 时间窗启发式
async function reverseLookupFdhMatchId(env, liveData, fixture) {
  const ko = parseKickoffBeijing(fixture).getTime()
  // 收集本场 lineup 所有球员 id
  const pids = [
    ...(liveData.HomeTeam?.Players || []),
    ...(liveData.AwayTeam?.Players || [])
  ].map(p => p.IdPlayer).filter(Boolean)

  // 找出已建档球员的 fdh_match_ids 并取交集（同一场 fdh_match_id 应在两队球员的列表中重合）
  const idSets = []
  for (const pid of pids) {
    const player = await env.MATCH_DATA.get(`players:${pid}`, 'json')
    if (player?.fdh_match_ids?.length) idSets.push(new Set(player.fdh_match_ids))
  }
  if (idSets.length === 0) return null

  // 交集：同时出现在多个球员列表中的 fdh_match_id
  const intersection = idSets.reduce((acc, s) => new Set([...acc].filter(x => s.has(x))))
  // 若交集为空，退化到"最常见"
  if (intersection.size === 0) {
    const counter = new Map()
    for (const s of idSets) for (const x of s) counter.set(x, (counter.get(x) || 0) + 1)
    const sorted = [...counter.entries()].sort((a,b) => b[1] - a[1])
    return sorted[0]?.[0] || null
  }
  // 多个候选时，无法精确选择哪个是本场；
  // 简化策略：取 fdh_match_id 数值最大者（FIFA 内部 id 单调递增，最大 = 最新场）
  const ids = [...intersection].map(Number).filter(n => !isNaN(n)).sort((a,b) => b - a)
  return ids[0] ? String(ids[0]) : null
}
```

### 4.3 calendar cron：`0 */6 * * *`

```javascript
async function calendarCron(env) {
  // 拉一个月窗口
  const from = new Date().toISOString()
  const to = new Date(Date.now() + 30 * 86400_000).toISOString()
  const fifaCal = await fetchFifaCalendar(17, from, to)
  await env.MATCH_DATA.put('fifa_calendar', JSON.stringify(fifaCal))

  // 对每场 500.com fixture 尝试 mapping（增量：只处理 unmapped / unmatched）
  const all500 = await load500FixturesAcrossDates(env)
  for (const m of all500) {
    const existing = await env.MATCH_DATA.get(`fixture_mapping:${m.id}`, 'json')
    if (existing && existing.match_confidence === 'exact') continue
    if (existing && existing.match_confidence === 'unmatched' &&
        Date.now() < Date.parse(existing.unmatched_retry_after)) continue
    const mapped = await tryAutoMap(m, env, fifaCal)
    await env.MATCH_DATA.put(`fixture_mapping:${m.id}`, JSON.stringify(mapped))
  }
}
```

### 4.4 tournament-wide cron：UTC 17/21/01/05 时

**v4 关键修订**：mangodev API 强制 gameDay token；URL 用 `limit=1`；解析 actor.tags。

```javascript
// gameDay token 缓存（KV key: 'gameday_token'，存 token + expiresAt）
async function ensureGamedayToken(env) {
  const cached = await env.MATCH_DATA.get('gameday_token', 'json')
  if (cached && Date.parse(cached.expiresAt) - Date.now() > 600_000 /* 10min 余量 */) {
    return cached.token
  }
  const r = await fetch('https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.fifa.com', 'Referer': 'https://www.fifa.com/' }
  })
  if (!r.ok) throw new Error(`token fetch failed: HTTP ${r.status}`)
  const j = await r.json()
  await env.MATCH_DATA.put('gameday_token', JSON.stringify(j), { expirationTtl: 86400 })
  return j.token
}
async function tournamentWideCron(env) {
  const seasonId = "285023"  // FWC 2026; FIFA mangodev API URL 参数叫 "competitionId" 但实际是 seasonId
                              // 这是 FIFA 自身命名错位，不要"修正"

  // 4.4.1 先拉 teams 列表，建立 country → team_id 映射 + roster 兜底
  const teams = await fetchMangoTeams(seasonId)
  const countryFrame = {}   // 用于兜底（无 lineup 数据时建立空 country 框架）
  for (const team of teams.items) {
    const code = team._externalNationId.toUpperCase()
    countryFrame[code] = {
      country_code: code,
      country_zh: lookupCountryZh(env, code),
      team_id: team._externalId.split('_')[1]
    }
  }

  // 4.4.2 遍历所有 classification + stat 拉 stories
  // STAT_KEY_MAP 把 "canonical key" → "mangodev tag full id"
  // 真实 tag id 格式：urn:gd:tag:football:stats:{snake_case_stat}
  // 首轮跑后用 dump 工具扫某个 actor.tags 收集完整 list 后填齐这个表
  const STAT_KEY_MAP = {
    'gcp_top_scorer': {
      'goals':              'urn:gd:tag:football:stats:goals',
      'assists':            'urn:gd:tag:football:stats:assists',
      'minutes_played':     'urn:gd:tag:football:stats:total_competition_minutes_played'
    },
    'gcp_attack': {
      // 真实键名待首轮跑后填：dump actor.tags 后取所有 urn:gd:tag:football:stats:* 即可
      // 候选：attempts_on_target / attempts_at_goal / heading_attempts_at_goal / xg
    },
    'gcp_discipline': {
      // 候选：fouls_for / fouls_against / yellow_cards / red_cards / offsides
    }
  }
  // 注意：classification 名也是 v4 校正项：'gcp_top_scorer' 是真实，'gcp_attack'/'gcp_discipline'
  // 首轮拉一次 sections/topPerformerGroup 验证真实 classification ID

  const token = await ensureGamedayToken(env)
  const playerAccumulator = {}   // pid → {profile, attacking, discipline, top_scorer}
  let allStatsOk = true

  for (const [classification, statMap] of Object.entries(STAT_KEY_MAP)) {
    for (const [canonicalKey, mangoTagId] of Object.entries(statMap)) {
      // 取 stat 名（tag id 最后一段）作为 URL 中的 {stat}
      const mangoStat = mangoTagId.split(':').pop()
      const ok = await fetchAllPages(token, seasonId, classification, mangoStat, (actor, rank) => {
        const pid = actor.key._externalSportsPersonId
        if (!playerAccumulator[pid]) {
          playerAccumulator[pid] = {
            profile: extractProfileFromActor(actor),
            attacking: {}, discipline: {}, top_scorer: {}
          }
        }
        const bucket = classification === 'gcp_top_scorer' ? 'top_scorer'
                     : classification === 'gcp_attack' ? 'attacking'
                     : 'discipline'
        playerAccumulator[pid][bucket][canonicalKey] = parseStatValue(actor, mangoTagId)
      })
      if (!ok) { allStatsOk = false; break }
    }
    if (!allStatsOk) break
  }

  if (!allStatsOk) {
    await logSla(env, { level: 'warn', event: 'tournament_wide_partial', note: 'aborting commit, keeping previous stats' })
    return   // 保留旧 tournament_stats 不动
  }

  // 4.4.3 commit 每个 player 的 tournament_stats（严格按 §3.0 矩阵：mangodev cron 只写矩阵中归属它的字段）
  for (const [pid, agg] of Object.entries(playerAccumulator)) {
    const existing = await env.MATCH_DATA.get(`players:${pid}`, 'json') || { id: pid }
    const updated = {
      ...existing,
      // 矩阵中 mangodev 列：photo_url + name.{多语言} + tournament_stats
      photo_url: agg.profile.photo_url || existing.photo_url,
      name: {
        ...(existing.name || {}),
        ...agg.profile.name_multilang
      },
      name_default: existing.name_default || agg.profile.name_eng || `Player ${pid}`,
      // 主 cron 字段保持不动（country_code / position / shirt_number 等）
      // 若主 cron 还没创建过这条 player，country_code 从 actor team_id 反查
      country_code: existing.country_code || agg.profile.country_code,
      country_zh: existing.country_zh || lookupCountryZh(env, agg.profile.country_code),
      team_id: existing.team_id || agg.profile.team_id,
      tournament_stats: {
        version: 1,
        fetched_at: new Date().toISOString(),
        source: 'mangodev',
        // matches_played / minutes_played 由主 cron 维护，这里保留
        matches_played: existing?.tournament_stats?.matches_played ?? null,
        minutes_played: existing?.tournament_stats?.minutes_played ?? null,
        attacking: agg.attacking,
        discipline: agg.discipline
      },
      last_updated: new Date().toISOString()
    }
    await env.MATCH_DATA.put(`players:${pid}`, JSON.stringify(updated))
  }

  // 4.4.4 用本轮 stats 同步刷新 players_by_country[].roster[].stats_summary
  // 注意：roster 的成员主源是主 cron 累积的 live/football lineup；此 cron 只更新 stats_summary 字段
  for (const code of Object.keys(countryFrame)) {
    const existing = await env.MATCH_DATA.get(`players_by_country:${code}`, 'json')
    if (!existing) {
      // 首次：用 countryFrame 建立空 roster 框架
      await env.MATCH_DATA.put(`players_by_country:${code}`, JSON.stringify({
        ...countryFrame[code],
        roster: [],
        updated_at: new Date().toISOString()
      }))
      continue
    }
    // 增量更新现有 roster 的 stats_summary 字段
    for (const entry of existing.roster) {
      const agg = playerAccumulator[entry.player_id]
      if (!agg) continue   // 该球员未在任何排行榜出现，stats 全 0，保留 stats_summary 不动或重置 0
      entry.stats_summary = {
        goals: agg.attacking.goals || 0,
        assists: agg.attacking.assists || 0,
        attempts_on_target: agg.attacking.attempts_on_target || 0,
        fouls_for: agg.discipline.fouls_for || 0,
        yellow_cards: agg.discipline.yellow_cards || 0
      }
    }
    existing.updated_at = new Date().toISOString()
    await env.MATCH_DATA.put(`players_by_country:${code}`, JSON.stringify(existing))
  }
}

// 抓 mangodev story 的所有页（v4 真实实现：带 token + limit=1）
// 每 story 自带 50 actor，pagination 用 page 参数（25 页/stat）
async function fetchAllPages(token, seasonId, classification, mangoStat, onActor) {
  const HARD_LIMIT = 30   // 防御：mangodev 自称 25 页
  for (let page = 1; page <= HARD_LIMIT; page++) {
    const url = `https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query=`
              + encodeURIComponent(`(and resourceStatus==\`urn:gd:resourceStatus:active\` `
              + `_externalId~\`urn:gd:story:classification:${classification}:competitionId:${seasonId}:${mangoStat}:rank_asc:page:${page}$\`)`)
              + `&skip=0&limit=1&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc`
    let json
    try {
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Origin': 'https://www.fifa.com',
          'Referer': 'https://www.fifa.com/',
          'Accept': 'application/json'
        }
      })
      if (r.status === 429) {
        // rate limit / pagination limit；等 2 秒重试一次
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      if (!r.ok) return false
      json = await r.json()
    } catch (e) { return false }

    if (!json.items || json.items.length === 0) return true   // 已是最后一页
    for (const story of json.items) {
      for (const actor of story.actors || []) {
        onActor(actor, actor.tags?.find(t => t.name === 'urn:gd:tag:story:staff:rank')?.value)
      }
    }
    if (json.anotherPage !== true) return true
    // mangodev: limit=1 时返回 1 story（含 50 actor），翻页 page+=1
  }
  return true
}

// 从 actor 提取球员档案字段（v4 真实实现：mangodev actor.tags 自带丰富 metadata）
function extractProfileFromActor(actor) {
  const tagMap = Object.fromEntries((actor.tags || []).map(t => [t.name, t.value]))
  const teamId = (actor.key._externalTeamId || '').split('_')[1] || null
  return {
    name_eng: actor.name?.eng,
    name_multilang: actor.name || {},
    photo_url: tagMap['urn:gd:tag:story:staff:image'],
    team_id: teamId,
    country_code: tagMap['urn:gd:tag:story:team:abbreviation'],   // 3 字母大写
    country_zh: tagMap['urn:gd:tag:story:team:name:zho'],
    position_label: tagMap['urn:gd:tag:story:staff:position'],   // "GK"/"DF"/"MF"/"FW"
    fdh_match_ids: tagMap['urn:gd:tag:story:staff:match_squad:match_id'] || []   // ["151631", "151634"]
  }
}

// 从 actor 提取该 stat 的数值（v4 真实实现）
// stat_id 形如 "urn:gd:tag:football:stats:goals"
function parseStatValue(actor, statId) {
  const tag = actor.tags?.find(t => t.name === statId)
  if (!tag) return null
  return Number(tag.value) || 0
}
```

**§4.4 实施时的 dump 验证清单**（首次跑务必做）：
1. dump 一个 actor 完整结构，找出 stat value 的真实位置（更新 `parseStatValue`）
2. dump 一个 stories 响应顶层，确认 pagination 字段（`anotherPage` vs `matchCount` 真实语义）
3. dump 所有 classification 下真实存在的 stat 列表（更新 `STAT_KEY_MAP`）

### 4.5 fixture 自动 mapping 算法

```javascript
async function tryAutoMap(fixture500, env, fifaCal /* optional */) {
  const countries = await env.MATCH_DATA.get('countries', 'json')
  const zhToCode = Object.fromEntries(countries.items.map(c => [c.zh, c.code]))

  const homeCode = zhToCode[fixture500.home]
  const awayCode = zhToCode[fixture500.away]
  const retryAfter = new Date(Date.now() + 3600_000).toISOString()  // 1h 后重试

  if (!homeCode || !awayCode) {
    await logSla(env, {
      level: 'warn', fixture: fixture500.id, event: 'country_mapping_missing',
      home: fixture500.home, away: fixture500.away
    })
    return { match_confidence: 'unmatched', matched_at: new Date().toISOString(), unmatched_retry_after: retryAfter, match_note: 'country code lookup failed' }
  }

  const kickoffUtc = parseKickoffUtc(fixture500)
  const cal = fifaCal || await env.MATCH_DATA.get('fifa_calendar', 'json')
  if (!cal) {
    await logSla(env, { level: 'warn', event: 'fifa_calendar_missing' })
    return { match_confidence: 'unmatched', matched_at: new Date().toISOString(), unmatched_retry_after: retryAfter, match_note: 'fifa_calendar missing' }
  }

  const candidates = cal.matches.filter(fm =>
    fm.home_code === homeCode &&
    fm.away_code === awayCode &&
    Math.abs(new Date(fm.date_utc).getTime() - kickoffUtc.getTime()) < 30 * 60_000
  )

  if (candidates.length === 0) {
    await logSla(env, {
      level: 'warn', fixture: fixture500.id, event: 'no_fifa_match',
      home: homeCode, away: awayCode, kickoff: kickoffUtc.toISOString()
    })
    return { match_confidence: 'unmatched', matched_at: new Date().toISOString(), unmatched_retry_after: retryAfter, match_note: 'no fifa candidate' }
  }
  if (candidates.length > 1) {
    await logSla(env, {
      level: 'error', fixture: fixture500.id, event: 'multi_candidates',
      count: candidates.length, candidates: candidates.map(c => c.id_match)
    })
    return { match_confidence: 'unmatched', matched_at: new Date().toISOString(), unmatched_retry_after: retryAfter, match_note: 'multi candidates' }
  }

  const fm = candidates[0]
  const skewMs = Math.abs(new Date(fm.date_utc).getTime() - kickoffUtc.getTime())
  return {
    fifa_id_match: fm.id_match,
    fifa_id_season: fm.id_season,
    fifa_id_stage: fm.id_stage,
    fifa_id_competition: fm.id_competition,
    fdh_match_id: null,
    home_code: homeCode,
    away_code: awayCode,
    kickoff_utc: kickoffUtc.toISOString(),
    kickoff_local_beijing: `${fixture500.date} ${fixture500.kickoff}`,
    matched_at: new Date().toISOString(),
    match_confidence: skewMs < 60_000 ? 'exact' : 'time_skew_5min',
    match_note: skewMs >= 60_000 ? `time skew ${Math.round(skewMs/1000)}s` : null,
    unmatched_retry_after: null
  }
}
```

### 4.6 SLA 监控

```javascript
async function logSlaForLineup(env, fixture, liveData) {
  const koMs = parseKickoffBeijing(fixture).getTime()
  const koMin = Math.round((koMs - Date.now()) / 60_000)
  const hasStarting = liveData.HomeTeam?.Players?.some(p => p.FieldStatus === 1) &&
                      liveData.AwayTeam?.Players?.some(p => p.FieldStatus === 1)

  // 关键阈值：KO−60min 之前必须 hasStarting=true
  const level = hasStarting
    ? 'info'
    : (koMin <= 60 ? 'warn' : 'info')

  await logSla(env, {
    level,
    fixture: fixture.id,
    event: hasStarting ? 'lineup_fetched' : 'lineup_not_yet_published',
    lineup_locked: hasStarting,
    minutes_to_kickoff: koMin
  })
}

async function logSla(env, entry) {
  const now = new Date()
  const dateStr = beijingDateStr(now.getTime())
  const hour = String(beijingHour(now.getTime())).padStart(2, '0')
  const key = `fifa_sla_logs:${dateStr}:${hour}`
  const existing = await env.MATCH_DATA.get(key, 'json') || { date: dateStr, hour: parseInt(hour), items: [] }
  existing.items.push({ ts: now.toISOString(), ...entry })

  // 软上限：保留所有 warn/error + 最近 N 条 info
  const errs = existing.items.filter(i => i.level !== 'info')
  const infos = existing.items.filter(i => i.level === 'info').slice(-300)
  existing.items = [...errs, ...infos].sort((a,b) => a.ts.localeCompare(b.ts))

  await env.MATCH_DATA.put(key, JSON.stringify(existing), { expirationTtl: 86400 * 7 })
}
```

## 5. API 端点

新增 Cloudflare Pages Functions（`functions/api/fifa/`）：

| Method | Path | 行为 |
|---|---|---|
| GET | `/api/fifa/players/:player_id` | 读 `players:{player_id}` |
| GET | `/api/fifa/players?ids=a,b,c` | 批量读，最多 30 个 id |
| GET | `/api/fifa/players-by-country/:code` | 读 `players_by_country:{COUNTRY_CODE}` |
| GET | `/api/fifa/countries` | 读 `countries` |
| PUT | `/api/fifa/countries` | admin auth，写 `countries` |
| GET | `/api/fifa/calendar` | 读 `fifa_calendar` |
| GET | `/api/fifa/mappings` | 列出所有 `fixture_mapping:*`（含 lineup_available 摘要） |
| GET | `/api/fifa/mapping/:500_fixture_id` | 读单条 `fixture_mapping:{id}` |
| GET | `/api/fifa/lineup/:500_fixture_id` | 读 `match_lineups:{id}`；无则返回 `{lineup_available:false, reason}` |
| POST | `/api/fifa/refresh/:500_fixture_id` | **需登录用户**：强制触发该 fixture 抓取。返回新结果。 |
| GET | `/api/fifa/sla-logs?date=YYYY-MM-DD` | admin auth，读全天 SLA 日志（按小时合并） |
| POST | `/api/fifa/bet-plan` | 占位 `501 Not Implemented` |

**Auth 约定**：
- 所有 GET 公开（除 `/sla-logs`）
- PUT `/countries` 需 admin role
- POST `/refresh/...` 需登录用户（任意 user），防匿名滥用触发外部 API

### 5.1 `/api/fifa/lineup/:500_id` 行为细节

```javascript
async function onRequestGet({ params, env }) {
  const lineup = await env.MATCH_DATA.get(`match_lineups:${params.id}`, 'json')
  if (lineup && lineup.lineup_available) {
    return Response.json(lineup)
  }
  // 推断下次抓取时间
  const mapping = await env.MATCH_DATA.get(`fixture_mapping:${params.id}`, 'json')
  const nextCronMs = (2 - (Date.now() / 60_000 % 2)) * 60_000   // 下个 */2 整分
  return Response.json({
    lineup_available: false,
    reason: !mapping ? 'fixture_not_mapped'
          : mapping.match_confidence === 'unmatched' ? 'fixture_unmatched'
          : 'not_yet_published_by_fifa',
    next_attempt_in_seconds: Math.round(nextCronMs / 1000)
  }, { status: 200 })
}
```

## 6. 错误降级与边界

| 场景 | 行为 |
|---|---|
| `countries` 国家名 mapping 缺失 | `tryAutoMap` 写 `unmatched`，记 warn log。`unmatched_retry_after=now+1h` |
| FIFA calendar endpoint 失败 | 旧 `fifa_calendar` 继续生效；6h cron 重试 |
| live/football 失败 | 不更新 `match_lineups:{id}`，下个 2min cron 重试 |
| fdh-api 失败 | 不累加 stats，下个 2min cron 重试 |
| mangodev 失败 | 整轮废弃，旧 `tournament_stats` 保留；下次 cron 重试 |
| FIFA `MatchStatus` 已 finished | scraper 继续抓直到 +15min 窗口结束；之后停止。**finished 值待 probe**（首场实际数据观察） |
| 同对阵候选 > 1 | 不写 mapping，error log，留 admin 介入 |
| `fdh_match_id` 未知 | 见 §3.2 mapping schema：留 null，每 2min 重试从 live/football 提取 |
| extra-time 加时赛 | `matchDurationMs` 自动按 stage_name 判断为 165min |
| live/football `FieldStatus` 异常（首发 < 11 或 > 11） | scraper 写 `match_lineups:{id}` 但 `fixture_locked=false`，记 warn log |
| `name.eng` 缺失 | 用 live/football PlayerName fallback，再失败用 `"Player {id}"` |
| 网络从 CF Worker 出走被 FIFA 限流 / 拒绝 | 5xx / 429 错误 → 当次 skip + log；下个 cron 重试 |

## 7. 实施分阶段

### 阶段 1（本期 scope）
- 1.1 KV `countries` seed
- 1.2 fifa-scraper worker 完整实现三个 cron
- 1.3 fixture mapping 算法
- 1.4 API endpoints（含 lineup 不在时的 `{lineup_available:false}` 返回）
- 1.5 SLA logs 写入（小时分片）
- 1.6 单元/集成测试：mapping 算法、KV write semantics、tournament_stats 聚合 idempotency

### 阶段 2（不在本设计范围）
- 前端 UI（待用户提供截图）
- admin 页 countries 维护界面

### 阶段 3（未来扩展）
- 投注算法接入 FIFA 数据
- 实时事件流（WebSocket / `gameDay/token` 路径）

## 8. 待验证项（实施时第一时间 dump 真实数据校正）

| 项 | 验证方式 |
|---|---|
| `Position` 枚举 | ✅ 已 probe：0=GK / 1=DF / 2=MF / 3=FW / 6=其他（待实际遇到时确认 6 的语义） |
| `FieldStatus` 枚举 | ✅ 已 probe：1=首发 / 2=替补（无 0） |
| `MatchStatus` 各阶段值（scheduled/live/halftime/finished） | 0=scheduled 已验证；比赛进行中观察其他值 |
| `Card` 枚举（黄/红/二黄） | 比赛中实际牌出现时观察 |
| mangodev stat 名称完整 enum | ✅ 部分 probe：`goals` / `assists` / `total_competition_minutes_played` / `fdcp_top_scorer_rank` 等已确认；其他 stat 首轮跑后 dump |
| mangodev pagination | ✅ 已 probe：`anotherPage`、`page_count`（25 页）、单 story 含 50 actor；URL `limit=1` |
| **mangodev API 鉴权** | ✅ 已 probe：**强制 gameDay token**（裸调 403）|
| **fdh_match_id 来源** | ✅ 已 probe：mangodev actor.tags `urn:gd:tag:story:staff:match_squad:match_id` 直接给数组；live/football `Properties.IdStatsPerform` 不是它 |
| Cloudflare Worker IP 是否被 FIFA 限流 | 上线第一周观察 SLA logs |

## 9. 附录

### 9.1 `countries` 初始 seed（48 国）

待补全 — 实施时按以下来源生成：
1. 从 `fifa_calendar` 第一次抓取后提取 unique `home_code`/`away_code`（48 个 FIFA 大写码）
2. 从 500.com `matches:*` 中提取 unique home/away 中文名
3. 人工对照表填 zh ↔ code 映射
4. 写入 `countries` KV

每个 zh 名称必须与 500.com 的实际抓取一致（含全角括号等）。建议实施时先 dry-run 一次：
- 把 500 的 zh 名和 FIFA 的 code 双向 print，让 admin 手动审一遍后再写入

### 9.2 cron 时区说明

CF Worker cron 表达式按 UTC 执行：
- `*/2 * * * *` UTC = `*/2 * * * *` Beijing（频率相同）
- `0 */6 * * *` UTC → Beijing 08:00 / 14:00 / 20:00 / 02:00
- `0 17,21,1,5 * * *` UTC → Beijing 01:00 / 05:00 / 09:00 / 13:00

### 9.3 时间戳处理约定

- KV 中所有时间戳用 ISO 8601 + offset，遵循 [[feedback_timestamp_format]] 规则（禁止 `.Z` 后缀）
- 500 fixture 的 `kickoff` 是北京时间（`YYYY-MM-DD HH:MM`，无 timezone 标记），代码内统一按 `+08:00` 解析
- FIFA endpoint 返回 UTC（`Z` 后缀），代码内统一转为带 +00:00 offset 的标准格式后再存
- 比对/匹配统一用 UTC 毫秒时间戳
