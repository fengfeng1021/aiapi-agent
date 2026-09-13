/**
 * Model-facing skill-installer tools over the controlled installer.
 *
 * `skill_install` writes one `<name>/SKILL.md` bundle under a known skill
 * root; `skill_enable` and `skill_disable` rewrite the invocation flags of an
 * installed skill without touching other bytes. The composition row is the
 * policy gate: skill-filesystem registers these tools only when its
 * `installTools` config is true, so agents without an explicit opt-in never
 * see a filesystem-writing skill surface.
 *
 * @module @deepseek-ai/dsh-skill-filesystem/install-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  SkillInstallError,
  createNodeSkillFileWriter,
  decodeInstallScope,
  installSkillFile,
  locateSkillFile,
  resolveInstallRoot,
  setSkillEnabled,
  type SkillFileWriter,
  type SkillInstallRoots,
  type SkillInstallScope,
} from './install.ts'

/** Filesystem facts the installer tools resolve through their owning provider. */
export interface SkillInstallHost {
  /** Concrete install roots; project roots need the calling agent cwd. */
  installRoots(cwd: string | undefined): Promise<SkillInstallRoots>
  /** Invalidate the provider catalog after a successful mutation. */
  refreshCatalog(): void
}

/** Shared node:fs writer; one handle serves every tool call. */
const nodeWriter: SkillFileWriter = createNodeSkillFileWriter()

/** Stable tool failure text carrying the installer code. */
function toolError(error: unknown): Error {
  return error instanceof SkillInstallError
    ? new Error(`skill-install [${error.code}] ${error.message}`, { cause: error })
    : new Error(`skill-install [internal_error] ${error instanceof Error ? error.message : String(error)}`)
}

/** Calling agent workspace, if the call runs inside an agent turn. */
function callCwd(exec: { agent?: { session: { header: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Resolve the install scope and root for one tool call.
 * @param host - owning provider facts.
 * @param exec - tool execution carrying the optional calling agent.
 * @param scopeArg - raw scope argument, defaulting to project skills.
 * @param customDir - raw custom root argument for the custom scope.
 * @returns the accepted scope and its absolute root.
 */
async function scopeRootForCall(
  host: SkillInstallHost,
  exec: { agent?: { session: { header: { cwd?: string } } } },
  scopeArg: unknown,
  customDir: string | undefined,
): Promise<{ scope: SkillInstallScope; root: string }> {
  const scope = decodeInstallScope(scopeArg ?? 'project-dsh')
  const root = resolveInstallRoot(await host.installRoots(callCwd(exec)), scope, customDir)
  return { scope, root }
}

const SCOPE_DESCRIPTION =
  'Install scope: project-dsh (.dsh/skills), project-agents (.agents/skills), user-dsh, user-agents, or custom. Defaults to project-dsh.'

/** Shared identity result properties for installer tool outputs. */
const INSTALL_RESULT_BASE = {
  name: { type: 'string', required: true },
  scope: { type: 'string', required: true },
  path: { type: 'string', required: true },
} as const

/** JSON result rendering shared by installer tool outputs. */
function renderJsonResult(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Register the installer tools on the exact calling scope.
 * @param ctx - plugin context owning the tool registry.
 * @param host - owning provider facts for root resolution and invalidation.
 * @returns disposer removing the three registrations.
 */
export function registerSkillInstallTools(ctx: Context, host: SkillInstallHost): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.tools.register(defineTool({
      name: 'skill_install',
      description: 'Install a skill from an explicit name, description, and instruction body. Writes <name>/SKILL.md under one skill root and refuses to overwrite without overwrite true. Prefer the skill-installer skill guidance before composing the body.',
      parameters: {
        name: { type: 'string', required: true, description: 'Kebab-case skill name, for example code-review.' },
        description: { type: 'string', required: true, description: 'Short routing description shown by discovery.' },
        body: { type: 'string', required: true, description: 'Full instruction body below the frontmatter.' },
        scope: { type: 'string', description: SCOPE_DESCRIPTION },
        custom_dir: { type: 'string', description: 'Custom root for custom scope; must equal a configured custom skill root.' },
        overwrite: { type: 'boolean', description: 'Replace an existing SKILL.md. Defaults to false.' },
        when_to_use: { type: 'string', description: 'Optional extra routing guidance.' },
        disable_model_invocation: { type: 'boolean', description: 'Hide the skill from the model catalog. Defaults to false.' },
        user_invocable: { type: 'boolean', description: 'Offer the skill as a /name gesture. Defaults to true.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ...INSTALL_RESULT_BASE },
        },
        render: renderJsonResult,
      },
      async execute(args, exec) {
        try {
          const { scope, root } = await scopeRootForCall(host, exec, args.scope, args.custom_dir)
          const installed = await installSkillFile(nodeWriter, root, {
            name: args.name,
            description: args.description,
            body: args.body,
            ...args.when_to_use === undefined ? {} : { whenToUse: args.when_to_use },
            ...args.disable_model_invocation === undefined
              ? {}
              : { disableModelInvocation: args.disable_model_invocation },
            ...args.user_invocable === undefined ? {} : { userInvocable: args.user_invocable },
          }, { overwrite: args.overwrite === true })
          host.refreshCatalog()
          return { name: args.name, scope, path: installed.path }
        } catch (error: unknown) {
          throw toolError(error)
        }
      },
      presentCall: args => ({ card: 'generic', title: `Install skill ${args.name}`, kind: 'other', rawInput: args.name }),
    })))

    for (const enabled of [true, false] as const) {
      const toolName = enabled ? 'skill_enable' : 'skill_disable'
      disposers.push(ctx.tools.register(defineTool({
        name: toolName,
        description: enabled
          ? 'Enable an installed skill: writes the explicit enabled invocation pair without touching other bytes.'
          : 'Disable an installed skill: writes the explicit disabled invocation pair without touching other bytes.',
        parameters: {
          name: { type: 'string', required: true, description: 'Kebab-case skill name.' },
          scope: { type: 'string', description: SCOPE_DESCRIPTION },
          custom_dir: { type: 'string', description: 'Custom root for custom scope; must equal a configured custom skill root.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...INSTALL_RESULT_BASE,
              enabled: { type: 'boolean', required: true },
            },
          },
          render: renderJsonResult,
        },
        async execute(args, exec) {
          try {
            const { scope, root } = await scopeRootForCall(host, exec, args.scope, args.custom_dir)
            const file = await locateSkillFile(nodeWriter, root, args.name)
            if (file === undefined) {
              throw new SkillInstallError('not_found', `skill "${args.name}" is not installed in scope "${scope}"`)
            }
            const toggled = await setSkillEnabled(nodeWriter, file, enabled)
            host.refreshCatalog()
            return { name: args.name, scope, path: toggled.path, enabled: toggled.enabled }
          } catch (error: unknown) {
            throw toolError(error)
          }
        },
        presentCall: args => ({
          card: 'generic',
          title: `${enabled ? 'Enable' : 'Disable'} skill ${args.name}`,
          kind: 'other',
          rawInput: args.name,
        }),
      })))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
