import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
  closeCalls: number
}

interface FakeWatchFileControl {
  path: string
  listener(current: Stats, previous: Stats): void
}

const watcherHarness = vi.hoisted(() => ({
  watchers: [] as FakeWatcherControl[],
  startupErrors: [] as Error[],
  closeErrors: 0,
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
      const control: FakeWatcherControl = { emitter, path: String(path), closeCalls: 0 }
      emitter.close = async () => {
        control.closeCalls += 1
        if (watcherHarness.closeErrors > 0) {
          watcherHarness.closeErrors -= 1
          throw new Error('close failed')
        }
      }
      watcherHarness.watchers.push(control)
      queueMicrotask(() => {
        const error = watcherHarness.startupErrors.shift()
        if (error === undefined) emitter.emit('ready')
        else emitter.emit('error', error)
      })
      return emitter
    },
  },
}))

import { CommandsFilesystemProvider } from '../src/index.ts'

async function writeCommand(root: string, name: string, description: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${name}.md`), `---\ndescription: ${description}\n---\n\nRun the workflow.\n`)
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

let home: string | undefined
let provider: CommandsFilesystemProvider | undefined

beforeEach(() => {
  watcherHarness.watchers.length = 0
  watcherHarness.startupErrors.length = 0
  watcherHarness.closeErrors = 0
  watcherHarness.watchFiles.length = 0
})

afterEach(async () => {
  await provider?.dispose()
  provider = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function harness(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  home = await mkdtemp(join(tmpdir(), 'dsh-commands-fs-watch-'))
  provider = new CommandsFilesystemProvider(ctx, { dshHome: home })
  await provider.ready
  const session = Session.create(SessionId('commands-filesystem-watch-test'))
  const agent = {
    session,
    status: 'idle',
    options: {},
    steer: vi.fn(),
  } as unknown as Agent
  return { ctx, agent }
}

function watcher(): FakeWatcherControl {
  const control = watcherHarness.watchers[0]
  if (control === undefined) throw new Error('no watcher opened')
  return control
}

describe('dsh-commands watcher', () => {
  it('waits on an ancestor watcher until the root directory appears', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    // The root is missing: no Chokidar watcher, one ancestor watchFile probe.
    expect(watcherHarness.watchers).toHaveLength(0)
    expect(watcherHarness.watchFiles).toHaveLength(1)
    expect(watcherHarness.watchFiles[0]?.path).toBe(join(home!, 'commands'))

    await mkdir(root)
    await writeCommand(root, 'go', 'Execute the plan')
    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()

    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')
    expect(watcherHarness.watchers).toHaveLength(1)
    expect(watcherHarness.watchFiles).toHaveLength(0)
  })

  it('unregisters every command and returns to the ancestor watcher when the root disappears', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    await mkdir(root)
    await writeCommand(root, 'go', 'Execute the plan')
    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')
    expect(watcherHarness.watchFiles).toHaveLength(0)

    await rm(root, { recursive: true, force: true })
    watcher().emitter.emit('unlinkDir', root)
    await settle()

    expect(ctx.commands.find(agent, 'go')).toBeUndefined()
    expect(watcherHarness.watchFiles).toHaveLength(1)
    expect(watcher().closeCalls).toBeGreaterThanOrEqual(1)
  })

  it('ignores subdirectory events in flat discovery', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    await mkdir(root)
    await mkdir(join(root, 'sub'))
    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()

    watcher().emitter.emit('addDir', join(root, 'sub'))
    watcher().emitter.emit('add', join(root, 'sub', 'nested.md'))
    await settle()
    expect(ctx.commands.list(agent)).toEqual([])
  })

  it('ignores ancestor probes while the root stays missing', async () => {
    const { ctx, agent } = await harness()
    expect(watcherHarness.watchFiles).toHaveLength(1)

    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()

    // No mode transition, no rewatch, no rescan, no registration.
    expect(ctx.commands.list(agent)).toEqual([])
    expect(watcherHarness.watchFiles).toHaveLength(1)
    expect(watcherHarness.watchers).toHaveLength(0)
  })

  it('handles an error emitted after the watcher is ready by rewatching', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    await mkdir(root)
    await writeCommand(root, 'go', 'Execute the plan')
    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeDefined()

    watcher().emitter.emit('error', new Error('late failure'))
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeDefined()
    expect(watcherHarness.watchers[0]?.closeCalls).toBeGreaterThanOrEqual(1)
  })

  it('keeps the last registration when a rewatch startup fails', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    await mkdir(root)
    await writeCommand(root, 'go', 'Execute the plan')
    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeDefined()

    // The first rewatch succeeds; the second one fails to start.
    watcher().emitter.emit('error', new Error('late failure'))
    await settle()
    watcherHarness.startupErrors.push(new Error('rewatch failed'))
    watcher().emitter.emit('error', new Error('another late failure'))
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeDefined()
  })

  it('contains a watcher close failure while rewatching', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    await mkdir(root)
    await writeCommand(root, 'go', 'Execute the plan')
    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()
    watcherHarness.closeErrors = 1

    await rm(root, { recursive: true, force: true })
    watcher().emitter.emit('unlinkDir', root)
    await settle()
    expect(ctx.commands.find(agent, 'go')).toBeUndefined()
    expect(watcherHarness.watchFiles).toHaveLength(1)
  })

  it('preserves a symlinked root when link following is disabled', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dsh-commands-fs-link-target-'))
    const aliasParent = await mkdtemp(join(tmpdir(), 'dsh-commands-fs-link-alias-'))
    try {
      const root = join(aliasParent, 'commands')
      await symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir')
      await writeCommand(target, 'linked', 'Linked command')
      const ctx = new Context()
      await ctx.plugin(CommandRuntime)
      provider = new CommandsFilesystemProvider(ctx, {
        dshHome: aliasParent,
        watchFollowSymlinks: false,
      })
      await provider.ready
      const session = Session.create(SessionId('commands-filesystem-link-test'))
      const agent = {
        session,
        status: 'idle',
        options: {},
        steer: vi.fn(),
      } as unknown as Agent
      expect(ctx.commands.find(agent, 'linked')?.description).toBe('Linked command')
      expect(watcherHarness.watchers[0]?.path).toBe(root)
      await provider?.dispose()
      provider = undefined
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it('unregisters nothing when an empty root disappears', async () => {
    const { ctx, agent } = await harness()
    const root = join(home!, 'commands')
    await mkdir(root)
    for (const control of watcherHarness.watchFiles) control.listener({} as Stats, {} as Stats)
    await settle()
    expect(ctx.commands.list(agent)).toEqual([])

    await rm(root, { recursive: true, force: true })
    watcher().emitter.emit('unlinkDir', root)
    await settle()
    expect(ctx.commands.list(agent)).toEqual([])
    expect(watcherHarness.watchFiles).toHaveLength(1)
  })

  it('keeps static discovery when watch is disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    home = await mkdtemp(join(tmpdir(), 'dsh-commands-fs-nowatch-'))
    const root = join(home, 'commands')
    await mkdir(root)
    await writeCommand(root, 'go', 'Execute the plan')
    provider = new CommandsFilesystemProvider(ctx, { dshHome: home, watch: false })
    await provider.ready

    const session = Session.create(SessionId('commands-filesystem-nowatch-test'))
    const agent = {
      session,
      status: 'idle',
      options: {},
      steer: vi.fn(),
    } as unknown as Agent
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')
    expect(watcherHarness.watchers).toHaveLength(0)
    expect(watcherHarness.watchFiles).toHaveLength(0)
  })

  it('keeps static discovery when the watcher fails to start', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    home = await mkdtemp(join(tmpdir(), 'dsh-commands-fs-watcherror-'))
    const root = join(home, 'commands')
    await mkdir(root)
    await writeCommand(root, 'go', 'Execute the plan')
    watcherHarness.startupErrors.push(new Error('watch failed'))
    provider = new CommandsFilesystemProvider(ctx, { dshHome: home })
    await provider.ready

    const session = Session.create(SessionId('commands-filesystem-watcherror-test'))
    const agent = {
      session,
      status: 'idle',
      options: {},
      steer: vi.fn(),
    } as unknown as Agent
    expect(ctx.commands.find(agent, 'go')?.description).toBe('Execute the plan')
    expect(watcherHarness.watchers[0]).toBeDefined()
  })
})
