import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FileSystemSkillProvider } from '../src/index.ts'
import { registerSkillInstallTools } from '../src/install-tools.ts'
import type { SkillInstallHost } from '../src/install-tools.ts'
import { validateSkillDocument } from '../src/install.ts'

async function tempRoot(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `dsh-installer-tools-${name}-`))
}

function stubTools(): { ctx: Context; registered: ToolDefinition[]; disposed: string[] } {
  const registered: ToolDefinition[] = []
  const disposed: string[] = []
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition)
        return () => {
          disposed.push(definition.name)
        }
      },
    },
  } as unknown as Context
  return { ctx, registered, disposed }
}

function stubHost(roots: Record<string, string>, custom: readonly string[] = []) {
  let refreshes = 0
  return {
    host: {
      installRoots: () => Promise.resolve({ ...roots, custom }),
      refreshCatalog: () => {
        refreshes += 1
      },
    } satisfies SkillInstallHost,
    refreshCount: () => refreshes,
  }
}

function byName(registered: ToolDefinition[], name: string): ToolDefinition {
  const found = registered.find(definition => definition.name === name)
  if (found === undefined) throw new Error(`tool ${name} was not registered`)
  return found
}

const NO_AGENT = { signal: new AbortController().signal } as never

describe('registerSkillInstallTools', () => {
  it('registers three tools and disposes them idempotently', () => {
    const { ctx, registered, disposed } = stubTools()
    const { host } = stubHost({})
    const dispose = registerSkillInstallTools(ctx, host)
    expect(registered.map(definition => definition.name).sort()).toEqual([
      'skill_disable',
      'skill_enable',
      'skill_install',
    ])
    dispose()
    expect(disposed.sort()).toEqual(['skill_disable', 'skill_enable', 'skill_install'])
    dispose()
    expect(disposed).toHaveLength(3)
  })

  it('installs through user scope without an agent and refreshes once', async () => {
    const root = await tempRoot('user')
    try {
      const { ctx, registered } = stubTools()
      const { host, refreshCount } = stubHost({ userDsh: root })
      registerSkillInstallTools(ctx, host)
      const result = await byName(registered, 'skill_install').execute(
        { name: 'code-review', description: 'Review code.', body: 'Follow the checklist.', scope: 'user-dsh' },
        NO_AGENT,
      ) as { name: string; scope: string; path: string }
      expect(result).toMatchObject({ name: 'code-review', scope: 'user-dsh' })
      expect(validateSkillDocument(await readFile(result.path, 'utf8')).body).toBe('Follow the checklist.')
      expect(refreshCount()).toBe(1)
      await expect(byName(registered, 'skill_install').execute(
        { name: 'code-review', description: 'Review code.', body: 'Other.', scope: 'user-dsh' },
        NO_AGENT,
      )).rejects.toThrow('skill-install [already_exists]')
      expect(refreshCount()).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves project scope from the calling agent cwd', async () => {
    const project = await tempRoot('project')
    try {
      await mkdir(join(project, '.git'), { recursive: true })
      const { ctx, registered } = stubTools()
      const host: SkillInstallHost = {
        installRoots: () => Promise.resolve({ projectDsh: join(project, '.dsh/skills'), custom: [] }),
        refreshCatalog: () => {},
      }
      registerSkillInstallTools(ctx, host)
      const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: project } } } } as never
      const result = await byName(registered, 'skill_install').execute(
        { name: 'code-review', description: 'Review code.', body: 'Follow the checklist.' },
        exec,
      ) as { scope: string; path: string }
      expect(result.scope).toBe('project-dsh')
      expect(result.path.startsWith(project)).toBe(true)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('rolls back earlier registrations when a later one conflicts', () => {
    const registered: ToolDefinition[] = []
    const disposed: string[] = []
    const ctx = {
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          if (registered.length === 2) throw new Error('name taken')
          return () => {
            disposed.push(definition.name)
          }
        },
      },
    } as unknown as Context
    expect(() => registerSkillInstallTools(ctx, stubHost({}).host)).toThrow('name taken')
    expect(disposed).toEqual(['skill_install'])
  })

  it('maps foreign host failures to internal_error', async () => {
    const { ctx, registered } = stubTools()
    const failing: SkillInstallHost = {
      installRoots: () => Promise.reject(new Error('backend gone')),
      refreshCatalog: () => {},
    }
    registerSkillInstallTools(ctx, failing)
    await expect(byName(registered, 'skill_install').execute(
      { name: 'code-review', description: 'Review code.', body: 'Follow the checklist.' },
      NO_AGENT,
    )).rejects.toThrow('skill-install [internal_error] backend gone')
    const foreign: SkillInstallHost = {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the point of this case.
      installRoots: () => Promise.reject('backend gone'),
      refreshCatalog: () => {},
    }
    const { ctx: ctx2, registered: registered2 } = stubTools()
    registerSkillInstallTools(ctx2, foreign)
    await expect(byName(registered2, 'skill_install').execute(
      { name: 'code-review', description: 'Review code.', body: 'Follow the checklist.' },
      NO_AGENT,
    )).rejects.toThrow('skill-install [internal_error] backend gone')
  })

  it('passes optional routing and invocation controls through', async () => {
    const root = await tempRoot('optionals')
    try {
      const { ctx, registered } = stubTools()
      const { host } = stubHost({ userDsh: root })
      registerSkillInstallTools(ctx, host)
      const result = await byName(registered, 'skill_install').execute(
        {
          name: 'code-review',
          description: 'Review code.',
          body: 'Follow the checklist.',
          scope: 'user-dsh',
          when_to_use: 'reviews',
          disable_model_invocation: true,
          user_invocable: false,
        },
        NO_AGENT,
      ) as { path: string }
      expect(validateSkillDocument(await readFile(result.path, 'utf8')).invocation).toEqual({
        disableModelInvocation: true,
        userInvocable: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps scope and toggle failures to stable codes', async () => {
    const root = await tempRoot('failures')
    try {
      const { ctx, registered } = stubTools()
      const { host } = stubHost({ userDsh: root })
      registerSkillInstallTools(ctx, host)
      const install = byName(registered, 'skill_install')
      await expect(install.execute({ name: 'x', description: 'D.', body: 'B.', scope: 'bundled' }, NO_AGENT))
        .rejects.toThrow('skill-install [invalid_scope]')
      const enable = byName(registered, 'skill_enable')
      await expect(enable.execute({ name: 'missing', scope: 'user-dsh' }, NO_AGENT))
        .rejects.toThrow('skill-install [not_found]')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('toggles availability and reports idempotent repeats', async () => {
    const root = await tempRoot('toggle')
    try {
      const { ctx, registered } = stubTools()
      const { host, refreshCount } = stubHost({ userDsh: root })
      registerSkillInstallTools(ctx, host)
      const install = byName(registered, 'skill_install')
      const enable = byName(registered, 'skill_enable')
      const disable = byName(registered, 'skill_disable')
      const installed = await install.execute(
        { name: 'code-review', description: 'Review code.', body: 'Follow the checklist.', scope: 'user-dsh' },
        NO_AGENT,
      ) as { path: string }
      expect(await disable.execute({ name: 'code-review', scope: 'user-dsh' }, NO_AGENT)).toMatchObject({
        path: installed.path,
        enabled: false,
      })
      expect(await disable.execute({ name: 'code-review', scope: 'user-dsh' }, NO_AGENT)).toMatchObject({
        enabled: false,
      })
      expect(await enable.execute({ name: 'code-review', scope: 'user-dsh' }, NO_AGENT)).toMatchObject({
        enabled: true,
      })
      expect(refreshCount()).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('presents stable call titles and JSON results', () => {
    const { ctx, registered } = stubTools()
    registerSkillInstallTools(ctx, stubHost({}).host)
    const install = byName(registered, 'skill_install')
    expect(install.presentCall?.({ name: 'code-review', description: 'D.', body: 'B.' }))
      .toMatchObject({ title: 'Install skill code-review' })
    expect(byName(registered, 'skill_enable').presentCall?.({ name: 'code-review' }))
      .toMatchObject({ title: 'Enable skill code-review' })
    expect(byName(registered, 'skill_disable').presentCall?.({ name: 'code-review' }))
      .toMatchObject({ title: 'Disable skill code-review' })
    const rendered = install.output.render({}, { name: 'code-review', scope: 'user-dsh', path: '/skills' })
    expect(rendered).toHaveLength(1)
    expect(JSON.stringify(rendered)).toContain('code-review')
  })
})

describe('FileSystemSkillProvider installer facts', () => {
  function provider(home: string, custom: readonly string[] = []) {
    const control = { invalidate: vi.fn(), signal: new AbortController().signal }
    const ctx = { get: () => undefined } as unknown as Context
    const instance = new FileSystemSkillProvider(ctx, control, {
      providerName: 'test',
      dshHome: home,
      agentsHome: join(home, 'agents'),
      customSkillDirs: [...custom],
      watch: false,
    })
    return { instance, control }
  }

  it('resolves project, user, and custom roots for a workspace cwd', async () => {
    const home = await tempRoot('home')
    const project = await tempRoot('project')
    try {
      await mkdir(join(project, '.git'), { recursive: true })
      const custom = await tempRoot('custom')
      const { instance } = provider(home, [custom])
      const roots = await instance.installRoots(project)
      expect(roots.projectDsh).toBe(join(project, '.dsh/skills'))
      expect(roots.projectAgents).toBe(join(project, '.agents/skills'))
      expect(roots.userDsh).toBe(join(home, 'skills'))
      expect(roots.userAgents).toBe(join(home, 'agents', 'skills'))
      expect(roots.custom).toEqual([custom])
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(project, { recursive: true, force: true })
    }
  })

  it('omits project roots without a workspace and custom roots when unconfigured', async () => {
    const home = await tempRoot('home')
    try {
      const { instance } = provider(home)
      const roots = await instance.installRoots(undefined)
      expect(roots.projectDsh).toBeUndefined()
      expect(roots.userDsh).toBe(join(home, 'skills'))
      expect(roots.custom).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refreshes the catalog through the registration control', async () => {
    const home = await tempRoot('home')
    try {
      const { instance, control } = provider(home)
      instance.refreshCatalog()
      expect(control.invalidate).toHaveBeenCalledTimes(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
