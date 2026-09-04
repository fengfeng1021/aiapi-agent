/**
 * CodexLoopAgent: Drives session turns via the Codex App-Server backend,
 * translating Codex streaming deltas, tool executions, token metrics, and
 * completions into standard DeepSeek Harness SessionEvents for UI rendering.
 *
 * @module dsh-agent-loop/codex-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createToolResultMessage,
  StreamingThinkingNormalizer,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import {
  getCodexAppServerDaemon,
  compileProvidersConfig,
  type CodexAppServerDaemon,
  type CodexTurnItem,
  type CodexTokenUsage,
  type CodexTurnResult,
} from './codex-server.ts'
import { AdaptiveParamSanitizer } from './param-sanitizer.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
      kind: 'maintenance'
      abort: AbortController
      lastTurn: number
      wakeRequested: boolean
    }
  | {
      kind: 'running'
      abort: AbortController
      turn: number
      step: number
      wakeRequested: boolean
    }

export class CodexLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  readonly scope: Scope
  readonly ctx: Context
  private readonly dispatch: AgentEventDispatch

  private requestHeaderLogged = false
  private threadId: string | undefined
  private readonly daemon: CodexAppServerDaemon

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => {
        this.dispatch.emit('agent/inbox/inserted', { message })
      },
      discarded: (message) => {
        this.dispatch.emit('agent/inbox/discarded', { message })
      },
      claimed: (message, turn) => {
        this.dispatch.emit('agent/inbox/claimed', { message, turn })
      },
    })
    const lastTurn = this.loopCtx.sessionProjections?.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.daemon = getCodexAppServerDaemon()
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') {
      this.phase.abort.abort(cause)
      if (this.threadId) {
        this.daemon.interruptTurn(this.threadId).catch(() => {})
      }
    }
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Catch and contain at driver boundary
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private ensureHeader(): void {
    if (this.requestHeaderLogged) return
    this.requestHeaderLogged = true
    const header = canonicalHeader({
      config: {
        provider: this.options.provider ?? 'opencode-go',
        model: this.options.model ?? 'muse-spark-1.3-contributor',
      },
      system: 'Codex Autonomous Agent Engine',
      tools: [],
    })
    try {
      this.session.append('request/header', { header, reason: 'initial' })
      this.session.append('request/context', {
        provider: this.options.provider ?? 'opencode-go',
        model: this.options.model ?? 'muse-spark-1.3-contributor',
        contextWindow: 128000,
      })
    } catch {
      // Ignore duplicate request header log
    }
  }

  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()

    const turn = phase.turn + 1
    phase.turn = turn
    this.session.append('turn/start', { turn })

    let turnEnds: TurnEndReason | null = null
    try {
      this.ensureHeader()

      // Claim pending turn input (prioritizing next-turn, falling back to next-step for steer)
      const target: InboxTarget = this.inbox.nextTurn.length > 0 ? 'next-turn' : 'next-step'
      const claimed = this.inbox.claim(target, turn)
      if (claimed.length === 0) {
        turnEnds = { kind: 'completed' }
        return false
      }

      const step = 1
      phase.step = step
      this.session.append('step/start', { turn, step })

      try {
        for (const msg of claimed) {
          this.session.append('user/message', msg, { surfaceOp: 'append' })
        }

        signal.throwIfAborted()
        turnEnds = await this.executeCodexTurn(turn, step, claimed, signal)
      } finally {
        this.session.append('step/end', { turn, step })
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: 'UNKNOWN',
        },
      }
      this.throwError(error)
    } finally {
      this.session.append('turn/end', {
        turn,
        reason: turnEnds ?? { kind: 'completed' },
      })
    }

    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async executeCodexTurn(
    turn: number,
    step: number,
    claimed: UserMessage[],
    signal: AbortSignal,
  ): Promise<TurnEndReason> {
    // 1. Ensure Codex thread exists
    if (!this.threadId) {
      const permissionMode = (process.env.DSH_PERMISSION_MODE as 'read-only' | 'workspace-write' | 'danger-full-access') ?? 'workspace-write'
      const approvalPolicy = permissionMode === 'danger-full-access' ? 'never' : 'on-request'

      this.threadId = await this.daemon.createThread({
        cwd: this.session.header.cwd,
        model: this.options.model ?? 'muse-spark-1.3-contributor',
        modelProvider: this.options.provider ?? 'opencode-go',
        sandbox: permissionMode,
        approvalPolicy,
      })
    }

    // 2. Extract text from user messages
    const promptLines: string[] = []
    for (const msg of claimed) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          promptLines.push(block.text)
        }
      }
    }
    const userPrompt = promptLines.join('\n\n') || 'Hello'

    let accumulatedReasoning = ''
    let accumulatedText = ''
    let lastTokenUsage: CodexTokenUsage | undefined
    let normalizer = new StreamingThinkingNormalizer()
    let result: CodexTurnResult | undefined

    const maxAttempts = 2
    let attempt = 0

    while (attempt < maxAttempts) {
      attempt++
      accumulatedReasoning = ''
      accumulatedText = ''
      lastTokenUsage = undefined
      normalizer = new StreamingThinkingNormalizer()

      // 3. Dispatch to Codex and stream events into session
      result = await this.daemon.startTurn(
        this.threadId,
        [{ type: 'text', text: userPrompt }],
        {
          onAgentMessageDelta: (delta) => {
            const parts = normalizer.feedContent(delta)
            for (const part of parts) {
              if (part.type === 'reasoning') {
                accumulatedReasoning += part.text
                this.session.append('assistant/chunk', {
                  turn,
                  step,
                  chunk: { type: 'reasoning-delta', index: 0, text: part.text },
                })
              } else {
                accumulatedText += part.text
                this.session.append('assistant/chunk', {
                  turn,
                  step,
                  chunk: { type: 'text-delta', index: 0, text: part.text },
                })
              }
            }
          },

          onReasoningDelta: (delta) => {
            accumulatedReasoning += delta
            this.session.append('assistant/chunk', {
              turn,
              step,
              chunk: { type: 'reasoning-delta', index: 0, text: delta },
            })
          },

          onItemStarted: (item: CodexTurnItem) => {
            if (item.type === 'commandExecution') {
              this.session.append('tool/call', {
                turn,
                step,
                callId: brandString<ToolCallId>(item.id),
                name: 'bash',
                arguments: JSON.stringify({ command: item.command ?? '' }),
              })
            } else if (item.type === 'fileChange') {
              const firstChange = item.changes?.[0]
              this.session.append('tool/call', {
                turn,
                step,
                callId: brandString<ToolCallId>(item.id),
                name: 'patch',
                arguments: JSON.stringify({ path: firstChange?.path ?? 'workspace' }),
              })
            } else if (item.type === 'mcpToolCall') {
              this.session.append('tool/call', {
                turn,
                step,
                callId: brandString<ToolCallId>(item.id),
                name: `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`,
                arguments: JSON.stringify(item.arguments ?? {}),
              })
            }
          },

          onItemCompleted: (item: CodexTurnItem) => {
            if (item.type === 'commandExecution') {
              this.session.append(
                'tool/result',
                {
                  turn,
                  step,
                  message: createToolResultMessage({
                    callId: brandString<ToolCallId>(item.id),
                    content: [{ type: 'text', text: item.aggregatedOutput ?? '' }],
                    isError: item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0,
                  }),
                },
                { surfaceOp: 'append' },
              )
            } else if (item.type === 'fileChange') {
              const diffText = item.changes?.map((c) => c.diff).filter(Boolean).join('\n')
              const summary = item.changes?.map((c) => `Updated ${c.path}`).join(', ') || 'Files updated'
              this.session.append(
                'tool/result',
                {
                  turn,
                  step,
                  message: createToolResultMessage({
                    callId: brandString<ToolCallId>(item.id),
                    content: [{ type: 'text', text: summary }],
                    isError: false,
                  }),
                  ...(diffText ? { meta: { patch: diffText } } : {}),
                },
                { surfaceOp: 'append' },
              )
            } else if (item.type === 'mcpToolCall') {
              this.session.append(
                'tool/result',
                {
                  turn,
                  step,
                  message: createToolResultMessage({
                    callId: brandString<ToolCallId>(item.id),
                    content: [{ type: 'text', text: JSON.stringify(item.result ?? item.error ?? '') }],
                    isError: Boolean(item.error),
                  }),
                },
                { surfaceOp: 'append' },
              )
            }
          },

          onTokenUsage: (usage) => {
            lastTokenUsage = usage
          },
        },
        signal,
      )

      if (result.status === 'failed' && attempt < maxAttempts) {
        const errMsg = result.error?.message ?? ''
        if (AdaptiveParamSanitizer.isParamCompatibilityError(errMsg)) {
          const provider = this.options.provider ?? 'opencode-go'
          const model = this.options.model ?? 'muse-spark-1.3-contributor'
          const learned = AdaptiveParamSanitizer.learnFromFailure(provider, model, errMsg)
          if (learned.recovered) {
            console.warn(
              `[codex-agent] Auto-healed incompatible parameter "${learned.offendingParam}" for model "${model}". Recompiling configuration and retrying turn...`,
            )
            compileProvidersConfig(model, provider)
            continue
          }
        }
      }
      break
    }

    for (const part of normalizer.flush()) {
      if (part.type === 'reasoning') {
        accumulatedReasoning += part.text
        this.session.append('assistant/chunk', {
          turn,
          step,
          chunk: { type: 'reasoning-delta', index: 0, text: part.text },
        })
      } else {
        accumulatedText += part.text
        this.session.append('assistant/chunk', {
          turn,
          step,
          chunk: { type: 'text-delta', index: 0, text: part.text },
        })
      }
    }

    // 4. Finalize assistant message with reasoning, text, and token accounting
    const contentBlocks: ContentBlock[] = []
    if (accumulatedReasoning.trim().length > 0) {
      contentBlocks.push({ type: 'reasoning', text: accumulatedReasoning })
    }
    const finalReply = result?.finalMessageText || accumulatedText
    if (finalReply.trim().length > 0) {
      contentBlocks.push({ type: 'text', text: finalReply })
    }

    if (contentBlocks.length > 0) {
      const usage = lastTokenUsage ?? result?.usage
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message: createAssistantMessage({
            content: contentBlocks,
            source: {
              provider: this.options.provider ?? 'opencode-go',
              model: this.options.model ?? 'muse-spark-1.3-contributor',
            },
          }),
          ...(usage
            ? {
                usage: {
                  inputTokens: Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)),
                  outputTokens: usage.outputTokens ?? 0,
                  totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
                  ...(usage.cachedInputTokens !== undefined ? { cacheReadTokens: usage.cachedInputTokens } : {}),
                  ...(usage.reasoningOutputTokens !== undefined ? { reasoningTokens: usage.reasoningOutputTokens } : {}),
                },
              }
            : {}),
        },
        { surfaceOp: 'append' },
      )
    }

    if (!result || result.status === 'interrupted') {
      return { kind: 'aborted', reason: { kind: 'user' } }
    }
    if (result.status === 'failed') {
      return {
        kind: 'error',
        error: { message: result.error?.message ?? 'Codex turn failed', code: 'UNKNOWN' },
      }
    }
    return { kind: 'completed' }
  }
}
