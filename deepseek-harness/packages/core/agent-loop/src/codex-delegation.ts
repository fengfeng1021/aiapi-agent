/**
 * Codex dynamic-tool bridge for subagent delegation: the `delegate` tool
 * offered on every dsh-driven Codex thread, executed in-process through
 * `ctx.subagents`.
 *
 * The official app-server owns the model-visible tool surface, so dsh custom
 * tools cannot ride along any other way; `thread/start.dynamicTools` (gated
 * behind the `experimentalApi` client capability, which the daemon declares)
 * is the seam. A Codex turn calling `delegate` arrives at the daemon as an
 * `item/tool/call` server request; the per-turn owner executes it here and
 * the response text becomes the model's function output.
 *
 * @module dsh-agent-loop/codex-delegation
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'

/** Model-visible tool name on Codex threads. */
export const DELEGATE_TOOL_NAME = 'delegate'

/** In-process providers the tool may target; fork inherits the parent context. */
export type DelegateProvider = 'spawn' | 'fork'

/**
 * The `thread/start.dynamicTools` wire shape (codex `DynamicToolSpec`,
 * function variant). Field names are already wire camelCase.
 */
export interface DynamicToolFunctionSpec {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  readonly deferLoading?: boolean
}

/** Wire request the app-server sends for one dynamic tool call. */
export interface DynamicToolCallParams {
  readonly callId: string
  readonly turnId: string
  readonly namespace?: string
  readonly tool: string
  readonly arguments: unknown
}

/** Wire response resuming the model with plain-text content. */
export interface DynamicToolCallResponse {
  readonly contentItems: ReadonlyArray<{ readonly type: 'inputText'; readonly text: string }>
  readonly success: boolean
}

/** Parsed `delegate` arguments. */
export interface DelegateRequest {
  /** Self-contained task delivered as the child's user message. */
  readonly task: string
  /** In-process provider; omission selects a fresh `spawn` child. */
  readonly provider?: DelegateProvider
}

/** Settled delegation mapped onto the dynamic-tool response vocabulary. */
export interface DelegateResult {
  /** Model-facing text: the child's output, or a failure account. */
  readonly text: string
  /** Whether the child completed (as opposed to any other stop reason). */
  readonly success: boolean
}

/** Minimal subagents face the bridge drives; the real service satisfies it structurally. */
export interface DelegateSubagents {
  /**
   * Start a one-shot run.
   * @param provider - registered provider name.
   * @param request - delegation request naming the live parent.
   * @returns the published run.
   */
  start(provider: string, request: SubagentStartRequest): Promise<SubagentRun>
}

/**
 * The `delegate` tool spec published on every dsh-driven Codex thread.
 * @returns the dynamic-tool function spec.
 */
export function delegateToolSpec(): DynamicToolFunctionSpec {
  return {
    type: 'function',
    name: DELEGATE_TOOL_NAME,
    description: 'Delegate a self-contained subtask to a subagent running in the same workspace. '
      + 'Use for parallelizable work or tasks that deserve isolated context; the subagent shares your files '
      + 'and returns its final answer as text, but cannot see this conversation. '
      + 'Omit provider for a fresh child; pass "fork" only to continue this conversation in the child.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          minLength: 1,
          description: 'The complete task for the subagent, including every file path, constraint, and done criterion it needs: it starts with no other context.',
        },
        provider: {
          type: 'string',
          enum: ['spawn', 'fork'],
          description: 'Which in-process provider runs the child: "spawn" starts fresh (default), "fork" inherits this conversation.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  }
}

/**
 * Parse raw tool arguments into a {@link DelegateRequest}.
 * @param args - the decoded `arguments` payload.
 * @returns the validated request.
 * @throws when the task is missing, empty, or a provider override is unknown.
 */
export function parseDelegateArguments(args: unknown): DelegateRequest {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('subagent-codex-bridge: delegate arguments must be an object')
  }
  const record = args as Record<string, unknown>
  if (typeof record.task !== 'string' || record.task.trim().length === 0) {
    throw new Error('subagent-codex-bridge: delegate requires a non-empty task')
  }
  if (record.provider !== undefined && record.provider !== 'spawn' && record.provider !== 'fork') {
    throw new Error(`subagent-codex-bridge: unknown delegate provider ${JSON.stringify(record.provider)}`)
  }
  return {
    task: record.task,
    ...(record.provider === undefined ? {} : { provider: record.provider }),
  }
}

/** Render one settled run as model-facing text. */
function renderResult(result: SubagentResult): DelegateResult {
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n\n')
  if (result.stopReason === 'completed') {
    return { text, success: true }
  }
  return {
    text: text === '' ? `subagent ended (${result.stopReason}) with no output` : text,
    success: false,
  }
}

/**
 * Drive one delegation to settlement through the subagents service.
 * Execution faults (unknown provider, child infrastructure failure) resolve
 * to a failure result so the Codex turn survives with a model-visible
 * account; only malformed input throws.
 * @param subagents - the host subagents service.
 * @param parent - the exact live delegating agent (lineage, depth, policies).
 * @param request - validated delegate request.
 * @param signal - caller cancellation owning the run; omitted runs unscoped.
 * @returns the model-facing result.
 */
export async function executeDelegation(
  subagents: DelegateSubagents,
  parent: Agent,
  request: DelegateRequest,
  signal?: AbortSignal,
): Promise<DelegateResult> {
  // Without an external cancellation source the run is unscoped: it settles
  // on its own and disposal still bounds its teardown.
  const effective = signal ?? new AbortController().signal
  let run: SubagentRun
  try {
    run = await subagents.start(request.provider ?? 'spawn', {
      prompt: [{ type: 'text', text: request.task }],
      parent,
      signal: effective,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { text: `subagent could not start: ${message}`, success: false }
  }
  try {
    return renderResult(await run.result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { text: `subagent failed: ${message}`, success: false }
  } finally {
    await run.dispose()
  }
}
