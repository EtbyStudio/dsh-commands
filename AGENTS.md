# AGENTS.md — dsh-commands

DeepSeek Harness 的文件系统 slash 命令发现。把 `<dshHome>/commands/` 下的 Markdown 命令文件自动注册为 slash 命令，并随文件增删改热更新注册表。

## 项目状态

- ✅ 已实现：目录发现、frontmatter 解析、注册、执行语义（显式提交模型）、watcher 热更新、冲突策略；30 个测试全绿（含真实 Loader 组合测试），`src/` 100% 覆盖率
- ✅ 已挂载：web profile（`dsh plugin --profile web add .` + `cordis.patch.yml` 的 `- insert:` 块）

## 目录结构

```
src/index.ts       全部实现：CommandsFilesystemProvider + CommandWatchManager + 解析辅助
src/invariant.ts   invariants 伴生（空 installer，注册生命周期由 dsh-commands 的 invariant 约束）
tests/             3 个 spec：发现/解析/冲突（fake chokidar）、watcher（fake watchFile）、Loader 组合
lib/               tsc 构建产物（提交前必须重新构建，勿手改）
```

## 常用命令

```sh
pnpm install            # 依赖；@deepseek-ai/* 为 peer，运行时从 dsh 安装解析
pnpm run build          # tsc → lib/
pnpm run typecheck
pnpm run test           # vitest，30 个测试
pnpm run test:coverage  # 覆盖率门禁（src/ 100%）
```

## 关键设计决策（改动前必读）

1. **命令文件格式**：flat `*.md`，文件名 stem 即命令名（小写/数字/`_`/`-`，复用 `parseCommand()` 校验），frontmatter 必填 `description`。
2. **执行语义**：DSH 命令 handler 不会隐式提交模型。执行时**重新读取文件正文**，显式 `agent.steer()` 提交 user 消息；参数空行后追加，正文含 `$ARGUMENTS` 占位符时替换。
3. **冲突策略**：文件命令低优先级，注册式同名命令胜出（文件跳过 + warn，不补位）。
4. **watcher 模式**：与 `@deepseek-ai/dsh-skill-filesystem` 的 `SkillWatchManager` 对称（realpath 锚点 + `fs.watchFile` 祖先探测缺失根）；`src/index.ts` 中 `jscpd:ignore-start` 区域即该共享模式。
5. **包名与依赖**：npm 包名 `@etby-studio/dsh-commands`（插件名保持 `dsh-commands`，与上游 `@deepseek-ai/dsh-commands` 无冲突），`@deepseek-ai/*` 全部为 peerDependencies——宿主 dsh profile 的 `autoInstallPeers: false` + fallback node_modules 保证从 dsh 安装解析同一份 cordis 实例，不要改成 dependencies。
6. **挂载方式**（用户侧）：`dsh plugin --profile <name> add <path>` 装入 profile + 在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 用 `- insert:` 块注册插件行（顶层 `- id: + name:` 是覆盖语义，会报 "entry not found"）：
   ```yaml
   - insert:
       - id: dsh-commands
         name: @etby-studio/dsh-commands
   ```

## 约束

- 注释与文档使用简体中文（API 文档可英文）
- commit message 使用英文
- 测试改动必须保持 30 个测试全绿 + `src/` 100% 覆盖率
- 构建产物 `lib/` 由 `pnpm run build` 生成，随源码变更一起更新
- 代码风格沿用 DSH 仓库惯例：strict TS、exactOptionalPropertyTypes、无 non-null assertion
