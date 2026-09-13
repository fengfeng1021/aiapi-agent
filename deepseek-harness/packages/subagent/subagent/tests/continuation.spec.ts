import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import type { GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, {
  SubagentError,
  SUBAGENT_DESCRIPTOR_VERSION,
} from '../src/index.ts'
import type { SubagentRunEndInfo, SubagentRunInfo } from '../src/index.ts'
import * as SubagentInvariant from '../src/invariant.ts'
import { TestSessionQuery } from './test-session-query.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

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

// Each persistence-backed temp root cleans up by closing its handle before
// removing the directory: Windows rmSync over a dir holding a still-open handle
// fails with EPERM.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'temp-root cleanup failed')
})

/** Boot the full continuable stack: loop, persistence, providers, and subagents. */
async function setupWith(
  adapter: LlmAdapter,
  options: { persistence?: boolean; sessionQuery?: boolean } = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // The registry is a required injection of AgentLoop and SubagentRuntime
  // (both register projection units on activation).
  await ctx.plugin(SessionProjectionRegistry)
  let disposePersistence: (() => Promise<void>) | undefined
  let root: string | undefined
  if (options.persistence !== false) {
    root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    const persistedRoot = root
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    disposePersistence = () => persistenceFiber.dispose()
    cleanups.push(async () => {
      await persistenceFiber.dispose()
      rmSync(persistedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.sessionQuery !== false) await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, disposePersistence, root }
}

async function setup(script: Script, options: { persistence?: boolean } = {}) {
  const adapter = new MockAdapter(script)
  const booted = await setupWith(adapter, options)
  return { ...booted, adapter }
}

const testSignal = new AbortController().signal

function startSpec(parent: Agent, provider = 'spawn', signal: AbortSignal = testSignal) {
  return {
    provider,
    label: 'child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal,
  }
}

function message(text: string) {
  return [{ type: 'text' as const, text }]
}

function hasUserText(events: readonly SessionEvent[], text: string): boolean {
  return events.some(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === text))
}

/** Caller-supplied user message texts in log order (runtime-context snapshots excluded). */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

function followup(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  content: ReturnType<typeof message>,
  signal: AbortSignal = testSignal,
) {
  return ctx.subagents.followup(parent, childId, content, {
    source: { kind: 'user' },
    signal,
  })
}

/**
 * Exercise manager-wide teardown through the package-private owner rather than
 * adding the irreversible operation to the public service contract.
 */
function drainManager(ctx: Context): Promise<void> {
  const manager = (ctx.subagents as unknown as {
    continuations?: { drain(): Promise<void> }
  }).continuations
  if (manager === undefined) throw new Error('expected a bound continuation manager')
  return manager.drain()
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

/**
 * Keep the top-level test parent out of a scripted model corpus. Every child
 * settlement wakes its parent, so a suite that scripts only child responses
 * would otherwise spend them on the parent's own turns.
 */
function parkParent(ctx: Context, parent: Agent): void {
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
}

/** Observe calls at the Agent cancellation boundary without a production event. */
function observeCancel(agent: Agent, callback: () => void): void {
  const cancel = agent.cancel.bind(agent)
  let observed = false
  vi.spyOn(agent, 'cancel').mockImplementation((cause, options) => {
    if (!observed) {
      observed = true
      callback()
    }
    cancel(cause, options)
  })
}

describe('SubagentRuntime.startContinuable', () => {
  it('returns both identities at inbox acceptance, without waiting for the turn or the log', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('first answer')])
    const enqueued: { id: MessageId; loggedYet: boolean }[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // Acceptance is the boundary `startContinuable` resolves at, so observe
      // the log state exactly there rather than after later microtasks.
      enqueued.push({ id: message.id, loggedYet: hasUserText(agent.session.events, 'child task') })
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))

    expect(started.childId).toMatch(/[0-9a-f-]{36}/)
    // The returned id is exactly the accepted inbox message's id, and nothing
    // was logged or requested to earn it.
    expect(enqueued).toEqual([{ id: started.messageId, loggedYet: false }])
    expect(adapter.requests).toEqual([])

    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'child task')).toBe(true)
  })

  it('rejects without ids when the provider has no prepareContinuable capability', async () => {
    const { ctx, parent } = await setup([])
    const start = vi.fn(async () => { throw new Error('must not dispatch') })
    ctx.subagents.registerProvider({
      name: 'one-shot',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start,
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'one-shot')))
      .rejects.toThrow(/does not support continuable children/)
    expect(start).not.toHaveBeenCalled()
    // No child Agent and no session were created.
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects synchronously when persistence is not configured', async () => {
    const { ctx, parent } = await setup([textResponse('unused')], { persistence: false })
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow(/require session persistence/)
  })

  it('publishes the reserved child id and appends the pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptorIndex = loaded.events.findIndex(event => event.type === 'subagent/descriptor')
    const turnStartIndex = loaded.events.findIndex(event => event.type === 'turn/start')
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(descriptorIndex).toBeLessThan(turnStartIndex)
    const descriptor = loaded.events[descriptorIndex] as SessionEvent<'subagent/descriptor'>
    expect(descriptor.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'child task',
      agentProvider: 'mock',
      agentModel: 'mock',
    })
    // Model-hidden: the descriptor never carries surface metadata.
    expect('surfaceOp' in descriptor).toBe(false)
    expect(loaded.meta.id).toBe(started.childId)
    expect(loaded.meta.parentSession).toBe(SessionId('parent'))
    expect(loaded.meta.origin).toBe('subagent')
  })

  it('persists a selected reasoning effort and reapplies it on cold resume', async () => {
    const effort = ReasoningEffortId('max')
    const adapter = new MockAdapter([
      textResponse('first answer'),
      textResponse('resumed answer'),
    ], {
      efforts: [{ id: effort, name: 'Max' }],
      defaultEffort: effort,
    })
    const { ctx, parent } = await setupWith(adapter)
    parkParent(ctx, parent)
    const childEfforts: Array<string | undefined> = []
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) childEfforts.push(agent.options.reasoningEffort)
    })

    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('selected reasoning'),
        parent,
        agentOptions: { reasoningEffort: effort },
      },
    })
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.events.find(event => event.type === 'subagent/descriptor')?.data)
      .toMatchObject({ agentReasoningEffort: 'max' })

    await followup(ctx, parent, started.childId, message('resume selected reasoning'))
    await waitNoActivation(ctx, started.childId)
    expect(childEfforts).toEqual(['max', 'max'])
  })

  it('rolls the child back completely when the caller signal aborts before acceptance', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const controller = new AbortController()
    // Abort inside the child's creation window: setup runs before publication.
    ctx.on('agent/created', ({ agent: child }) => {
      if (child !== parent) controller.abort('caller gave up')
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'spawn', controller.signal)))
      .rejects.toThrow()
    // No Activation, no live child Agent, and no parent ownership remains.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it('rolls the child back when the signal aborts between publication and acceptance', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const controller = new AbortController()
    // `subagent/start` fires once the epoch is resident, before the prompt is
    // submitted, so cancelling here lands squarely in the handoff window.
    ctx.on('subagent/start', () => { controller.abort('caller gave up') })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'spawn', controller.signal)))
      .rejects.toThrow()

    // No resident child and no queued turn survive the abort.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it('rolls an unpublished Activation back when lifecycle publication fails', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))
    ctx.on('internal/dispatch', (_mode, eventName) => {
      if (eventName === 'subagent/start') throw new Error('start publication failed')
    }, { global: true })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow(/start publication failed/)

    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
    expect(ends).toEqual([])
    await expect(drainManager(ctx)).resolves.toBeUndefined()
  })

  it('rejects a continuable child that would exceed the configured depth cap', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: 0 },
    })).rejects.toThrow(/exceeds maxDepth 0/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects an invalid continuable depth cap before provider preparation', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: Number.NaN },
    })).rejects.toThrow(/non-negative safe integer/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('omits undeclared composition fields from the descriptor', async () => {
    const { ctx } = await setup([])
    // A routeless parent declares no provider/model, and this start declares no
    // persona or tool filter, so the descriptor records only what exists.
    const routeless = ctx.agentLoop.create(SessionId('routeless'), {})
    const started = await ctx.subagents.startContinuable(startSpec(routeless))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const descriptor = child.session.events.find(event => event.type === 'subagent/descriptor')

    expect(descriptor?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'child task',
    })
    await drainManager(ctx)
  })

  it('records a declared tool filter in the descriptor', async () => {
    const { ctx } = await setup([])
    // Register one global tool so the filter names something real.
    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: 'noop' }],
      },
      execute: () => Promise.resolve({}),
    }))
    const routeless = ctx.agentLoop.create(SessionId('routeless-filtered'), {})
    const started = await ctx.subagents.startContinuable({
      ...startSpec(routeless),
      request: { prompt: message('filtered work'), parent: routeless, toolFilter: { deny: ['noop'] } },
    })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    expect(child.session.events.find(event => event.type === 'subagent/descriptor')?.data)
      .toEqual({
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'continuable',
        provider: 'spawn',
        label: 'child task',
        toolFilter: { deny: ['noop'] },
      })
    await drainManager(ctx)
  })

  it('continues turn numbering after an inherited fork prefix and pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([
      textResponse('parent turn'),
      textResponse('forked child'),
    ])
    // Complete one parent turn so fork has a prefix to contribute.
    parent.followup(createUserMessage({ content: message('parent work'), source: { kind: 'user' } }))
    await parent.whenIdle()

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptorIndex = loaded.events.findIndex(event => event.type === 'subagent/descriptor')
    const childTurn = loaded.events.slice(descriptorIndex + 1)
      .find(event => event.type === 'turn/start')
    // The first child turn after the descriptor continues the inherited prefix
    // rather than restarting at 1, so the replayed child log stays balanced.
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(childTurn?.type === 'turn/start' && childTurn.data.turn).toBe(2)
    expect(loaded.meta.seedLength).toBeGreaterThan(0)
  })

  it('records the declared persona in the descriptor and reapplies it on cold resume', async () => {
    const { ctx, parent } = await setup([textResponse('scoped'), textResponse('resumed')])
    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('scoped work'),
        parent,
        persona: 'You are scoped.',
      },
    })
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = loaded.events.find(event => event.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ persona: 'You are scoped.' })

    // Cold resume reconstructs the declared composition from that descriptor.
    await followup(ctx, parent, started.childId, message('resume it'))
    await waitNoActivation(ctx, started.childId)
    const resumed = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(resumed.events, 'resume it')).toBe(true)
  })
})

describe('continuable image follow-ups', () => {
  const imageBlock = {
    type: 'image' as const,
    attachment: {
      attachmentId: 'att-1' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
    },
  }

  it('refuses an image follow-up when the child model declines image input, leaving no partial message', async () => {
    const { ctx, parent } = await setup([textResponse('child work')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo')
      .mockResolvedValue({ inputModalities: ['text'] } as never)

    await expect(ctx.subagents.followup(parent, started.childId, [
      { type: 'text' as const, text: 'see this' },
      imageBlock,
    ], { source: { kind: 'user' }, signal: testSignal }))
      .rejects.toMatchObject({ code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })

    expect(resolve).toHaveBeenCalledWith('mock', 'mock', testSignal)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'see this')).toBe(false)
    await drainManager(ctx)
  })

  it('rejects a materialized image follow-up whose capability read raced a drain', async () => {
    const { ctx, parent } = await setup([textResponse('child work')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const capability = Promise.withResolvers<{ inputModalities: string[] }>()
    const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo').mockReturnValue(capability.promise as never)

    const delivery = ctx.subagents.followup(parent, started.childId, [imageBlock], {
      source: { kind: 'user' }, signal: testSignal,
    })
    delivery.catch(() => undefined)
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalled() })
    const draining = drainManager(ctx)
    capability.resolve({ inputModalities: ['text', 'image'] })

    await expect(delivery).rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await draining
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'image'))).toBe(false)
  })

})

describe('SubagentRuntime.followup residency routing', () => {
  it('fails a cold follow-up when Session query is unavailable', async () => {
    const { ctx, parent } = await setupWith(new MockAdapter([]), {
      persistence: false,
      sessionQuery: false,
    })

    await expect(followup(ctx, parent, SessionId('cold-without-query'), message('continue')))
      .rejects.toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' })
  })

  it('cold-resumes a settled child into a new Activation', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const messageId = await followup(ctx, parent, started.childId, message('continue please'))
    expect(messageId).toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'continue please'])
    // One descriptor only: cold resume never re-seeds it.
    expect(loaded.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
  })

  it('cold-resumes after the initial provider unregisters', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SubagentInvariant)
    const disposeProvider = ctx.subagents.registerProvider({
      name: 'retired',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('one-shot start is not used') },
      prepareContinuable: () => Promise.resolve({}),
    })
    const starts: SubagentRunInfo[] = []
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/start', info => void starts.push(info))
    ctx.on('subagent/end', info => void ends.push(info))

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'retired'))
    await waitNoActivation(ctx, started.childId)
    disposeProvider()
    expect(ctx.subagents.getProvider('retired')).toBeUndefined()

    await expect(followup(ctx, parent, started.childId, message('continue without provider')))
      .resolves.toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })

    expect(starts.map(info => info.provider)).toEqual(['retired', 'retired'])
    expect(ends.map(info => info.runId)).toEqual(starts.map(info => info.runId))
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'continue without provider'])
  })

  it('rejects a parent that is not the durable direct parent', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    await expect(followup(ctx, stranger, started.childId, message('mine now')))
      .rejects.toThrow(/belongs to another parent session/)
  })

  it('reports an unresumable child whose persisted log has no supported descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    // A one-shot child has durable identity but no supported continuation state.
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    await run.result
    await ctx.sessions.flush(run.localAgent!.session)
    const oneShotId = run.id
    await run.dispose()

    await expect(followup(ctx, parent, oneShotId, message('continue')))
      .rejects.toThrow(/no supported continuation state/)
  })

  it('reports an unknown child id as unavailable', async () => {
    const { ctx, parent } = await setup([])
    await expect(followup(ctx, parent, SessionId('missing'), message('hello')))
      .rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
  })

  it('propagates cancellation while inspecting a cold child', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const inspectStarted = Promise.withResolvers<undefined>()
    const inspect = vi.spyOn(ctx.sessionPersistence, 'borrowSession').mockImplementation((_id, signal) => {
      return new Promise<never>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error('cold inspection must receive the followup signal'))
          return
        }
        inspectStarted.resolve(undefined)
        signal.addEventListener('abort', () => {
          reject(reason)
        }, { once: true })
      })
    })
    const controller = new AbortController()
    const reason = new Error('cold inspection cancelled')

    try {
      const delivery = followup(ctx, parent, started.childId, message('cancel me'), controller.signal)
      await inspectStarted.promise
      controller.abort(reason)
      await expect(delivery).rejects.toBe(reason)
    } finally {
      inspect.mockRestore()
    }
  })

  it('preserves a SubagentError raised while cold-materializing a child', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const failure = new SubagentError('materialization denied', 'UNAUTHORIZED')
    ctx.agents.resume = () => Promise.reject(failure)

    await expect(followup(ctx, parent, started.childId, message('continue')))
      .rejects.toBe(failure)
  })

  it('cold-resumes a delivery that lost the race with final disposal', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after the race')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Deliver in the same tick the settlement watcher opens its transaction:
    // exactly one side wins the cutoff. A delivery that loses awaits release and
    // cold-resumes rather than reaching a handle being torn down.
    const delivery = child.whenIdle().then(() =>
      followup(ctx, parent, started.childId, message('raced')))

    await expect(delivery).resolves.toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'raced')).toBe(true)
  })
})

describe('continuable child ownership', () => {
  it('does not add a top-level parent to the waiting graph', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    // The top-level parent remains independently registered after its child settles.
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })
})

describe('continuable durability and teardown', () => {
  it('disposes every live Activation forest child-first on manager teardown', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })

    const disposals: SessionId[] = []
    ctx.on('agent/disposed', ({ agent }) => { disposals.push(agent.id) })
    const drained = drainManager(ctx)
    // Let the held model call observe its cancellation so quiescence can settle.
    hold.resolve(undefined)
    await drained

    // Child-first: the grandchild's disposal precedes its parent's.
    expect(disposals.indexOf(grandchild.childId)).toBeGreaterThanOrEqual(0)
    expect(disposals.indexOf(grandchild.childId))
      .toBeLessThan(disposals.indexOf(started.childId))
    // Durable sessions survive process-local teardown.
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.id).toBe(started.childId)
  })

  it('rejects selected-child teardown through a stale parent identity', async () => {
    const { ctx, parent } = await setup([])
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await expect(ctx.subagents.drainContinuableChildren(stale, []))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('awaits and rolls back an admitted materialization below a scoped root', async () => {
    const { ctx, parent } = await setup([])
    const manager = (ctx.subagents as unknown as {
      continuations: { ownerCtx: Context }
    }).continuations
    const agents = manager.ownerCtx.agents
    const create = agents.create.bind(agents)
    const published = Promise.withResolvers<SessionId>()
    const releaseMaterialization = Promise.withResolvers<undefined>()
    const createSpy = vi.spyOn(agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      published.resolve(handle.agent.id)
      await releaseMaterialization.promise
      return handle
    })

    try {
      const starting = ctx.subagents.startContinuable(startSpec(parent))
      const childId = await published.promise
      let drainResolved = false
      const drained = ctx.subagents.drainContinuableDescendants([parent]).then(() => {
        drainResolved = true
      })
      await Promise.resolve()
      expect(drainResolved).toBe(false)

      releaseMaterialization.resolve(undefined)
      await expect(starting).rejects.toMatchObject({ code: 'DRAINING' })
      await drained
      expect(ctx.agents.get(childId)).toBeUndefined()
    } finally {
      createSpy.mockRestore()
    }
  })

  it('ignores a stale scoped root without disabling its live same-id Agent', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await ctx.subagents.drainContinuableDescendants([stale])
    const started = await ctx.subagents.startContinuable(startSpec(parent))

    await waitNoActivation(ctx, started.childId)
  })

  it('rejects new materialization and delivery once draining begins', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await drainManager(ctx)

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await expect(followup(ctx, parent, started.childId, message('too late')))
      .rejects.toMatchObject({ code: 'DRAINING' })
  })

  it('rejects an initial prompt when drain starts after materialization', async () => {
    const { ctx, parent } = await setup([])
    const drains: Promise<void>[] = []
    const accepted: MessageId[] = []
    ctx.on('subagent/start', () => { drains.push(drainManager(ctx)) })
    ctx.on('agent/inbox/inserted', ({ message }) => { accepted.push(message.id) })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)

    expect(accepted).toEqual([])
    expect(ctx.agents.list()).toEqual([parent])
  })

  it('waits for a published materialization to finish rollback before drain resolves', async () => {
    const { ctx, parent } = await setup([])
    const order: string[] = []
    const drains: Promise<void>[] = []
    ctx.on('agent/created', ({ agent: child }) => {
      if (child === parent) return
      const draining = drainManager(ctx).then(() => { order.push('drain') })
      drains.push(draining)
    })
    ctx.on('agent/disposed', ({ agent: child }) => {
      if (child !== parent) order.push('disposed')
    })

    // `agent/created` runs after registry publication but before materialize()
    // receives the handle and installs the Activation.
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)

    expect(order).toEqual(['disposed', 'drain'])
    expect(ctx.agents.list()).toEqual([parent])
  })

})

describe('continuable review regressions', () => {
  it('rechecks exact parent liveness after cold-resume materialization', async () => {
    const { ctx } = await setup([textResponse('first')])
    const parentId = SessionId('replaceable-parent')
    const originalParent = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(originalParent.agent))
    await waitNoActivation(ctx, started.childId)

    const manager = (ctx.subagents as unknown as {
      continuations: { ownerCtx: Context }
    }).continuations
    const ownerAgents = manager.ownerCtx.agents
    const originalResume = ownerAgents.resume.bind(ownerAgents)
    const resumed = Promise.withResolvers<undefined>()
    const releaseResume = Promise.withResolvers<undefined>()
    const resumeSpy = vi.spyOn(ownerAgents, 'resume').mockImplementation(async (options) => {
      const handle = await originalResume(options)
      resumed.resolve(undefined)
      await releaseResume.promise
      return handle
    })

    const delivery = followup(
      ctx,
      originalParent.agent,
      started.childId,
      message('must not cross parent replacement'),
    )
    await resumed.promise
    await originalParent.dispose()
    const replacement = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    releaseResume.resolve(undefined)

    await expect(delivery).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    resumeSpy.mockRestore()
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'must not cross parent replacement')).toBe(false)
    await replacement.dispose()
  })

  it('reports handle-disposal failure on the terminal edge', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = await vi.waitFor(() => {
      const found = manager.activations.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped cleanup failed')
    }

    await expect(drainManager(ctx)).rejects.toThrow()
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Emitting before disposal would have reported this failed epoch as success.
    expect(ends[0]!.stopReason).toBe('error')
  })

  it('reports a pre-disposal teardown failure on the terminal edge', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { observer: { capture: (child: Agent) => void } }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    activation.observer.capture = () => { throw new Error('capture failed') }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('error')
  })

  it('preserves independent pre-disposal and handle-disposal failures', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, {
          handle: { dispose: () => Promise<void> }
          observer: { capture: (child: Agent) => void }
        }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.observer.capture = () => { throw new Error('capture failed') }
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped cleanup failed')
    }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    const failure = await drained.catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(String(failure)).toContain('capture failed')
    expect(String(failure)).toContain('scoped cleanup failed')
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('cancels a running turn before the best-effort final flush', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('slow'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const order: string[] = []
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) order.push('flush')
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    observeCancel(child, () => { order.push('cancel') })

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    // Flushing a still-running turn cannot cover the events cancellation adds.
    expect(order.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('cancel')).toBeLessThan(order.lastIndexOf('flush'))
  })

})

/** Every settlement notice this agent received, in order, as flat text. */
function settlementNotices(agent: Agent): { sender: string; text: string; summary: string }[] {
  const logged = agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
  return [...logged, ...agent.inbox.nextStep, ...agent.inbox.nextTurn].flatMap((message) => {
    if (message.source.kind !== 'subagent-settled') return []
    return [{
      sender: message.source.senderSessionId,
      summary: message.source.summary,
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    }]
  })
}

describe('continuable settlement delivery', () => {
  it('delivers even when the child already reported for itself', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    await ctx.subagents.reportFrom(child, message('an explicit report'), {
      delivery: 'quiet',
      signal: testSignal,
    })
    await waitNoActivation(ctx, started.childId)

    // The contract is unconditional precisely so the parent-side tool
    // description can promise it; bookkeeping "did it report?" would make the
    // promise conditional on a channel this manager does not own.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
  })

  it('withholds an outcome the harness could not durably release', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose(): Promise<void> } }> }
    }).continuations
    const activation = await vi.waitFor(() => {
      const live = manager.activations.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    const dispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await dispose()
      throw new Error('scope unwind failed')
    }

    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} failed before it finished.\nIt left no closing message.`,
    )
  })

  it('does not wake a parent whose own teardown already began', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    // Delivered and durably logged, but no turn: waking a parent the host is
    // about to dispose spends a model request nothing reads. What happens to the
    // message when that parent is disposed next is pinned by the test below.
    expect(settlementNotices(parent)).toHaveLength(1)
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )
    expect(parent.session.events.some(event => event.type === 'agent/inbox/spliced')).toBe(true)
    expect(parent.session.events.some(event => event.type === 'turn/start')).toBe(false)
    expect(parent.status).toBe('idle')
  })

  it('does not wake a parent below a scoped teardown root', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainContinuableDescendants([parent])
    hold.resolve(undefined)
    await drained

    expect(settlementNotices(parent)).toHaveLength(1)
    expect(parent.session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  it('records but cannot deliver a teardown notice once the parent is disposed too', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx } = await setupWith(adapter)
    const parentId = SessionId('closing-parent')
    const host = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    hold.resolve(undefined)
    await drained
    expect(settlementNotices(host.agent)).toHaveLength(1)

    // Disposal is a `keepInbox: false` cancel, so it durably cancels the notice
    // it never claimed. Teardown delivery therefore reaches a parent that is
    // still resident — a resumed one reads the log, not a pending message — and
    // no wording anywhere may promise otherwise.
    await host.dispose()
    const resumed = await ctx.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(settlementNotices(resumed.agent)).toEqual([])
    await resumed.dispose()
    // The account is still in the durable log: delivered, then cancelled unread.
    const persisted = await ctx.sessionPersistence.load(parentId)
    expect(persisted.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? [{ inserted: event.data.inserted.length, removed: event.data.removedCount ?? 0 }]
      : [])).toEqual([{ inserted: 1, removed: 0 }, { inserted: 0, removed: 1 }])
  })

  it('drops the notice without disturbing teardown when the parent is gone', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: releaseChild.promise }])
    const { ctx } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    const host = await ctx.agents.create({
      sessionId: SessionId('disposable-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    releaseChild.resolve(undefined)
    await host.dispose()
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(warnings).toEqual([])
  })

  it('stays silent about a child the caller was told does not exist', async () => {
    const { ctx, parent } = await setup([])
    const drains: Promise<void>[] = []
    ctx.on('subagent/start', () => { drains.push(drainManager(ctx)) })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)
    expect(settlementNotices(parent)).toEqual([])
  })
})

describe('continuable public API', () => {
  it('exposes no host authority, residency query, cancellation, steering, or report operation', async () => {
    const { ctx } = await setup([])
    const subagents: Record<string, unknown> = ctx.subagents as unknown as Record<string, unknown>
    for (const absent of [
      'activationState',
      'cancel',
      'kill',
      'report',
      'resume',
      'steer',
      'steerContinuable',
      'userAuthority',
    ]) {
      expect(subagents[absent]).toBeUndefined()
    }
    // No steering tool and no report tool are registered by this seam.
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('report')
    expect(names).not.toContain('steer_subagent')
  })

  it('keeps one-shot runs free of a steering capability', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    expect('steer' in run).toBe(false)
    await run.result
    await run.dispose()
  })

  it('reports a caller-signal abort before acceptance without delivering', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const controller = new AbortController()
    controller.abort('caller gave up')
    await expect(followup(ctx, parent, started.childId, message('aborted'), controller.signal))
      .rejects.toThrow()

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'aborted')).toBe(false)
  })

})

describe('continuable errors', () => {
  it('rejects a duplicate Activation at the agent registry collision boundary', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Drop the Activation without disposing the Agent, leaving the id live but
    // unmanaged. Materialization must not adopt it.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, unknown> }
    }).continuations
    manager.activations.delete(started.childId)

    await expect(followup(ctx, parent, started.childId, message('hello')))
      .rejects.toThrow(SubagentError)
    expect(ctx.agents.get(started.childId)).toBe(child)
    hold.resolve(undefined)
  })

  it('rejects a parent that is no longer the live registry entry', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // A stale parent reference: same id, not the exact live entry.
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await expect(followup(ctx, stale, started.childId, message('stale')))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    void child
  })

  it('rejects establishing a child under a parent whose disposal already began', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    // Begin the parent Activation's teardown, then try to give it a child.
    const drained = drainManager(ctx)
    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    hold.resolve(undefined)
    await drained
  })

  it('reports a failing branch after every branch settles, without pinning the rest', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })
    // Make the grandchild's own handle disposal reject: scope teardown failure
    // propagates, unlike a contained `agent/disposed` listener throw.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const branch = manager.activations.get(grandchild.childId)!
    const realDispose = branch.handle.dispose.bind(branch.handle)
    branch.handle.dispose = async () => {
      await realDispose()
      throw new Error('grandchild reap failed')
    }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    // The other branch still released, and durable sessions survive.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.id).toBe(started.childId)
  })

  it('rolls the transfer back when ownership registration fails after handle transfer', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent child'), gate: hold.promise },
      { chunks: textResponse('unused') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(outer.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Begin the would-be parent's disposal, then race a grandchild into it. The
    // handle transfers before ownership registration rejects, so the rollback
    // must leave no Activation and no live Agent behind.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { disposal: Promise<void> | undefined }> }
    }).continuations
    const before = new Set(ctx.agents.list().map(agent => agent.id))
    manager.activations.get(outer.childId)!.disposal = Promise.resolve()

    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id).filter(id => !before.has(id))).toEqual([])
    })
    hold.resolve(undefined)
  })

  it('unloading the manager drains its live activations', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child'), gate: hold.promise }])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    cleanups.push(async () => {
      await persistenceFiber.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    const serviceFiber = await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    // Manager unload uses the same drain, so no child outlives its runtime.
    const disposal = serviceFiber.dispose()
    hold.resolve(undefined)
    await disposal
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })
})

describe('SubagentRuntime.interrupt', () => {
  it('accepts absent and one-shot ids as no-ops without touching the one-shot Agent', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'ancestor', agent: parent })

    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    const oneShot = run.localAgent!
    const cancelSpy = vi.spyOn(oneShot, 'cancel')
    ctx.subagents.interrupt(run.id, { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(run.id, { kind: 'ancestor', agent: parent })
    expect(cancelSpy).not.toHaveBeenCalled()
    await run.result
    await run.dispose()
  })

  it('accepts an interrupt after natural completion', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
  })

})
