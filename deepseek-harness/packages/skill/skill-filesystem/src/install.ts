/**
 * Controlled skill-file installer.
 *
 * This module owns every write the skill system performs: validating a skill
 * document, resolving the target directory inside a known skill root,
 * rendering the canonical `SKILL.md` text, and orchestrating the file
 * operations over an injected {@link SkillFileWriter}. Discovery
 * (`index.ts`) stays read-only; model-facing tools (`install-tools.ts`) are
 * thin wiring over these functions.
 *
 * Writes go through node:fs directly rather than `ctx.fs`: install roots
 * include user-home and project directories outside any session filesystem
 * scope, where service writes fail closed. The installing composition row is
 * the policy gate — the tools only exist where a deployment mounts them.
 *
 * @module @deepseek-ai/dsh-skill-filesystem/install
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'

/** Stable installer failure codes surfaced to tools and the marketplace UI. */
export type SkillInstallErrorCode =
  | 'invalid_name'
  | 'invalid_scope'
  | 'outside_root'
  | 'invalid_document'
  | 'missing_frontmatter'
  | 'invalid_frontmatter'
  | 'missing_name'
  | 'missing_description'
  | 'invalid_body'
  | 'invalid_invocation'
  | 'already_exists'
  | 'not_found'
  | 'not_a_skill'
  | 'write_failed'

/** Installer failure carrying a stable machine-readable code. */
export class SkillInstallError extends Error {
  /** Stable machine-readable failure discriminator. */
  readonly code: SkillInstallErrorCode

  /**
   * Construct an installer failure.
   * @param code - stable public failure discriminator.
   * @param message - stable public diagnostic.
   * @param options - optional contained implementation cause.
   */
  constructor(code: SkillInstallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SkillInstallError'
    this.code = code
  }
}

/** Writable skill-root bucket accepted by the installer. */
export type SkillInstallScope = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents' | 'custom'

const INSTALL_SCOPES: readonly SkillInstallScope[] = [
  'project-dsh',
  'project-agents',
  'user-dsh',
  'user-agents',
  'custom',
]

/**
 * Require a known install scope.
 * @param value - untrusted scope selector.
 * @returns the accepted scope.
 */
export function decodeInstallScope(value: unknown): SkillInstallScope {
  if (typeof value === 'string' && (INSTALL_SCOPES as readonly string[]).includes(value)) {
    return value as SkillInstallScope
  }
  throw new SkillInstallError(
    'invalid_scope',
    `install scope must be one of ${INSTALL_SCOPES.join(', ')}`,
  )
}

/** Concrete root directories the installer may write under. */
export interface SkillInstallRoots {
  /** `<project>/.dsh/skills`; absent without a session cwd. */
  readonly projectDsh?: string
  /** `<project>/.agents/skills`; absent without a session cwd. */
  readonly projectAgents?: string
  /** `<dshHome>/skills`. */
  readonly userDsh?: string
  /** `<agentsHome>/skills`. */
  readonly userAgents?: string
  /** Configured custom roots; `custom` scope resolves inside these only. */
  readonly custom: readonly string[]
}

/**
 * Resolve the writable root directory for one install scope.
 * @param roots - concrete root directories available to the caller.
 * @param scope - accepted install scope.
 * @param customDir - required_bias for `custom`: must equal a configured custom root.
 * @returns the absolute root directory.
 */
export function resolveInstallRoot(
  roots: SkillInstallRoots,
  scope: SkillInstallScope,
  customDir?: string,
): string {
  switch (scope) {
    case 'project-dsh':
    case 'project-agents':
    case 'user-dsh':
    case 'user-agents': {
      const key = scope === 'project-dsh' ? 'projectDsh'
        : scope === 'project-agents' ? 'projectAgents'
          : scope === 'user-dsh' ? 'userDsh' : 'userAgents'
      const root = roots[key]
      if (root === undefined) {
        throw new SkillInstallError('invalid_scope', `install scope "${scope}" is unavailable without a session workspace`)
      }
      return resolve(root)
    }
    case 'custom': {
      const configured = roots.custom.map(candidate => resolve(candidate))
      if (customDir === undefined) {
        if (configured.length === 0) {
          throw new SkillInstallError('invalid_scope', 'custom scope needs custom_dir when no custom root is configured')
        }
        const [first] = configured
        /* v8 ignore next -- the length check above proves one root exists. */
        if (first === undefined) throw new SkillInstallError('invalid_scope', 'custom scope needs custom_dir')
        return first
      }
      const wanted = resolve(customDir)
      if (!configured.includes(wanted)) {
        throw new SkillInstallError('invalid_scope', 'custom_dir must equal a configured custom skill root')
      }
      return wanted
    }
  }
}

/**
 * Whether a candidate path stays inside a root directory.
 * @param rootDir - anchoring root directory.
 * @param candidate - absolute or root-relative candidate path.
 * @returns false when the candidate escapes the root.
 */
export function isWithinRoot(rootDir: string, candidate: string): boolean {
  const root = resolve(rootDir)
  const target = resolve(root, candidate)
  const child = relative(root, target)
  return child.length === 0 || (child !== '..' && !child.startsWith(`..${sep}`))
}

/**
 * Resolve the skill bundle directory for a name inside a root.
 * @param rootDir - writable skill root directory.
 * @param name - kebab-case skill name.
 * @returns the absolute `<root>/<name>` directory.
 */
export function resolveSkillInstallDir(rootDir: string, name: string): string {
  if (!isSkillName(name)) {
    throw new SkillInstallError('invalid_name', `skill name "${name}" must be kebab-case like "code-review"`)
  }
  const root = resolve(rootDir)
  const dir = join(root, name)
  /* v8 ignore next -- kebab-case names carry no separators and cannot escape; the check guards future grammar relaxations. */
  if (!isWithinRoot(root, dir)) {
    throw new SkillInstallError('outside_root', `skill "${name}" escapes its install root`)
  }
  return dir
}

/** Frontmatter boundary offsets inside a skill document. */
interface FrontmatterSplit {
  /** Offset where the frontmatter YAML starts (after the opening line). */
  readonly yamlStart: number
  /** Offset where the closing `---` line starts. */
  readonly closingStart: number
  /** Offset where the body starts (after the closing line). */
  readonly bodyStart: number
  /** Line separator used by the document. */
  readonly eol: string
}

/**
 * Split the `---` frontmatter envelope without parsing its YAML.
 * @param text - raw skill document text.
 * @returns boundary offsets, or undefined without a complete envelope.
 */
function splitFrontmatterEnvelope(text: string): FrontmatterSplit | undefined {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  if (lines[0] !== '---') return undefined
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      const yamlStart = lines.slice(0, 1).join(eol).length + eol.length
      const closingStart = lines.slice(0, index).join(eol).length + eol.length
      return { yamlStart, closingStart, bodyStart: closingStart + '---'.length + eol.length, eol }
    }
  }
  return undefined
}

/** Legacy frontmatter keys the installer rejects; discovery ignores such files. */
const LEGACY_INVOCATION_KEYS: Readonly<Record<string, string>> = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
}

/** Tolerant frontmatter boolean spellings mirroring discovery's accepted set. */
const BOOLEAN_TOKENS: Readonly<Record<string, boolean>> = {
  true: true,
  yes: true,
  on: true,
  '1': true,
  false: false,
  no: false,
  off: false,
  '0': false,
}

/** Require a canonical-or-tolerant frontmatter boolean. */
function decodeInvocationBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  } else if (typeof value === 'string') {
    const parsed = BOOLEAN_TOKENS[value.toLowerCase()]
    if (parsed !== undefined) return parsed
  }
  throw new SkillInstallError('invalid_invocation', `frontmatter field "${key}" must be a boolean`)
}

/** Validated skill document ready to render or compare. */
export interface ValidatedSkillDocument {
  /** Kebab-case skill name. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Trimmed instruction body. */
  readonly body: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Normalized invocation controls present in the document. */
  readonly invocation: { readonly disableModelInvocation?: boolean; readonly userInvocable?: boolean }
}

/**
 * Validate raw text as an installable skill document.
 * @param text - untrusted skill document text.
 * @returns the validated name, description, body, and invocation controls.
 */
export function validateSkillDocument(text: unknown): ValidatedSkillDocument {
  if (typeof text !== 'string') {
    throw new SkillInstallError('invalid_document', 'skill document must be text')
  }
  const split = splitFrontmatterEnvelope(text)
  if (split === undefined) {
    throw new SkillInstallError('missing_frontmatter', 'skill document must start with a YAML frontmatter envelope')
  }
  let data: unknown
  try {
    data = parseYaml(text.slice(split.yamlStart, split.closingStart))
  } catch (error: unknown) {
    throw new SkillInstallError('invalid_frontmatter', `skill frontmatter is not valid YAML: ${errorMessage(error)}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SkillInstallError('invalid_frontmatter', 'skill frontmatter must be a mapping')
  }
  const fields = data as Record<string, unknown>
  for (const legacy of Object.keys(LEGACY_INVOCATION_KEYS)) {
    if (Object.hasOwn(fields, legacy)) {
      throw new SkillInstallError(
        'invalid_invocation',
        `frontmatter field "${legacy}" is unsupported; use "${LEGACY_INVOCATION_KEYS[legacy]}"`,
      )
    }
  }
  const name = fields['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new SkillInstallError('missing_name', 'skill frontmatter requires a name')
  }
  if (!isSkillName(name)) {
    throw new SkillInstallError('invalid_name', `skill name "${name}" must be kebab-case like "code-review"`)
  }
  const description = fields['description']
  if (typeof description !== 'string' || description.length === 0) {
    throw new SkillInstallError('missing_description', 'skill frontmatter requires a description')
  }
  const whenToUse = fields['whenToUse']
  if (whenToUse !== undefined && (typeof whenToUse !== 'string' || whenToUse.length === 0)) {
    throw new SkillInstallError('invalid_document', 'skill frontmatter whenToUse must be a non-empty string')
  }
  const metadata = fields['metadata']
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw new SkillInstallError('invalid_document', 'skill frontmatter metadata must be a mapping')
  }
  const body = text.slice(split.bodyStart).trim()
  if (body.length === 0) {
    throw new SkillInstallError('invalid_body', 'skill document body must be non-empty')
  }
  const disableModelInvocation = decodeInvocationBoolean(fields, 'disable-model-invocation')
  const userInvocable = decodeInvocationBoolean(fields, 'user-invocable')
  return {
    name,
    description,
    body,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation: {
      ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
      ...(userInvocable === undefined ? {} : { userInvocable }),
    },
  }
}

/** Input accepted by the skill-file renderer. */
export interface RenderSkillFileInput {
  /** Kebab-case skill name. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Instruction body. */
  readonly body: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Optional model-invocation control. */
  readonly disableModelInvocation?: boolean
  /** Optional user-invocation control. */
  readonly userInvocable?: boolean
}

/**
 * Render the canonical `SKILL.md` text for validated input.
 * Strings render JSON-quoted so descriptions containing YAML-significant
 * characters stay parseable; the body stays verbatim.
 * @param input - skill file input.
 * @returns canonical file text ending in one newline.
 */
export function renderSkillFile(input: RenderSkillFileInput): string {
  if (!isSkillName(input.name)) {
    throw new SkillInstallError('invalid_name', `skill name "${input.name}" must be kebab-case like "code-review"`)
  }
  if (input.description.length === 0) {
    throw new SkillInstallError('missing_description', 'skill frontmatter requires a description')
  }
  if (input.body.trim().length === 0) {
    throw new SkillInstallError('invalid_body', 'skill document body must be non-empty')
  }
  const lines = [
    '---',
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    ...(input.whenToUse === undefined ? [] : [`whenToUse: ${JSON.stringify(input.whenToUse)}`]),
    ...(input.disableModelInvocation === undefined
      ? []
      : [`disable-model-invocation: ${input.disableModelInvocation ? 'true' : 'false'}`]),
    ...(input.userInvocable === undefined ? [] : [`user-invocable: ${input.userInvocable ? 'true' : 'false'}`]),
    '---',
    '',
    input.body.trim(),
    '',
  ]
  return lines.join('\n')
}

/** Frontmatter flag lines rewritten by the toggle, in any spacing or value form. */
const MODEL_FLAG_PATTERN = /^disable-model-invocation\s*(?::|$)/
const USER_FLAG_PATTERN = /^user-invocable\s*(?::|$)/

/**
 * Rewrite the two invocation flags in a skill document, preserving every
 * other byte. Absent flags are inserted before the closing envelope line.
 * @param text - validated skill document text.
 * @param enabled - true writes the enabled pair, false the disabled pair.
 * @returns the updated text, or the identical input when already exact.
 */
export function upsertInvocationFlags(text: string, enabled: boolean): string {
  const split = splitFrontmatterEnvelope(text)
  if (split === undefined) {
    throw new SkillInstallError('missing_frontmatter', 'skill document must start with a YAML frontmatter envelope')
  }
  const modelLine = `disable-model-invocation: ${enabled ? 'false' : 'true'}`
  const userLine = `user-invocable: ${enabled ? 'true' : 'false'}`
  const head = text.slice(0, split.yamlStart)
  const tail = text.slice(split.closingStart)
  const lines = text.slice(split.yamlStart, split.closingStart).split(split.eol)
  // The YAML slice ends at the closing line start, so its last element is the
  // trailing partial line before `---` (empty when the envelope is tidy).
  const rewrite = (pattern: RegExp, canonical: string): boolean => {
    const index = lines.findIndex(line => pattern.test(line))
    if (index === -1) return false
    lines[index] = canonical
    return true
  }
  const hadModel = rewrite(MODEL_FLAG_PATTERN, modelLine)
  const hadUser = rewrite(USER_FLAG_PATTERN, userLine)
  if (hadModel && hadUser) return `${head}${lines.join(split.eol)}${tail}`
  const additions = [...(!hadModel ? [modelLine] : []), ...(!hadUser ? [userLine] : [])]
  return `${head}${lines.join(split.eol)}${additions.join(split.eol)}${split.eol}${tail}`
}

/** Minimal file operations the installer orchestrates; production uses node:fs. */
export interface SkillFileWriter {
  /** Create a directory and any missing ancestors. */
  makeDir(dir: string): Promise<void>
  /** Write a file that must not exist; rejects when it does. */
  writeNew(path: string, text: string): Promise<void>
  /** Read a file, or undefined when absent. */
  read(path: string): Promise<string | undefined>
  /** Replace a file unconditionally. */
  overwrite(path: string, text: string): Promise<void>
}

/**
 * Install one skill bundle directory with a rendered `SKILL.md`.
 * @param writer - file operations.
 * @param rootDir - writable skill root directory.
 * @param input - skill file input.
 * @param options - overwrite permits replacing an existing `SKILL.md`.
 * @returns the installed directory and file path.
 */
export async function installSkillFile(
  writer: SkillFileWriter,
  rootDir: string,
  input: RenderSkillFileInput,
  options?: { readonly overwrite?: boolean },
): Promise<{ dir: string; path: string }> {
  const dir = resolveSkillInstallDir(rootDir, input.name)
  const text = renderSkillFile(input)
  try {
    await writer.makeDir(dir)
  } catch (error: unknown) {
    throw new SkillInstallError('write_failed', `skill install cannot create ${dir}: ${errorMessage(error)}`, { cause: error })
  }
  const path = join(dir, 'SKILL.md')
  try {
    if (options?.overwrite === true) await writer.overwrite(path, text)
    else await writer.writeNew(path, text)
  } catch (error: unknown) {
    if (error instanceof SkillInstallError) throw error
    throw new SkillInstallError('write_failed', `skill install cannot write ${path}: ${errorMessage(error)}`, { cause: error })
  }
  return { dir, path }
}

/**
 * Locate an installed skill file: the bundle `SKILL.md` first, then a flat sibling.
 * @param writer - file operations.
 * @param rootDir - writable skill root directory.
 * @param name - kebab-case skill name.
 * @returns the skill file path, or undefined when neither layout exists.
 */
export async function locateSkillFile(
  writer: SkillFileWriter,
  rootDir: string,
  name: string,
): Promise<string | undefined> {
  const dir = resolveSkillInstallDir(rootDir, name)
  const bundle = join(dir, 'SKILL.md')
  try {
    if ((await writer.read(bundle)) !== undefined) return bundle
    const flat = `${dir}.md`
    if ((await writer.read(flat)) !== undefined) return flat
    return undefined
  } catch (error: unknown) {
    throw new SkillInstallError('write_failed', `skill lookup cannot read under ${dir}: ${errorMessage(error)}`, { cause: error })
  }
}

/**
 * Toggle one installed skill's invocation flags, preserving other bytes.
 * Enabling writes the explicit enabled pair; disabling writes the disabled
 * pair. Repeating the current state is a no-op without a file write.
 * @param writer - file operations.
 * @param skillFile - installed `SKILL.md` (or flat skill file) path.
 * @param enabled - desired toggle state.
 * @returns the file path and the applied state.
 */
export async function setSkillEnabled(
  writer: SkillFileWriter,
  skillFile: string,
  enabled: boolean,
): Promise<{ path: string; enabled: boolean }> {
  let raw: string | undefined
  try {
    raw = await writer.read(skillFile)
  } catch (error: unknown) {
    throw new SkillInstallError('write_failed', `skill toggle cannot read ${skillFile}: ${errorMessage(error)}`, { cause: error })
  }
  if (raw === undefined) {
    throw new SkillInstallError('not_found', `skill file ${skillFile} does not exist`)
  }
  try {
    validateSkillDocument(raw)
  } catch (error: unknown) {
    throw new SkillInstallError('not_a_skill', `${skillFile} is not a loadable skill document`, { cause: error })
  }
  const next = upsertInvocationFlags(raw, enabled)
  if (next === raw) return { path: skillFile, enabled }
  try {
    await writer.overwrite(skillFile, next)
  } catch (error: unknown) {
    throw new SkillInstallError('write_failed', `skill toggle cannot write ${skillFile}: ${errorMessage(error)}`, { cause: error })
  }
  return { path: skillFile, enabled }
}

/** Whether an error carries a node-style `code` property equal to a value. */
function hasErrorCode(error: unknown, code: string): boolean {
  /* v8 ignore next -- node:fs rejects with keyed SystemErrors; foreign rejections cannot surface here. */
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === code
}

/** Whether a node filesystem failure reports a missing path. */
function isAbsentPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')
}

/**
 * Build the production node:fs writer.
 * @returns file operations over the host filesystem.
 */
export function createNodeSkillFileWriter(): SkillFileWriter {
  return {
    makeDir: async (dir) => {
      await mkdir(dir, { recursive: true })
    },
    writeNew: async (path, text) => {
      try {
        await writeFile(path, text, { flag: 'wx' })
      } catch (error: unknown) {
        /* v8 ignore next -- node:fs throws keyed SystemErrors, never installer errors. */
        if (error instanceof SkillInstallError) throw error
        if (hasErrorCode(error, 'EEXIST')) {
          throw new SkillInstallError('already_exists', `skill file ${path} already exists`)
        }
        throw new SkillInstallError('write_failed', `skill install cannot write ${path}: ${errorMessage(error)}`, { cause: error })
      }
    },
    read: async (path) => {
      try {
        return await readFile(path, 'utf8')
      } catch (error: unknown) {
        /* v8 ignore next -- node:fs throws keyed SystemErrors, never installer errors. */
        if (error instanceof SkillInstallError) throw error
        if (isAbsentPathError(error)) return undefined
        throw new SkillInstallError('write_failed', `skill file cannot read ${path}: ${errorMessage(error)}`, { cause: error })
      }
    },
    overwrite: async (path, text) => {
      try {
        await writeFile(path, text)
      } catch (error: unknown) {
        /* v8 ignore next -- node:fs throws keyed SystemErrors, never installer errors. */
        if (error instanceof SkillInstallError) throw error
        throw new SkillInstallError('write_failed', `skill file cannot write ${path}: ${errorMessage(error)}`, { cause: error })
      }
    },
  }
}

/** Readable one-line rendering of an unknown failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
