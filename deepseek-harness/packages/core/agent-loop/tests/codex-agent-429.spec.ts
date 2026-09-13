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
import {
  GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS,
} from '../src/rate-limit.ts'
import { getCodexAppServerDaemon } from '../src/codex-server.ts'

const RATE_429 = 'exceeded retry limit, last status: 429 Too Many Requests, request id: a37a4c968d435ef0-PDX'

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

describe('CodexLoopAgent gateway 429 recovery', () => {
  it('backs off and completes when throttling clears', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-429-retry'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-429')
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockResolvedValueOnce({ status: 'failed', items: [], error: { message: RATE_429 } })
        .mockResolvedValueOnce({ status: 'completed', items: [], finalMessageText: 'recovered' })

      vi.useFakeTimers()
      handle.agent.followup(userText('hi'))
      await vi.advanceTimersByTimeAsync(60_000)
      await handle.agent.whenIdle()

      expect(startTurn).toHaveBeenCalledTimes(2)
      const turnEnd = handle.agent.session.events.findLast(e => e.type === 'turn/end')
      expect(turnEnd).toBeDefined()
      expect(JSON.stringify(turnEnd)).toContain('completed')
    } finally {
      vi.useRealTimers()
      await handle.dispose()
    }
  })

  it('surfaces a hinted error after the retry budget is spent', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-429-exhausted'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-429x')
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockResolvedValue({ status: 'failed', items: [], error: { message: RATE_429 } })

      vi.useFakeTimers()
      handle.agent.followup(userText('hi'))
      await vi.advanceTimersByTimeAsync(300_000)
      await handle.agent.whenIdle()

      // One initial attempt plus the bounded backoff schedule.
      expect(startTurn).toHaveBeenCalledTimes(1 + GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length)
      const events = handle.agent.session.events
      const retries = events.filter(e => e.type === 'llm/retry')
      expect(retries).toHaveLength(GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length)
      expect(retries.map(e => e.type === 'llm/retry' ? e.data.retry : -1)).toEqual([1, 2, 3, 4, 5])
      expect(events.filter(e => e.type === 'llm/retry-started')).toHaveLength(GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length)
      const turnEnd = handle.agent.session.events.findLast(e => e.type === 'turn/end')
      expect(turnEnd).toBeDefined()
      const serialized = JSON.stringify(turnEnd)
      expect(serialized).toContain('网关限流')
      expect(serialized).toContain('已自动退避重试仍失败')
      expect(serialized).toContain('a37a4c968d435ef0-PDX')
    } finally {
      vi.useRealTimers()
      await handle.dispose()
    }
  })

  it('retries a text-only partial turn and hides it through llm/retry', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-429-partial-text'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-429p')
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockImplementationOnce(async (_threadId, _inputs, handlers) => {
          handlers.onAgentMessageDelta?.('partial ', 'm1')
          return { status: 'failed', items: [], error: { message: RATE_429 } }
        })
        .mockImplementationOnce(async (_threadId, _inputs, handlers) => {
          handlers.onAgentMessageDelta?.('recovered', 'm2')
          return { status: 'completed', items: [], finalMessageText: 'recovered' }
        })

      vi.useFakeTimers()
      handle.agent.followup(userText('hi'))
      await vi.advanceTimersByTimeAsync(60_000)
      await handle.agent.whenIdle()

      expect(startTurn).toHaveBeenCalledTimes(2)
      const events = handle.agent.session.events
      const retries = events.filter(e => e.type === 'llm/retry')
      expect(retries).toHaveLength(1)
      const record = retries[0]?.type === 'llm/retry' ? retries[0].data : undefined
      expect(record).toMatchObject({
        turn: 1,
        step: 1,
        provider: 'opencode-go',
        mode: 'normal',
        policyKey: 'codex-gateway-429',
        retry: 1,
        maxRetries: GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length,
        delayMs: GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS[0],
        failure: { message: RATE_429, code: 'RATE_LIMIT', status: 429 },
      })
      const turnEnd = events.findLast(e => e.type === 'turn/end')
      expect(JSON.stringify(turnEnd)).toContain('completed')
    } finally {
      vi.useRealTimers()
      await handle.dispose()
    }
  })

  it('continues the same thread instead of re-sending after tools ran', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-429-after-tools'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-429t')
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockImplementationOnce(async (_threadId, _inputs, handlers) => {
          handlers.onAgentMessageDelta?.('doing work ', 'm1')
          handlers.onItemStarted?.({ type: 'commandExecution', id: 'c1', command: 'ls' }, 'c1')
          handlers.onItemCompleted?.({
            type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'out', exitCode: 0,
          }, 'c1')
          return { status: 'failed', items: [], error: { message: RATE_429 } }
        })
        .mockImplementationOnce(async (_threadId, inputs, handlers) => {
          // The continuation reuses the thread: history already holds the
          // tool result, so the model continues instead of re-executing.
          expect(inputs).toHaveLength(1)
          const firstInput = inputs[0]
          expect(firstInput?.type).toBe('text')
          expect(firstInput !== undefined && firstInput.type === 'text' ? firstInput.text : '').toContain('不要重複已經執行過的工具調用')
          handlers.onAgentMessageDelta?.('continued', 'm2')
          return { status: 'completed', items: [], finalMessageText: 'continued' }
        })

      vi.useFakeTimers()
      handle.agent.followup(userText('hi'))
      await vi.advanceTimersByTimeAsync(60_000)
      await handle.agent.whenIdle()

      expect(startTurn).toHaveBeenCalledTimes(2)
      const events = handle.agent.session.events
      // The delivered round keeps its message; tools execute exactly once.
      expect(events.filter(e => e.type === 'tool/call')).toHaveLength(1)
      const messages = events.filter(e => e.type === 'assistant/message')
      expect(messages).toHaveLength(2)
      const textOf = (e: (typeof messages)[number]): string =>
        e.type === 'assistant/message'
          ? e.data.message.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
          : ''
      expect(textOf(messages[0]!)).toBe('doing work ')
      expect(textOf(messages[1]!)).toBe('continued')
      // Time order: round-one message, tool rows, then the continuation.
      const at = (type: string, n: number): number => {
        let seen = -1
        return events.findIndex(e => e.type === type && (seen += 1) === n)
      }
      expect(at('assistant/message', 0)).toBeLessThan(at('tool/call', 0))
      expect(at('tool/result', 0)).toBeLessThan(at('assistant/message', 1))
      const turnEnd = events.findLast(e => e.type === 'turn/end')
      expect(JSON.stringify(turnEnd)).toContain('completed')
    } finally {
      vi.useRealTimers()
      await handle.dispose()
    }
  })

  it('keeps retrying continuations until the shared budget is spent', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-429-continuations-exhausted'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-429c')
      let calls = 0
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockImplementation(async (_threadId, _inputs, handlers) => {
          calls += 1
          const callId = `c${calls}`
          handlers.onAgentMessageDelta?.('doing work ', 'm1')
          handlers.onItemStarted?.({ type: 'commandExecution', id: callId, command: 'ls' }, callId)
          handlers.onItemCompleted?.({
            type: 'commandExecution', id: callId, command: 'ls', aggregatedOutput: 'out', exitCode: 0,
          }, callId)
          return { status: 'failed', items: [], error: { message: RATE_429 } }
        })

      vi.useFakeTimers()
      handle.agent.followup(userText('hi'))
      await vi.advanceTimersByTimeAsync(300_000)
      await handle.agent.whenIdle()

      // One initial attempt plus continuations sharing the same budget; the
      // tool executes once per codex turn drive, never re-sent blindly.
      expect(startTurn).toHaveBeenCalledTimes(1 + GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length)
      const events = handle.agent.session.events
      // Delivered rounds keep their messages (no llm/retry hiding for them).
      expect(events.filter(e => e.type === 'llm/retry')).toHaveLength(0)
      const turnEnd = events.findLast(e => e.type === 'turn/end')
      const serialized = JSON.stringify(turnEnd)
      expect(serialized).toContain('网关限流')
      expect(serialized).toContain('已自动退避重试仍失败')
    } finally {
      vi.useRealTimers()
      await handle.dispose()
    }
  })
})
