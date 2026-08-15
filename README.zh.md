# dsh-commands

[English](README.md) | 中文

面向 DeepSeek Harness UI 的文件系统 slash 命令发现。

本插件把 `<dshHome>/commands` 下的每个 Markdown 文件注册为一条 slash 命令，对齐 `@deepseek-ai/dsh-skill-filesystem` 的用户根布局：文件名（去 `.md`）即命令名，YAML frontmatter 提供描述，正文是命令执行时的指令。宿主 watcher 保持注册与目录同步：新增、修改或删除命令文件无需重启即可更新注册表，注册表自身的 `commands/change` 事件会刷新在线发现 UI。

它是 DeepSeek Harness 命令注册表（`ctx.commands`，`@deepseek-ai/dsh-commands`）的插件。

## 安装

从 npm 安装：

```sh
dsh plugin --profile web add @etby-studio/dsh-commands
```

本地开发（构建产物 `lib/` 不入库；克隆后先构建）：

```sh
pnpm run build
dsh plugin --profile web add /path/to/dsh-commands
```

两种方式都要在 profile 的用户 patch 层插入插件行：

```sh
# $DSH_HOME/profiles/web/cordis.patch.yml
# - insert:
#     - id: dsh-commands
#       name: @etby-studio/dsh-commands
```

启动后，`<dshHome>/commands` 下的每个 `*.md` 文件都会成为 slash 命令（`dshHome` 默认为 `$DSH_HOME` 或 `~/.dsh`）。

## 命令文件格式

每个命令一个 Markdown 文件；文件名 stem（去 `.md`）即命令名，小写 ASCII，含字母、数字、`_` 或 `-`，符合 `parseCommand()`：

```markdown
---
description: 执行计划
---

## 流程

1. 回顾计划
2. 创建任务列表
```

- `description`（必填）— 显示在命令发现 UI。
- 正文 — 命令执行时提交给模型的指令。

非法文件（缺 frontmatter、description 为空、名字非法、正文为空）带警告跳过、永不注册。

## 执行

命令处理器不会隐式把正文发给模型。`/name [参数]` 时读取当前正文并向接收 Agent 提交一条用户消息：

- 参数在空行后追加（`/go 目标描述` → 正文 + 空行 + `目标描述`）。
- 正文含 `$ARGUMENTS` 占位符时用参数替换。

每次执行都重新读取正文，文件编辑即时生效、无需重启。

## 冲突

文件命令是低优先级：其他插件已注册同名时，该文件带警告跳过，程序化注册胜出（存续期间不补位）。

## 监听

已存在的根用 Chokidar 监听（realpath 锚点、`depth: 1`、`awaitWriteFinish` 稳定性）。缺失的根从最近存在的祖先用 `fs.watchFile` 探测，因此之后创建 `~/.dsh/commands` 仍能挂上。根删除注销全部命令并退回探测；重建重新扫描。`commands/change` 由注册表自身发出。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 配置根；扫描其下 `commands`。 |
| `commandDirs` | `[]` | 在 `<dshHome>/commands` 之后扫描的额外命令根。 |
| `watch` | `true` | 监听命令根以更新注册。 |
| `watchUsePolling` | `false` | 改用 Chokidar 轮询而非原生事件。 |
| `watchStabilityThresholdMs` | `200` | Chokidar 事件的稳定写入窗口。 |
| `watchPollIntervalMs` | `100` | 轮询/稳定与缺失路径探测间隔。 |
| `watchFollowSymlinks` | `true` | 监听根时跟随符号链接。 |

## 开发

```sh
pnpm install
pnpm run build     # tsc → lib/
pnpm run typecheck
pnpm run test      # 30 个测试：发现、watcher、真实 Loader 组合
```

`@deepseek-ai/*` 包是 peer 依赖，运行时从 dsh 安装解析；测试针对已发布的 npm 版本运行。

## 许可证

MIT
