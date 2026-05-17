# World Cup 2026 投注助手

基于概率的竞彩复式投注策略系统。多数据源赔率分析 + AI方案优化，目标：100元本金获取最优风险收益比。

## 架构

```
┌─────────────────────────────────────────────────┐
│  Frontend (Cloudflare Pages)                    │
│  index.html  recommend.html  result.html        │
│  dashboard.html  design.html                    │
├─────────────────────────────────────────────────┤
│  API Layer (Pages Functions)                    │
│  /api/matches  /api/picks  /api/plans           │
│  /api/submit   /api/logs   /api/login           │
├─────────────────────────────────────────────────┤
│  Shared Lib                                     │
│  lib/response.js  lib/auth.js  lib/logger.js    │
├─────────────────────────────────────────────────┤
│  Storage: Cloudflare KV (MATCH_DATA)            │
│  matches:{date}  picks:{date}  plans:pending    │
│  plans:settled   system:logs   system:logs:{月}  │
├─────────────────────────────────────────────────┤
│  Worker (worldcup-scraper)                      │
│  Cron: 03:01 UTC 赛程快照 / */30min 比分更新    │
│  数据源: 500.com + live.500.com                 │
└─────────────────────────────────────────────────┘
```

## 页面说明

| 页面 | 路径 | 功能 |
|------|------|------|
| 赛程 | `/index` | 按期查看比赛赔率，勾选生成投注推荐 |
| 推荐 | `/recommend` | 查看/提交预备方案，AI确认后转正式方案 |
| 方案 | `/result` | 查看所有正式方案及开奖结果（增量加载） |
| 看板 | `/dashboard` | 累计收益曲线、命中率、盈亏日历 |
| 管理 | `/design` | 系统日志、版本摘要、变更请求、版本历史 |

## 方案生命周期

```
用户选赔率 → 推荐(recommendation) → 预备方案(pending_plan)
    → AI优化(口令确认) → 正式方案(plan) → 开奖(won/lost)
```

## API

| 端点 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/api/matches` | GET | `date` | 获取指定日期比赛数据 |
| `/api/picks` | GET | `date` / `from,to` | 获取投注picks（日期范围） |
| `/api/plans` | GET | `status`, `from`, `to` | 获取方案（支持过滤） |
| `/api/submit` | POST | body | 提交推荐/预备方案 |
| `/api/logs` | GET | `month` | 获取系统日志（支持月度查询） |
| `/api/login` | POST | username, password | 用户登录 |

## 本地开发

```bash
# 启动Pages本地开发
npx wrangler pages dev . --kv=MATCH_DATA

# 部署到Cloudflare Pages
npx wrangler pages deploy . --project-name worldmoney --commit-dirty=true

# 部署Scraper Worker
cd workers/scraper && npx wrangler deploy

# 写入系统日志
node scripts/log.js "方案" "描述信息"
```

## 数据源

| 来源 | 用途 |
|------|------|
| 500.com | 竞彩赛程、胜平负/让球赔率 |
| live.500.com | 实时比分更新 |

## 技术栈

- **前端**: 原生HTML/JS，Chart.js（看板图表）
- **后端**: Cloudflare Pages Functions (ES Module)
- **存储**: Cloudflare KV（无数据库，全KV分片）
- **定时任务**: Cloudflare Workers Cron Triggers
- **部署**: Cloudflare Pages + Workers

## 版本

当前版本: **v4.0** (2026-05-17)

详见管理页面 `/design` 的版本历史。

## License

Private — for personal use only.
