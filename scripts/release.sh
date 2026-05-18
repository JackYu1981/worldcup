#!/usr/bin/env bash
# 发版：把 data/versions.json 最后一条同步到 KV cr:current_version
# Usage: scripts/release.sh
# 前置：先在 data/versions.json 末尾追加新版本条目
set -e

KV_NS="278f1209ffd84662bd51921370a2fbe9"
VERSIONS_FILE="$(dirname "$0")/../data/versions.json"

if [ ! -f "$VERSIONS_FILE" ]; then
  echo "❌ 找不到 $VERSIONS_FILE"
  exit 1
fi

PAYLOAD=$(python3 -c "
import json, sys
with open('$VERSIONS_FILE') as f:
    d = json.load(f)
if not d.get('versions'):
    sys.exit('versions 为空')
latest = d['versions'][-1]
out = {'version': latest['version'], 'date': latest['date'], 'summary': latest['summary']}
print(json.dumps(out, ensure_ascii=False))
")

VERSION=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")

TMP=$(mktemp)
echo "$PAYLOAD" > "$TMP"

echo "→ 同步 versions.json 最新条目到 KV cr:current_version"
echo "  版本：$VERSION"
npx wrangler kv key put --namespace-id=$KV_NS "cr:current_version" --path="$TMP" --remote
rm "$TMP"

echo ""
echo "✅ 当前版本已更新为 $VERSION"
echo "提示：别忘了 git commit && git push 归档 versions.json"
