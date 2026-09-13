/**
 * Delegation policy through child session events appended before publication:
 * the parent's sandbox override plus the pinned `approval/policy: never`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const contexts: Context[] = []
let workspace: string

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-inherit-')))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
})

async function setupWalled(script: Script): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: workspace },
  )
  return { ctx, parent }
}

function spawnRequest(parent: Agent) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'spawn',
      label: 'child task',
    }),
  }
}



describe('in-process policy inheritance', () => {
  it('places inherited events after a fork prefix so fresh policy wins stale seed state', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const blocked = join(workspace, 'fork-blocked.txt')
    setSandboxMode(parent.session, 'workspace-write')
    const seed = [...parent.session.events]
    setSandboxMode(parent.session, 'read-only')
    script.push(
      toolCallResponse('write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), { seed })
    try {
      await run.result
      const child = run.localAgent as Agent

      expect(child.session.header.seedLength).toBe(1)
      expect(child.session.firstLiveSeq).toBe(seed.length)
      // seq 1 is the constructor's end-seed marker.
      expect(child.session.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
        { seq: 0, data: { mode: 'workspace-write' } },
        { seq: 2, data: { mode: 'read-only', source: 'delegation' } },
      ])
      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')

      setSandboxMode(child.session, 'danger-full-access')
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    } finally {
      await run.dispose()
    }
  })

  it('captures policy at delegation before asynchronous child creation', async () => {
    const script: Script = [textResponse('child done')]
    const { ctx, parent } = await setupWalled(script)
    setSandboxMode(parent.session, 'read-only')

    const starting = startInProcessRun(spawnRequest(parent), {})
    setSandboxMode(parent.session, 'danger-full-access')
    const run = await starting
    try {
      await run.result
      const child = run.localAgent as Agent
      expect(ctx.sandboxPolicy.overrideOf(parent.session)).toBe('danger-full-access')
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')
    } finally {
      await run.dispose()
    }
  })

})
