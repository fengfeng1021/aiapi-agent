import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { getCodexAppServerDaemon } from '../src/codex-server.ts'
import type { CodexTurnHandlers, CodexTurnInput } from '../src/codex-server.ts'

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

const LIMITS = {
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: ['image/png'] as const,
}

function imageRef(): ImageAttachmentRef {
  return {
    attachmentId: 'att-1',
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
  } as unknown as ImageAttachmentRef
}

function mockTurn(captured: { inputs?: CodexTurnInput[] }): void {
  const daemon = getCodexAppServerDaemon()
  vi.spyOn(daemon, 'createThread').mockResolvedValue('thread-images')
  vi.spyOn(daemon, 'startTurn').mockImplementation(async (_threadId, inputs: CodexTurnInput[], _handlers: CodexTurnHandlers) => {
    captured.inputs = inputs
    return { status: 'completed', items: [], finalMessageText: 'done' }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('CodexLoopAgent image turn input', () => {
  it('forwards pasted images as localImage items behind the text', async () => {
    const ctx = await setupHarness()
    await ctx.plugin(class extends AttachmentStore {
      readonly imageLimits = LIMITS
      validateImage(): Promise<void> { return Promise.resolve() }
      saveImage(): Promise<never> { return Promise.reject(new Error('unused')) }
      readImage(): Promise<never> { return Promise.reject(new Error('unused')) }
      override imageHostPath(): string { return 'D:/tmp/test-image.png' }
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-images-local'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const captured: { inputs?: CodexTurnInput[] } = {}
      mockTurn(captured)
      handle.agent.followup(createUserMessage({
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', attachment: imageRef() },
        ],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      expect(captured.inputs).toEqual([
        { type: 'text', text: 'describe this' },
        { type: 'localImage', path: 'D:/tmp/test-image.png' },
      ])
    } finally {
      await handle.dispose()
    }
  })

  it('inlines images as data URLs when no host path is available', async () => {
    const ctx = await setupHarness()
    await ctx.plugin(class extends AttachmentStore {
      readonly imageLimits = LIMITS
      validateImage(): Promise<void> { return Promise.resolve() }
      saveImage(): Promise<never> { return Promise.reject(new Error('unused')) }
      readImage(): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
        return Promise.resolve({ ref: imageRef(), data: new Uint8Array([1, 2, 3]) })
      }
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-images-inline'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const captured: { inputs?: CodexTurnInput[] } = {}
      mockTurn(captured)
      handle.agent.followup(createUserMessage({
        content: [{ type: 'image', attachment: imageRef() }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      expect(captured.inputs).toEqual([
        { type: 'image', url: 'data:image/png;base64,AQID' },
      ])
    } finally {
      await handle.dispose()
    }
  })

  it('keeps text-only turns as a single text item', async () => {
    const ctx = await setupHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-images-text'),
      agentOptions: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    })
    try {
      const captured: { inputs?: CodexTurnInput[] } = {}
      mockTurn(captured)
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Say hi' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      expect(captured.inputs).toEqual([{ type: 'text', text: 'Say hi' }])
    } finally {
      await handle.dispose()
    }
  })
})