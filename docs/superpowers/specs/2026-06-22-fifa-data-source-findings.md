# FIFA 数据源调研发现（2026-06-22，已完整）

这份文档是 brainstorming 阶段的事实记录，不是设计文档。

## 三大数据源概览

| 数据源 | 用途 | 鉴权 |
|---|---|---|
| `gameday-prod.fifa.mangodev.co.uk/1-0/...` | tournament-wide aggregated player/team stats（"stories" + "teams"）| 暂未发现需要 token（可裸调） |
| `fdh-api.fifa.com/v1/stats/match/{id}/...` | 单场 player/team stats（112 项） | 暂未发现需要 token |
| `api.fifa.com/api/v3/live/football/.../...` | 单场元数据 + lineup + 进球/换人/黄红牌事件 | 暂未发现需要 token |

注：`cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token` 颁发 JWT，含 `urn:gameday:ws` 和 `cross_collection_aggregation` claim。
当前裸调 mangodev API 也能拿到数据，**但生产环境可能需要 token**，scraper 实现时**先做带 token 兜底**。

## tournament-wide：mangodev API（关键发现！）

### Team 列表
```
GET https://gameday-prod.fifa.mangodev.co.uk/1-0/teams?query=_externalCompetitionId==`285023`
```
返回 48 个 World Cup 2026 球队：
```json
{
  "items": [{
    "_externalId": "285023_43843",         // competition_id_team_id
    "_externalNationId": "alg",            // 3 字母小写国家码
    "name": {"eng":"Algeria","zho":"阿尔及利亚",...},
    "images": [
      {"url":"https://api.fifa.com/api/v3/picture/flags-sq-3/ALG", ...}
    ]
  }, ...]
}
```

### Player stats stories（排行榜形式）
```
GET https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query=(and resourceStatus==`urn:gd:resourceStatus:active` _externalId~`urn:gd:story:classification:{classification}:competitionId:{seasonId}:{stat}:rank_asc:page:{N}$`)&skip=0&limit={N}&sort=...
```

- `{classification}`：`gcp_top_scorer` / `gcp_attack` / `gcp_discipline` 等（与 sections/topPerformerGroup 中的 categories 对应）
- `{seasonId}`：`285023`（FWC 2026）
- `{stat}`：`goals` / `assists` / `attempts_on_target` / `fouls` / `yellow_cards` 等具体 stat
- `{N}`：分页（page=1 是榜首 N 名）

每个 story = 一个排行榜，actor = 排名球员，含：
- `_externalSportsPersonId`（FIFA player id，6 位数字）
- `_externalTeamId`（competition_id_team_id 组合）
- `name`（多语言，12 种语言）
- `tags`（image URL、background_colour、staff:gender 等）
- `number`（排名）

**注意**：一个排行榜 1 个 actor，要拿前 N 名得遍历 page=1, page=2, ... matchCount 字段告诉你总共多少页。

## 单场比赛：3 个 endpoint

### 比赛元数据 + lineup + 事件
```
GET https://api.fifa.com/api/v3/live/football/{idCompetition}/{idSeason}/{idStage}/{idMatch}?language=en
```
4 段哈希 ID，~25KB。返回：
```json
{
  "IdMatch": "52cm9g2ph41wy7jcvhjsbkc9g",
  "Date": "...", "Stadium": {...}, "MatchStatus": ..., "Period": ...,
  "HomeTeam": {
    "IdTeam": "43969",             // 5 位数字 team id（同 mangodev 末段）
    "IdCountry": "ENG",            // 3 字母大写国家码
    "TeamName": [{"Locale":"en-GB","Description":"England"}],
    "Players": [    // 26 人，首发 + 替补
      {
        "IdPlayer": "447853",
        "ShirtNumber": 1,
        "PlayerName": [{"Description":"David RAYA"}],
        "Position": 0,               // 0=GK/1=DF/2=MF/3=FW（待实测）
        "Captain": false,
        "FieldStatus": 2,            // 1=首发/0=替补 待实测
        "LineupX": null, "LineupY": null
      }, ...
    ],
    "Substitutions": [...], "Bookings": [...], "Goals": [...]
  },
  "AwayTeam": { /* 同上 */ },
  "BallPossession": ..., "MatchTime": ..., "Officials": ...
}
```

### 球员级 stats（单场）
```
GET https://fdh-api.fifa.com/v1/stats/match/{fdh_match_id}/players.json
```
fdh_match_id 是 6 位数字（如 151651），与 4 段哈希 id 互不相同。~210KB。

```json
{
  "447853": [          // FIFA player id
    ["Assists", 0, true],
    ["AttemptAtGoal", 0, true],
    ["AttemptAtGoalOnTarget", 0, true],
    ...112 项
    ["FoulsAgainst", 0, true],
    ["FoulsFor", 0, true],
    ["YellowCards", 0, true],
    ["RedCards", 0, true]
  ],
  ...52 个球员（双方各 26）
}
```

### 球队级 stats（单场）
```
GET https://fdh-api.fifa.com/v1/stats/match/{fdh_match_id}/teams.json
```

## 关键 ID 系统映射

| 系统 | 形态 | 示例 |
|---|---|---|
| Competition（公共） | 6 位数字 | 17（=World Cup） |
| Season（公共） | 6 位数字 | 285023（=FWC 2026） |
| Stage（公共） | 6 位数字 | 289273（=Group Stage） |
| Match URL ID（公共） | 9 位数字 | 400021483 |
| Match Internal ID（哈希） | 25 字符 | 52cm9g2ph41wy7jcvhjsbkc9g |
| **FDH-API Match ID** | 6 位数字 | 151651 |
| Mangodev Team _externalId | seasonId_teamId | 285023_43948 |
| Player ID | 6 位数字 | 447853 |
| Team ID | 5 位数字 | 43969 |
| Nation ID（mangodev） | 3 字母小写 | alg / eng / esp |
| Country ID（live API） | 3 字母大写 | ALG / ENG / ESP |

### ID 映射策略（关键）
- **500.com fixture_id → FIFA match_id**：无直接映射，需用 `(home_country, away_country, kickoff_datetime)` 三元组匹配 FIFA `calendar/17/285023/289273` 中的某一场（calendar endpoint 待 probe，但已知存在 `api.fifa.com/api/v3/calendar/17/285023/{stage}/standing`）
- **FIFA 公共 match_id → fdh_match_id**：需要单独 endpoint 映射（待 probe）

## 我们关心的 stats 子集（直接来自 fdh-api 的 112 项）

**Attacking**（射门相关）
- AttemptAtGoal — 总射门
- AttemptAtGoalOnTarget — 射正 ⭐
- AttemptAtGoalOffTarget / Blocked
- AttemptAtGoalInsideThePenaltyArea / OutsideThePenaltyArea
- AttemptAtGoalFromPenalty / FromFreeKicks / FromCorner / FromCross
- HeadedAttemptAtGoal
- Goals / XG / Assists

**Discipline**（犯规相关）
- FoulsAgainst — 球员被犯规
- FoulsFor — 球员犯规对方 ⭐
- YellowCards / RedCards
- DirectRedCards / IndirectRedCards
- Offsides

**辅助（球员档案需要）**
- MatchesPlayed / TimePlayed
- SubstitutionsIn / SubstitutionsOut

## 已知不确定项（实施时需要再验证）

1. `Position` 字段（0/1/2/3）的具体含义
2. `FieldStatus` 字段（0/1/2）的具体含义（首发 vs 替补 vs 未上场）
3. mangodev API 的 stat 完整 enum（如 `attempts_on_target` 是否真实存在，要扫一遍所有 classification 的所有 stat）
4. fdh-api 是否需要 `gameDay/token` 鉴权（当前裸调成功，但生产可能限流）
5. 比赛进行中（live）时 fdh-api 数据是 real-time 推送还是几分钟延迟
6. FIFA 公共 match_id（9位数字）↔ fdh_match_id（6位数字）的映射 endpoint

## 决策：scraper 数据获取路径

**主路径**：
1. 每场比赛 kickoff−90min ~ kickoff+15min 窗口内：
   - 拉一次 `live/football/...` 拿 lineup（写 KV match_lineups:*）
   - 每 5 min 拉一次 `fdh-api/stats/match/{fdh_id}/players.json`（更新 KV players:*）
2. 兜底：tournament-wide 累计 stats 直接从 mangodev API 拿（**赛前 90min 触发一次**，作为基线）

**降级路径**（如果 mangodev 限流或封禁）：
- 自己用 `fdh-api/.../players.json` 单场数据聚合成 tournament-wide

## 比赛日程列表 endpoint（fixture mapping 关键）

```
GET https://api.fifa.com/api/v3/calendar/matches?idCompetition=17&from={ISO}&to={ISO}&language=en&count=500
```

- `idCompetition=17` 过滤 World Cup（接受公共数字 ID）
- `from` / `to` 是 UTC ISO 时间
- 返回 67 场 World Cup 2026 比赛（含 48 球队，3 场/队，96 小组 + 淘汰赛）

每条 `Results[i]`：
```json
{
  "IdCompetition": "<25 char hash>",
  "IdSeason": "<25 char hash>",
  "IdStage": "<25 char hash>",
  "IdMatch": "<25 char hash>",      // 这就是 live/football endpoint 的 idMatch
  "Date": "2026-06-15T02:00:00Z",   // UTC
  "LocalDate": "...",                // 本地
  "Home": {
    "IdCountry": "SWE",              // 3 字母大写
    "TeamName": [{"Locale":"en-gb","Description":"Sweden"}],
    "IdTeam": "<25 char hash>"
  },
  "Away": { /* 同 */ },
  "MatchStatus": 0,                  // 0=scheduled, 待实测其他状态
  "Stadium": {...},
  ...
}
```

## fixture mapping 自动化策略

输入：500.com 的 fixture（500_id, home_zh, away_zh, kickoff_beijing）

匹配流程：
1. 维护一份 `countries` 表：`{"西班牙": "ESP", "沙特阿拉伯": "KSA", ...}`，初始 seed = 48 World Cup 参赛国
2. 拉 FIFA calendar/matches 缓存到 `fifa_calendar` KV key（按 from/to 一周窗口刷新）
3. 对每个 500 fixture，计算 `(home_code = countries[home_zh], away_code = countries[away_zh], kickoff_utc)`
4. 在 FIFA Results 列表里找 match 满足：
   - `Home.IdCountry == home_code AND Away.IdCountry == away_code`
   - `abs(Date - kickoff_utc) < 30min`（容忍 FIFA 与 500 时间略偏差）
5. 命中即把 mapping 写入 KV：`fixture_mapping:{500_id} = {IdMatch, IdCompetition, IdSeason, IdStage, fdh_match_id_unknown, home_code, away_code}`
6. **fdh_match_id 需要另一步**：从 `live/football/{C}/{S}/{Stg}/{M}` 响应中找 `Properties.IdStatsPerform` 或类似字段。fdh-api 的 match_id 来源待 probe。

### 错误降级
- 国家码 mapping 不全 → 跳过本场，写 `logs:` 警告
- FIFA calendar 无命中 → 跳过本场，写 `logs:` 警告
- 多于 1 个命中（理论上不会）→ 写 `logs:` 警告，跳过等人工

