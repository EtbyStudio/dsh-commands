# dsh-commands

English | [中文](README.zh.md)

Filesystem slash-command discovery for DeepSeek Harness UIs.

This plugin registers one slash command per Markdown file under `<dshHome>/commands`, mirroring the user-root layout of the skill discovery in `@deepseek-ai/dsh-skill-filesystem`. The filename stem is the command name, the YAML frontmatter supplies the description, and the body is the instruction executed when the command runs. A host watcher keeps registrations in sync with the directory: adding, editing, or deleting a command file updates the registry without a restart, and the registry's own `commands/change` event refreshes live discovery UIs.

It is a plugin for the DeepSeek Harness command registry (`ctx.commands`, `@deepseek-ai/dsh-commands`).

## Install

From npm:

```sh
dsh plugin --profile web add @etby-studio/dsh-commands
```

Developing locally (the build output `lib/` is gitignored; build it first after cloning):

```sh
pnpm run build
dsh plugin --profile web add /path/to/dsh-commands
```

In both cases, insert the plugin in the profile's user patch layer:

```sh
# $DSH_HOME/profiles/web/cordis.patch.yml
# - insert:
#     - id: dsh-commands
#       name: @etby-studio/dsh-commands
```

After boot, any `*.md` file in `<dshHome>/commands` becomes a slash command (`dshHome` defaults to `$DSH_HOME` or `~/.dsh`).

## Command file format

Each command is one Markdown file; the filename stem (without `.md`) is the command name, lowercased ASCII with letters, digits, `_`, or `-`, matching `parseCommand()`:

```markdown
---
description: Execute the plan
---

## Steps

1. Review the plan
2. Create a task list
```

- `description` (required) — shown in command discovery UI.
- Body — the instruction submitted to the model when the command runs.

Invalid files (missing frontmatter, empty description, invalid name, empty body) are skipped with a warning and never registered.

## Execution

The handler never implicitly submits to the model. On `/name [args]` it reads the current body and steers one user message to the receiving agent:

- Typed arguments append after a blank line (`/go <description>` → body + blank line + `<description>`).
- A `$ARGUMENTS` placeholder in the body is substituted with the arguments instead.

The body is re-read at every execution, so file edits take effect without a restart.

## Conflicts

File commands are low priority: when a plugin has already registered the same name, the file is skipped with a warning and the programmatic registration wins (no backfill while it lives).

## Watcher

Existing roots are watched with Chokidar (realpathed anchor, `depth: 1`, `awaitWriteFinish` stability). A missing root is probed from the nearest existing ancestor with `fs.watchFile`, so creating `~/.dsh/commands` later still attaches. Root deletion unregisters everything and reverses to the probe; recreation rescans. `commands/change` is emitted by the registry itself.

## Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Config root; scans `commands` under it. |
| `commandDirs` | `[]` | Extra command roots scanned after `<dshHome>/commands`. |
| `watch` | `true` | Watch command roots for registry updates. |
| `watchUsePolling` | `false` | Use Chokidar polling instead of native events. |
| `watchStabilityThresholdMs` | `200` | Stable-write window for Chokidar events. |
| `watchPollIntervalMs` | `100` | Polling/stability and missing-path probe interval. |
| `watchFollowSymlinks` | `true` | Follow symbolic links while watching roots. |

## Development

```sh
pnpm install
pnpm run build     # tsc → lib/
pnpm run typecheck
pnpm run test      # 30 tests: discovery, watcher, real Loader composition
```

`@deepseek-ai/*` packages are peer dependencies resolved from the dsh installation at runtime; the tests run against the published npm releases.

## License

MIT
