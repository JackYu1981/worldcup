#!/usr/bin/env bash
# 一站式发版脚本 — 失败即停，完成校验
# Usage:
#   scripts/release.sh "<version>" "<summary>" [doc_url]
# Example:
#   scripts/release.sh "v4.61" "修复 X bug，优化 Y 性能"
#   scripts/release.sh "v5.0" "里程碑：Z 架构升级" "https://github.com/JackYu1981/worldcup/blob/main/docs/superpowers/specs/2026-XX-XX-z-design.md"
set -euo pipefail

VERSION="${1:-}"
SUMMARY="${2:-}"
DOC_URL="${3:-https://github.com/JackYu1981/worldcup/blob/main/docs/release-workflow.md}"

if [ -z "$VERSION" ] || [ -z "$SUMMARY" ]; then
  echo "Usage: $0 <version> <summary> [doc_url]"
  echo "Example: $0 v4.61 \"修复 X，优化 Y\""
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSIONS_FILE="$ROOT/data/versions.json"
KV_NS="278f1209ffd84662bd51921370a2fbe9"
GITHUB_RAW="https://raw.githubusercontent.com/JackYu1981/worldcup/main/data/versions.json"

step() { echo ""; echo "━━━ $* ━━━"; }
fail() { echo "❌ $*" >&2; exit 1; }

# === 1. 前置校验 ===
step "1/7 前置校验"
cd "$ROOT"

# 检查 versions.json 中没有重复的版本号
if python3 -c "
import json,sys
with open('$VERSIONS_FILE') as f: d=json.load(f)
if any(v['version']=='$VERSION' for v in d['versions']):
    sys.exit(1)
"; then
  echo "✓ 版本号 $VERSION 未占用"
else
  fail "版本号 $VERSION 已存在于 versions.json"
fi

# 校验时间戳格式（不含 Z）
if [[ "$SUMMARY" == *"Z\""* ]]; then
  fail "summary 含可疑 Z 后缀，请用 +08:00"
fi

# === 2. 取系统真实时间 ===
step "2/7 取系统时间"
RELEASE_DATE=$(date "+%Y-%m-%dT%H:%M:%S+08:00")
echo "✓ 当前北京时间：$RELEASE_DATE"

# === 3. 追加 versions.json ===
step "3/7 追加 versions.json"
python3 - <<EOF
import json
with open('$VERSIONS_FILE') as f:
    d = json.load(f)
d['versions'].append({
    'version': '$VERSION',
    'date': '$RELEASE_DATE',
    'summary': '''$SUMMARY''',
    'doc_url': '$DOC_URL'
})
with open('$VERSIONS_FILE', 'w') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
print(f"✓ 已追加 {d['versions'][-1]['version']} 到 versions.json（共 {len(d['versions'])} 条）")
EOF

# === 4. 部署到 Cloudflare Pages ===
step "4/7 部署 Cloudflare Pages"
npx wrangler pages deploy . --project-name=worldmoney --branch=main --commit-dirty=true 2>&1 | tail -3

# === 5. 同步 KV cr:current_version ===
step "5/7 更新 KV cr:current_version"
TMP=$(mktemp)
python3 - <<EOF > "$TMP"
import json
with open('$VERSIONS_FILE') as f:
    d = json.load(f)
v = d['versions'][-1]
print(json.dumps({'version': v['version'], 'date': v['date'], 'summary': v['summary']}, ensure_ascii=False))
EOF
npx wrangler kv key put --namespace-id=$KV_NS "cr:current_version" --path="$TMP" --remote 2>&1 | tail -2
rm "$TMP"

# === 6. Git commit + push ===
step "6/7 Git commit + push"
git add -A
COMMIT_MSG="$VERSION: $SUMMARY"
# 限制首行长度，超出截断到 100 字符
SHORT_MSG=$(echo "$COMMIT_MSG" | head -c 100)
git commit -m "$SHORT_MSG" 2>&1 | tail -3
git push 2>&1 | tail -3

# === 7. 校验 GitHub 已收到新版本 ===
step "7/7 校验 GitHub 同步"
sleep 3
REMOTE_LATEST=$(curl -fsSL "$GITHUB_RAW" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['versions'][-1]['version'])
" 2>/dev/null || echo "")

if [ "$REMOTE_LATEST" = "$VERSION" ]; then
  echo "✓ GitHub raw 已同步到 $VERSION"
else
  echo "⚠️  GitHub raw 当前是 $REMOTE_LATEST（CDN 可能延迟最多 5 分钟同步），请稍后刷新管理页确认"
fi

# === 完成 ===
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 发版完成：$VERSION"
echo "  - data/versions.json 已追加"
echo "  - Cloudflare Pages 已部署"
echo "  - KV cr:current_version 已更新"
echo "  - Git 已 push"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
