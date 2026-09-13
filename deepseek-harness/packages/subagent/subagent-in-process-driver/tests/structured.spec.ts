import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-system-prompt'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Config as ToolConfig, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'
import {
  STRUCTURED_OUTPUT_TOOL,
} from '../src/structured.ts'

const testToolSignal = new AbortController().signal

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

interface CodeRunRequestLike {
  bindings: { global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }[]
}

interface SetupOptions {
  toolMode?: ToolConfig['mode']
  codeRun?: (request: CodeRunRequestLike) => Promise<{ logs: never[]; value?: unknown }>
}

const SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: { answer: { type: 'number' }, note: { type: 'string' } },
  required: ['answer'],
}

/**
 * Real loop, scripted model, and inline fresh-conversation provider over the shared driver. Loading
 * spawn/fork here would create a dev-dependency cycle; their specs cover plugin integration while
 * this fixture isolates driver behavior and scripts the child's `structured_output` calls.
 */
async function setup(script: Script, options: SetupOptions = {}) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx, {
    tools: { mode: options.toolMode ?? 'native' },
  })
  if (options.toolMode === 'ptc' || options.toolMode === 'both') {
    ctx.provide('codeRuntime', {
      language: 'typescript',
      isolation: 'test',
      run: options.codeRun ?? (() => Promise.resolve({ logs: [] })),
    } as never)
  }
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  const disposeProvider = ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: (request: ResolvedSubagentStartRequest) => startInProcessRun(request, {}),
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter, disposeProvider }
}

function structuredRequest(parent: SubagentStartRequest['parent'], extra?: Partial<SubagentStartRequest>): SubagentStartRequest {
  return {
    label: 'produce the answer',
    prompt: [{ type: 'text', text: 'produce the answer' }],
    parent,
    signal: new AbortController().signal,
    outputSchema: SCHEMA,
    ...extra,
  }
}

describe('in-process structured output', () => {
  it('a cancel landing after a clean capture-less turn settles aborted, not error', async () => {
    const { ctx, parent } = await setup([textResponse('prose, no capture')])
    const controller = new AbortController()
    const run = await ctx.subagents.start('spawn', structuredRequest(parent, { signal: controller.signal }))
    // Cancel synchronously inside the turn's end recording: the cancel
    // contract outranks the schema shortfall, so the result maps to aborted.
    ctx.on('session/event', (session, event) => {
      const child = ctx.agents.get(run.id)
      if (session === child?.session && event.type === 'turn/end') controller.abort('cancelled at turn end')
    })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('rejects a schema outside the subset loud, before any child exists', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.start('spawn', structuredRequest(parent, {
      outputSchema: { type: 'object', oneOf: [] } as unknown as ObjectJsonSchema,
    }))).rejects.toThrow(/unsupported JSON schema/)
    expect(ctx.agents.get(SessionId('parent'))).toBeDefined()
  })

  it('a schema carrying non-JSON values fails as JsonSchemaError at the validation boundary', async () => {
    const { ctx, parent } = await setup([])
    // Semantic assertion runs before provider startup.
    await expect(ctx.subagents.start('spawn', structuredRequest(parent, {
      outputSchema: { type: 'object', default: () => {} } as unknown as ObjectJsonSchema,
    }))).rejects.toThrow(/unsupported JSON schema.*annotation must be lossless JSON data/)
  })

  it('a structured_output call from an agent WITHOUT a structured run is UNKNOWN_TOOL (the tool does not exist for it)', async () => {
    const { ctx, parent } = await setup([])
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('a structured_output call with NO calling agent at all is UNKNOWN_TOOL', async () => {
    const { ctx } = await setup([])
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('a failed execution stage is discarded and never promoted by a later call', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
    ])
    const run = await ctx.subagents.start('spawn', structuredRequest(parent))
    // A prepended post-execute listener blocks the first capture without
    // delegating. The final-result notification discards that execution's
    // stage when it observes the error.
    let blocks = 1
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && blocks > 0) {
        blocks -= 1
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'rejected' }] })
      }
      return next()
    }, { prepend: true })
    const result = await run.result
    const child = ctx.agents.get(run.id)!
    // The blocked capture must NOT surface as structured success…
    expect(result.stopReason).toBe('error')
    expect(result.structured).toBeUndefined()
    // …and a LATER invalid call (its own body staged nothing) must not
    // resurrect c1's discarded value: drive the pipeline directly.
    const invalid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c2' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 'not-a-number' },
      agent: child,
    })
    expect(invalid.isError).toBe(true)
    // A fresh valid call still captures ITS OWN value.
    const valid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c3' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 9 },
      agent: child,
    })
    expect(valid.isError).toBeFalsy()
    await run.dispose()
  })

  it('reusing a failed execution\'s call id never promotes its discarded stage', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
    ])
    const run = await ctx.subagents.start('spawn', structuredRequest(parent))
    // Block the first capture after its body stages a value. Its final error
    // discards that execution's stage.
    let blocks = 1
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && blocks > 0) {
        blocks -= 1
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'rejected' }] })
      }
      return next()
    }, { prepend: true })
    await run.result
    const child = ctx.agents.get(run.id)!
    // A SECOND capture call with the SAME call id whose body never stages
    // (invalid args throw before the stage): the discarded value must not ride
    // its acceptance.
    const reused = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 'not-a-number' },
      agent: child,
    })
    expect(reused.isError).toBe(true)
    // Nothing was ever committed: a fresh valid call is still required.
    const valid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 5 },
      agent: child,
    })
    expect(valid.isError).toBeFalsy()
    await run.dispose()
  })

  it('a pre-execute deny with call-id reuse cannot promote another execution\'s stage', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
    ])
    const run = await ctx.subagents.start('spawn', structuredRequest(parent))
    // Discard the first capture's stage via a final post-execute block.
    let blocks = 1
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && blocks > 0) {
        blocks -= 1
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'rejected' }] })
      }
      return next()
    }, { prepend: true })
    await run.result
    const child = ctx.agents.get(run.id)!
    // A prepended pre-execute deny skips the body, while the denied call still
    // reaches the final notification with the same adapter-minted call id.
    const offDeny = ctx.on('tools/pre-execute', (exec) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL) {
        return Promise.resolve({ kind: 'deny' as const, reason: 'outer veto' })
      }
      return undefined as never
    }, { prepend: true })
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 2 },
      agent: child,
    })
    expect(denied.isError).toBe(true)
    offDeny()
    // The discarded value was never promoted: a fresh valid call is required
    // (and succeeds, proving the runtime is not wedged).
    const valid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 5 },
      agent: child,
    })
    expect(valid.isError).toBeFalsy()
    await run.dispose()
  })
})
