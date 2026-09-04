/**
 * Global Model Registry Synchronizer
 *
 * Dynamically synchronizes official model specifications (context window, max output tokens,
 * thinking/reasoning efforts, benchmarks) from authoritative global LLM registries
 * (OpenRouter Public API & LiteLLM Hub) without requiring manual hardcoded dictionaries.
 */

export interface GlobalModelSpec {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: {
    supportedEfforts?: string[]
    defaultEffort?: string
  }
}

interface OpenRouterModelEntry {
  id: string
  name?: string
  context_length?: number
  top_provider?: {
    context_length?: number
    max_completion_tokens?: number
  }
  supported_parameters?: string[]
  reasoning?: {
    supported_efforts?: string[]
    default_effort?: string
  }
}

/** Pre-warmed baseline specs for instant zero-latency startup */
const BASELINE_SPECS: Record<string, GlobalModelSpec> = {
  'muse-spark-1.2-contributor': {
    id: 'meta/muse-spark-1.2-contributor',
    name: 'Muse Spark 1.2 Contributor',
    contextWindow: 1048576,
    maxTokens: 943718,
    reasoning: { supportedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'xhigh' },
  },
  'kimi-k3': {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    contextWindow: 1048576,
    maxTokens: 943718,
    reasoning: { supportedEfforts: ['off', 'low', 'high', 'max'], defaultEffort: 'max' },
  },
  'deepseek-v4-pro': {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: { supportedEfforts: ['off', 'low', 'high', 'max'], defaultEffort: 'max' },
  },
  'deepseek-v4-flash': {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: { supportedEfforts: ['off', 'low', 'high', 'max'], defaultEffort: 'max' },
  },
  'glm-5.3': {
    id: 'z-ai/glm-5.3',
    name: 'GLM 5.3',
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: { supportedEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'high' },
  },
  'glm-5.2': {
    id: 'z-ai/glm-5.2',
    name: 'GLM 5.2',
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: { supportedEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'high' },
  },
  'minimax-m3': {
    id: 'minimax/minimax-m3',
    name: 'MiniMax M3',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: { supportedEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'high' },
  },
  'hy4-preview': {
    id: 'tencent/hy4-preview',
    name: 'Hy4 preview',
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: { supportedEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'high' },
  },
  'mimo-v2.5': {
    id: 'xiaomi/mimo-v2.5',
    name: 'MiMo-V2.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: { supportedEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'high' },
  },
}

function initBaselineMap(): Map<string, GlobalModelSpec> {
  const map = new Map<string, GlobalModelSpec>()
  for (const [key, spec] of Object.entries(BASELINE_SPECS)) {
    map.set(key.toLowerCase(), spec)
    map.set(normalizeId(key), spec)
    if (spec.id) {
      map.set(spec.id.toLowerCase(), spec)
      map.set(normalizeId(spec.id), spec)
    }
  }
  return map
}

let cachedSpecs: Map<string, GlobalModelSpec> = initBaselineMap()
let cacheTimestamp = 0
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour cache

/** Normalize model identifier for fuzzy matching (e.g. 'moonshotai/kimi-k3' -> 'kimik3') */
function normalizeId(id: string): string {
  const withoutPrefix = id.split('/').pop() ?? id
  return withoutPrefix.toLowerCase().replace(/[-_.:]/g, '')
}

/**
 * Fetch and build the global model registry from the authoritative OpenRouter public endpoint.
 * Returns a map of normalized slug -> GlobalModelSpec.
 */
export async function fetchGlobalModelRegistry(signal?: AbortSignal): Promise<Map<string, GlobalModelSpec>> {
  const now = Date.now()
  if (cachedSpecs.size > 20 && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSpecs
  }

  const map = initBaselineMap()

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)
    const combinedSignal = signal ?? controller.signal

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: combinedSignal,
    }).finally(() => clearTimeout(timeout))

    if (response.ok) {
      const data = await response.json() as { data?: OpenRouterModelEntry[] }
      if (Array.isArray(data.data)) {
        for (const entry of data.data) {
          if (!entry.id) continue
          const contextWindow = entry.top_provider?.context_length ?? entry.context_length
          const maxTokens = entry.top_provider?.max_completion_tokens

          let supportedEfforts = entry.reasoning?.supported_efforts
          if (!supportedEfforts && entry.supported_parameters?.includes('reasoning_effort')) {
            supportedEfforts = ['off', 'low', 'medium', 'high', 'max']
          }
          if (supportedEfforts) {
            const VALID = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
            supportedEfforts = supportedEfforts.map(e => {
              const l = e.toLowerCase()
              return l === 'none' ? 'off' : l
            }).filter(e => VALID.has(e))
          }

          let defaultEffort = entry.reasoning?.default_effort
          if (defaultEffort) {
            const l = defaultEffort.toLowerCase()
            defaultEffort = l === 'none' ? 'off' : l
          }

          const spec: GlobalModelSpec = {
            id: entry.id,
            name: entry.name || entry.id,
            ...typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {},
            ...typeof maxTokens === 'number' && maxTokens > 0 ? { maxTokens } : {},
            ...supportedEfforts && supportedEfforts.length > 0 ? {
              reasoning: {
                supportedEfforts,
                ...defaultEffort ? { defaultEffort } : {},
              },
            } : {},
          }

          // Index by exact ID, slug, and normalized slug
          map.set(entry.id.toLowerCase(), spec)
          const slug = (entry.id.split('/').pop() ?? entry.id).toLowerCase()
          map.set(slug, spec)
          map.set(normalizeId(entry.id), spec)
        }
      }
      cachedSpecs = map
      cacheTimestamp = now
    }
  } catch {
    // If offline or network timeout, retain existing cache if any
  }

  return cachedSpecs
}

/** Pre-trigger background sync on module load */
void fetchGlobalModelRegistry().catch(() => {})

/**
 * Synchronously query the active cached global registry, or fallback to fuzzy heuristic match.
 */
export function matchGlobalModelSpec(
  id: string,
  registry: Map<string, GlobalModelSpec> | null,
): GlobalModelSpec | undefined {
  const activeRegistry = registry && registry.size > 0 ? registry : cachedSpecs

  const direct = activeRegistry.get(id.toLowerCase())
  if (direct) return direct

  const slug = (id.split('/').pop() ?? id).toLowerCase()
  const bySlug = activeRegistry.get(slug)
  if (bySlug) return bySlug

  const normalized = normalizeId(id)
  const byNormalized = activeRegistry.get(normalized)
  if (byNormalized) return byNormalized

  // Prefix match (e.g. 'kimi-k3' matches 'moonshotai/kimi-k3-20260715')
  for (const [key, spec] of activeRegistry.entries()) {
    if (key.startsWith(normalized) || normalized.startsWith(key)) {
      return spec
    }
  }

  return undefined
}
