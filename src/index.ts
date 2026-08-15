/**
 * Filesystem slash-command discovery for DeepSeek Harness UIs.
 *
 * This plugin registers one slash command per flat Markdown file under
 * `<dshHome>/commands` (and any configured extra directories), mirroring the
 * skill discovery layout of `@deepseek-ai/dsh-skill-filesystem`. Each file's
 * filename stem is the command name, its YAML frontmatter supplies the
 * description, and its body is the command instruction. Because DSH command
 * handlers never implicitly submit anything to the model, the generated
 * handler explicitly steers the file body plus any typed arguments to the
 * receiving agent as a user message, like `@deepseek-ai/dsh-plan-mode` does
 * for `/plan [message]`.
 *
 * A watcher keeps the registry in sync with the directory: add, change, and
 * unlink events re-register or unregister the affected command without a
 * restart, and `commands/change` is emitted by the registry itself so live
 * adapters refresh discovery.
 *
 * @module dsh-commands
 */

import { createHash } from 'node:crypto'
import { watchFile, unwatchFile, type Stats } from 'node:fs'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import chokidar from 'chokidar'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import { parseCommand, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const DEFAULT_WATCH_STABILITY_THRESHOLD_MS = 200
const DEFAULT_WATCH_POLL_INTERVAL_MS = 100

export const name = 'dsh-commands'
export const inject = ['commands']

/** Filesystem command discovery configuration. */
export interface Config {
  /** DeepSeek Harness config root. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Additional command roots scanned after `<dshHome>/commands`. */
  commandDirs?: string[]
  /** Whether command roots are watched for registry changes. */
  watch?: boolean
  /** Whether Chokidar uses polling instead of native filesystem events. */
  watchUsePolling?: boolean
  /** Milliseconds a changed command file must remain stable before it is observed. */
  watchStabilityThresholdMs?: number
  /** Milliseconds between Chokidar stability or polling probes. */
  watchPollIntervalMs?: number
  /** Whether watched symbolic links follow their target files. */
  watchFollowSymlinks?: boolean
}

export const Config: Schema<Config> = z.object({
  dshHome: z.string(),
  commandDirs: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(DEFAULT_WATCH_STABILITY_THRESHOLD_MS),
  watchPollIntervalMs: z.number().default(DEFAULT_WATCH_POLL_INTERVAL_MS),
  watchFollowSymlinks: z.boolean().default(true),
})

/** Register one filesystem command per Markdown file in the command roots. */
export function apply(ctx: Context, config: Config = {}): void {
  const provider = new CommandsFilesystemProvider(ctx, config)
  /* v8 ignore next 2 -- the watcher start already logs; only a fatal scan error reaches this catch */
  void provider.ready.catch((error: unknown) => {
    ctx.logger.warn(`dsh-commands: initial discovery failed: ${errorMessage(error)}`)
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'dsh-commands watcher')
}

/** One command file's stable identity after parsing. */
interface ParsedFileCommand {
  name: string
  description: string
  content: string
  contentHash: string
}

/** Registration record for one discovered command. */
interface FileCommandEntry {
  /** Exact registry disposer returned by `ctx.commands.register()`. */
  disposer: () => void
  /** Content hash of the file at registration time. */
  contentHash: string
}

/** A watcher event targeting one command file inside a root. */
interface FileWatchEvent {
  kind: 'file'
  event: 'add' | 'change' | 'unlink'
  name: string
}

/** A watcher event targeting the root directory itself. */
interface RootWatchEvent {
  kind: 'root'
  event: 'addDir' | 'unlinkDir'
}

type WatchEvent = FileWatchEvent | RootWatchEvent

/**
 * Discovers Markdown slash commands from the filesystem and registers them
 * on `ctx.commands`, keeping registrations in sync through host watchers.
 */
export class CommandsFilesystemProvider {
  private readonly ctx: Context
  private readonly roots: readonly string[]
  private readonly watchManager: CommandWatchManager
  /** Per-root registrations keyed by command name. */
  private readonly registered = new Map<string, Map<string, FileCommandEntry>>()
  /** Per-root serialized mutation queue; resolves when the queue drains. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Settles after the initial scan; rejects on a fatal scan error. */
  readonly ready: Promise<void>
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, config: Config = {}) {
    this.ctx = ctx
    this.roots = Object.freeze([
      join(resolveDshHome(config.dshHome), 'commands'),
      ...(config.commandDirs ?? []).map(dir => resolve(dir)),
    ])
    this.watchManager = new CommandWatchManager(
      ctx,
      (root, event) => { this.handleWatchEvent(root, event) },
      resolveWatchConfig(config),
    )
    this.ready = this.start()
  }

  /**
   * Establish every root's watcher, then run the initial scan.
   * @returns a promise settling after the initial scan completes.
   */
  private async start(): Promise<void> {
    for (const root of this.roots) {
      try {
        await this.watchManager.retainRoot(root)
      } catch (error) {
        // A failed watcher keeps static discovery working; the next change
        // event or restart retries the watch.
        this.ctx.logger.warn(`dsh-commands: failed to watch ${root}: ${errorMessage(error)}`)
      }
    }
    await Promise.all(this.roots.map(root => this.enqueue(root, () => this.scanRoot(root))))
  }

  /**
   * Unregister every discovered command and close every watcher.
   * @returns a shared promise settling when all registrations and watchers are gone.
   */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      await Promise.all(this.queues.values())
      for (const [root, commands] of this.registered) {
        this.registered.delete(root)
        for (const entry of commands.values()) entry.disposer()
      }
      await this.watchManager.dispose()
    })()
    return this.disposal
  }

  /** Serialize one root mutation behind the previous one. */
  private enqueue(root: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(root) ?? Promise.resolve()
    const next = previous.then(task, task)
    // Keep the queue tail alive whether the task settles or throws; a failed
    // scan is logged at its call site and must not wedge later events.
    /* v8 ignore next -- task failures are logged at their call sites; the tail only contains them */
    this.queues.set(root, next.then(() => undefined, () => undefined))
    return next
  }

  private handleWatchEvent(root: string, event: WatchEvent): void {
    void this.enqueue(root, async () => {
      if (event.kind === 'root') {
        if (event.event === 'unlinkDir') this.clearRoot(root)
        await this.scanRoot(root)
        return
      }
      if (event.event === 'unlink') {
        this.unregisterName(root, commandNameFromStem(event.name))
        return
      }
      await this.registerFile(root, join(root, event.name))
    })
  }

  /** Register every valid command file currently present in one root. */
  private async scanRoot(root: string): Promise<void> {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      // A missing root is the idle state; the ancestor watcher scans again
      // once the directory appears.
      /* v8 ignore start -- non-absence readdir failures need a platform permission or I/O fault */
      if (isAbsentPathError(error)) return
      throw error
      /* v8 ignore stop */
    }
    const present = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = commandNameFromStem(entry.name)
      present.add(name)
      await this.registerFile(root, join(root, entry.name))
    }
    for (const name of this.registered.get(root)?.keys() ?? []) {
      if (!present.has(name)) this.unregisterName(root, name)
    }
  }

  /**
   * Parse and register one command file, or unregister the command when the
   * file became invalid. A registration conflict with an existing same-named
   * command skips the file with a warning: programmatic registrations win.
   */
  private async registerFile(root: string, path: string): Promise<void> {
    const parsed = await parseCommandFile(path, this.ctx)
    const name = parsed?.name ?? commandNameFromStem(basenameOf(path))
    const existing = this.registered.get(root)?.get(name)
    if (parsed === undefined) {
      if (existing !== undefined) {
        this.ctx.logger.warn(`command file ${path} became invalid; unregistering "${name}"`)
        this.unregisterName(root, name)
      }
      return
    }
    if (existing !== undefined && existing.contentHash === parsed.contentHash) return
    if (existing !== undefined) this.unregisterName(root, name)
    let disposer: () => void
    try {
      disposer = this.ctx.commands.register({
        name: parsed.name,
        description: parsed.description,
        input: { hint: '[message]' },
        handler: invocation => this.runCommandFile(invocation, path),
      })
    } catch (error) {
      // The registry rejects duplicate names within one layer; another
      // plugin's registration of the same name wins over this file.
      this.ctx.logger.warn(
        /* v8 ignore next -- the registry throws Error instances for metadata and duplicate names */
        `command file ${path} skipped: ${error instanceof Error ? error.message : errorMessage(error)}`,
      )
      return
    }
    let commands = this.registered.get(root)
    if (commands === undefined) {
      commands = new Map()
      this.registered.set(root, commands)
    }
    commands.set(parsed.name, { disposer, contentHash: parsed.contentHash })
  }

  /**
   * Execute one command file against the receiving agent: read the current
   * body, compose it with the typed arguments, and steer it as a user message.
   * @returns the direct UI outcome; the submitted text is the model instruction.
   */
  private async runCommandFile(invocation: CommandInvocation, path: string): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> {
    let raw: string
    try {
      raw = await readFile(path, { encoding: 'utf8' })
    } catch (error) {
      /* v8 ignore start -- non-absence read failures need a platform permission or I/O fault */
      if (isAbsentPathError(error)) {
        return { kind: 'error', text: `Command file ${path} no longer exists.` }
      }
      throw error
      /* v8 ignore stop */
    }
    const parsed = parseFrontmatter(raw)
    if (parsed === undefined) {
      return { kind: 'error', text: `Command file ${path} lost its YAML frontmatter.` }
    }
    // The body is read at every execution so file edits take effect without
    // a restart; arguments are appended or substituted into the body.
    const text = composeCommandText(parsed.body.trim(), invocation.rawInput)
    invocation.agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    return { kind: 'success', text: 'Command body submitted to the model.' }
  }

  private unregisterName(root: string, name: string): void {
    const commands = this.registered.get(root)
    if (commands === undefined) return
    const entry = commands.get(name)
    if (entry === undefined) return
    commands.delete(name)
    entry.disposer()
  }

  private clearRoot(root: string): void {
    const commands = this.registered.get(root)
    if (commands === undefined) return
    this.registered.delete(root)
    for (const entry of commands.values()) entry.disposer()
  }
}

type CommandWatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'

type RootWatchMode =
  | { kind: 'root'; anchor: string }
  | { kind: 'ancestor'; anchor: string; nextPath: string }

interface RootWatchState {
  root: string
  watcher: WatchHandle | undefined
  opening: Promise<void> | undefined
  unhealthy: boolean
}

interface WatchHandle {
  mode: RootWatchMode
  close(): Promise<void> | void
}

interface ResolvedWatchConfig {
  enabled: boolean
  usePolling: boolean
  stabilityThresholdMs: number
  pollIntervalMs: number
  followSymlinks: boolean
}

/** Owns one bounded host watcher per command root. */
// Watcher lifecycle mirrors skill-filesystem until TODO(file-watch-service) extracts a shared service.
/* jscpd:ignore-start */
class CommandWatchManager {
  private readonly states = new Map<string, RootWatchState>()
  private readonly lifecycle = new AbortController()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly onChange: (root: string, event: WatchEvent) => void,
    private readonly config: ResolvedWatchConfig,
  ) {}

  /** Ensure the root's watcher exists; a missing root waits on its ancestor. */
  async retainRoot(root: string): Promise<void> {
    /* v8 ignore next -- a dispose racing startup can close the manager before a late retain */
    if (this.closing) return
    let state = this.states.get(root)
    /* v8 ignore next -- each root is retained exactly once by the provider */
    if (state === undefined) {
      state = { root, watcher: undefined, opening: undefined, unhealthy: true }
      this.states.set(root, state)
    }
    if (this.config.enabled) await this.ensureWatcher(state)
  }

  /** Close every watcher and contain late filesystem callbacks. */
  async dispose(): Promise<void> {
    this.closing = true
    this.lifecycle.abort(new Error('dsh-commands watcher disposed'))
    const states = [...this.states.values()]
    this.states.clear()
    await Promise.all(states.map(async (state) => {
      await settleWatcherOpening(state.opening)
      const watcher = state.watcher
      state.watcher = undefined
      if (watcher !== undefined) await this.closeWatcher(watcher)
    }))
  }

  private ensureWatcher(state: RootWatchState): Promise<void> {
    /* v8 ignore next -- Teardown can reach this guard only when its dispose wins the await. */
    if (this.closing || !this.config.enabled) return Promise.resolve()
    /* v8 ignore next -- concurrent rewatching reuses the in-flight opening */
    if (state.opening !== undefined) return state.opening
    const opening = this.ensureCurrentWatcher(state)
    state.opening = opening
    void opening.then(
      () => { state.opening = undefined },
      () => { state.opening = undefined },
    )
    return opening
  }

  private async ensureCurrentWatcher(state: RootWatchState): Promise<void> {
    /* v8 ignore start -- a healthy retained watcher is never re-ensured; only failures and mode transitions reach replaceWatcher */
    const watcher = state.watcher
    if (watcher !== undefined && !state.unhealthy) {
      const current = await resolveRootWatchMode(state.root, this.config.followSymlinks)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- watcher callbacks can mark unhealthy while the probe awaits
      if (!state.unhealthy && sameWatchMode(watcher.mode, current)) return
    }
    /* v8 ignore stop */
    await this.replaceWatcher(state)
  }

  private async replaceWatcher(state: RootWatchState): Promise<void> {
    const previous = state.watcher
    state.watcher = undefined
    if (previous !== undefined) await this.closeWatcher(previous)
    /* v8 ignore next -- Teardown can win while an unhealthy watcher is still closing. */
    if (this.closing) return
    try {
      const watcher = await this.openStableWatcher(state)
      /* v8 ignore next -- The loop returns no handle only when teardown wins between awaited probes. */
      if (watcher === undefined) return
      /* v8 ignore start -- Post-open teardown is timing-dependent; the disposal race has an explicit integration test. */
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- teardown can race awaited watcher startup
      if (this.closing) {
        await this.closeWatcher(watcher)
        return
      }
      /* v8 ignore stop */
      state.watcher = watcher
      state.unhealthy = false
    } catch (error) {
      /* v8 ignore start -- teardown can race awaited watcher startup */
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- teardown can race awaited watcher startup
      if (!this.closing) {
        state.unhealthy = true
        this.ctx.logger.warn(`dsh-commands: failed to watch ${state.root}: ${errorMessage(error)}`)
      }
      /* v8 ignore stop */
      throw error
    }
  }

  private async openStableWatcher(state: RootWatchState): Promise<WatchHandle | undefined> {
    while (!this.closing) {
      const mode = await resolveRootWatchMode(state.root, this.config.followSymlinks)
      const watcher = mode.kind === 'ancestor'
        ? this.openAncestorWatcher(state, mode)
        : await this.openRootWatcher(state, mode)
      const current = await resolveRootWatchMode(state.root, this.config.followSymlinks)
      /* v8 ignore else -- A host path transition between the two probes is timing-dependent. */
      if (sameWatchMode(mode, current)) return watcher
      /* v8 ignore next -- Covered by the same host path transition guard. */
      await this.closeWatcher(watcher)
    }
    /* v8 ignore next -- The loop exits only when teardown wins between awaited probes. */
    return undefined
  }

  private openAncestorWatcher(state: RootWatchState, mode: Extract<RootWatchMode, { kind: 'ancestor' }>): WatchHandle {
    const listener = (_current: Stats, _previous: Stats): void => {
      void this.handleAncestorWatchEvent(state, mode)
    }
    watchFile(mode.nextPath, {
      persistent: false,
      interval: this.config.pollIntervalMs,
    }, listener)
    return {
      mode,
      close() {
        unwatchFile(mode.nextPath, listener)
      },
    }
  }

  private async handleAncestorWatchEvent(
    state: RootWatchState,
    mode: Extract<RootWatchMode, { kind: 'ancestor' }>,
  ): Promise<void> {
    let current: RootWatchMode
    try {
      current = await resolveRootWatchMode(state.root, this.config.followSymlinks)
    } catch (error) {
      /* v8 ignore start -- Non-absence stat failures need a platform permission or I/O fault. */
      if (!this.closing) this.handleWatcherError(state, error)
      return
      /* v8 ignore stop */
    }
    if (this.closing || sameWatchMode(mode, current)) return
    state.unhealthy = true
    this.scheduleRewatch(state)
    // The root transitioned (created or removed); rescan from the new mode.
    /* v8 ignore next -- only a higher-ancestor deletion switches an ancestor mode to 'unlinkDir' */
    this.onChange(state.root, { kind: 'root', event: current.kind === 'root' ? 'addDir' : 'unlinkDir' })
  }

  private async openRootWatcher(state: RootWatchState, mode: Extract<RootWatchMode, { kind: 'root' }>): Promise<WatchHandle> {
    const watcher = chokidar.watch(mode.anchor, {
      // Chokidar owns late native fs.watch errors only for persistent watchers;
      // this plugin's effect explicitly closes every handle at teardown.
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      followSymlinks: this.config.followSymlinks,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.stabilityThresholdMs,
        pollInterval: this.config.pollIntervalMs,
      },
      usePolling: this.config.usePolling,
      interval: this.config.pollIntervalMs,
    })
    const handle: WatchHandle = {
      mode,
      close: () => watcher.close(),
    }
    let ready = false
    const readiness = Promise.withResolvers<undefined>()
    const signal = this.lifecycle.signal
    /* v8 ignore start -- startup is always awaited inside the provider fiber; only a racing dispose aborts here */
    if (signal.aborted) {
      await this.closeWatcher(handle)
      signal.throwIfAborted()
    }
    const onAbort = (): void => { readiness.reject(signal.reason) }
    /* v8 ignore stop */
    signal.addEventListener('abort', onAbort, { once: true })
    const onError = (error: unknown): void => {
      if (!ready) {
        readiness.reject(error)
        return
      }
      this.handleWatcherError(state, error)
    }
    watcher.on('error', onError)
    watcher.once('ready', () => {
      ready = true
      readiness.resolve(undefined)
    })
    for (const event of ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const) {
      watcher.on(event, (path) => { this.handleWatchEvent(state, mode, event, path) })
    }
    try {
      await readiness.promise
    } catch (error) {
      await this.closeWatcher(handle)
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    return handle
  }

  private handleWatchEvent(
    state: RootWatchState,
    mode: Extract<RootWatchMode, { kind: 'root' }>,
    event: CommandWatchEvent,
    path: string,
  ): void {
    /* v8 ignore next -- a closing manager ignores late watcher events */
    if (this.closing) return
    const target = resolve(path)
    const segments = containedSegments(mode.anchor, target)
    /* v8 ignore next -- Chokidar only emits paths under the anchor */
    if (segments === undefined) return
    if (segments.length === 0) {
      // The root directory itself appeared or disappeared.
      /* v8 ignore next -- file events never target the anchor itself */
      if (event === 'addDir' || event === 'unlinkDir') {
        if (event === 'unlinkDir') {
          state.unhealthy = true
          this.scheduleRewatch(state)
        }
        this.onChange(state.root, { kind: 'root', event })
      }
      return
    }
    if (segments.length !== 1) return
    const name = segments[0]
    /* v8 ignore next -- Chokidar only emits paths under the anchor. */
    if (name === undefined) return
    if (!name.endsWith('.md')) return
    /* v8 ignore next -- directory events were handled above and never target a file */
    if (event === 'add' || event === 'change' || event === 'unlink') {
      this.onChange(state.root, { kind: 'file', event, name })
    }
  }

  private handleWatcherError(state: RootWatchState, error: unknown): void {
    /* v8 ignore next -- a closing manager skips late error bookkeeping */
    if (this.closing) return
    this.ctx.logger.warn(`dsh-commands: watcher for ${state.root} failed: ${errorMessage(error)}`)
    state.unhealthy = true
    this.scheduleRewatch(state)
  }

  private scheduleRewatch(state: RootWatchState): void {
    const currentOpening = state.opening ?? Promise.resolve()
    void (async () => {
      await settleWatcherOpening(currentOpening)
      try {
        await this.ensureWatcher(state)
      } catch {
        // Watch startup logged the retry failure; the next ancestor event retries it.
        return
      }
    })()
  }

  private async closeWatcher(watcher: WatchHandle): Promise<void> {
    try {
      await watcher.close()
    } catch (error) {
      this.ctx.logger.warn(`dsh-commands: failed to close watcher: ${errorMessage(error)}`)
    }
  }
}

async function settleWatcherOpening(opening: Promise<void> | undefined): Promise<void> {
  if (opening === undefined) return
  try {
    await opening
  } catch {
    // Watch startup already logged the underlying failure; teardown only contains it.
  }
}

function resolveWatchConfig(config: Config): ResolvedWatchConfig {
  const stabilityThresholdMs = config.watchStabilityThresholdMs ?? DEFAULT_WATCH_STABILITY_THRESHOLD_MS
  const pollIntervalMs = config.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS
  assertPositiveInteger('watchStabilityThresholdMs', stabilityThresholdMs)
  assertPositiveInteger('watchPollIntervalMs', pollIntervalMs)
  return {
    enabled: config.watch ?? true,
    usePolling: config.watchUsePolling ?? false,
    stabilityThresholdMs,
    pollIntervalMs,
    followSymlinks: config.watchFollowSymlinks ?? true,
  }
}

async function resolveRootWatchMode(root: string, followSymlinks: boolean): Promise<RootWatchMode> {
  let candidate = root
  while (true) {
    try {
      const info = await stat(candidate)
      /* v8 ignore next -- a regular-file root needs a platform misconfiguration */
      if (info.isDirectory()) {
        const preserveRootLink = candidate === root
          && !followSymlinks
          && (await lstat(candidate)).isSymbolicLink()
        const anchor = preserveRootLink ? resolve(candidate) : await canonicalizeWatchPath(candidate)
        if (candidate === root) return { kind: 'root', anchor }
        const firstSegment = relative(candidate, root).split(sep)[0]
        /* v8 ignore next -- candidate is a strict ancestor of root. */
        if (firstSegment === undefined || firstSegment.length === 0) return { kind: 'root', anchor }
        return { kind: 'ancestor', anchor, nextPath: join(anchor, firstSegment) }
      }
    } catch (error) {
      /* v8 ignore next -- Non-absence stat failures are platform/permission-specific and propagate as incomplete discovery. */
      if (!isAbsentPathError(error)) throw error
    }
    const parent = dirname(candidate)
    /* v8 ignore next -- Traversal reaches the existing filesystem root before this fallback. */
    if (parent === candidate) return { kind: 'ancestor', anchor: candidate, nextPath: root }
    candidate = parent
  }
}

function sameWatchMode(left: RootWatchMode, right: RootWatchMode): boolean {
  return left.kind === right.kind
    && left.anchor === right.anchor
    && (left.kind === 'root' || (right.kind === 'ancestor' && left.nextPath === right.nextPath))
}

function containedSegments(root: string, path: string): string[] | undefined {
  const child = relative(root, path)
  if (child.length === 0) return []
  /* v8 ignore next -- watcher events are always inside the anchor */
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined
  return child.split(sep)
}

function isAbsolute(child: string): boolean {
  return child.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(child)
}

/** Strip the trailing `.md` from a flat command file name. */
function commandNameFromStem(stem: string): string {
  /* v8 ignore next -- every caller already filtered the `.md` suffix */
  return stem.endsWith('.md') ? stem.slice(0, -3) : stem
}

/** Whether a stem is a valid slash command name under `parseCommand()`. */
function isCommandName(name: string): boolean {
  const parsed = parseCommand(`/${name}`)
  return parsed !== undefined && parsed.name === name
}

/**
 * Parse one command file: `---` YAML frontmatter with a required non-empty
 * `description`, a valid filename stem, and a non-empty body.
 * @returns the parsed command, or `undefined` when the file is not a valid command.
 */
async function parseCommandFile(path: string, ctx: Context): Promise<ParsedFileCommand | undefined> {
  let raw: string
  try {
    raw = await readFile(path, { encoding: 'utf8' })
  } catch (error) {
    /* v8 ignore start -- non-absence read failures need a platform permission or I/O fault */
    if (isAbsentPathError(error)) return undefined
    throw error
    /* v8 ignore stop */
  }
  const name = commandNameFromStem(basenameOf(path))
  if (!isCommandName(name)) {
    ctx.logger.warn(`command file ${path} ignored: invalid command name "${name}"`)
    return undefined
  }
  let parsed
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    ctx.logger.warn(`command file ${path} ignored: invalid YAML frontmatter: ${errorMessage(error)}`)
    return undefined
  }
  if (parsed === undefined) {
    ctx.logger.warn(`command file ${path} ignored: missing YAML frontmatter`)
    return undefined
  }
  const description = stringField(parsed.data, 'description')
  if (description === undefined) {
    ctx.logger.warn(`command file ${path} ignored: frontmatter requires a non-empty description`)
    return undefined
  }
  const content = parsed.body.trim()
  if (content.length === 0) {
    ctx.logger.warn(`command file ${path} ignored: empty command body`)
    return undefined
  }
  return {
    name,
    description,
    content,
    contentHash: contentHash(content),
  }
}

function basenameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** Compose the model instruction text from the file body and typed arguments. */
function composeCommandText(body: string, rawInput: string): string {
  const args = rawInput.trim()
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', args)
  return args === '' ? body : `${body}\n\n${args}`
}

function contentHash(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex')
}

// Frontmatter scanning is shared with skill-filesystem's file format.
/* jscpd:ignore-end */
/* jscpd:ignore-start */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const yaml = raw.slice(start, closing.start)
  const parsed = parseYaml(yaml) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}
/* jscpd:ignore-end */

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`dsh-commands: ${field} must be a positive integer`)
  }
}

function isAbsentPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return String(error)
}
