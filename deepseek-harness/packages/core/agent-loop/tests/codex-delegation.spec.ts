import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import {
  DELEGATE_TOOL_NAME,
  delegateToolSpec,
  executeDelegation,
  parseDelegateArguments,
  type DelegateSubagents,
} from '../src/codex-delegation.ts'

const PARENT = { id: 'parent-session' } as unknown as Agent

function textResult(text: string, stopReason: SubagentResult['stopReason'] = 'completed'): SubagentResult {
  return {
    output: text === '' ? [] : [{ type: 'text', text } as ContentBlock],
    stopReason,
  }
}

/** Scriptable in-process subagents double: records starts, plays results. */
class FakeSubagents implements DelegateSubagents {
  readonly starts: { provider: string; request: SubagentStartRequest }[] = []
  disposals = 0
  constructor(private readonly script: (request: SubagentStartRequest) => Promise<SubagentResult>) {}

  async start(provider: string, request: SubagentStartRequest): Promise<SubagentRun> {
    this.starts.push({ provider, request })
    const outcome = await this.script(request)
    return {
      id: SessionId('child-session'),
      localAgent: undefined,
      result: Promise.resolve(outcome),
      dispose: () => {
        this.disposals += 1
        return Promise.resolve()
      },
    }
  }
}

describe('delegate tool spec', () => {
  it('publishes a single function tool with a task-first schema', () => {
    const spec = delegateToolSpec()
    expect(spec.type).toBe('function')
    expect(spec.name).toBe(DELEGATE_TOOL_NAME)
    expect(spec.inputSchema).toMatchObject({
      type: 'object',
      required: ['task'],
      additionalProperties: false,
    })
    const properties = (spec.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties).sort()).toEqual(['provider', 'task'])
    expect(properties.provider).toMatchObject({ enum: ['spawn', 'fork'] })
  })
})

describe('parseDelegateArguments', () => {
  it('defaults an omitted provider and passes fork through', () => {
    expect(parseDelegateArguments({ task: 'do X' })).toEqual({ task: 'do X' })
    expect(parseDelegateArguments({ task: 'do X', provider: 'fork' })).toEqual({ task: 'do X', provider: 'fork' })
  })

  it('rejects missing, blank, and malformed payloads', () => {
    expect(() => parseDelegateArguments({})).toThrow(/non-empty task/)
    expect(() => parseDelegateArguments({ task: '  ' })).toThrow(/non-empty task/)
    expect(() => parseDelegateArguments(null)).toThrow(/must be an object/)
    expect(() => parseDelegateArguments('task')).toThrow(/must be an object/)
    expect(() => parseDelegateArguments({ task: 'x', provider: 'teleport' })).toThrow(/unknown delegate provider/)
  })
})

describe('executeDelegation', () => {
  it('starts a spawn child by default and maps a completed run', async () => {
    const subagents = new FakeSubagents(() => Promise.resolve(textResult('child answer')))
    const result = await executeDelegation(subagents, PARENT, { task: 'do X' }, new AbortController().signal)
    expect(result).toEqual({ text: 'child answer', success: true })
    expect(subagents.starts).toHaveLength(1)
    expect(subagents.starts[0]?.provider).toBe('spawn')
    expect(subagents.starts[0]?.request.parent).toBe(PARENT)
    expect(subagents.starts[0]?.request.prompt).toEqual([{ type: 'text', text: 'do X' }])
    expect(subagents.disposals).toBe(1)
  })

  it('honors an explicit fork provider', async () => {
    const subagents = new FakeSubagents(() => Promise.resolve(textResult('ok')))
    const result = await executeDelegation(
      subagents,
      PARENT,
      { task: 'do X', provider: 'fork' },
      new AbortController().signal,
    )
    expect(result).toEqual({ text: 'ok', success: true })
    expect(subagents.starts[0]?.provider).toBe('fork')
  })

  it('maps non-completed endings to failure results without losing partial text', async () => {
    const subagents = new FakeSubagents(() => Promise.resolve(textResult('partial', 'max-tokens')))
    const result = await executeDelegation(subagents, PARENT, { task: 'do X' })
    expect(result).toEqual({ text: 'partial', success: false })
    expect(subagents.disposals).toBe(1)
  })

  it('accounts an empty failed run instead of returning blank text', async () => {
    const subagents = new FakeSubagents(() => Promise.resolve(textResult('', 'error')))
    const result = await executeDelegation(subagents, PARENT, { task: 'do X' })
    expect(result.success).toBe(false)
    expect(result.text).toContain('error')
  })

  it('maps start and result rejections to failure results', async () => {
    const refused: DelegateSubagents = {
      start: () => Promise.reject(new Error('no such provider')),
    }
    await expect(executeDelegation(refused, PARENT, { task: 'do X' }).then(result => result)).resolves.toEqual({
      text: 'subagent could not start: no such provider',
      success: false,
    })
    const broken: DelegateSubagents = {
      start: () => Promise.resolve({
        id: SessionId('child-session'),
        localAgent: undefined,
        result: Promise.reject(new Error('lost')),
        dispose: () => Promise.resolve(),
      }),
    }
    await expect(executeDelegation(broken, PARENT, { task: 'do X' }).then(result => result)).resolves.toEqual({
      text: 'subagent failed: lost',
      success: false,
    })
  })

  it('propagates caller cancellation to the run', async () => {
    const seen: AbortSignal[] = []
    const subagents: DelegateSubagents = {
      start: (_provider, request) => {
        seen.push(request.signal)
        return Promise.resolve({
          id: SessionId('child-session'),
          localAgent: undefined,
          result: new Promise<SubagentResult>((resolve) => {
            request.signal.addEventListener('abort', () => {
              resolve(textResult('', 'aborted'))
            }, { once: true })
          }),
          dispose: () => Promise.resolve(),
        })
      },
    }
    const controller = new AbortController()
    const pending = executeDelegation(subagents, PARENT, { task: 'do X' }, controller.signal)
    controller.abort()
    await expect(pending).resolves.toEqual({
      text: "subagent ended (aborted) with no output",
      success: false,
    })
    expect(seen).toHaveLength(1)
    vi.restoreAllMocks()
  })
})
