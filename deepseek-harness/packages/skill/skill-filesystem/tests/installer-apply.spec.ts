import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as SkillFileSystem from '../src/index.ts'

const homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) await rm(home, { recursive: true, force: true })
  }
})

async function boot(config: { installTools?: boolean }): Promise<Context> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-installer-apply-'))
  homes.push(home)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    watch: false,
    ...config,
  })
  return ctx
}

describe('installer composition', () => {
  it('registers no installer tools by default', async () => {
    const ctx = await boot({})
    try {
      const names = ctx.tools.schemas().map(schema => schema.name)
      expect(names).not.toContain('skill_install')
      expect(names).not.toContain('skill_enable')
      expect(names).not.toContain('skill_disable')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the three installer tools plus the bundled guidance when enabled', async () => {
    const ctx = await boot({ installTools: true })
    try {
      const names = ctx.tools.schemas().map(schema => schema.name)
      expect(names).toContain('skill_install')
      expect(names).toContain('skill_enable')
      expect(names).toContain('skill_disable')
      const skills = await ctx.skills.list({})
      expect(skills.map(skill => skill.name)).toContain('skill-installer')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
