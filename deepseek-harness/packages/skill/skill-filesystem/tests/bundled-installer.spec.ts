import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { bundledInstallerProvider } from '../src/bundled-installer.ts'
import { validateSkillDocument } from '../src/install.ts'

const SKILL_FILE_URL = new URL('../assets/skill-installer/SKILL.md', import.meta.url)

describe('bundled skill-installer provider', () => {
  it('lists one bundled candidate', async () => {
    const listed = await bundledInstallerProvider.list({})
    expect('candidates' in listed ? listed.candidates : listed).toHaveLength(1)
  })

  it('loads the packaged SKILL.md with file-matching identity', async () => {
    const listed = await bundledInstallerProvider.list({})
    const candidates = 'candidates' in listed ? listed.candidates : listed
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('expected the bundled candidate')
    const loaded = await bundledInstallerProvider.get(candidate, {})
    const raw = await readFile(SKILL_FILE_URL, 'utf8')
    const doc = validateSkillDocument(raw)
    expect(candidate.name).toBe('skill-installer')
    expect(candidate.description).toBe(doc.description)
    expect(loaded?.name).toBe(doc.name)
    expect(loaded?.description).toBe(doc.description)
    expect(loaded?.content).toBe(doc.body)
    expect(loaded?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(loaded?.source).toBe('bundled')
    expect(loaded?.resourceBase).toMatchObject({ kind: 'directory' })
  })
})
