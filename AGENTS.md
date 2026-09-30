# AGENTS.md — dsh-commands

DeepSeek Harness 的文件系统 slash 命令发现。把 `<dshHome>/commands/` 下的 Markdown 命令文件自动注册为 slash 命令，并随文件增删改热更新注册表。

## 项目状态

- ✅ 已实现：目录发现、frontmatter 解析、注册、执行语义（显式提交模型）、watcher 热更新、冲突策略；30 个测试全绿（含真实 Loader 组合测试）
- ✅ 可安装：声明 `dsh.bundle.patch`（`cordis.patch.yml`），`dsh plugin add @etby-studio/dsh-commands` 即可装入 profile 并自动插入插件行；面向 dsh `0.2.0-rc.2`
- ⚠️ 覆盖率：`pnpm run test:coverage` 未配置阈值，`src/index.ts` 实测约 97.6%（未覆盖行为 v8 ignore 标注的竞态/IO 故障分支）

## 目录结构

```
src/index.ts       全部实现：CommandsFilesystemProvider + CommandWatchManager + 解析辅助
src/invariant.ts   invariants 伴生（空 installer，注册生命周期由 dsh-commands 的 invariant 约束）
cordis.patch.yml   组合包 patch 层：`dsh.bundle.patch` 指向它，插入 dsh-commands 插件行
tests/             3 个 spec：发现/解析/冲突（fake chokidar）、watcher（fake watchFile）、Loader 组合
lib/               tsc 构建产物（提交前必须重新构建，勿手改）
```

## 常用命令

```sh
pnpm install            # 依赖；@deepseek-ai/* 为 peer，运行时从 dsh 安装解析
pnpm run build          # tsc → lib/
pnpm run typecheck
pnpm run test           # vitest，30 个测试
pnpm run test:coverage  # v8 覆盖率报告（未配置阈值；见“项目状态”）
```

## 关键设计决策（改动前必读）

1. **命令文件格式**：flat `*.md`，文件名 stem 即命令名（小写/数字/`_`/`-`，复用 `parseCommand()` 校验），frontmatter 必填 `description`。
2. **执行语义**：DSH 命令 handler 不会隐式提交模型。执行时**重新读取文件正文**，显式 `agent.steer()` 提交 user 消息；参数空行后追加，正文含 `$ARGUMENTS` 占位符时替换。
3. **冲突策略**：文件命令低优先级，注册式同名命令胜出（文件跳过 + warn，不补位）。
4. **watcher 模式**：与 `@deepseek-ai/dsh-skill-filesystem` 的 `SkillWatchManager` 对称（realpath 锚点 + `fs.watchFile` 祖先探测缺失根）；`src/index.ts` 中 `jscpd:ignore-start` 区域即该共享模式。
5. **包名与依赖**：npm 包名 `@etby-studio/dsh-commands`（插件名保持 `dsh-commands`，与上游 `@deepseek-ai/dsh-commands` 无冲突），`@deepseek-ai/*` 全部为 peerDependencies——宿主 dsh profile 的 `autoInstallPeers: false` + fallback node_modules 保证从 dsh 安装解析同一份 cordis 实例，不要改成 dependencies。peer 版本范围必须覆盖目标运行时：DSH 在加载组合包前逐个校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 与 `getDshRuntimeVersion()`，不匹配就拒绝该组合包（`dsh plugin allow-version` 只能按 `名称@版本` 逐版本豁免）。当前对齐 dsh `0.2.0-rc.2`。
6. **组合包装配**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh plugin add <name|path>` 会把它作为 profile 配置层应用并自动把包名写入 `dsh.profile.bundles`——**不要再手工编辑** `$DSH_HOME/profiles/<name>/cordis.patch.yml` 插入插件行（重复 id 会产生重复 Loader 条目）。`cordis.patch.yml` 必须进 `files` 与 `exports`，否则发布后组合包解析不到 patch。用户 patch 层里若要覆盖插件配置，仍用 `- id: dsh-commands` + `config:`（顶层 `- id: + name:` 是覆盖语义，行不存在会报 "entry not found"）。
7. **0.2.0 迁移要点**：`ctx.commands.execute(agent, line, attachments, signal)` 多了附件数组参数；`Session.events` 已移除，读日志用 `snapshotEvents()`；`canonicalizeWatchPath()` 现在走 `realpath`，因此 watcher 测试的临时根目录要先 `realpath()`（macOS `/var` → `/private/var`），否则事件路径不在锚点下而被忽略。

## 约束

- 注释与文档使用简体中文（API 文档可英文）
- commit message 使用英文
- 测试改动必须保持 30 个测试全绿；覆盖率看 `pnpm run test:coverage` 报告（当前未配置阈值）
- 构建产物 `lib/` 由 `pnpm run build` 生成，随源码变更一起更新
- 代码风格沿用 DSH 仓库惯例：strict TS、exactOptionalPropertyTypes、无 non-null assertion
