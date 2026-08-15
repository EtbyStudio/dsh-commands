import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

interface FakeWatcherControl {
  emitter: EventEmitter
  path: string
}

interface FakeWatchFileControl {
  path: string
  listener(current: Stats, previous: Stats): void
}

const watcherHarness = vi.hoisted(() => ({
  watchers: [] as FakeWatcherControl[],
  startupErrors: [] as Error[],
  deferredReady: 0,
  watchFiles: [] as FakeWatchFileControl[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watchFile(path: string, _options: unknown, listener: FakeWatchFileControl['listener']) {
      watcherHarness.watchFiles.push({ path, listener })
    },
    unwatchFile(path: string, listener: FakeWatchFileControl['listener']) {
      const index = watcherHarness.watchFiles.findIndex(control => control.path === path && control.listener === listener)
      if (index !== -1) watcherHarness.watchFiles.splice(index, 1)
    },
  }
})

vi.mock('chokidar', () => ({
  default: {
    watch(path: unknown, _options: Record<string, unknown>) {
      const emitter = new EventEmitter() as EventEmitter & { close(): Promise<void> }
      const control: FakeWatcherControl = { emitter, path: String(path) }
      emitter.close = async () => undefined
      watcherHarness.watchers.push(control)
      queueMicrotask(() => {
        if (watcherHarness.deferredReady > 0) {
          watcherHarness.deferredReady -= 1
          return
        }
        const error = watcherHarness.startupErrors.shift()
        if (error === undefined) emitter.emit('ready')
        else emitter.emit('error', error)
      })
      return emitter
    },
  },
}))

import { CommandsFilesystemProvider, type Config } from '../src/index.ts'

async function writeCommand(root: string, name: string, description: string, body = 'Run the workflow.'): Promise<string> {
  const path = join(root, `${name}.md`)
  await mkdir(root, { recursive: true })
  await writeFile(path, `---\ndescription: ${description}\n---\n\n${body}\n`)
  return path
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

let home: string | undefined
let provider: CommandsFilesystemProvider | undefined

beforeEach(() => {
  watcherHarness.watchers.length = 0
  watcherHarness.startupErrors.length = 0
  watcherHarness.deferredReady = 0
  watcherHarness.watchFiles.length = 0
})

afterEach(async () => {
  await provider?.dispose()
  provider = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function harness(
  pre?: (home: string) => Promise<void>,
  config: Partial<Config> | ((home: string) => Partial<Config>) = {},
): Promise<{ ctx: Context; agent: Agent; steer: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  home = await mkdtemp(join(tmpdir(), 'dsh-commands-'))
  await pre?.(home)
  // The command root exists up front so discovery opens the Chokidar watcher
  // (the missing-root ancestor path has its own watcher suite).
  await mkdir(join(home, 'commands'), { recursive: true })
  const resolved = typeof config === 'function' ? config(home) : config
  provider = new CommandsFilesystemProvider(ctx, { dshHome: home, ...resolved })
  await provider.ready
  const session = Session.create(SessionId('dsh-commands-test'))
  const steer = vi.fn()
  const agent = {
    session,
    status: 'idle',
    options: {},
    steer,
  } as unknown as Agent
  return { ctx, agent, steer }
}

/** The single fake watcher opened for `<dshHome>/commands`. */
function watcher(): FakeWatcherControl {
  const control = watcherHarness.watchers[0]
  if (control === undefined) throw new Error('no watcher opened')
  return control
}

describe('dsh-commands discovery', () => {
  it('registers one command per valid Markdown file with its frontmatter description', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    expect(watcher().path).toBe(await realpath(root))
    const go = await writeCommand(root, 'go', 'Execute the plan')
    await writeCommand(root, 'commit', 'git commit')
    watcher().emitter.emit('add', go)
    watcher().emitter.emit('add', join(root, 'commit.md'))
    await settle()

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['commit', 'go'])
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')
  })

  it('registers files that exist before the initial scan runs', async () => {
    const { ctx, agent } = await harness(async (dshHome) => {
      await mkdir(join(dshHome, 'commands'))
      await writeCommand(join(dshHome, 'commands'), 'go', 'Execute the plan')
    })
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')
  })

  it('skips files without frontmatter, description, a valid name, or a body', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await writeFile(join(root, 'plain.md'), 'No frontmatter here.')
    await writeFile(join(root, 'nodesc.md'), '---\nagent: ceo\n---\n\nBody.')
    await writeFile(join(root, 'Uppercase.md'), '---\ndescription: bad name\n---\n\nBody.')
    await writeFile(join(root, 'empty.md'), '---\ndescription: empty body\n---\n\n   ')
    await writeFile(join(root, 'notes.txt'), '---\ndescription: not markdown\n---\n\nBody.')
    for (const name of ['plain.md', 'nodesc.md', 'Uppercase.md', 'empty.md', 'notes.txt']) {
      watcher().emitter.emit('add', join(root, name))
    }
    await settle()

    expect(ctx.commands.list(agent)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('executes the file body as a model instruction and appends typed arguments', async () => {
    const { ctx, agent, steer } = await harness()
    const root = join(home!, 'commands')
    const go = await writeCommand(root, 'go', 'Execute the plan', '## Flow\n1. Review.\n2. Execute.')
    watcher().emitter.emit('add', go)
    await settle()

    const execution = await ctx.commands.execute(agent, '/go', new AbortController().signal)
    if (execution === undefined) throw new Error('did not resolve /go')
    expect(execution.result).toEqual({ kind: 'success', text: 'Command body submitted to the model.' })
    const steers = steer.mock.calls
    const first = steers[0]?.[0] as { content: { type: string; text: string }[]; source: { kind: string } }
    expect(first.content[0]?.text).toBe('## Flow\n1. Review.\n2. Execute.')
    expect(first.source).toEqual({ kind: 'user' })

    await ctx.commands.execute(agent, '/go 目标描述', new AbortController().signal)
    const second = steers[1]?.[0] as { content: { type: string; text: string }[] }
    expect(second.content[0]?.text).toBe('## Flow\n1. Review.\n2. Execute.\n\n目标描述')
  })

  it('substitutes $ARGUMENTS placeholders instead of appending', async () => {
    const { ctx, agent, steer } = await harness()
    const root = join(home!, 'commands')
    const audit = await writeCommand(root, 'audit', 'Audit', 'Scope: $ARGUMENTS\n\nRun the audit.')
    watcher().emitter.emit('add', audit)
    await settle()

    await ctx.commands.execute(agent, '/audit PA 删除', new AbortController().signal)
    const steered = steer.mock.calls[0]?.[0] as { content: { type: string; text: string }[] }
    expect(steered.content[0]?.text).toBe('Scope: PA 删除\n\nRun the audit.')
  })

  it('re-registers a changed file and unregisters a deleted or invalid one', async () => {
    const { ctx, agent, steer } = await harness()
    const root = join(home!, 'commands')
    const path = await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')

    await writeFile(path, '---\ndescription: Execute the plan now\n---\n\nNew body.')
    watcher().emitter.emit('change', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan now')
    await ctx.commands.execute(agent, '/go', new AbortController().signal)
    const steered = steer.mock.calls.at(-1)?.[0] as { content: { type: string; text: string }[] }
    expect(steered.content[0]?.text).toBe('New body.')

    watcher().emitter.emit('unlink', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeUndefined()

    await writeFile(path, 'broken without frontmatter')
    watcher().emitter.emit('add', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeUndefined()
  })

  it('lets programmatic registrations win over same-named files', async () => {
    const { ctx, agent, steer } = await harness()
    let handled = false
    ctx.commands.register({
      name: 'plan',
      description: 'Built-in plan mode',
      handler: () => {
        handled = true
        return { kind: 'success' as const }
      },
    })
    const root = join(home!, 'commands')
    await writeCommand(root, 'plan', 'File plan')
    watcher().emitter.emit('add', join(root, 'plan.md'))
    await settle()

    expect(ctx.commands.find(agent, 'plan')?.description).toBe('Built-in plan mode')
    await ctx.commands.execute(agent, '/plan', new AbortController().signal)
    expect(handled).toBe(true)
    expect(steer).not.toHaveBeenCalled()
  })

  it('reports an error result when the command file disappears before execution', async () => {
    const { ctx, agent, steer } = await harness()
    const root = join(home!, 'commands')
    const path = await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', path)
    await settle()
    await rm(path)

    const execution = await ctx.commands.execute(agent, '/go', new AbortController().signal)
    if (execution === undefined) throw new Error('did not resolve /go')
    expect(execution.result.kind).toBe('error')
    expect(steer).not.toHaveBeenCalled()
  })

  it('scans extra configured command directories after the default root', async () => {
    const { ctx, agent } = await harness(
      async (dshHome) => { await mkdir(join(dshHome, 'extra')) },
      dshHome => ({ commandDirs: [join(dshHome, 'extra')] }),
    )
    const extra = join(home!, 'extra')
    const review = await writeCommand(extra, 'review', 'Review changes')
    const extraWatcher = watcherHarness.watchers[1]
    extraWatcher?.emitter.emit('add', review)
    await settle()

    expect(ctx.commands.find(agent, 'review')?.description).toBe('Review changes')
    expect(ctx.commands.find(agent, 'go')).toBeUndefined()
  })

  it('unregisters commands whose files vanished when a root rescan runs', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    const path = await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeDefined()

    await rm(path)
    watcher().emitter.emit('addDir', root)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeUndefined()
  })

  it('unregisters a registered command whose file becomes invalid', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    const path = await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeDefined()

    await writeFile(path, 'broken without frontmatter')
    watcher().emitter.emit('change', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeUndefined()
  })

  it('ignores a re-add of an unchanged file', async () => {
    const { ctx, agent, steer } = await harness()
    const root = join(home!, 'commands')
    const path = await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', path)
    await settle()
    const first = steer

    watcher().emitter.emit('add', path)
    await settle()
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')
    await ctx.commands.execute(agent, '/go', new AbortController().signal)
    expect(first.mock.calls).toHaveLength(1)
  })

  it('reports an error result when the file loses its frontmatter before execution', async () => {
    const { ctx, agent, steer } = await harness()
    const root = join(home!, 'commands')
    const path = await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', path)
    await settle()
    await writeFile(path, 'broken without frontmatter')

    const execution = await ctx.commands.execute(agent, '/go', new AbortController().signal)
    if (execution === undefined) throw new Error('did not resolve /go')
    expect(execution.result.kind).toBe('error')
    expect(steer).not.toHaveBeenCalled()
  })

  it('ignores events for files that were never registered', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    // An empty root has no registration map for the unlink to consult.
    watcher().emitter.emit('unlink', join(root, 'ghost.md'))
    await settle()
    expect(ctx.commands.list(agent)).toEqual([])
    // A root that already holds registrations still ignores unrelated unlinks.
    const go = await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', go)
    watcher().emitter.emit('unlink', join(root, 'ghost.md'))
    await settle()
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['go'])
  })

  it('skips malformed frontmatter variants and missing files', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    const warn = vi.spyOn(ctx.logger, 'warn')
    const cases: [string, string][] = [
      ['no-separator.md', 'hello\nworld'],
      ['unclosed.md', '---\ndescription: x'],
      ['unclosed-newline.md', '---\ndescription: x\n'],
      ['array.md', '---\n- a\n- b\n---\n\nBody.'],
      ['no-trailing-newline.md', '---\ndescription: x\n---'],
      ['bad-yaml.md', '---\ndescription: [unclosed\n---\n\nBody.'],
    ]
    for (const [name, content] of cases) {
      await writeFile(join(root, name), content)
      watcher().emitter.emit('add', join(root, name))
    }
    // An add event for a file that vanished before parsing is a no-op.
    watcher().emitter.emit('add', join(root, 'ghost.md'))
    await settle()

    expect(ctx.commands.list(agent)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('rejects non-positive watcher tuning values', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    home = await mkdtemp(join(tmpdir(), 'dsh-commands-'))
    expect(() => new CommandsFilesystemProvider(ctx, {
      dshHome: home!,
      watchStabilityThresholdMs: 0,
    })).toThrow('watchStabilityThresholdMs must be a positive integer')
    expect(() => new CommandsFilesystemProvider(ctx, {
      dshHome: home!,
      watchPollIntervalMs: 0,
    })).toThrow('watchPollIntervalMs must be a positive integer')
  })

  it('treats a file occupying the command root as an absent directory', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    home = await mkdtemp(join(tmpdir(), 'dsh-commands-'))
    await writeFile(join(home, 'commands'), 'not a directory')
    provider = new CommandsFilesystemProvider(ctx, { dshHome: home })
    await provider.ready
    const session = Session.create(SessionId('dsh-commands-rootfile-test'))
    const agent = {
      session,
      status: 'idle',
      options: {},
      steer: vi.fn(),
    } as unknown as Agent
    expect(ctx.commands.list(agent)).toEqual([])
  })

  it('disposes every registration together with the provider', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    await writeCommand(root, 'go', 'Execute the plan')
    watcher().emitter.emit('add', join(root, 'go.md'))
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeDefined()

    await provider?.dispose()
    expect(ctx.commands.find(agent, 'go')).toBeUndefined()
  })
})
