import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolRalph from '../src/index.ts'

type MockScript = ConstructorParameters<typeof MockAdapter>[0]

/** Mount the shipped Ralph execution stack around one keyless model script. */
async function mountRalph(script: MockScript, config: toolRalph.Config) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(WorkerThreadWorkflowEngine, {})
  await ctx.plugin(toolRalph, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId('ralph-parent'),
    meta: { cwd: '/tmp/ralph-shared-workspace' },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, adapter, parentHandle, parent: parentHandle.agent }
}

describe('dsh-tool-ralph over the real spawn and worker-thread stack', () => {
  it('cancels the real worker and fresh child to quiescence', { timeout: 90_000 }, async () => {
    const { ctx, parent, parentHandle } = await mountRalph(['hang'], { maxRounds: 2 })
    const children: Agent[] = []
    const outcomes: string[] = []
    let resolveChildStarted!: (child: Agent) => void
    const childStarted = new Promise<Agent>((resolve) => { resolveChildStarted = resolve })
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      if (agent !== undefined) {
        children.push(agent)
        resolveChildStarted(agent)
      }
    })
    ctx.on('workflow/agent-end', (_run, child) => { outcomes.push(child.outcome) })
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      callId: ToolCallId('ralph-real-cancel'),
      name: 'ralph',
      arguments: { objective: 'Keep working until cancelled.', maxRounds: 2 },
      agent: parent,
      signal: controller.signal,
    })
    await childStarted

    controller.abort()
    const result = await pending

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('Ralph workflow was cancelled')
    expect(outcomes).toEqual(['cancelled'])
    expect(ctx.agents.get(children[0]!.id)).toBeUndefined()
    await parentHandle.dispose()
  })
})
