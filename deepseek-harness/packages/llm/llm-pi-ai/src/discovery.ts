/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A route the installed pi-ai catalog ships is answered **from that catalog**,
 * with no network call at all: pi-ai's registry is the authoritative list for
 * its own providers, and it carries the capacities a listing endpoint would
 * not disclose. Only a route the catalog does not describe — a gateway, a
 * self-hosted server — is interrogated over the wire.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `settings.yaml` remains the only
 * thing that decides what a route serves.
 *
 * Only OpenAI-compatible protocols are interrogated. Their listing is the one
 * shape a gateway, a self-hosted server, and the official endpoints all agree
 * on, which is the case this action exists for; every other protocol reports
 * that it cannot be interrogated so the surface falls back to hand-entry
 * rather than guessing a response shape.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogModels } from './catalog.ts'
import { fetchGlobalModelRegistry, matchGlobalModelSpec, type GlobalModelSpec } from './registry-sync.ts'

/**
 * Protocols whose model listing this module can read: the two that speak
 * OpenAI's `GET /models` shape with bearer auth. Azure is absent despite its
 * OpenAI lineage — it authenticates with an `api-key` header and requires an
 * `api-version` query — and Codex authenticates through OAuth; guessing at
 * either would report an authentication failure as a provider with no models.
 * pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
])

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  reasoning_efforts?: unknown
  supported_thinking_levels?: unknown
  reasoning_effort_levels?: unknown
  supported_parameters?: unknown
  thinking?: unknown
  capabilities?: unknown
}

const VALID_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function parseReasoningEfforts(entry: ListingEntry | null): Record<string, string | null> | undefined {
  if (!entry) return undefined
  const rawList = entry.supported_thinking_levels ?? entry.reasoning_efforts ?? entry.reasoning_effort_levels
  if (Array.isArray(rawList) && rawList.length > 0) {
    const map: Record<string, string | null> = {}
    for (const item of rawList) {
      if (typeof item === 'string' && item.length > 0) {
        const lower = item.toLowerCase()
        if (lower === 'off' || lower === 'none') {
          map.off = null
        } else if (VALID_EFFORTS.has(lower)) {
          map[lower] = lower
        }
      }
    }
    if (Object.keys(map).length > 0) {
      return map
    }
  }
  if (typeof entry.thinking === 'object' && entry.thinking !== null) {
    const thinkingObj = entry.thinking as Record<string, unknown>
    if (Array.isArray(thinkingObj.levels)) {
      const map: Record<string, string | null> = {}
      for (const item of thinkingObj.levels) {
        if (typeof item === 'string' && item.length > 0) {
          const lower = item.toLowerCase()
          if (lower === 'off' || lower === 'none') {
            map.off = null
          } else if (VALID_EFFORTS.has(lower)) {
            map[lower] = lower
          }
        }
      }
      return map
    }
  }
  return undefined
}

/**
 * Known context window and max output token capacities for popular frontier models
 * used when an upstream endpoint does not disclose them in /models metadata.
 */
const KNOWN_MODEL_CAPACITIES: Record<string, { name?: string; contextWindow?: number; maxTokens?: number }> = {
  'minimax-m3': { name: 'MiniMax M3', contextWindow: 1000000, maxTokens: 131072 },
  'minimax-m2.7': { name: 'MiniMax M2.7', contextWindow: 204800, maxTokens: 131072 },
  'minimax-m2.5': { name: 'MiniMax M2.5', contextWindow: 1000000, maxTokens: 128000 },
  'kimi-k3': { name: 'Kimi K3', contextWindow: 1048576, maxTokens: 131072 },
  'kimi-k2.7-code': { name: 'Kimi K2.7 Code', contextWindow: 262144, maxTokens: 262144 },
  'kimi-k2.6': { name: 'Kimi K2.6', contextWindow: 262144, maxTokens: 65536 },
  'kimi-k2.5': { name: 'Kimi K2.5', contextWindow: 262144, maxTokens: 65536 },
  'longcat-2.0': { name: 'LongCat-2.0', contextWindow: 1000000, maxTokens: 131072 },
  'glm-5.3': { name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 131072 },
  'glm-5.3-flash': { name: 'GLM-5.3-Flash', contextWindow: 1000000, maxTokens: 131072 },
  'glm-5.2': { name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 131072 },
  'glm-5.1': { name: 'GLM-5.1', contextWindow: 202752, maxTokens: 32768 },
  'glm-5': { name: 'GLM-5', contextWindow: 202752, maxTokens: 32768 },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 384000 },
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000 },
  'deepseek-v4-flash-vision-exp': { name: 'DeepSeek V4 Flash Vision Exp', contextWindow: 1000000, maxTokens: 384000 },
  'deepseek-chat': { name: 'DeepSeek V3', contextWindow: 65536, maxTokens: 8192 },
  'deepseek-reasoner': { name: 'DeepSeek R1', contextWindow: 65536, maxTokens: 8192 },
  'qwen3.8-max': { name: 'Qwen3.8 Max', contextWindow: 1000000, maxTokens: 131072 },
  'qwen3.8-flash': { name: 'Qwen3.8 Flash', contextWindow: 1000000, maxTokens: 131072 },
  'qwen3.7-max': { name: 'Qwen3.7 Max', contextWindow: 1000000, maxTokens: 65536 },
  'qwen3.7-plus': { name: 'Qwen3.7 Plus', contextWindow: 1000000, maxTokens: 65536 },
  'qwen3.6-plus': { name: 'Qwen3.6 Plus', contextWindow: 1000000, maxTokens: 65536 },
  'qwen3.5-plus': { name: 'Qwen3.5 Plus', contextWindow: 1000000, maxTokens: 65536 },
  'mimo-v2.5-pro': { name: 'MiMo-V2.5-Pro', contextWindow: 1048576, maxTokens: 128000 },
  'mimo-v2.5': { name: 'MiMo-V2.5', contextWindow: 1000000, maxTokens: 128000 },
  'mimo-v2-pro': { name: 'MiMo-V2-Pro', contextWindow: 1048576, maxTokens: 128000 },
  'mimo-v2-omni': { name: 'MiMo-V2-Omni', contextWindow: 1048576, maxTokens: 128000 },
  'hy4-preview': { name: 'Hy4 preview', contextWindow: 1000000, maxTokens: 128000 },
  'hy3': { name: 'Hy3', contextWindow: 256000, maxTokens: 64000 },
  'hy3-preview': { name: 'Hy3-preview', contextWindow: 256000, maxTokens: 64000 },
  'gpt-5.6-luna': { name: 'GPT 5.6 Luna', contextWindow: 1050000, maxTokens: 128000 },
  'gpt-5.6-sol': { name: 'GPT 5.6 Sol', contextWindow: 1000000, maxTokens: 128000 },
  'gpt-5.6': { name: 'GPT 5.6', contextWindow: 1000000, maxTokens: 128000 },
  'gpt-5.6-terra': { name: 'GPT 5.6 Terra', contextWindow: 1000000, maxTokens: 128000 },
  'gpt-5.5': { name: 'GPT 5.5', contextWindow: 1000000, maxTokens: 128000 },
  'gpt-5.4': { name: 'GPT 5.4', contextWindow: 1000000, maxTokens: 128000 },
  'gpt-5.4-mini': { name: 'GPT 5.4 Mini', contextWindow: 1000000, maxTokens: 128000 },
  'grok-4.6': { name: 'Grok 4.6', contextWindow: 1000000, maxTokens: 500000 },
  'grok-4.5': { name: 'Grok 4.5', contextWindow: 500000, maxTokens: 500000 },
  'muse-spark-1.2-contributor': { name: 'Muse Spark 1.2 Contributor', contextWindow: 1000000, maxTokens: 131072 },
  'claude-3-7-sonnet': { name: 'Claude 3.7 Sonnet', contextWindow: 200000, maxTokens: 64000 },
  'claude-3-5-sonnet': { name: 'Claude 3.5 Sonnet', contextWindow: 200000, maxTokens: 8192 },
  'claude-3-5-haiku': { name: 'Claude 3.5 Haiku', contextWindow: 200000, maxTokens: 8192 },
  'gemini-2.5-pro': { name: 'Gemini 2.5 Pro', contextWindow: 1048576, maxTokens: 65536 },
  'gemini-2.0-flash': { name: 'Gemini 2.0 Flash', contextWindow: 1048576, maxTokens: 8192 },
}

function resolveKnownCapacities(id: string): { name?: string; contextWindow?: number; maxTokens?: number } | undefined {
  const direct = KNOWN_MODEL_CAPACITIES[id.toLowerCase()]
  if (direct) return direct
  const slug = (id.split('/').pop() ?? id).toLowerCase()
  if (KNOWN_MODEL_CAPACITIES[slug]) return KNOWN_MODEL_CAPACITIES[slug]

  // Smart Family Heuristic Inference for future/unlisted models
  if (slug.includes('deepseek')) {
    if (slug.includes('r1') || slug.includes('v3') || slug.includes('chat') || slug.includes('reasoner')) {
      return { contextWindow: 65536, maxTokens: 8192 }
    }
    return { contextWindow: 1000000, maxTokens: 384000 }
  }
  if (slug.includes('kimi')) {
    if (slug.includes('code') || slug.includes('k2.7')) {
      return { contextWindow: 262144, maxTokens: 262144 }
    }
    if (slug.includes('k2.6') || slug.includes('k2.5')) {
      return { contextWindow: 262144, maxTokens: 65536 }
    }
    return { contextWindow: 1048576, maxTokens: 131072 }
  }
  if (slug.includes('minimax')) {
    if (slug.includes('m2.7')) return { contextWindow: 204800, maxTokens: 131072 }
    return { contextWindow: 1000000, maxTokens: 131072 }
  }
  if (slug.includes('glm')) {
    if (slug.includes('5.1') || slug.includes('glm-5') || slug.includes('glm-4')) {
      return { contextWindow: 202752, maxTokens: 32768 }
    }
    return { contextWindow: 1000000, maxTokens: 131072 }
  }
  if (slug.includes('qwen')) {
    if (slug.includes('max')) return { contextWindow: 1000000, maxTokens: 131072 }
    if (slug.includes('3.7') || slug.includes('3.6') || slug.includes('3.5')) return { contextWindow: 1000000, maxTokens: 65536 }
    return { contextWindow: 1000000, maxTokens: 131072 }
  }
  if (slug.includes('mimo')) {
    return { contextWindow: 1048576, maxTokens: 128000 }
  }
  if (slug.includes('grok')) {
    if (slug.includes('4.5')) return { contextWindow: 500000, maxTokens: 500000 }
    return { contextWindow: 1000000, maxTokens: 500000 }
  }
  if (slug.includes('gpt-5') || slug.includes('gpt-6')) {
    return { contextWindow: 1000000, maxTokens: 128000 }
  }
  if (slug.includes('claude')) {
    if (slug.includes('3-7') || slug.includes('4')) return { contextWindow: 200000, maxTokens: 64000 }
    return { contextWindow: 200000, maxTokens: 8192 }
  }
  if (slug.includes('gemini')) {
    return { contextWindow: 1048576, maxTokens: 65536 }
  }
  if (slug.includes('hunyuan') || slug.includes('hy')) {
    if (slug.includes('hy3')) return { contextWindow: 256000, maxTokens: 64000 }
    return { contextWindow: 1000000, maxTokens: 128000 }
  }
  if (slug.includes('longcat')) {
    return { contextWindow: 1000000, maxTokens: 131072 }
  }

  return undefined
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one model listing reply from any OpenAI/Ollama/OpenCode/OpenRouter-compatible gateway.
 * Entries without a usable id are skipped rather than failing the whole interrogation.
 */
/**
 * Read one model listing reply from any OpenAI/Ollama/OpenCode/OpenRouter-compatible gateway.
 * Entries without a usable id are skipped rather than failing the whole interrogation.
 */
function readListing(body: unknown, globalRegistry?: Map<string, GlobalModelSpec> | null): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(
      entry?.id,
      (entry as Record<string, unknown> | null)?.model,
      (entry as Record<string, unknown> | null)?.model_id,
      (entry as Record<string, unknown> | null)?.model_name,
    )
    if (id === undefined) continue
    const globalSpec = matchGlobalModelSpec(id, globalRegistry ?? null)
    const known = resolveKnownCapacities(id)
    const name = label(
      entry?.name,
      entry?.display_name,
      (entry as Record<string, unknown> | null)?.title,
    ) ?? globalSpec?.name ?? known?.name
    const contextWindow = capacity(
      entry?.context_window,
      entry?.context_length,
      (entry as Record<string, unknown> | null)?.context_size,
      (entry as Record<string, unknown> | null)?.max_context_length,
      ((entry as Record<string, unknown> | null)?.architecture as Record<string, unknown> | undefined)?.context_length,
      ((entry as Record<string, unknown> | null)?.top_provider as Record<string, unknown> | undefined)?.context_length,
    ) ?? globalSpec?.contextWindow ?? known?.contextWindow
    const maxTokens = capacity(
      entry?.max_output_tokens,
      entry?.max_tokens,
      (entry as Record<string, unknown> | null)?.max_completion_tokens,
      ((entry as Record<string, unknown> | null)?.architecture as Record<string, unknown> | undefined)?.max_output_tokens,
      ((entry as Record<string, unknown> | null)?.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens,
    ) ?? globalSpec?.maxTokens ?? known?.maxTokens

    let reasoningEfforts = parseReasoningEfforts(entry)
    if (reasoningEfforts === undefined && globalSpec?.reasoning?.supportedEfforts) {
      const map: Record<string, string | null> = {}
      for (const effort of globalSpec.reasoning.supportedEfforts) {
        const lower = effort.toLowerCase()
        if (lower === 'off' || lower === 'none') {
          map.off = null
        } else if (VALID_EFFORTS.has(lower)) {
          map[lower] = lower
        }
      }
      if (Object.keys(map).length > 0) {
        reasoningEfforts = map
      }
    }

    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  storedApiKey?: () => Promise<string | undefined>,
): Promise<readonly LlmDiscoveredModel[]> {
  // A catalog route already has its answer, unless it is opencode-go or aiapi which have dynamic live endpoints
  if (request.provider !== undefined && request.provider !== 'opencode-go' && request.provider !== 'aiapi') {
    const installed = catalogModels(request.provider)
    if (installed.size > 0) {
      return [...installed.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
    }
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    if (request.provider !== undefined) {
      const installed = catalogModels(request.provider)
      if (installed.size > 0) {
        return [...installed.values()].map(model => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }))
      }
    }
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }

  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }

  const url = listingUrl(request.baseURL)
  const supplied = request.apiKey ?? await storedApiKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  let globalRegistry: Map<string, GlobalModelSpec> | null = null

  try {
    const [reg, res] = await Promise.all([
      fetchGlobalModelRegistry(request.signal).catch(() => null),
      fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}`, 'api-key': apiKey, 'x-api-key': apiKey },
          ...attributionHeaders(),
        },
        ...request.signal === undefined ? {} : { signal: request.signal },
      }),
    ])
    globalRegistry = reg
    response = res
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body, globalRegistry)
}
