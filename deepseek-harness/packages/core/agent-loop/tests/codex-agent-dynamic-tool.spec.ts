import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  CodexAppServerDaemon,
  CodexTurnHandlers,
  CodexTurnItem,
  CodexTurnResult,
} from '../src/codex-server.ts'

/**
 * Scripted stand-in for the external app-server child process: drives one
 * dynamic `delegate` item through the turn handlers, then completes. The
 * fake answers the item itself, so no model or subagent runs here — row
 * mapping is the behavior under test.
 */
const started: CodexTurnItem = {
  type: 'dynamicToolCall',
  id: 'dyn-1',
  tool: 'delegate',
  arguments: { task: 'do X' },
}
const completed: CodexTurnItem = {
  ...started,
  status: 'completed',
  contentItems: [{ type: 'inputText', text: 'child answer' }],
  success: true,
}

const fakeDaemon = {
  createThread: () => Promise.resolve('thread-stub'),
  startTurn: (
    _threadId: string,
    _inputs: unknown,
    handlers: CodexTurnHandlers,
  ): Promise<CodexTurnResult> => {
    handlers.onItemStarted?.(started, started.id)
    handlers.onItemCompleted?.(completed, completed.id)
    return Promise.resolve({
      status: 'completed',
      items: [completed],
      finalMessageText: 'child answer',
    })
  },
} as unknown as CodexAppServerDaemon

vi.mock('../src/codex-server.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codex-server.ts')>()
  return {
    ...actual,
    getCodexAppServerDaemon: () => fakeDaemon,
  }
})

const { CodexLoopAgent } = await import('../src/codex-agent.ts')

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

describe('CodexLoopAgent dynamic tool rows', () => {
  it('logs a delegate item as tool/call and tool/result rows', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-dynamic-tool-session'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    expect(handle.agent).toBeInstanceOf(CodexLoopAgent)

    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'run the delegated task' }],
        source: { kind: 'user' },
      }),
    )
    await handle.agent.whenIdle()

    const calls = handle.agent.session.events.filter((e) => e.type === 'tool/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      type: 'tool/call',
      data: { name: 'delegate', arguments: JSON.stringify({ task: 'do X' }) },
    })

    const results = handle.agent.session.events.filter((e) => e.type === 'tool/result')
    expect(results).toHaveLength(1)
    const message = (results[0] as { data: { message: {
      content: Array<{ type: string; toolCallId?: string; content?: unknown; isError?: boolean }>
    } } }).data.message
    expect(message.content).toEqual([{
      type: 'tool-result',
      toolCallId: 'dyn-1',
      content: [{ type: 'text', text: 'child answer' }],
      isError: false,
    }])

    await handle.dispose()
    vi.restoreAllMocks()
  }, 30000)
})
