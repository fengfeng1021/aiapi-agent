import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentRuntime, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as fork from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

function start(ctx: Context, provider: string, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return ctx.subagents.start(provider, { signal: request.signal ?? new AbortController().signal, ...request })
}

/**
 * Drives the REAL fork backend with a real loop + scripted mock MODEL + the
 * real invariant service and package companions. The session contribution replays a seeded child log on
 * `session/created`, so a malformed (unbalanced) fork seed makes these tests
 * THROW — that is the regression guard for the completed-turn-prefix boundary.
 */
async function setup(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(fork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

describe('dsh-subagent-fork-in-process', () => {
  it('emits subagent/start only after the seeded child is published', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    let childAtStart: ReturnType<typeof ctx.agents.get>
    ctx.on('subagent/start', (info) => {
      if (info.provider === 'fork') childAtStart = ctx.agents.get(info.id)
    })

    const starting = start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    expect(childAtStart).toBeUndefined()
    const run = await starting
    expect(childAtStart).toBe(ctx.agents.get(run.id))
    expect(childAtStart?.id).toBe(run.id)

    await run.result
    await run.dispose()
  })

  it('seeds every completed parent turn through the last turn/end', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second'), textResponse('child')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentPrefixLen = parent.session.events.length

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.seedLength).toBe(parentPrefixLen)
    expect(child.session.events.slice(0, parentPrefixLen).at(-1)?.type).toBe('turn/end')
    expect(child.session.events.slice(0, parentPrefixLen).filter(e => e.type === 'turn/end')).toHaveLength(2)
    await run.dispose()
  })

  it('advertises every start-time capability', async () => {
    const { ctx } = await setup([])
    expect(ctx.subagents.getProvider('fork')!.capabilities).toEqual({
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(fork, { providerName: 'fork' })
    expect(ctx.subagents.list()).toEqual(['fork'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('contributes the completed-turn prefix as a continuable child\'s seed', async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('child answer')])
    const provider = ctx.subagents.getProvider('fork')!
    const signal = new AbortController().signal

    // Before any completed parent turn there is nothing to inherit, so the
    // child starts fresh rather than carrying an empty seed.
    const fresh = await provider.prepareContinuable!({
      sessionId: SessionId('continuable-fresh'),
      parent,
      signal,
    })
    expect(fresh.seed).toBeUndefined()

    // Complete one parent turn, then the prefix is captured once at creation.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const seeded = await provider.prepareContinuable!({
      sessionId: SessionId('continuable-seeded'),
      parent,
      signal,
    })
    expect(seeded.seed).toBeDefined()
    const lastSeeded = seeded.seed!.at(-1)
    // The seed ends at a completed turn, so it replays as a valid child log.
    expect(lastSeeded?.type).toBe('turn/end')
    expect(seeded.seed!.map(event => event.seq)).toEqual(seeded.seed!.map((_event, index) => index))
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in fork).toBe(false)
    expect(fork.name).toBe('subagent-fork-in-process')
    expect(fork.inject).toEqual(['subagents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(fork) as Record<string, unknown>
    expect(unwrapped).toBe(fork)
    expect(unwrapped.name).toBe('subagent-fork-in-process')
    expect(unwrapped.inject).toEqual(['subagents'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
