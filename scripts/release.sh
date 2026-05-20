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
# 显式传 ASCII commit message：wrangler 自动从 git 取的字段经 Cloudflare API
# 校验时偶发触发 "Invalid commit message UTF-8" (code 8000111)，强制 ASCII 绕过
npx wrangler pages deploy . --project-name=worldmoney --branch=main --commit-dirty=true --commit-message="$VERSION release" 2>&1 | tail -3

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
# 只 stage 项目代码相关路径，避免把截图/临时文件也带上。
# 用 ls 过滤存在的路径，避免 git add 因不存在的路径而报错跳过其他文件。
PATHS=()
for p in data/versions.json docs functions lib workers scripts \
         index.html admin.html recommend.html result.html dashboard.html login.html \
         auth.js pull-refresh.js wrangler.toml package.json README.md; do
  [ -e "$p" ] && PATHS+=("$p")
done
git add "${PATHS[@]}"

COMMIT_MSG="$VERSION: $SUMMARY"
SHORT_MSG=$(echo "$COMMIT_MSG" | head -c 100)
if git diff --cached --quiet; then
  echo "（无暂存变更，跳过 commit）"
else
  git commit -m "$SHORT_MSG" 2>&1 | tail -3
  git push 2>&1 | tail -3
fi

# === 7. 校验 GitHub 已收到新版本（非阻断） ===
step "7/7 校验 GitHub 同步（非阻断）"
sleep 3
set +e  # 临时关闭 errexit / nounset，校验失败不算发版失败
set +u
REMOTE_LATEST=$(curl -fsSL --max-time 10 "$GITHUB_RAW" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d['versions'][-1]['version'])
except Exception:
    pass
" 2>/dev/null)
set -eu

if [ "${REMOTE_LATEST:-}" = "$VERSION" ]; then
  echo "✓ GitHub raw 已同步到 $VERSION"
else
  echo "⚠️  GitHub raw 暂未同步（可能网络超时或 CDN 延迟），git push 已成功，稍后 GitHub 会同步。"
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
