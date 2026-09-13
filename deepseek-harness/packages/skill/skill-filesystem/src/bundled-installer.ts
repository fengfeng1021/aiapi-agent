/**
 * Bundled `skill-installer` skill provider.
 *
 * Serves the packaged installer guidance (`assets/skill-installer/SKILL.md`)
 * as one immutable `bundled` candidate so every composition already mounting
 * skill-filesystem can discover how to author skills. The companion
 * `skill_install`, `skill_enable`, and `skill_disable` tools stay behind the
 * `installTools` config; the guidance itself is read-only and always listed.
 *
 * @module @deepseek-ai/dsh-skill-filesystem/bundled-installer
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { validateSkillDocument } from './install.ts'

const PROVIDER_NAME = 'skill-installer'
const SKILL_NAME = 'skill-installer'
const SKILL_DIR_URL = new URL('../assets/skill-installer/', import.meta.url)
const SKILL_FILE_URL = new URL('../assets/skill-installer/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(SKILL_DIR_URL),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION =
  'Create or update a skill with a valid SKILL.md and install it with the skill_install tool. '
  + 'Use when the user asks to add, install, or author a skill.'

const CANDIDATE: SkillCandidate = {
  name: SKILL_NAME,
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_FILE_URL,
}

/** Static provider serving the packaged installer guidance. */
export const bundledInstallerProvider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    const raw = await readFile(SKILL_FILE_URL, 'utf8')
    const doc = validateSkillDocument(raw)
    return {
      name: doc.name,
      description: doc.description,
      invocation: INVOCATION,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: RESOURCE_BASE,
      content: doc.body,
    }
  },
}
