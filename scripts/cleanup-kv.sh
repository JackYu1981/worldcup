#!/usr/bin/env bash
# 清零 KV 数据 —— 保留赛程(matches)和结果(results)，删除指定日期(含)之前的所有业务数据
# 用法:
#   scripts/cleanup-kv.sh <cutoff-date> [--apply]
#   不带 --apply 仅列出待删除 key 清单（dry-run），加上 --apply 才真正执行删除
# 例:
#   scripts/cleanup-kv.sh 2026-05-17                 # 列清单：删除 2026-05-17 及之前的业务数据
#   scripts/cleanup-kv.sh 2026-05-17 --apply         # 实际执行
#
# 删除范围（按 key 前缀）:
#   - recommendations:{date}    where date <= cutoff
#   - pending_plans:{date}      where date <= cutoff
#   - plans:{date}              where date <= cutoff
#   - picks:{date}              where date <= cutoff（legacy）
# 同时清理:
#   - aggregate:unsettled_plans 中 period <= cutoff 的 plans
# 保留:
#   - matches:* / results:* / users / cr:* / versions / logs:*

set -euo pipefail

CUTOFF="${1:-}"
APPLY="${2:-}"

if [ -z "$CUTOFF" ]; then
  echo "Usage: $0 <cutoff-date> [--apply]"
  echo "Example: $0 2026-05-17           (dry-run)"
  echo "         $0 2026-05-17 --apply   (真删)"
  exit 1
fi

if ! [[ "$CUTOFF" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "❌ cutoff-date 必须是 YYYY-MM-DD 格式"
  exit 1
fi

KV_NS="278f1209ffd84662bd51921370a2fbe9"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "━━━ 列出待删除 key（cutoff = ${CUTOFF}）━━━"

ALL_KEYS=$(npx wrangler kv key list --namespace-id="$KV_NS" --remote 2>/dev/null \
  | python3 -c "import json,sys; [print(k['name']) for k in json.load(sys.stdin)]")

# 选出三类业务 key 中 date <= cutoff 的
TO_DELETE=$(echo "$ALL_KEYS" | python3 -c "
import sys
cutoff = '$CUTOFF'
prefixes = ('recommendations:', 'pending_plans:', 'plans:', 'picks:')
for line in sys.stdin:
    k = line.strip()
    for p in prefixes:
        if k.startswith(p):
            date = k[len(p):]
            if len(date) >= 10 and date[:10] <= cutoff:
                print(k)
            break
")

if [ -z "$TO_DELETE" ]; then
  echo "(无匹配的 key)"
else
  echo "$TO_DELETE"
  COUNT=$(echo "$TO_DELETE" | wc -l | tr -d ' ')
  echo "━━━ 共 ${COUNT} 个 key ━━━"
fi

# aggregate:unsettled_plans 内部裁剪
echo ""
echo "━━━ 检查 aggregate:unsettled_plans ━━━"
UNSETTLED=$(npx wrangler kv key get "aggregate:unsettled_plans" --namespace-id="$KV_NS" --remote 2>/dev/null || echo "")
if [ -n "$UNSETTLED" ]; then
  TRIM_INFO=$(echo "$UNSETTLED" | python3 -c "
import json,sys
cutoff = '$CUTOFF'
try:
    d = json.load(sys.stdin)
    plans = d.get('plans', [])
    keep = [p for p in plans if (p.get('period') or p.get('date') or '9999') > cutoff]
    drop = [p for p in plans if (p.get('period') or p.get('date') or '9999') <= cutoff]
    print(f'保留 {len(keep)} 条 / 移除 {len(drop)} 条')
    for p in drop:
        print(f'  - {p.get(\"period\")} {p.get(\"passphrase\")}')
except Exception as e:
    print(f'解析失败: {e}')
")
  echo "$TRIM_INFO"
fi

# aggregate:settled_plans 内部裁剪（已开奖归档：所有 period <= cutoff 的都移除）
echo ""
echo "━━━ 检查 aggregate:settled_plans ━━━"
SETTLED=$(npx wrangler kv key get "aggregate:settled_plans" --namespace-id="$KV_NS" --remote 2>/dev/null || echo "")
if [ -n "$SETTLED" ]; then
  STRIM_INFO=$(echo "$SETTLED" | python3 -c "
import json,sys
cutoff = '$CUTOFF'
try:
    d = json.load(sys.stdin)
    plans = d.get('plans', [])
    keep = [p for p in plans if (p.get('period') or p.get('date') or '9999') > cutoff]
    drop = [p for p in plans if (p.get('period') or p.get('date') or '9999') <= cutoff]
    print(f'保留 {len(keep)} 条 / 移除 {len(drop)} 条')
    for p in drop:
        print(f'  - {p.get(\"period\")} {p.get(\"passphrase\")} status={p.get(\"status\")}')
except Exception as e:
    print(f'解析失败: {e}')
")
  echo "$STRIM_INFO"
fi

if [ "$APPLY" != "--apply" ]; then
  echo ""
  echo "▶ Dry-run 完成。如确认无误，重新运行加 --apply 真删。"
  exit 0
fi

# === 真删除 ===
echo ""
echo "━━━ 开始执行删除 ━━━"
if [ -n "$TO_DELETE" ]; then
  echo "$TO_DELETE" | while read -r KEY; do
    [ -z "$KEY" ] && continue
    echo "DELETE $KEY"
    npx wrangler kv key delete "$KEY" --namespace-id="$KV_NS" --remote 2>&1 | tail -1
  done
fi

# 裁剪 aggregate:unsettled_plans
if [ -n "$UNSETTLED" ]; then
  TRIMMED=$(echo "$UNSETTLED" | python3 -c "
import json,sys
cutoff = '$CUTOFF'
d = json.load(sys.stdin)
keep = [p for p in d.get('plans', []) if (p.get('period') or p.get('date') or '9999') > cutoff]
print(json.dumps({'plans': keep}, ensure_ascii=False))
")
  TMP=$(mktemp)
  echo "$TRIMMED" > "$TMP"
  echo "UPDATE aggregate:unsettled_plans (裁剪后)"
  npx wrangler kv key put "aggregate:unsettled_plans" --path="$TMP" --namespace-id="$KV_NS" --remote 2>&1 | tail -1
  rm "$TMP"
fi

# 裁剪 aggregate:settled_plans
if [ -n "$SETTLED" ]; then
  STRIMMED=$(echo "$SETTLED" | python3 -c "
import json,sys
cutoff = '$CUTOFF'
d = json.load(sys.stdin)
keep = [p for p in d.get('plans', []) if (p.get('period') or p.get('date') or '9999') > cutoff]
print(json.dumps({'plans': keep}, ensure_ascii=False))
")
  TMP=$(mktemp)
  echo "$STRIMMED" > "$TMP"
  echo "UPDATE aggregate:settled_plans (裁剪后)"
  npx wrangler kv key put "aggregate:settled_plans" --path="$TMP" --namespace-id="$KV_NS" --remote 2>&1 | tail -1
  rm "$TMP"
fi

echo ""
echo "✅ 清零完成"
