import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { getCodexAppServerDaemon } from '../src/codex-server.ts'
import type { CodexTurnHandlers } from '../src/codex-server.ts'

async function setupHarness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function userText(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('CodexLoopAgent per-round steps', () => {
  it('settles each model→tools round with its own step and message in time order', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-round-steps'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-rounds')
      vi.spyOn(daemon, 'startTurn').mockImplementation(async (_threadId, _inputs, handlers: CodexTurnHandlers) => {
        handlers.onAgentMessageDelta?.('text one ', 'm1')
        handlers.onItemStarted?.({ type: 'commandExecution', id: 'c1', command: 'ls' }, 'c1')
        handlers.onItemCompleted?.({
          type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'out', exitCode: 0,
        }, 'c1')
        handlers.onAgentMessageDelta?.('text two', 'm2')
        return {
          status: 'completed',
          items: [],
          finalMessageText: 'text two',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }
      })

      handle.agent.followup(userText('hi'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      const types = events.map(e => e.type)
      // One step per round: text round, then the post-tool text round.
      expect(types.filter(t => t === 'step/start')).toHaveLength(2)
      expect(types.filter(t => t === 'step/end')).toHaveLength(2)

      const messages = events.filter(e => e.type === 'assistant/message')
      expect(messages).toHaveLength(2)
      const [first, second] = messages.map(e =>
        e.type === 'assistant/message' ? e.data : undefined,
      )
      expect(first?.turn).toBe(1)
      expect(second?.turn).toBe(1)

      const textOf = (data: typeof first): string =>
        (data?.message.content ?? []).filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
      expect(textOf(first)).toBe('text one ')
      expect(textOf(second)).toBe('text two')
      // Only the closing round carries token accounting: the earlier round's
      // message carries no usage key at all.
      expect(first?.usage).toBeUndefined()
      expect(second?.usage).toBeDefined()

      // Time order: round-one message, then the tool rows, then round two.
      const indexOf = (type: string, at: number): number => {
        let seen = -1
        return events.findIndex(e => e.type === type && (seen += 1) === at)
      }
      const msg1 = indexOf('assistant/message', 0)
      const toolCall = indexOf('tool/call', 0)
      const toolResult = indexOf('tool/result', 0)
      const msg2 = indexOf('assistant/message', 1)
      expect(msg1).toBeGreaterThanOrEqual(0)
      expect(toolCall).toBeGreaterThan(msg1)
      expect(toolResult).toBeGreaterThan(toolCall)
      expect(msg2).toBeGreaterThan(toolResult)

      // Rounds own their steps: message one and the tools share step 1.
      const stepOf = (index: number): unknown =>
        (events[index] as { data?: { step?: unknown } } | undefined)?.data?.step
      expect(stepOf(msg1)).toBe(1)
      expect(stepOf(toolCall)).toBe(1)
      expect(stepOf(msg2)).toBe(2)
    } finally {
      await handle.dispose()
    }
  })

  it('leaves tool-only rounds without an empty message', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-tool-only-round'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-tool-only')
      vi.spyOn(daemon, 'startTurn').mockImplementation(async (_threadId, _inputs, handlers: CodexTurnHandlers) => {
        handlers.onItemStarted?.({ type: 'commandExecution', id: 'c1', command: 'ls' }, 'c1')
        handlers.onItemCompleted?.({
          type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'out', exitCode: 0,
        }, 'c1')
        return { status: 'completed', items: [] }
      })

      handle.agent.followup(userText('hi'))
      await handle.agent.whenIdle()

      const events = handle.agent.session.events
      // No prose anywhere: no round message and no second step.
      expect(events.filter(e => e.type === 'assistant/message')).toHaveLength(0)
      expect(events.filter(e => e.type === 'step/start')).toHaveLength(1)
      expect(events.filter(e => e.type === 'step/end')).toHaveLength(1)
      expect(events.filter(e => e.type === 'tool/call')).toHaveLength(1)
    } finally {
      await handle.dispose()
    }
  })
})
