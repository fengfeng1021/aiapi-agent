import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  CodexAppServerDaemon,
  CodexThreadGoneError,
  getCodexAppServerDaemon,
} from '../src/codex-server.ts'
import type { CodexTurnResult } from '../src/codex-server.ts'

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

function completed(text: string): CodexTurnResult {
  return { status: 'completed', items: [], finalMessageText: text }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CodexLoopAgent thread-gone recovery', () => {
  it('drops a stale thread id and drives the same input on a fresh thread', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-thread-gone-heals'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      const createThread = vi.spyOn(daemon, 'createThread')
        .mockResolvedValueOnce('thread-stale')
        .mockResolvedValueOnce('thread-fresh')
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockRejectedValueOnce(new CodexThreadGoneError('thread-stale'))
        .mockResolvedValueOnce(completed('recovered on a fresh thread'))

      handle.agent.followup(userText('hi'))
      await handle.agent.whenIdle()

      expect(createThread).toHaveBeenCalledTimes(2)
      expect(startTurn).toHaveBeenCalledTimes(2)
      const delegateOwner = expect.objectContaining({ executeDynamicTool: expect.any(Function) })
      expect(startTurn).toHaveBeenNthCalledWith(1, 'thread-stale', expect.anything(), expect.anything(), expect.anything(), delegateOwner)
      expect(startTurn).toHaveBeenNthCalledWith(2, 'thread-fresh', expect.anything(), expect.anything(), expect.anything(), delegateOwner)
      const events = handle.agent.session.events
      const turnEnd = events.findLast(event => event.type === 'turn/end')
      expect(turnEnd).toBeDefined()
      expect(JSON.stringify(turnEnd)).toContain('completed')
      const assistant = events.find(event => event.type === 'assistant/message')
      expect(assistant).toBeDefined()
      expect(JSON.stringify(assistant)).toContain('recovered on a fresh thread')
    } finally {
      await handle.dispose()
    }
  })

  it('fails loudly when the fresh thread is gone too', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-thread-gone-twice'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      const createThread = vi.spyOn(daemon, 'createThread')
        .mockResolvedValueOnce('thread-stale')
        .mockResolvedValueOnce('thread-fresh')
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockRejectedValueOnce(new CodexThreadGoneError('thread-stale'))
        .mockRejectedValueOnce(new CodexThreadGoneError('thread-fresh'))

      handle.agent.followup(userText('hi'))
      await handle.agent.whenIdle()

      expect(createThread).toHaveBeenCalledTimes(2)
      expect(startTurn).toHaveBeenCalledTimes(2)
      const turnEnd = handle.agent.session.events.findLast(event => event.type === 'turn/end')
      expect(turnEnd).toBeDefined()
      expect(JSON.stringify(turnEnd)).toContain('thread is gone')
    } finally {
      await handle.dispose()
    }
  })

  it('retries startup after a failed start instead of latching the rejection', async () => {
    // A failed start must not poison later callers: each ensureStarted past
    // the failure re-runs startup. Pointing the isolated home at a file
    // fails config compilation before any spawn; restoring a directory lets
    // the retry proceed to a real keyless handshake.
    const probe = join(tmpdir(), `codex-home-probe-${process.pid}`)
    writeFileSync(probe, 'not a directory')
    const previous = process.env.CODEX_ISOLATED_HOME
    process.env.CODEX_ISOLATED_HOME = probe
    const daemon = new CodexAppServerDaemon()
    let home: string | undefined
    try {
      await expect(daemon.ensureStarted()).rejects.toThrow()
      home = mkdtempSync(join(tmpdir(), 'codex-home-retry-'))
      process.env.CODEX_ISOLATED_HOME = home
      // A latched daemon would reject with the compilation failure again.
      await daemon.ensureStarted()
    } finally {
      daemon.dispose()
      if (previous === undefined) delete process.env.CODEX_ISOLATED_HOME
      else process.env.CODEX_ISOLATED_HOME = previous
      rmSync(probe, { force: true })
      // The disposed child's file handles release asynchronously on
      // Windows; retry removal briefly rather than leaking temp homes.
      for (let attempt = 0; home !== undefined && attempt < 10; attempt++) {
        try {
          rmSync(home, { recursive: true, force: true })
          home = undefined
        } catch {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      if (home !== undefined) rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not recreate the thread when the miss names another id', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-thread-gone-foreign-id'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      const createThread = vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-mine')
      const startTurn = vi.spyOn(daemon, 'startTurn')
        .mockRejectedValue(new CodexThreadGoneError('thread-someone-elses'))
      handle.agent.followup(userText('hi'))
      await handle.agent.whenIdle()

      expect(createThread).toHaveBeenCalledTimes(1)
      expect(startTurn).toHaveBeenCalledTimes(1)
      const turnEnd = handle.agent.session.events.findLast(event => event.type === 'turn/end')
      expect(turnEnd).toBeDefined()
      expect(JSON.stringify(turnEnd)).toContain('thread-someone-elses')
    } finally {
      await handle.dispose()
    }
  })

  it('does not recreate the thread for unrelated turn failures', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-thread-gone-other-error'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const daemon = getCodexAppServerDaemon()
      const createThread = vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-kept')
      const startTurn = vi.spyOn(daemon, 'startTurn').mockRejectedValue(new Error('boom'))

      handle.agent.followup(userText('hi'))
      await handle.agent.whenIdle()

      expect(createThread).toHaveBeenCalledTimes(1)
      expect(startTurn).toHaveBeenCalledTimes(1)
      const turnEnd = handle.agent.session.events.findLast(event => event.type === 'turn/end')
      expect(turnEnd).toBeDefined()
      expect(JSON.stringify(turnEnd)).toContain('boom')
    } finally {
      await handle.dispose()
    }
  })
})
