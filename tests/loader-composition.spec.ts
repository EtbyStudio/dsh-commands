import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandsFilesystem from '@etby-studio/dsh-commands'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dsh-commands real Loader composition', () => {
  it('discovers and executes a directory command through the assembled command plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-commands-loader-'))
    const dshHome = join(root, 'dsh')
    const commandsDir = join(dshHome, 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'go.md'), [
      '---',
      'description: 执行计划',
      'agent: ceo',
      '---',
      '',
      '## 流程',
      '',
      '1. 回顾计划',
      '2. 创建任务列表',
      '',
    ].join('\n'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@etby-studio/dsh-commands'",
      '  config:',
      `    dshHome: ${dshHome}`,
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@etby-studio/dsh-commands', commandsFilesystem],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const session = Session.create(SessionId('loader-commands-filesystem'))
    const steer = vi.fn()
    const agent = {
      session,
      status: 'idle',
      options: {},
      steer,
    } as unknown as Agent
    // Discovery is asynchronous behind the Loader; poll until the initial scan lands.
    await vi.waitFor(() => {
      expect(context!.commands.list(agent)).toContainEqual({
        name: 'go',
        description: '执行计划',
        input: { hint: '[message]' },
      })
    })
    const execution = await context.commands.execute(agent, '/go 目标描述', new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /go')
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Command body submitted to the model.',
    })
    const steered = steer.mock.calls[0]?.[0] as { content: { type: string; text: string }[]; source: { kind: string } }
    expect(steered.content[0]?.text).toContain('1. 回顾计划')
    expect(steered.content[0]?.text).toContain('目标描述')
    expect(steered.source).toEqual({ kind: 'user' })

    // The session log records the command lifecycle exactly as dispatched.
    expect(session.events.map(event => ({ type: event.type, data: event.data }))).toEqual([
      {
        type: 'command/run',
        data: {
          commandId: execution.commandId,
          name: 'go',
          args: ' 目标描述',
          source: { kind: 'user' },
        },
      },
      {
        type: 'command/done',
        data: {
          commandId: execution.commandId,
          kind: 'success',
          text: 'Command body submitted to the model.',
        },
      },
    ])

    // Disposing the composition closes the watcher and unregisters the command.
    await context.fiber.dispose()
  })
})
