/** TUI bundle composition stays thin and below both user patch layers. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))

function patches(path: string): PatchOptions[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`${path} must contain a patch list`)
  return parsed as PatchOptions[]
}

describe('dsh-tui bundle', () => {
  it('declares a thin protocol surface without copying the base tree', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({ '@deepseek-ai/dsh-sdk-jsonrpc-server': 'workspace:^' })

    const tui = patches(resolve(root, manifest.dsh!.bundle!.patch!))
    const inserted = tui.flatMap(patch => patch.insert ?? [])
    expect(inserted).toEqual([{
      id: 'sdk-jsonrpc-server',
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server',
      config: { maxTokensAsSuccess: true },
    }])
    expect(tui.filter(patch => patch.id !== undefined).map(patch => patch.id)).toEqual([
      'system-prompt',
      'tools',
    ])
  })

  it('keeps base capabilities and lets profile then home patches override the surface', () => {
    const base = patches(resolve(root, '../base/cordis.patch.yml'))
    const tui = patches(resolve(root, 'cordis.patch.yml'))
    const profile: PatchOptions[] = [
      { id: 'system-prompt', config: { persona: 'profile persona' } },
      { insert: [{ id: 'external-plugin', name: 'fixture-plugin', config: { owner: 'profile' } }] },
    ]
    const home: PatchOptions[] = [
      { id: 'system-prompt', config: { persona: 'home persona' } },
      { id: 'external-plugin', config: { owner: 'home' } },
    ]
    const composed = applyEntryPatches([], structuredClone([
      ...base,
      ...tui,
      ...profile,
      ...home,
    ]), () => {})
    const byId = new Map(composed.map(row => [row.id, row]))

    expect(byId.get('system-prompt')?.config).toEqual({ persona: 'home persona' })
    expect(byId.get('external-plugin')?.config).toEqual({ owner: 'home' })
    expect(byId.get('sdk-jsonrpc-server')?.name).toBe('@deepseek-ai/dsh-sdk-jsonrpc-server')
    for (const baseCapability of [
      'credentials',
      'session-persistence-jsonl',
      'agent-instructions',
      'skill-filesystem',
      'tool-fs',
      'tool-subagent',
    ]) {
      expect(composed.filter(row => row.id === baseCapability), baseCapability).toHaveLength(1)
    }
  })
})
