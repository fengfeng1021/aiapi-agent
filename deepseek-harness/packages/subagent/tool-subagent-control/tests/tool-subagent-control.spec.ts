import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'
import { parkParent } from './park-parent.ts'
import { TestSessionQuery } from './test-session-query.ts'

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const testToolSignal = new AbortController().signal

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setupWith(adapter: MockAdapter | GatedAdapter) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-subagent-control-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  return setupWith(new MockAdapter(script))
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** Wait until a child's Activation released its handle. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('dsh-tool-subagent-control', () => {
  it('registers send_message once, globally, with the two required parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'send_message')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['message', 'subagent_id'])
    // The continuable path has no Task, so the schema must not promise one.
    expect(schemas[0]!.description).not.toContain('job_output')
    expect(schemas[0]!.description).not.toContain('job id')
    // Follow-up ordering is model-visible: it cannot redirect the open turn.
    expect(schemas[0]!.description).toContain('next turn')
  })

  it('cold-resumes a settled child and reports the queued next turn', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)

    const result = await callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'and then?',
    }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`message queued as the next turn for subagent ${started.childId}`)
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const followUp = loaded.events.findLast(event => event.type === 'user/message')
    // The durable message source records the calling agent without granting authority.
    expect(followUp?.type === 'user/message' && followUp.data.source).toEqual({
      kind: 'coordinator',
      form: 'relay',
      senderSessionId: parent.id,
    })
  })

  it('reports a delivery failure as an errored, not-delivered result', async () => {
    const { ctx, parent } = await setup([])
    const result = await callTool(ctx, 'send_message', {
      subagent_id: 'no-such-child',
      message: 'hello?',
    }, parent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unavailable')
  })

  it('rejects a caller that is not the child\'s durable direct parent', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    const result = await callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'mine now',
    }, stranger)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('another parent session')
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'send_message', { subagent_id: 'x', message: 'y' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'send_message')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'interrupt_agent')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'send_message')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'interrupt_agent')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-control')
    expect(tool.inject).toEqual(['tools', 'subagents'])
    expect(typeof tool.apply).toBe('function')
  })
})

describe('dsh-tool-subagent-control interrupt_agent', () => {
  it('registers interrupt_agent with the single agent_id parameter and current-turn wording', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'interrupt_agent')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['agent_id'])
    expect(schemas[0]!.description).toContain('current turn')
    expect(schemas[0]!.description).toContain('send_message')
  })

  it('accepts an absent target as a no-op without cold-resuming it', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settled child',
      request: { prompt: [{ type: 'text', text: 'child work' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)

    const settled = await callTool(ctx, 'interrupt_agent', { agent_id: started.childId }, parent)
    expect(settled.isError).toBe(false)
    expect(text(settled)).toBe(`interrupt requested for agent ${started.childId}`)
    const unknown = await callTool(ctx, 'interrupt_agent', { agent_id: 'no-such-agent' }, parent)
    expect(unknown.isError).toBe(false)
    // No cold resume: the settled target never rematerialized.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'interrupt_agent', { agent_id: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })
})
