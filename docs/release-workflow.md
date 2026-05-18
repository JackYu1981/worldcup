# 发版流程

## TL;DR — 一条命令搞定

```bash
scripts/release.sh "v4.61" "修复 X 问题，优化 Y 性能"
```

脚本自动完成 7 步、失败即停、成功后校验 GitHub 同步。**不要手工跑任何子步骤**。

---

## 版本号规则

- **里程碑**（v3.0 / v4.0 / v5.0...）：仅在重大架构升级时使用，**由用户明确指定**
- **小版本递增**：里程碑之后按 0.01 递增（v4.6 → v4.61 → v4.62 ...）
- **不可跳号**：`v4.6 → v5.0` 必须用户授权

## 数据源（v4.6 起）

| 数据 | 存储 | 写入 | 读取 |
|---|---|---|---|
| 代码 / spec / `versions.json` | GitHub | `git push` | Pages 打包 / API 读 GitHub Contents |
| CR 列表 | KV `cr:requests` | `/api/cr` POST | `/api/design-data` GET |
| 当前版本 | KV `cr:current_version` | `scripts/release.sh` | `/api/design-data` GET |

---

## 发版前 Checklist

发版命令会自动跑这些动作。**前置条件**由你确认：

- [ ] 代码改动已完成、本地自测通过
- [ ] 如果是新功能/重大改动，已写 spec 到 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- [ ] 决定好版本号（小版本 +0.01；里程碑由用户指定）
- [ ] 决定好 summary（一句话，用中文逗号/分号分隔要点，前端会拆 bullet 列表）

## 发版命令

```bash
scripts/release.sh "<version>" "<summary>" [doc_url]
```

参数：
- `version` — 例 `v4.61`、`v5.0`
- `summary` — 一句话要点。**禁止在 summary 中写带 `Z` 的时间戳**
- `doc_url`（可选）— spec 链接，缺省指向本文档

示例：
```bash
scripts/release.sh "v4.61" "修复管理页时间戳显示错误，对齐 git commit 真实时间"

scripts/release.sh "v5.0" "里程碑：积分赛架构升级" \
  "https://github.com/JackYu1981/worldcup/blob/main/docs/superpowers/specs/2026-XX-XX-points-design.md"
```

## 脚本执行的 7 步

```
1/7 前置校验           # 版本号未占用、summary 无 Z 后缀
2/7 取系统时间         # date "+%Y-%m-%dT%H:%M:%S+08:00"
3/7 追加 versions.json # JSON 末尾插入新条目
4/7 部署 Pages         # wrangler pages deploy
5/7 更新 KV            # cr:current_version = versions.json 末尾条目
6/7 git commit + push  # 自动暂存所有改动、用 "<version>: <summary>" 提交
7/7 校验 GitHub 同步   # curl raw.githubusercontent.com 确认新版本到位
```

任何一步失败立即终止，不会留半成品。

---

## 不要做的事

- ❌ 不要手工编辑 `data/versions.json`，让脚本写
- ❌ 不要手工跑 `wrangler pages deploy` + `wrangler kv put`（会忘 git push）
- ❌ 不要在 summary 里写 `Z` 后缀时间
- ❌ 不要凭印象编时间，所有时间由脚本取系统真实时间
- ❌ 不要手工写 `data/change-requests.json`（已删除，CR 走 KV）
- ❌ 不要在没有用户指令的情况下跳大版本号

## 版本历史清理

`versions.json` 默认保留：
- 所有里程碑（v2.0、v3.0、v4.0...）
- 当前里程碑下的所有小版本

下个里程碑发布后，**用户授权**才能清理上一个里程碑的中间小版本，只保留起点和末版。
