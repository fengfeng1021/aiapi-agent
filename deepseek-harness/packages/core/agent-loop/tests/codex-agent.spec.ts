import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CodexLoopAgent } from '../src/codex-agent.ts'
import { findCodexBinary } from '../src/codex-server.ts'

async function setupHarness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { engine: 'codex', agents: [] })
  return ctx
}

describe('CodexLoopAgent Integration', () => {
  it('locates valid codex/aiapi binary', () => {
    const bin = findCodexBinary()
    expect(bin).toBeDefined()
    expect(bin.length).toBeGreaterThan(0)
  })

  it('instantiates CodexLoopAgent as default engine under AgentLoop', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-test-session-1'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    expect(handle.agent).toBeInstanceOf(CodexLoopAgent)
    expect(handle.agent.id).toBe('codex-test-session-1')
    expect(handle.agent.status).toBe('idle')
    await handle.dispose()
  })

  it('runs a live turn through Codex App-Server and records SessionEvents', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-test-session-2'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })

    const agent = handle.agent
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Respond with only the single word: "READY"' }],
        source: { kind: 'user' },
      }),
    )

    await agent.whenIdle()

    const eventTypes = agent.session.events.map((e) => e.type)
    expect(eventTypes).toContain('turn/start')
    expect(eventTypes).toContain('step/start')
    expect(eventTypes).toContain('user/message')
    expect(eventTypes).toContain('assistant/chunk')
    expect(eventTypes).toContain('assistant/message')
    expect(eventTypes).toContain('step/end')
    expect(eventTypes).toContain('turn/end')

    // Verify assistant message content and token usage
    const assistantMsg = agent.session.events.find((e) => e.type === 'assistant/message')
    expect(assistantMsg).toBeDefined()
    if (assistantMsg && assistantMsg.type === 'assistant/message') {
      const textBlock = assistantMsg.data.message.content.find((b) => b.type === 'text')
      expect(textBlock).toBeDefined()
      expect(textBlock?.type === 'text' && textBlock.text).toContain('READY')
      expect(assistantMsg.data.usage).toBeDefined()
      expect(assistantMsg.data.usage?.outputTokens).toBeGreaterThanOrEqual(1)
    }

    await handle.dispose()
  }, 30000)

  it('handles cancellation gracefully', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-test-session-3'),
      agentOptions: { provider: 'aiapi', model: 'gpt-5.1-codex-mini' },
    })

    const agent = handle.agent
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Count from 1 to 1000 slowly with long explanations' }],
        source: { kind: 'user' },
      }),
    )

    // Cancel shortly after dispatch
    setTimeout(() => {
      agent.cancel({ kind: 'user' })
    }, 100)

    await agent.whenIdle()

    const eventTypes = agent.session.events.map((e) => e.type)
    expect(eventTypes).toContain('turn/start')
    expect(eventTypes).toContain('turn/end')

    await handle.dispose()
  }, 30000)
})
