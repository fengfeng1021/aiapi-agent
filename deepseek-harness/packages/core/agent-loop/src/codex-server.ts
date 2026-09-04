/**
 * Codex App-Server lifecycle and JSON-RPC multiplexer for DeepSeek Harness.
 *
 * Spawns and supervises `aiapi app-server --stdio`, manages threads and turns,
 * handles server-initiated approval requests, and routes item notifications.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { capabilityStore, inferDefaultCapabilities } from './provider-probe.js'
import { AdaptiveParamSanitizer } from './param-sanitizer.js'
import { UniversalResponsesBridge } from './responses-bridge.js'

export interface CodexTokenUsage {
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}

export interface CodexTurnItem {
  type: string
  id: string
  command?: string
  cwd?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
  changes?: Array<{ path: string; kind?: string; diff?: string }>
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  text?: string
  phase?: string | null
}

export interface CodexTurnHandlers {
  onAgentMessageDelta?(delta: string, itemId: string): void
  onReasoningDelta?(delta: string, itemId: string): void
  onCommandOutputDelta?(delta: string, itemId: string): void
  onItemStarted?(item: CodexTurnItem, itemId: string): void
  onItemCompleted?(item: CodexTurnItem, itemId: string): void
  onTokenUsage?(usage: CodexTokenUsage): void
  onApprovalRequest?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export interface CodexTurnResult {
  status: 'completed' | 'interrupted' | 'failed'
  items: CodexTurnItem[]
  finalMessageText?: string
  usage?: CodexTokenUsage
  error?: { message: string } | null
}

export function findCodexBinary(): string {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN
  }
  if (process.env.AIAPI_BIN && existsSync(process.env.AIAPI_BIN)) {
    return process.env.AIAPI_BIN
  }
  const root = resolve(process.cwd(), '..')
  const candidates = [
    resolve(process.cwd(), 'codex-rs/target/debug/aiapi.exe'),
    resolve(process.cwd(), 'codex-rs/target/release/aiapi.exe'),
    resolve(root, 'codex-rs/target/debug/aiapi.exe'),
    resolve(root, 'codex-rs/target/release/aiapi.exe'),
    resolve(root, 'codex-rs/target/debug/codex.exe'),
    resolve(root, 'codex-rs/target/release/codex.exe'),
    'd:/Desktop/App/Aiapi Agent/codex-rs/target/debug/aiapi.exe',
    'd:/Desktop/App/Aiapi Agent/codex-rs/target/release/aiapi.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // 1. Resolve via subagent-codex which has @openai/codex as a direct dependency
  try {
    const subagentRun = resolve(process.cwd(), 'packages/subagent/subagent-codex/src/run.ts')
    if (existsSync(subagentRun)) {
      const codexPkgPath = createRequire(subagentRun).resolve('@openai/codex/package.json')
      const codexPkg = JSON.parse(readFileSync(codexPkgPath, 'utf8')) as { bin?: { codex?: string } }
      if (codexPkg?.bin?.codex) {
        const bin = resolve(dirname(codexPkgPath), codexPkg.bin.codex)
        if (existsSync(bin)) return bin
      }
    }
  } catch {}

  // 2. Direct pnpm candidates
  const directBinaries = [
    resolve(process.cwd(), 'node_modules/.pnpm/@openai+codex@0.149.1/node_modules/@openai/codex/bin/codex.js'),
    resolve(process.cwd(), 'node_modules/.pnpm/@openai+codex@0.149.1/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
    'D:/Desktop/App/Aiapi Agent/deepseek-harness/node_modules/.pnpm/@openai+codex@0.149.1/node_modules/@openai/codex/bin/codex.js',
    'D:/Desktop/App/Aiapi Agent/deepseek-harness/node_modules/.pnpm/@openai+codex@0.149.1/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  ]
  for (const bin of directBinaries) {
    if (existsSync(bin)) return bin
  }

  return 'aiapi'
}

export interface ProviderEntry {
  name: string
  baseUrl: string
  wireApi?: string | undefined
  apiKey?: string | undefined
  envKey?: string | undefined
  requiresOpenaiAuth?: boolean | undefined
}

/**
 * Compiles an open, platform-agnostic provider configuration for Codex App-Server.
 * Scans Opencode credentials, Harness settings, and environment variables.
 * Writes to an isolated CODEX_HOME to completely decouple from any local ChatGPT OAuth session.
 */
export function compileProvidersConfig(targetModel?: string, targetProvider?: string): { codexHome: string; providers: Record<string, ProviderEntry> } {
  let activeModel = targetModel || 'muse-spark-1.3-contributor'
  let activeProvider = targetProvider || 'opencode-go'
  const codexHome = process.env.CODEX_ISOLATED_HOME || join(homedir(), '.dsh', 'codex-isolated')
  if (!existsSync(codexHome)) {
    mkdirSync(codexHome, { recursive: true })
  }

  const providers: Record<string, ProviderEntry> = {
    'opencode-go': {
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      wireApi: 'responses',
      requiresOpenaiAuth: false,
    },
    'opencode-zen': {
      name: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/zen/v1',
      wireApi: 'responses',
      requiresOpenaiAuth: false,
    },
    'aiapi': {
      name: 'Aiapi',
      baseUrl: 'https://aiapi.tw/v1',
      wireApi: 'responses',
      envKey: 'AIAPI_API_KEY',
      requiresOpenaiAuth: false,
    },
    'deepseek': {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      wireApi: 'responses',
      envKey: 'DEEPSEEK_API_KEY',
      requiresOpenaiAuth: false,
    },
    'gemini': {
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      wireApi: 'responses',
      envKey: 'GEMINI_API_KEY',
      requiresOpenaiAuth: false,
    },
    'anthropic': {
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      wireApi: 'responses',
      envKey: 'ANTHROPIC_API_KEY',
      requiresOpenaiAuth: false,
    },
    'openai': {
      name: 'OpenAI API',
      baseUrl: 'https://api.openai.com/v1',
      wireApi: 'responses',
      envKey: 'OPENAI_API_KEY',
      requiresOpenaiAuth: false,
    },
    'ollama': {
      name: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      wireApi: 'responses',
      requiresOpenaiAuth: false,
    },
    'lmstudio': {
      name: 'LM Studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      wireApi: 'responses',
      requiresOpenaiAuth: false,
    },
  }

  // 1. Scan ~/.local/share/opencode/auth.json for API keys
  try {
    const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
    if (existsSync(authPath)) {
      const authData = JSON.parse(readFileSync(authPath, 'utf8'))
      for (const [pid, record] of Object.entries(authData)) {
        const key = (record as { key?: string; apiKey?: string; token?: string })?.key
          || (record as { key?: string; apiKey?: string; token?: string })?.apiKey
          || (record as { key?: string; apiKey?: string; token?: string })?.token
        if (key && typeof key === 'string') {
          if (!providers[pid]) {
            providers[pid] = {
              name: pid,
              baseUrl: pid.includes('opencode') ? 'https://opencode.ai/zen/go/v1' : 'https://api.openai.com/v1',
              wireApi: 'responses',
              apiKey: key,
              requiresOpenaiAuth: false,
            }
          } else {
            providers[pid].apiKey = key
          }
        }
      }
    }
  } catch (err) {
    console.warn('[codex-server] Could not load opencode auth.json:', err)
  }

  // 2. Scan ~/.config/opencode/opencode.json
  try {
    const opencodeJsonPath = join(homedir(), '.config', 'opencode', 'opencode.json')
    if (existsSync(opencodeJsonPath)) {
      const raw = readFileSync(opencodeJsonPath, 'utf8')
      const clean = raw.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '')
      const opencodeCfg = JSON.parse(clean)
      if (opencodeCfg.provider && typeof opencodeCfg.provider === 'object') {
        for (const [pid, pcfg] of Object.entries<{ name?: string; options?: { baseURL?: string; base_url?: string; apiKey?: string; api_key?: string } }>(opencodeCfg.provider)) {
          const bUrl = pcfg?.options?.baseURL || pcfg?.options?.base_url
          const aKey = pcfg?.options?.apiKey || pcfg?.options?.api_key
          const effectiveApiKey = aKey || undefined
          if (!providers[pid]) {
            providers[pid] = {
              name: pcfg?.name || pid,
              baseUrl: bUrl || 'https://opencode.ai/zen/go/v1',
              wireApi: 'responses',
              ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
              requiresOpenaiAuth: false,
            }
          } else {
            const current = providers[pid]
            if (current) {
              if (bUrl) current.baseUrl = bUrl
              if (effectiveApiKey) current.apiKey = effectiveApiKey
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[codex-server] Could not load opencode.json:', err)
  }

  // 3. Scan ~/.dsh/settings.yaml
  try {
    const settingsYamlPath = join(homedir(), '.dsh', 'settings.yaml')
    if (existsSync(settingsYamlPath)) {
      const yamlContent = readFileSync(settingsYamlPath, 'utf8')
      const lines = yamlContent.split('\n')
      let inPiAiProviders = false
      let currentProviderId = ''

      for (const line of lines) {
        if (/^\s*providers:\s*$/.test(line)) {
          inPiAiProviders = true
          continue
        }
        if (inPiAiProviders) {
          const providerMatch = line.match(/^ {6}([a-zA-Z0-9_-]+):\s*$/)
          if (providerMatch && providerMatch[1]) {
            currentProviderId = providerMatch[1]
            if (!providers[currentProviderId]) {
              providers[currentProviderId] = {
                name: currentProviderId,
                baseUrl: '',
                wireApi: 'responses',
                requiresOpenaiAuth: false,
              }
            }
            continue
          }
          if (/^ {0,5}\S/.test(line)) {
            inPiAiProviders = false
            currentProviderId = ''
            continue
          }
          const p = currentProviderId ? providers[currentProviderId] : undefined
          if (p) {
            const baseMatch = line.match(/baseURL:\s*(.+)$/)
            if (baseMatch && baseMatch[1]) {
              const url = baseMatch[1].trim().replace(/^['"]|['"]$/g, '')
              if (url) p.baseUrl = url
            }
            const envMatch = line.match(/apiKeyEnv:\s*(.+)$/)
            if (envMatch && envMatch[1]) {
              const envKey = envMatch[1].trim().replace(/^['"]|['"]$/g, '')
              if (envKey) p.envKey = envKey
            }
          }
        }
      }

      const defaultModelMatch = yamlContent.match(/agent-default-model:\s*\n\s*provider:\s*([^\n]+)\s*\n\s*model:\s*([^\n]+)/)
      if (defaultModelMatch) {
        if (!targetProvider && defaultModelMatch[1]) activeProvider = defaultModelMatch[1].trim()
        if (!targetModel && defaultModelMatch[2]) activeModel = defaultModelMatch[2].trim()
      }
    }
  } catch (err) {
    console.warn('[codex-server] Could not parse settings.yaml:', err)
  }

  // 4. Scan environment variables
  for (const [pid, p] of Object.entries(providers)) {
    const defaultEnv = `${pid.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    const defaultVal = process.env[defaultEnv]
    if (defaultVal && !p.apiKey) {
      p.apiKey = defaultVal
    }
    const envKeyVal = p.envKey ? process.env[p.envKey] : undefined
    if (envKeyVal && !p.apiKey) {
      p.apiKey = envKeyVal
    }
  }

  const RESERVED_PROVIDER_IDS = new Set([
    'openai',
    'ollama',
    'lmstudio',
    'amazon-bedrock',
    'amazon-bedrock-runtime',
  ])

  // 5. Connect and route via Universal Responses Bridge for chat-only providers
  const bridge = UniversalResponsesBridge.getInstance()
  for (const [rawPid, p] of Object.entries(providers)) {
    if (!p.baseUrl) continue
    const pid = RESERVED_PROVIDER_IDS.has(rawPid) ? `${rawPid}-custom` : rawPid
    const cap = capabilityStore.get(rawPid, activeModel) || inferDefaultCapabilities(rawPid, activeModel, p.baseUrl)

    if (p.wireApi === 'chat' || cap.wireProtocol === 'chat') {
      bridge.registerTarget({
        id: pid,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
      })
      try {
        p.baseUrl = bridge.getBridgeBaseUrl(pid)
        p.wireApi = 'responses'
      } catch {
        // Bridge starts asynchronously during daemon start
      }
    }
  }

  // 6. Generate config.toml with Adaptive Parameter Sanitization
  const effectiveDefaultPid = RESERVED_PROVIDER_IDS.has(activeProvider) ? `${activeProvider}-custom` : activeProvider
  const sanitized = AdaptiveParamSanitizer.sanitize(activeProvider, activeModel)

  const tomlLines: string[] = [
    '# Auto-generated by deepseek-harness CodexAppServerDaemon',
    '# Ensures an open, platform-agnostic Codex runtime without ChatGPT account restrictions',
    '',
    `model_provider = "${effectiveDefaultPid}"`,
    `model = "${activeModel}"`,
  ]

  if (sanitized.reasoningEffort) {
    tomlLines.push(`model_reasoning_effort = "${sanitized.reasoningEffort}"`)
  }
  if (sanitized.serviceTier) {
    tomlLines.push(`service_tier = "${sanitized.serviceTier}"`)
  }
  tomlLines.push('')

  for (const [rawPid, p] of Object.entries(providers)) {
    if (!p.baseUrl) continue
    const pid = RESERVED_PROVIDER_IDS.has(rawPid) ? `${rawPid}-custom` : rawPid
    tomlLines.push(`[model_providers.${pid}]`)
    tomlLines.push(`name = "${p.name || pid}"`)
    tomlLines.push(`base_url = "${p.baseUrl}"`)
    tomlLines.push(`wire_api = "${p.wireApi || 'responses'}"`)
    if (p.apiKey) {
      tomlLines.push(`experimental_bearer_token = "${p.apiKey}"`)
    }
    if (p.envKey) {
      tomlLines.push(`env_key = "${p.envKey}"`)
    }
    tomlLines.push(`requires_openai_auth = false`)
    tomlLines.push('')
  }

  const tomlPath = join(codexHome, 'config.toml')
  writeFileSync(tomlPath, tomlLines.join('\n'), 'utf8')

  return { codexHome, providers }
}

interface ActiveTurnRecord {
  threadId: string
  turnId?: string
  handlers: CodexTurnHandlers
  resolve: (res: CodexTurnResult) => void
  reject: (err: Error) => void
  lastUsage?: CodexTokenUsage
  items: Map<string, CodexTurnItem>
  finalText: string
}

export class CodexAppServerDaemon {
  private child: ChildProcess | undefined
  private transport: JsonRpcLineTransport | undefined
  private startPromise: Promise<void> | undefined
  private activeTurns = new Map<string, ActiveTurnRecord>()
  private turnIdToThreadId = new Map<string, string>()

  constructor(private readonly binPath: string = findCodexBinary()) {}

  async ensureStarted(): Promise<void> {
    if (this.transport && this.child && !this.child.killed) return
    if (!this.startPromise) {
      this.startPromise = this.start()
    }
    return this.startPromise
  }

  private async start(): Promise<void> {
    try {
      const bridge = UniversalResponsesBridge.getInstance()
      await bridge.start()
    } catch (err) {
      console.warn('[codex-server] Could not start universal responses bridge:', err)
    }
    const { codexHome } = compileProvidersConfig()
    const bin = this.binPath
    const isJs = bin.endsWith('.js')
    const spawnExe = isJs ? process.execPath : bin
    const spawnArgs = isJs ? [bin, 'app-server', '--stdio'] : ['app-server', '--stdio']

    const child = spawn(spawnExe, spawnArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        RUST_BACKTRACE: '1',
      },
    })
    this.child = child

    child.on('error', (err) => {
      console.error('[codex-server] Child process error:', err)
      this.child = undefined
      this.startPromise = undefined
    })

    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.warn(`[codex-server] Child process exited with code ${code}, signal: ${signal}`)
      }
      this.child = undefined
      this.transport = undefined
      this.startPromise = undefined
      for (const [, active] of this.activeTurns.entries()) {
        active.reject(new Error(`Codex app-server exited unexpectedly (code: ${code}, signal: ${signal})`))
      }
      this.activeTurns.clear()
      this.turnIdToThreadId.clear()
    })

    if (!child.stdout || !child.stdin) {
      throw new Error(`Failed to establish stdio pipes to Codex binary: ${bin}`)
    }

    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    this.transport = transport

    // Handle incoming server requests (e.g. tool approval, confirmations)
    transport.onRequest(async (method, params) => {
      return this.handleServerRequest(method, params as Record<string, unknown>)
    })

    // Handle notifications (streaming deltas, items, token usage, turn completion)
    transport.onNotification((method, params) => {
      this.handleServerNotification(method, (params ?? {}) as Record<string, unknown>)
    })

    transport.start()

    // Perform handshake
    await transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        version: '1.0.0',
      },
      capabilities: {},
    })
    transport.notify('initialized', {})
  }

  private async handleServerRequest(method: string, _params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: 'accept' }
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' }
      case 'item/tool/requestUserInput':
        return { answers: {} }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      default:
        return {}
    }
  }

  private handleServerNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined
    const matchedThreadId = threadId ?? (turnId ? this.turnIdToThreadId.get(turnId) : undefined)
    if (!matchedThreadId) return

    const active = this.activeTurns.get(matchedThreadId)
    if (!active) return

    if (turnId && !active.turnId) {
      active.turnId = turnId
      this.turnIdToThreadId.set(turnId, matchedThreadId)
    }

    switch (method) {
      case 'turn/started': {
        const t = params.turn as { id?: string } | undefined
        if (t?.id) {
          active.turnId = t.id
          this.turnIdToThreadId.set(t.id, matchedThreadId)
        }
        break
      }

      case 'item/started': {
        const item = params.item as CodexTurnItem | undefined
        if (item?.id) {
          active.items.set(item.id, item)
          active.handlers.onItemStarted?.(item, item.id)
        }
        break
      }

      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : ''
        const itemId = String(params.itemId ?? '')
        active.finalText += delta
        active.handlers.onAgentMessageDelta?.(delta, itemId)
        break
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = typeof params.delta === 'string' ? params.delta : ''
        const itemId = String(params.itemId ?? '')
        active.handlers.onReasoningDelta?.(delta, itemId)
        break
      }

      case 'item/commandExecution/outputDelta': {
        const delta = typeof params.delta === 'string' ? params.delta : ''
        const itemId = String(params.itemId ?? '')
        const item = active.items.get(itemId)
        if (item) {
          item.aggregatedOutput = (item.aggregatedOutput ?? '') + delta
        }
        active.handlers.onCommandOutputDelta?.(delta, itemId)
        break
      }

      case 'item/completed': {
        const item = params.item as CodexTurnItem | undefined
        if (item?.id) {
          active.items.set(item.id, item)
          active.handlers.onItemCompleted?.(item, item.id)
        }
        break
      }

      case 'thread/tokenUsage/updated': {
        const usageReport = params.tokenUsage as {
          total?: CodexTokenUsage
          last?: CodexTokenUsage
        } | undefined
        const usage = usageReport?.last ?? usageReport?.total
        if (usage) {
          active.lastUsage = usage
          active.handlers.onTokenUsage?.(usage)
        }
        break
      }

      case 'turn/completed': {
        const turn = params.turn as {
          id?: string
          status?: 'completed' | 'interrupted' | 'failed'
          items?: CodexTurnItem[]
          error?: { message?: string } | null
        } | undefined

        const items = turn?.items ?? Array.from(active.items.values())
        const status = turn?.status ?? 'completed'
        const error = turn?.error?.message ? { message: turn.error.message } : null

        this.activeTurns.delete(matchedThreadId)
        if (active.turnId) this.turnIdToThreadId.delete(active.turnId)

        active.resolve({
          status,
          items,
          finalMessageText: active.finalText,
          ...(active.lastUsage !== undefined ? { usage: active.lastUsage } : {}),
          error,
        })
        break
      }
    }
  }

  async createThread(options: {
    cwd?: string | undefined
    model?: string | undefined
    modelProvider?: string | undefined
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
    approvalPolicy?: 'never' | 'on-request' | undefined
  } = {}): Promise<string> {
    await this.ensureStarted()
    if (!this.transport) throw new Error('Codex transport is not ready')

    const reserved = new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime'])
    const effectiveProvider = options.modelProvider
      ? (reserved.has(options.modelProvider) ? `${options.modelProvider}-custom` : options.modelProvider)
      : undefined

    const res = (await this.transport.request('thread/start', {
      cwd: options.cwd || process.cwd(),
      approvalPolicy: options.approvalPolicy ?? 'never',
      sandbox: options.sandbox ?? 'workspace-write',
      model: options.model,
      modelProvider: effectiveProvider,
    })) as { thread?: { id: string } }

    const id = res?.thread?.id
    if (!id) throw new Error('Codex app-server did not return thread ID')
    return id
  }

  async startTurn(
    threadId: string,
    inputs: Array<{ type: 'text'; text: string }>,
    handlers: CodexTurnHandlers,
    signal?: AbortSignal,
  ): Promise<CodexTurnResult> {
    await this.ensureStarted()
    if (!this.transport) throw new Error('Codex transport is not ready')

    if (this.activeTurns.has(threadId)) {
      throw new Error(`Turn is already running on thread ${threadId}`)
    }

    const { promise, resolve, reject } = Promise.withResolvers<CodexTurnResult>()
    const active: ActiveTurnRecord = {
      threadId,
      handlers,
      resolve,
      reject,
      items: new Map(),
      finalText: '',
    }
    this.activeTurns.set(threadId, active)

    const onAbort = (): void => {
      const turnId = active.turnId
      if (turnId) {
        this.interruptTurn(threadId, turnId).catch(() => {})
      }
      this.activeTurns.delete(threadId)
      if (active.turnId) this.turnIdToThreadId.delete(active.turnId)
      active.resolve({
        status: 'interrupted',
        items: Array.from(active.items.values()),
        finalMessageText: active.finalText,
        ...(active.lastUsage !== undefined ? { usage: active.lastUsage } : {}),
      })
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return promise
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const turnReq = (await this.transport.request('turn/start', {
        threadId,
        input: inputs.map(i => ({ type: 'text', text: i.text, text_elements: [] })),
      })) as { turn?: { id: string } }

      if (turnReq?.turn?.id) {
        active.turnId = turnReq.turn.id
        this.turnIdToThreadId.set(turnReq.turn.id, threadId)
        if (signal?.aborted) {
          this.interruptTurn(threadId, turnReq.turn.id).catch(() => {})
        }
      }
    } catch (err: unknown) {
      this.activeTurns.delete(threadId)
      throw err
    }

    return promise
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    if (!this.transport || !turnId) return
    try {
      await this.transport.request('turn/interrupt', {
        threadId,
        turnId,
      })
    } catch {
      // Best-effort interrupt
    }
  }

  dispose(): void {
    if (this.transport) {
      this.transport.close()
      this.transport = undefined
    }
    if (this.child && !this.child.killed) {
      this.child.kill()
      this.child = undefined
    }
    this.startPromise = undefined
    this.activeTurns.clear()
    this.turnIdToThreadId.clear()
  }
}

let globalDaemon: CodexAppServerDaemon | undefined

export function getCodexAppServerDaemon(): CodexAppServerDaemon {
  if (!globalDaemon) {
    globalDaemon = new CodexAppServerDaemon()
  }
  return globalDaemon
}
