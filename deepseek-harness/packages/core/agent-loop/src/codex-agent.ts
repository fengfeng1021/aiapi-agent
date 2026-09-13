/**
 * CodexLoopAgent: Drives session turns via the Codex App-Server backend,
 * translating Codex streaming deltas, tool executions, token metrics, and
 * completions into standard DeepSeek Harness SessionEvents for UI rendering.
 *
 * @module dsh-agent-loop/codex-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
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
import type { ContentBlock, LlmFailure, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry/types'
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
  CodexThreadGoneError,
  type CodexAppServerDaemon,
  type CodexThreadToolOwner,
  type CodexTurnInput,
  type CodexTurnItem,
  type CodexTokenUsage,
  type CodexTurnResult,
} from './codex-server.ts'
import {
  DELEGATE_TOOL_NAME,
  executeDelegation,
  parseDelegateArguments,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
} from './codex-delegation.ts'
import { AdaptiveParamSanitizer } from './param-sanitizer.ts'
import { capabilityStore, inferDefaultCapabilities } from './provider-probe.ts'
import {
  GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS,
  isGatewayRateLimitError,
  withRateLimitHint,
} from './rate-limit.ts'

/**
 * Policy key naming this path's gateway-429 backoff chain in llm/retry
 * records. Distinct from provider-policy keys so the native retry plugin's
 * per-policy chains never collide with these daemon-driven attempts.
 */
const GATEWAY_429_POLICY_KEY = 'codex-gateway-429'

/**
 * Thread continuation input after a tool-involving rate limit. The failed
 * request's tool results already sit in the thread history, so the model
 * picks up where it stopped instead of re-executing anything. Never written
 * to our session log: only the continuation's own deltas land there, in
 * chronological order below the earlier rows.
 */
const CONTINUATION_PROMPT = '（系統自動繼續：上一輪模型請求遇到網關限流（429）中斷，對話記錄中已有本輪的上下文與工具結果。請基於已有上下文繼續完成任務，不要重複已經執行過的工具調用。）'

/**
 * Standing thread-level delivery style so every model answers like a
 * plain-language product update: what functionally changed and how the
 * workflow behaves, never file paths, code nouns, or schema names. Sent
 * once per thread through developer_instructions (protocol-native; older
 * app-servers ignore the unknown field), so per-turn inputs stay untouched.
 */
const DELIVERY_STYLE_INSTRUCTIONS = '工作時用一句話同步進度即可。給使用者的總結必須用白話文：只說功能上完成了什麼、操作或運作邏輯上有什麼變化，讓不懂程式的人也能看懂；不要出現檔案路徑、程式碼名詞、資料結構或設定欄位名稱，也不要複述這段要求。互相無關的工具在同一輪一起叫，不用等前一個回來；有依賴的才排隊。'

/**
 * Sleep that aborts with the turn's cancellation, so a user interrupt during
 * a rate-limit backoff ends the turn instead of surfacing a turn error.
 * @param ms - backoff delay.
 * @param signal - the turn's abort signal.
 */
function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      try {
        signal.throwIfAborted()
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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
  /** Pressure-compaction failure messages already warned about (warn once). */
  private readonly pressureWarnings = new Set<string>()
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
    const provider = this.options.provider ?? 'opencode-go'
    const model = this.options.model ?? 'muse-spark-1.3-contributor'
    const header = canonicalHeader({
      config: { provider, model },
      system: 'Codex Autonomous Agent Engine',
      tools: [],
    })
    try {
      this.session.append('request/header', { header, reason: 'initial' })
      const capability = capabilityStore.get(provider, model) ?? inferDefaultCapabilities(provider, model)
      this.session.append('request/context', {
        provider,
        model,
        // Real model capacity (not a placeholder): the context meter and any
        // reader derive the displayed window from this event. Inference always
        // sizes known models; the fallback only covers a total miss.
        contextWindow: capability.contextWindow ?? 128000,
      })
    } catch {
      // Ignore duplicate request header log
    }
  }

  /**
   * Run one dsh-side pressure-compaction check before the Codex turn, mirroring
   * the native loop's pre-step pressure hook (which never fires on this path
   * because no agent/pre-step waterfall runs here). Failures only warn: a
   * compaction outage must never block the turn.
   * @param signal - the turn's abort signal.
   */
  private async maybePressureCompact(signal: AbortSignal): Promise<void> {
    const compaction = this.loopCtx.get('compaction')
    if (compaction === undefined) return
    const agent: CompactionAgentContext = {
      session: this.session,
      options: {
        ...this.options.provider === undefined ? {} : { provider: this.options.provider },
        ...this.options.model === undefined ? {} : { model: this.options.model },
      },
    }
    try {
      const result = await compaction.compactIfNeeded(agent, 'pressure', signal)
      if (result !== null) {
        this.loopCtx.logger?.info?.(
          `codex pressure compaction: shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`,
        )
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.pressureWarnings.has(message)) {
        this.pressureWarnings.add(message)
        this.loopCtx.logger?.warn?.(`codex pressure compaction failed: ${message}; continuing the turn`)
      }
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
        await this.maybePressureCompact(signal)
        turnEnds = await this.executeCodexTurn(turn, step, claimed, signal)
      } finally {
        // executeCodexTurn advances phase.step as post-tool text opens new
        // rounds; always close whichever step is open (same object).
        this.session.append('step/end', { turn, step: phase.step })
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

  /**
   * Resolve pasted image attachments to Codex turn input items. Host-backed
   * attachments travel by filesystem path so the app-server encodes them;
   * anything else is inlined as a data URL from verified stored bytes.
   * Unresolvable images are skipped so one bad attachment never fails a turn.
   * @param refs - durable image references in user-message order.
   * @returns turn input items in the same order.
   */
  private async resolveTurnImages(refs: readonly ImageAttachmentRef[]): Promise<CodexTurnInput[]> {
    if (refs.length === 0) return []
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) return []
    const items: CodexTurnInput[] = []
    for (const ref of refs) {
      try {
        const hostPath = attachments.imageHostPath(ref)
        if (hostPath !== undefined) {
          items.push({ type: 'localImage', path: hostPath })
          continue
        }
        const stored = await attachments.readImage(ref)
        const base64 = Buffer.from(stored.data).toString('base64')
        items.push({ type: 'image', url: `data:${stored.ref.mediaType};base64,${base64}` })
      } catch {
        continue
      }
    }
    return items
  }

  /**
   * Resolve the Codex thread for the next turn, creating it on first use.
   * The id is cached: threads stay conversational across turns until the
   * daemon restarts underneath us (see the thread-gone recovery below).
   * @returns the live thread id.
   */
  private async ensureThread(): Promise<string> {
    if (this.threadId === undefined) {
      const permissionMode = (process.env.DSH_PERMISSION_MODE as 'read-only' | 'workspace-write' | 'danger-full-access') ?? 'workspace-write'
      const approvalPolicy = permissionMode === 'danger-full-access' ? 'never' : 'on-request'

      this.threadId = await this.daemon.createThread({
        cwd: this.session.header.cwd,
        model: this.options.model ?? 'muse-spark-1.3-contributor',
        modelProvider: this.options.provider ?? 'opencode-go',
        sandbox: permissionMode,
        approvalPolicy,
        developerInstructions: DELIVERY_STYLE_INSTRUCTIONS,
      })
    }
    return this.threadId
  }

  /**
   * Execute one Codex dynamic tool call against the host subagents service.
   * Runs with the owning turn's cancellation; every execution fault resolves
   * to a model-visible failure result, while malformed calls and a missing
   * service reject loudly.
   * @param params - wire `item/tool/call` params.
   * @param signal - the owning turn's cancellation, if it provided one.
   * @returns the wire response object resuming the model.
   */
  private async executeDelegateTool(
    params: DynamicToolCallParams,
    signal?: AbortSignal,
  ): Promise<DynamicToolCallResponse> {
    if (params.tool !== DELEGATE_TOOL_NAME) {
      throw new Error(`unknown Codex dynamic tool: ${params.tool}`)
    }
    const subagents = this.loopCtx.get('subagents')
    if (subagents === undefined) {
      throw new Error('subagent service is unavailable in this composition')
    }
    const result = await executeDelegation(
      subagents,
      this,
      parseDelegateArguments(params.arguments),
      signal,
    )
    return {
      contentItems: [{ type: 'inputText', text: result.text }],
      success: result.success,
    }
  }

  private async executeCodexTurn(
    turn: number,
    step: number,
    claimed: UserMessage[],
    signal: AbortSignal,
  ): Promise<TurnEndReason> {
    // 1. The Codex thread resolves inside the drive loop below, so a
    // thread-gone recovery recreates it before retrying the same input.

    // 2. Extract text and image attachments from user messages. Image blocks
    // must travel as turn input items; dropping them here blinds the model
    // to pasted images no matter what the provider supports downstream.
    const promptLines: string[] = []
    const imageRefs: ImageAttachmentRef[] = []
    for (const msg of claimed) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          promptLines.push(block.text)
        } else if (block.type === 'image') {
          imageRefs.push(block.attachment)
        }
      }
    }
    const userPrompt = promptLines.join('\n\n')

    let accumulatedReasoning = ''
    let accumulatedText = ''
    let lastTokenUsage: CodexTokenUsage | undefined
    let normalizer = new StreamingThinkingNormalizer()
    let result: CodexTurnResult | undefined

    const maxAttempts = 2
    let attempt = 0
    let rateLimitRetries = 0
    // Round tracking: one Session step per model→tools round, mirroring the
    // native loop so post-tool progress text renders after the tool rows in
    // time order instead of merging into the first bubble.
    let currentStep = step
    let sawToolActivity = false
    let stepMessaged = false
    let lastStepContent: ContentBlock[] | undefined
    // Sticky across attempts: once any tool executes this turn, only thread
    // continuations (never full re-sends) may follow a rate limit.
    let turnUsedTools = false
    // Per-step llm/retry chain state: a fresh retryId per step keeps each
    // step's backoff chain conformant with the retry-record invariant.
    let stepRetryCount = 0
    let stepRetryId: RetryId | undefined
    // The input of the codex turn currently being driven: the user's prompt,
    // or the continuation nudge after a tool-involving rate limit.
    let turnInput: CodexTurnInput[] = []
    if (userPrompt !== '') turnInput.push({ type: 'text', text: userPrompt })
    for (const image of await this.resolveTurnImages(imageRefs)) turnInput.push(image)
    if (turnInput.length === 0) turnInput = [{ type: 'text', text: 'Hello' }]

    const messageSource = () => ({
      provider: this.options.provider ?? 'opencode-go',
      model: this.options.model ?? 'muse-spark-1.3-contributor',
    })
    /** Text accumulated since the last round boundary, as message blocks. */
    const buildStepContent = (): ContentBlock[] => {
      const blocks: ContentBlock[] = []
      if (accumulatedReasoning.trim().length > 0) blocks.push({ type: 'reasoning', text: accumulatedReasoning })
      if (accumulatedText.trim().length > 0) blocks.push({ type: 'text', text: accumulatedText })
      return blocks
    }
    /**
     * Close the current round's prose with its own message BEFORE its tool
     * rows land, so the settled bubble anchors before the tools. No-op for
     * tool-only rounds and once per round.
     */
    const settleStepText = (): void => {
      if (stepMessaged) return
      const content = buildStepContent()
      if (content.length === 0) return
      lastStepContent = content
      this.session.append(
        'assistant/message',
        { turn, step: currentStep, message: createAssistantMessage({ content, source: messageSource() }) },
        { surfaceOp: 'append' },
      )
      stepMessaged = true
    }
    /**
     * Open a new round when model text resumes after tool activity. Lazy:
     * tool-only rounds never open an empty step.
     */
    const bumpStepForPostToolText = (): void => {
      if (!sawToolActivity) return
      sawToolActivity = false
      this.session.append('step/end', { turn, step: currentStep })
      currentStep += 1
      if (this.phase.kind === 'running') this.phase.step = currentStep
      stepMessaged = false
      stepRetryCount = 0
      stepRetryId = undefined
      accumulatedReasoning = ''
      accumulatedText = ''
      this.session.append('step/start', { turn, step: currentStep })
    }

    while (attempt < maxAttempts) {
      attempt++
      // Fresh response state per drive; step-scoped facts (currentStep,
      // sawToolActivity, settled messages, retry chains) persist because
      // steps outlive attempts: a continuation keeps appending to them.
      accumulatedReasoning = ''
      accumulatedText = ''
      lastTokenUsage = undefined
      normalizer = new StreamingThinkingNormalizer()

      // 3. Dispatch to Codex and stream events into session. A thread-gone
      // rejection means the daemon restarted underneath us: drop the stale
      // id, create a fresh thread, and drive this attempt's input there.
      const threadId = await this.ensureThread()
      const toolOwner: CodexThreadToolOwner = {
        executeDynamicTool: (params, signal) => this.executeDelegateTool(params, signal),
      }
      try {
        result = await this.daemon.startTurn(
          threadId,
          turnInput,
          {
            onAgentMessageDelta: (delta) => {
              const parts = normalizer.feedContent(delta)
              if (parts.length === 0) return
              bumpStepForPostToolText()
              for (const part of parts) {
                if (part.type === 'reasoning') {
                  accumulatedReasoning += part.text
                  this.session.append('assistant/chunk', {
                    turn,
                    step: currentStep,
                    chunk: { type: 'reasoning-delta', index: 0, text: part.text },
                  })
                } else {
                  accumulatedText += part.text
                  this.session.append('assistant/chunk', {
                    turn,
                    step: currentStep,
                    chunk: { type: 'text-delta', index: 0, text: part.text },
                  })
                }
              }
            },

            onReasoningDelta: (delta) => {
              if (delta === '') return
              bumpStepForPostToolText()
              accumulatedReasoning += delta
              this.session.append('assistant/chunk', {
                turn,
                step: currentStep,
                chunk: { type: 'reasoning-delta', index: 0, text: delta },
              })
            },

            onItemStarted: (item: CodexTurnItem) => {
              if (item.type === 'commandExecution') {
                settleStepText()
                sawToolActivity = true
                turnUsedTools = true
                this.session.append('tool/call', {
                  turn,
                  step: currentStep,
                  callId: brandString<ToolCallId>(item.id),
                  name: 'bash',
                  arguments: JSON.stringify({ command: item.command ?? '' }),
                })
              } else if (item.type === 'fileChange') {
                settleStepText()
                sawToolActivity = true
                turnUsedTools = true
                const firstChange = item.changes?.[0]
                this.session.append('tool/call', {
                  turn,
                  step: currentStep,
                  callId: brandString<ToolCallId>(item.id),
                  name: 'patch',
                  arguments: JSON.stringify({ path: firstChange?.path ?? 'workspace' }),
                })
              } else if (item.type === 'mcpToolCall') {
                settleStepText()
                sawToolActivity = true
                turnUsedTools = true
                this.session.append('tool/call', {
                  turn,
                  step: currentStep,
                  callId: brandString<ToolCallId>(item.id),
                  name: `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`,
                  arguments: JSON.stringify(item.arguments ?? {}),
                })
              } else if (item.type === 'dynamicToolCall') {
                settleStepText()
                sawToolActivity = true
                turnUsedTools = true
                this.session.append('tool/call', {
                  turn,
                  step: currentStep,
                  callId: brandString<ToolCallId>(item.id),
                  name: item.namespace == null ? (item.tool ?? 'tool') : `${item.namespace}:${item.tool ?? 'tool'}`,
                  arguments: JSON.stringify(item.arguments ?? {}),
                })
              }
            },

            onItemCompleted: (item: CodexTurnItem) => {
              if (item.type === 'commandExecution') {
                sawToolActivity = true
                turnUsedTools = true
                this.session.append(
                  'tool/result',
                  {
                    turn,
                    step: currentStep,
                    message: createToolResultMessage({
                      callId: brandString<ToolCallId>(item.id),
                      content: [{ type: 'text', text: item.aggregatedOutput ?? '' }],
                      isError: item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0,
                    }),
                  },
                  { surfaceOp: 'append' },
                )
              } else if (item.type === 'fileChange') {
                sawToolActivity = true
                turnUsedTools = true
                const diffText = item.changes?.map((c) => c.diff).filter(Boolean).join('\n')
                const summary = item.changes?.map((c) => `Updated ${c.path}`).join(', ') || 'Files updated'
                this.session.append(
                  'tool/result',
                  {
                    turn,
                    step: currentStep,
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
                sawToolActivity = true
                turnUsedTools = true
                this.session.append(
                  'tool/result',
                  {
                    turn,
                    step: currentStep,
                    message: createToolResultMessage({
                      callId: brandString<ToolCallId>(item.id),
                      content: [{ type: 'text', text: JSON.stringify(item.result ?? item.error ?? '') }],
                      isError: Boolean(item.error),
                    }),
                  },
                  { surfaceOp: 'append' },
                )
              } else if (item.type === 'dynamicToolCall') {
                sawToolActivity = true
                turnUsedTools = true
                const text = (item.contentItems ?? [])
                  .map(part => typeof part?.text === 'string' ? part.text : JSON.stringify(part ?? ''))
                  .join('\n\n')
                this.session.append(
                  'tool/result',
                  {
                    turn,
                    step: currentStep,
                    message: createToolResultMessage({
                      callId: brandString<ToolCallId>(item.id),
                      content: [{ type: 'text', text }],
                      isError: item.success === false,
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
        toolOwner,
      )
      } catch (error: unknown) {
        // The thread this attempt drove is gone (daemon restarted): drop the
        // stale id so the next pass creates a fresh thread for the same
        // input. Anything else — or a second miss inside the retry budget —
        // fails the turn loudly.
        if (!(error instanceof CodexThreadGoneError)
          || error.threadId !== threadId
          || attempt >= maxAttempts) {
          throw error
        }
        this.threadId = undefined
        continue
      }

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
      if (result.status === 'failed' && isGatewayRateLimitError(result.error?.message ?? '')) {
        if (rateLimitRetries < GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length) {
          const raw = result.error?.message ?? ''
          const delayMs = GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS[rateLimitRetries] ?? 120_000
          rateLimitRetries++
          // A step that already settled its message keeps it: only a pure
          // partial (text with no message yet) hides cleanly through the
          // llm/retry record, mirroring the native loop.
          const hidePartial = !stepMessaged
          let retryId: RetryId | undefined
          if (hidePartial) {
            stepRetryCount += 1
            stepRetryId ??= brandString<RetryId>(randomUUID())
            retryId = stepRetryId
            const failure: LlmFailure = { message: raw, code: 'RATE_LIMIT', status: 429 }
            this.session.append('llm/retry', {
              retryId,
              turn,
              step: currentStep,
              provider: this.options.provider ?? 'opencode-go',
              mode: 'normal',
              policyKey: GATEWAY_429_POLICY_KEY,
              retry: stepRetryCount,
              maxRetries: GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length,
              delayMs,
              failure,
            })
          }
          const resend = !turnUsedTools
          console.warn(
            `[codex-agent] Gateway rate limited (429) for model "${this.options.model ?? 'muse-spark-1.3-contributor'}". Backing off ${delayMs}ms before ${resend ? 'retry' : 'thread continuation'} ${rateLimitRetries}/${GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS.length}...`,
          )
          await sleepWithSignal(delayMs, signal)
          if (hidePartial && retryId !== undefined) {
            this.session.append('llm/retry-started', {
              retryId,
              turn,
              step: currentStep,
              retry: stepRetryCount,
            })
          }
          if (!resend) {
            // Tools already executed: re-sending would run them twice. Drive
            // a continuation on the same thread instead — its history already
            // holds the tool results, so the model picks up where the failed
            // request stopped. Not logged to our session: the continuation's
            // own deltas land chronologically below.
            accumulatedReasoning = ''
            accumulatedText = ''
            normalizer = new StreamingThinkingNormalizer()
            turnInput = [{ type: 'text', text: CONTINUATION_PROMPT }]
          }
          // Rate-limit backoff rides outside the param-heal attempt budget: a
          // throttled turn must not spend the attempts reserved for healing.
          attempt--
          continue
        }
      }
      break
    }

    for (const part of normalizer.flush()) {
      if (part.type === 'reasoning') {
        accumulatedReasoning += part.text
        this.session.append('assistant/chunk', {
          turn,
          step: currentStep,
          chunk: { type: 'reasoning-delta', index: 0, text: part.text },
        })
      } else {
        accumulatedText += part.text
        this.session.append('assistant/chunk', {
          turn,
          step: currentStep,
          chunk: { type: 'text-delta', index: 0, text: part.text },
        })
      }
    }

    // 4. Finalize the closing round's message with reasoning, text, and token
    // accounting. Earlier rounds already settled their own messages when their
    // tools landed, so each bubble keeps only its round's prose in time order.
    // A turn that dies right after its tools restates the last settled round
    // so the usage still has a message to ride on; an identical restatement
    // with no usage is skipped so the log keeps one copy.
    const closingBlocks: ContentBlock[] = []
    if (accumulatedReasoning.trim().length > 0) {
      closingBlocks.push({ type: 'reasoning', text: accumulatedReasoning })
    }
    const finalReply = result?.finalMessageText || accumulatedText
    if (finalReply.trim().length > 0) {
      closingBlocks.push({ type: 'text', text: finalReply })
    }
    const usage = lastTokenUsage ?? result?.usage
    const identicalToSettled = stepMessaged
      && lastStepContent !== undefined
      && JSON.stringify(closingBlocks) === JSON.stringify(lastStepContent)
    let effectiveBlocks: ContentBlock[] = []
    if (closingBlocks.length > 0 && !identicalToSettled) {
      effectiveBlocks = closingBlocks
    } else if (usage !== undefined && (closingBlocks.length > 0 || stepMessaged)) {
      effectiveBlocks = closingBlocks.length > 0 ? closingBlocks : (lastStepContent ?? [])
    }

    if (effectiveBlocks.length > 0) {
      this.session.append(
        'assistant/message',
        {
          turn,
          step: currentStep,
          message: createAssistantMessage({
            content: effectiveBlocks,
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
      const raw = result.error?.message ?? 'Codex turn failed'
      return {
        kind: 'error',
        error: { message: withRateLimitHint(raw), code: 'UNKNOWN' },
      }
    }
    return { kind: 'completed' }
  }
}
