# 发版流程

## 版本号规则

- **里程碑版本**（v2.0 / v3.0 / v4.0 / v5.0...）：仅在重大架构升级时使用，**由用户明确指定**
- **小版本递增**：里程碑之后，按 0.01 递增（v4.6 → v4.61 → v4.62 ...），每次发版对应一组完整改动
- **单一版本来源**：`data/versions.json` 是唯一的版本历史归档

## 数据源划分（v4.6 起）

| 数据 | 存储 | 写入路径 | 读取路径 |
|---|---|---|---|
| 代码 / spec / `versions.json` | **GitHub** | 本地 commit + push | Pages 构建时打包 / API 读 GitHub Contents |
| CR 列表 | **KV** `cr:requests` | 用户网页提交 → `/api/cr` POST | `/api/design-data` GET |
| 当前版本（顶部 badge + 版本摘要） | **KV** `cr:current_version` | `scripts/release.sh` 或 `/api/admin/release` POST | `/api/design-data` GET |

**核心原则**：代码与历史归档单向 `local → GitHub`；运营数据（CR + 当前版本指针）双向 `KV ↔ 网页`，不进 git。

## 发版步骤

### 1. 完成代码改动

正常开发，本地改 `index.html` / `functions/` / `docs/specs/` 等。

### 2. 写 spec（可选）

如果是新功能或重大改动，在 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` 写设计文档。bug fix 或小调整可省略。

### 3. 追加 versions.json

打开 `data/versions.json`，在数组**末尾**追加一条：

```json
{
  "version": "v4.61",
  "date": "<取真实当前时间>",
  "summary": "<本次改动要点，用中文逗号/分号分隔，前端会拆成 bullet 列表>",
  "doc_url": "https://github.com/JackYu1981/worldcup/blob/main/docs/superpowers/specs/<spec-file>.md"
}
```

**取时间的方法**（强制）：
- 运行 `date "+%Y-%m-%dT%H:%M:%S+08:00"` 获取系统当前北京时间
- **禁止凭印象编时间**，禁止用 `Z` 后缀
- 历史版本的 date 应取对应 git commit 的 `%ai` 字段

### 4. 部署代码

```bash
npx wrangler pages deploy . --project-name=worldmoney --branch=main --commit-dirty=true
```

### 5. 更新 KV 当前版本

```bash
scripts/release.sh
```

脚本会读取 `data/versions.json` 末尾条目同步到 KV `cr:current_version`，**保证两处 summary 完全一致**。无需手工传参，避免文字版不同步。

### 6. Git commit + push

```bash
git add -A
git commit -m "v4.61: <一行要点>"
git push
```

## 不要做的事

- ❌ 不要手动写 `data/change-requests.json`（文件已删除，CR 走 KV）
- ❌ 不要在 `versions.json` 用 `Z` 后缀时间（前端按本地时区显示会错）
- ❌ 不要凭印象编未来时间（必须取 `date` 命令真实时间）
- ❌ 不要忘记更新 `current_version` KV（否则顶部 badge 和版本摘要不会变）
- ❌ 不要在没有用户指令的情况下跳大版本号（v4.6 → v5.0 必须用户授权）

## 版本历史保留策略

`versions.json` 保留：
- 所有里程碑（v2.0、v3.0、v4.0...）
- 当前里程碑下的所有小版本（如 v4.0、v4.1、v4.2、... v4.6、v4.61 ...）
- 一旦下个里程碑（如 v5.0）发布，**v4.x 中间小版本可清理**，只保留 v4.0（起点）和 v4.x 末版

清理由用户决定时机，不要主动删除历史。
