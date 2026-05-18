# Infrastructure & Deployment Guide

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Cloudflare Pages: worldmoney                    │
│  URL: https://worldmoney.pages.dev               │
│                                                  │
│  Static: *.html, auth.js, pull-refresh.js,       │
│          assets/explosion.json                   │
│                                                  │
│  Functions (functions/api/):                     │
│    /api/matches         - GET 比赛数据（公开）   │
│    /api/picks           - GET 推荐/方案（需登录）│
│    /api/plans           - GET 已评估方案（需登录）│
│    /api/submit          - POST 新推荐/方案       │
│    /api/login           - POST 登录              │
│    /api/logs            - GET 系统日志（admin）  │
│    /api/cr              - GET/POST 升级请求      │
│    /api/period-version  - GET 比赛数据版本号     │
│    /api/admin/fix-score - POST 比分修正(admin)   │
│    /api/admin/release   - POST 发版(admin)       │
│    /api/admin/settle    - POST 触发结算(admin/scraper)│
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Cloudflare KV: MATCH_DATA                       │
│  Namespace ID: 278f1209ffd84662bd51921370a2fbe9  │
│  (shared between Pages and Worker)               │
└──────────────────────┬──────────────────────────┘
                       │
                       ▲
┌──────────────────────┴──────────────────────────┐
│  Cloudflare Worker: worldcup-scraper             │
│  URL: https://worldcup-scraper.yujuntao1981.     │
│       workers.dev                                │
│                                                  │
│  Crons:                                         │
│    1 3 * * *    → snapshotMatches (daily 11:01北京)│
│    */30 * * * * → updateScores (every 30min)     │
└─────────────────────────────────────────────────┘
```

## KV Data Model

All data persists indefinitely (no TTL) unless noted.

### Match Data (written by scraper)
| Key | Value | Description |
|-----|-------|-------------|
| `matches:{YYYY-MM-DD}` | `{ date, source, fetched_at, match_count, matches[] }` | Daily match pool with odds, handicap, scores |

### Recommendations & Plans (written by submit API)
| Key | Value | Description |
|-----|-------|-------------|
| `recommendations:{YYYY-MM-DD}` | `{ items[] }` | User-submitted AI recommendations for a date |
| `pending_plans:{YYYY-MM-DD}` | `{ items[] }` | User-selected picks awaiting AI confirmation |
| `plans:{YYYY-MM-DD}` | `{ items[] }` | AI-confirmed formal plans (source of truth) |

### Plan Evaluation (written by /api/admin/settle, triggered by scraper cron)
| Key | Value | Description |
|-----|-------|-------------|
| `plans:pending` | `{ plans[] }` | Aggregated plans awaiting match results |
| `plans:settled` | `{ plans[] }` | Plans with final won/lost status |

### System
| Key | Value | TTL | Description |
|-----|-------|-----|-------------|
| `system:logs` | `{ logs[] }` | none | Last 500 log entries (hot cache) |
| `system:logs:{YYYY-MM}` | `{ logs[] }` | 180 days | Monthly log archive |

## Data Lifecycle

```
recommendation (user submits AI output)
    → pending_plan (user selects picks + passphrase)
        → plan (AI confirms with combinations/odds)
            → plans:pending (aggregated for evaluation)
                → plans:settled (won/lost after match results)
```

## Environment Variables (Pages)

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | HMAC signing key for JWT tokens (required) |
| `SCRAPER_SECRET` | Shared secret for scraper worker → /api/admin/settle |
| `GITHUB_TOKEN` | GitHub API token (only for design comments) |
| `GITHUB_REPO` | GitHub repo name (default: JackYu1981/worldcup) |
| `USERS` | JSON string of allowed users |

## Environment Variables (Worker)

| Variable | Purpose |
|----------|---------|
| `SCRAPER_SECRET` | Same value as Pages env; sent as `X-Scraper-Secret` header to /api/admin/settle |

## Deployment Commands

```bash
# Deploy Pages (static + functions)
npx wrangler pages deploy . --project-name worldmoney

# Deploy Worker (scraper)
cd workers/scraper && npx wrangler deploy

# KV operations
npx wrangler kv key list --namespace-id 278f1209ffd84662bd51921370a2fbe9
npx wrangler kv key get --namespace-id 278f1209ffd84662bd51921370a2fbe9 "KEY_NAME"
npx wrangler kv key put --namespace-id 278f1209ffd84662bd51921370a2fbe9 "KEY_NAME" 'VALUE'
```

## Match Data Schema (per match object)

```json
{
  "id": "f1366432",
  "code": "周六001",
  "league": "日乙",
  "home": "水户蜀葵",
  "away": "东京绿茵",
  "date": "2026-05-16",
  "kickoff": "13:00",
  "status": "finished",
  "score": "2-1",
  "odds": { "home_win": 2.15, "draw": 3.20, "away_win": 3.05 },
  "handicap": { "line": -0.5, "home_win": 1.85, "draw": 3.60, "away_win": 3.45 }
}
```

## Plan/Recommendation Schema (per item)

```json
{
  "date": "2026-05-17",
  "source": "plan",
  "passphrase": "发财测试1",
  "submitted_by": "jack",
  "submitted_at": "2026-05-17T04:07:22.125Z",
  "stake": 100,
  "selected_tier": "progressive",
  "legs": [
    {
      "match_id": "f1373152",
      "match_desc": "全北现代vs金泉尚武",
      "code": "周日002",
      "market": "1x2",
      "pick": "home_win",
      "pick_desc": "全北现代胜",
      "odds": 1.78
    }
  ],
  "combinations": [
    {
      "legs": [...],
      "combined_odds": 5.23,
      "stake": 2,
      "potential_return": 10,
      "hit": null
    }
  ]
}
```
