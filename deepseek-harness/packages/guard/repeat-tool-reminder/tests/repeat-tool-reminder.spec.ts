import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as RepeatToolGuard from '@deepseek-ai/dsh-repeat-tool-reminder'

/**
 * Config surface for the repeat-tool-call guard: fail-loud validation only.
 *
 * The guard's loop behavior (threshold escalation, chain semantics, folding)
 * drove the removed react engine through a scripted mock adapter and has no
 * codex-engine equivalent; those suites were deleted with it.
 */

describe('config validation fails loud', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('rejects an empty thresholds list', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { thresholds: [] })).rejects.toThrow(/must not be empty/)
  })

  it('rejects a threshold below 2', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { thresholds: [1, 3] })).rejects.toThrow(/integer >= 2/)
  })

  it('rejects a non-integer threshold', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { thresholds: [2.5] })).rejects.toThrow(/integer >= 2/)
  })

  it('rejects duplicate thresholds', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { thresholds: [3, 3] })).rejects.toThrow(/duplicates/)
  })

  it('rejects a non-positive or fractional argumentsPreviewChars', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { argumentsPreviewChars: 0 })).rejects.toThrow(/argumentsPreviewChars/)
    const ctx2 = await spine()
    await expect(ctx2.plugin(RepeatToolGuard, { argumentsPreviewChars: 12.5 })).rejects.toThrow(/argumentsPreviewChars/)
  })
})
