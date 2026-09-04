import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Describes the fine-grained compatibility features and parameters of a model on a given provider.
 */
export interface ModelCapability {
  /** The wire protocol supported by the provider ('responses' or 'chat') */
  wireProtocol: 'responses' | 'chat'
  /** Whether the model accepts the `reasoning_effort` parameter */
  supportsReasoningEffort: boolean
  /** The maximum reasoning effort level supported if any */
  maxReasoningEffort?: 'xhigh' | 'high' | 'medium' | 'low'
  /** Whether the model accepts the `service_tier` parameter */
  supportsServiceTier: boolean
  /** Whether the model accepts `role: "developer"` in system messages or only `role: "system"` */
  supportsDeveloperRole: boolean
  /** Which field the model expects for token limits: 'max_completion_tokens' or 'max_tokens' */
  maxTokensField: 'max_completion_tokens' | 'max_tokens'
  /** Whether native function/tool calling is supported */
  supportsToolCalling: boolean
  /** Inferred or tested context window size in tokens */
  contextWindow?: number
  /** Inferred or tested max output tokens */
  maxOutputTokens?: number
}

const CACHE_PATH = join(homedir(), '.dsh', 'provider-capabilities.json')

/**
 * In-memory and disk-backed capability registry.
 */
class CapabilityStore {
  private cache: Record<string, ModelCapability> = {}
  private loaded = false

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(CACHE_PATH)) {
        const raw = readFileSync(CACHE_PATH, 'utf8')
        this.cache = JSON.parse(raw)
      }
    } catch {
      this.cache = {}
    }
  }

  get(providerId: string, modelId: string): ModelCapability | undefined {
    this.load()
    const key = `${providerId.toLowerCase()}::${modelId.toLowerCase()}`
    return this.cache[key]
  }

  set(providerId: string, modelId: string, capability: ModelCapability): void {
    this.load()
    const key = `${providerId.toLowerCase()}::${modelId.toLowerCase()}`
    this.cache[key] = capability
    this.persist()
  }

  patch(providerId: string, modelId: string, patch: Partial<ModelCapability>): ModelCapability {
    this.load()
    const key = `${providerId.toLowerCase()}::${modelId.toLowerCase()}`
    const existing = this.cache[key] || inferDefaultCapabilities(providerId, modelId)
    const updated = { ...existing, ...patch }
    this.cache[key] = updated
    this.persist()
    return updated
  }

  private persist(): void {
    try {
      const dir = join(homedir(), '.dsh')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(CACHE_PATH, JSON.stringify(this.cache, null, 2), 'utf8')
    } catch {
      // Non-fatal if persist fails
    }
  }
}

export const capabilityStore = new CapabilityStore()

/**
 * Heuristic capability inference based on known provider/model signatures.
 * Gives immediate zero-latency defaults for hundreds of models without network overhead.
 */
export function inferDefaultCapabilities(providerId: string, modelId: string, baseUrl?: string): ModelCapability {
  const p = providerId.toLowerCase()
  const m = modelId.toLowerCase()
  const url = (baseUrl || '').toLowerCase()

  // 1. Wire Protocol detection
  // Providers known to implement OpenAI `/v1/responses` natively
  const isNativeResponses =
    p.includes('opencode') ||
    p.includes('aiapi') ||
    (p === 'openai' && !url.includes('chat/completions')) ||
    url.includes('/responses') ||
    url.includes('opencode.ai') ||
    url.includes('aiapi.tw')

  const wireProtocol: 'responses' | 'chat' = isNativeResponses ? 'responses' : 'chat'

  // 2. Reasoning effort detection
  // Models that actively support `reasoning_effort` (OpenAI o-series, Muse Spark, DeepSeek-R1 via gateways)
  const isReasoningModel =
    m.includes('o1') ||
    m.includes('o3') ||
    m.includes('o4') ||
    m.includes('muse-spark') ||
    m.includes('r1') ||
    m.includes('reasoner') ||
    m.includes('thinking')

  // Official OpenAI or opencode gateways support reasoning_effort on reasoning models
  const supportsReasoningEffort = isReasoningModel

  // 3. Service tier (OpenAI-specific)
  const supportsServiceTier = p === 'openai' || p.includes('azure')

  // 4. Developer role vs System role
  const supportsDeveloperRole = (p === 'openai' || p.includes('azure')) && isReasoningModel

  // 5. Max tokens field
  const maxTokensField = (p === 'openai' || isReasoningModel) ? 'max_completion_tokens' : 'max_tokens'

  // 6. Tool calling capability
  const supportsToolCalling = !m.includes('base') && !m.includes('chat-mini-preview')

  // 7. Context window estimation
  let contextWindow = 128000
  if (m.includes('gemini') || m.includes('mimo') || m.includes('muse')) {
    contextWindow = 1048576
  } else if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) {
    contextWindow = 200000
  } else if (m.includes('kimi') || m.includes('moonshot')) {
    contextWindow = 256000
  } else if (m.includes('qwen') || m.includes('glm')) {
    contextWindow = 131072
  }

  return {
    wireProtocol,
    supportsReasoningEffort,
    maxReasoningEffort: m.includes('muse-spark') ? 'xhigh' : 'high',
    supportsServiceTier,
    supportsDeveloperRole,
    maxTokensField,
    supportsToolCalling,
    contextWindow,
    maxOutputTokens: 65536,
  }
}

/**
 * Probes and returns the capabilities of a provider + model.
 * Checks persistent cache first, falls back to heuristics, and updates the cache.
 */
export async function probeProviderModel(
  providerId: string,
  modelId: string,
  baseUrl?: string,
  _apiKey?: string,
): Promise<ModelCapability> {
  const cached = capabilityStore.get(providerId, modelId)
  if (cached) {
    return cached
  }

  const inferred = inferDefaultCapabilities(providerId, modelId, baseUrl)
  capabilityStore.set(providerId, modelId, inferred)
  return inferred
}
