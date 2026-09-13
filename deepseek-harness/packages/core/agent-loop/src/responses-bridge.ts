import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import { userAgent } from '@deepseek-ai/dsh-llm'

export interface BridgeProviderTarget {
  id: string
  baseUrl: string
  apiKey?: string | undefined
}

/** Session header OpenCode Go reads for routing and prompt-cache affinity. */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'
/** Codex-native turn metadata carrying the stable thread/session identity. */
const CODEX_TURN_METADATA_HEADER = 'x-codex-turn-metadata'

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return first !== undefined && first !== '' ? first : undefined
}

function isOpencodeTarget(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'opencode.ai' || hostname.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

/**
 * Session headers forwarded upstream. An explicit `x-opencode-session`
 * wins; otherwise derive it from the Codex turn metadata's thread id
 * (stable per conversation), falling back to its session id. Restricted to
 * OpenCode-served targets so internal thread identities never leak to
 * unrelated providers.
 * @param targetBaseUrl - the upstream endpoint receiving this request.
 * @param incoming - the inbound request headers (Node lowercases names).
 * @returns headers to merge into the upstream request.
 */
export function bridgeSessionHeaders(
  targetBaseUrl: string,
  incoming: NodeJS.Dict<string | string[]>,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!isOpencodeTarget(targetBaseUrl)) return headers
  const explicit = firstHeader(incoming[OPENCODE_SESSION_HEADER])
  if (explicit !== undefined) {
    headers[OPENCODE_SESSION_HEADER] = explicit
  } else {
    const metadata = firstHeader(incoming[CODEX_TURN_METADATA_HEADER])
    if (metadata !== undefined) {
      try {
        const parsed = JSON.parse(metadata) as { thread_id?: unknown; session_id?: unknown }
        const thread = typeof parsed.thread_id === 'string' && parsed.thread_id !== '' ? parsed.thread_id : undefined
        const session = typeof parsed.session_id === 'string' && parsed.session_id !== '' ? parsed.session_id : undefined
        const derived = thread ?? session
        if (derived !== undefined) headers[OPENCODE_SESSION_HEADER] = derived
      } catch {
        // Non-JSON metadata carries no session identity; forward nothing.
      }
    }
  }
  const turnMetadata = firstHeader(incoming[CODEX_TURN_METADATA_HEADER])
  if (turnMetadata !== undefined) headers[CODEX_TURN_METADATA_HEADER] = turnMetadata
  return headers
}

/** Anthropic Messages API version pinned for bridge translation. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Default output cap: Anthropic rejects requests without max_tokens. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

/** Per-stream tool routing so parallel calls keep distinct ids and slots. */
interface BridgeToolStreamState {
  nextOutputIndex: number
  idByIndex: Map<number, string>
  seenIds: Set<string>
}

function createBridgeToolStreamState(): BridgeToolStreamState {
  return { nextOutputIndex: 1, idByIndex: new Map(), seenIds: new Set() }
}

function isAnthropicTarget(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com')
  } catch {
    return false
  }
}

function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/messages')) return trimmed
  return `${trimmed.replace(/\/v1\/?$/, '')}/v1/messages`
}

function parseImageDataUrl(url: string): { mediaType: string, data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(url)
  const mediaType = match?.[1]
  const data = match?.[2]
  if (mediaType === undefined || data === undefined || data === '') return undefined
  return { mediaType, data }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Array<Record<string, unknown>>
}

/**
 * Map bridge chat messages to Anthropic Messages shapes. Developer and
 * system roles fold into the top-level system prompt, which the chat
 * protocol has no equivalent for.
 */
function toAnthropicMessages(messages: ChatMessage[]): { system: string | undefined, messages: AnthropicMessage[] } {
  const systems: string[] = []
  const converted: AnthropicMessage[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = typeof message.content === 'string'
        ? message.content
        : message.content.filter((part): part is ChatTextPart => part.type === 'text').map(part => part.text).join('\n')
      if (text !== '') systems.push(text)
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks: Array<Record<string, unknown>> = []
    if (typeof message.content === 'string') {
      if (message.content !== '') blocks.push({ type: 'text', text: message.content })
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text !== '') blocks.push({ type: 'text', text: part.text })
        } else {
          const url = part.image_url.url
          const inline = parseImageDataUrl(url)
          blocks.push(inline === undefined
            ? { type: 'image', source: { type: 'url', url } }
            : { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } })
        }
      }
    }
    if (blocks.length > 0) converted.push({ role, content: blocks })
  }
  if (converted.length === 0) converted.push({ role: 'user', content: [{ type: 'text', text: 'Hello' }] })
  return { system: systems.length > 0 ? systems.join('\n\n') : undefined, messages: converted }
}

/** Map Responses function tools to Anthropic tool definitions. */
function toAnthropicTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined
  const converted: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    if (record.type !== 'function' || typeof record.name !== 'string' || record.name === '') continue
    converted.push({
      name: record.name,
      ...(typeof record.description === 'string' && record.description !== '' ? { description: record.description } : {}),
      input_schema: record.parameters !== undefined ? record.parameters : { type: 'object' },
    })
  }
  return converted.length > 0 ? converted : undefined
}

/**
 * Convert one Anthropic SSE data payload to an OpenAI chat-delta shape so
 * both upstream dialects share the Responses event translation below.
 * @param event - parsed Anthropic stream data payload.
 * @param toolIds - content-block index to tool-use id, seeded by block starts.
 */
function anthropicEventToDelta(event: Record<string, unknown>, toolIds: Map<number, string>): Record<string, unknown> | undefined {
  if (event.type === 'content_block_start') {
    const block = event.content_block as Record<string, unknown> | undefined
    if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && typeof event.index === 'number') {
      toolIds.set(event.index, block.id)
      return { tool_calls: [{ id: block.id, function: { name: block.name } }] }
    }
    return undefined
  }
  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { content: delta.text }
    }
    if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && typeof event.index === 'number') {
      const id = toolIds.get(event.index)
      if (id !== undefined) return { tool_calls: [{ id, function: { arguments: delta.partial_json } }] }
    }
    return undefined
  }
  return undefined
}

/**
 * Lightweight in-process proxy that translates OpenAI `/v1/responses` protocol
 * into standard OpenAI `/v1/chat/completions` protocol, or into the
 * Anthropic Messages API for Anthropic-hosted targets.
 * Enables Codex App-Server to drive chat completions APIs (DeepSeek, Ollama,
 * Groq, Gemini through its OpenAI-compatible endpoint, etc.) and Claude.
 */

interface ChatTextPart {
  type: 'text'
  text: string
}

interface ChatImagePart {
  type: 'image_url'
  image_url: {
    url: string
    detail?: string | undefined
  }
}

type ChatContentPart = ChatTextPart | ChatImagePart

interface ChatMessage {
  role: string
  content: string | ChatContentPart[]
  tool_calls?: Array<{ id: string, type: string, function: { name: string, arguments: string } }>
  tool_call_id?: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function toChatContentPart(part: unknown): ChatContentPart | undefined {
  if (typeof part === 'string') {
    const text = nonEmptyString(part)
    return text === undefined ? undefined : { type: 'text', text }
  }
  if (!part || typeof part !== 'object') return undefined
  const record = part as Record<string, unknown>
  const kind = record.type
  if (kind === 'input_text' || kind === 'output_text' || kind === 'text') {
    const text = nonEmptyString(record.text)
    return text === undefined ? undefined : { type: 'text', text }
  }
  if (kind === 'input_image') {
    const url = nonEmptyString(record.image_url)
    if (url === undefined) return undefined
    const detail = nonEmptyString(record.detail)
    return detail === undefined
      ? { type: 'image_url', image_url: { url } }
      : { type: 'image_url', image_url: { url, detail } }
  }
  if (kind === 'image_url') {
    const raw = record.image_url
    const nested = (raw as Record<string, unknown> | null | undefined)?.url
    const url = typeof raw === 'string' ? nonEmptyString(raw) : nonEmptyString(nested)
    if (url === undefined) return undefined
    const nestedDetail = raw && typeof raw === 'object' ? nonEmptyString((raw as Record<string, unknown>).detail) : undefined
    const detail = nonEmptyString(record.detail) ?? nestedDetail
    return detail === undefined
      ? { type: 'image_url', image_url: { url } }
      : { type: 'image_url', image_url: { url, detail } }
  }
  return undefined
}
export class UniversalResponsesBridge {
  private static instance: UniversalResponsesBridge | null = null
  private server: Server | null = null
  private port = 0
  private targets: Map<string, BridgeProviderTarget> = new Map()

  static getInstance(): UniversalResponsesBridge {
    if (!UniversalResponsesBridge.instance) {
      UniversalResponsesBridge.instance = new UniversalResponsesBridge()
    }
    return UniversalResponsesBridge.instance
  }

  registerTarget(target: BridgeProviderTarget): void {
    this.targets.set(target.id, target)
  }

  getTarget(id: string): BridgeProviderTarget | undefined {
    return this.targets.get(id)
  }

  async start(): Promise<number> {
    if (this.server && this.port > 0) {
      return this.port
    }

    return new Promise<number>((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          resolve(this.port)
        } else {
          reject(new Error('Failed to acquire bridge port'))
        }
      })
      this.server.on('error', reject)
    })
  }

  getBridgeBaseUrl(providerId: string): string {
    if (this.port === 0) {
      throw new Error('Bridge server is not running')
    }
    return `http://127.0.0.1:${this.port}/bridge/${providerId}/v1`
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const parts = url.pathname.split('/').filter(Boolean)

    // Expected format: /bridge/:providerId/v1/responses or /bridge/:providerId/responses
    if (parts[0] !== 'bridge' || parts.length < 3) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Bridge route not found' } }))
      return
    }

    const providerId = parts[1]
    if (!providerId) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Provider ID missing in bridge route' } }))
      return
    }

    const target = this.targets.get(providerId)
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Provider ${providerId} not registered in bridge` } }))
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Method Not Allowed' } }))
      return
    }

    let bodyData = ''
    req.on('data', chunk => {
      bodyData += chunk
    })

    req.on('end', () => {
      try {
        const responsesPayload = JSON.parse(bodyData)
        this.forwardAsChatCompletions(target, responsesPayload, req.headers, res)
      } catch (err: unknown) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Malformed JSON payload' } }))
      }
    })
  }

  private forwardAsChatCompletions(
    target: BridgeProviderTarget,
    payload: Record<string, unknown>,
    incomingHeaders: NodeJS.Dict<string | string[]>,
    clientRes: ServerResponse,
  ): void {
    const model = String(payload.model || 'default')
    const messages = this.convertInputToMessages(payload.input)
    const tools = payload.tools as unknown[] | undefined

    if (target.id === 'anthropic' || isAnthropicTarget(target.baseUrl)) {
      this.forwardAsAnthropicMessages(target, incomingHeaders, clientRes, model, messages, tools)
      return
    }

    const chatPayload: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
      chatPayload.tools = tools
      chatPayload.tool_choice = 'auto'
    }

    const targetUrl = new URL(
      target.baseUrl.endsWith('/chat/completions')
        ? target.baseUrl
        : `${target.baseUrl.replace(/\/v1\/?$/, '')}/v1/chat/completions`,
    )

    const outHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // Session attribution the gateway requires (routing + prompt-cache
      // affinity); never invented here, only preserved or derived.
      ...bridgeSessionHeaders(target.baseUrl, incomingHeaders),
      // Identify the product per the gateway client contract, keeping the
      // caller own agent name when it already self-identifies.
      'User-Agent': firstHeader(incomingHeaders['user-agent']) ?? userAgent(),
    }
    if (target.apiKey) {
      outHeaders.Authorization = `Bearer ${target.apiKey}`
    }

    const outboundBody = JSON.stringify(chatPayload)
    outHeaders['Content-Length'] = String(Buffer.byteLength(outboundBody))

    const toolState = createBridgeToolStreamState()
    this.postUpstream(targetUrl, outHeaders, outboundBody, clientRes, (parsed, messageId) => {
      const record = parsed as Record<string, unknown>
      const choices = record.choices as Array<Record<string, unknown>> | undefined
      const first = Array.isArray(choices) ? choices[0] : undefined
      if (!first) return
      this.forwardChatDelta(clientRes, messageId, (first.delta ?? {}) as Record<string, unknown>, toolState)
    })
  }

  private forwardAsAnthropicMessages(
    target: BridgeProviderTarget,
    incomingHeaders: NodeJS.Dict<string | string[]>,
    clientRes: ServerResponse,
    model: string,
    messages: ChatMessage[],
    tools: unknown,
  ): void {
    const converted = toAnthropicMessages(messages)
    const anthropicTools = toAnthropicTools(tools)
    const body: Record<string, unknown> = {
      model,
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream: true,
      messages: converted.messages,
    }
    if (converted.system !== undefined) {
      body.system = converted.system
    }
    if (anthropicTools !== undefined) {
      body.tools = anthropicTools
    }
    const targetUrl = new URL(anthropicMessagesUrl(target.baseUrl))
    const outHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
      'User-Agent': firstHeader(incomingHeaders['user-agent']) ?? userAgent(),
    }
    if (target.apiKey) {
      outHeaders['x-api-key'] = target.apiKey
    }
    const outboundBody = JSON.stringify(body)
    outHeaders['Content-Length'] = String(Buffer.byteLength(outboundBody))
    const toolIds = new Map<number, string>()
    const toolState = createBridgeToolStreamState()
    this.postUpstream(targetUrl, outHeaders, outboundBody, clientRes, (parsed, messageId) => {
      const delta = anthropicEventToDelta(parsed as Record<string, unknown>, toolIds)
      if (delta !== undefined) {
        this.forwardChatDelta(clientRes, messageId, delta, toolState)
      }
    })
  }

  private postUpstream(
    targetUrl: URL,
    outHeaders: Record<string, string>,
    outboundBody: string,
    clientRes: ServerResponse,
    onDataLine: (parsed: unknown, messageId: string) => void,
  ): void {
    const isHttps = targetUrl.protocol === 'https:'
    const requester = isHttps ? httpsRequest : httpRequest
    const upstreamReq = requester(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: 'POST',
        headers: outHeaders,
      },
      upstreamRes => {
        if ((upstreamRes.statusCode || 200) >= 400) {
          let errBody = ''
          upstreamRes.on('data', d => {
            errBody += d
          })
          upstreamRes.on('end', () => {
            clientRes.writeHead(upstreamRes.statusCode || 500, { 'Content-Type': 'application/json' })
            clientRes.end(errBody)
          })
          return
        }
        const ids = this.openResponsesStream(clientRes)
        let buffer = ''
        upstreamRes.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data:')) continue
            const jsonStr = trimmed.slice(5).trim()
            if (jsonStr === '[DONE]') continue
            try {
              const parsed: unknown = JSON.parse(jsonStr)
              onDataLine(parsed, ids.messageId)
            } catch {
              // Ignore unparseable SSE line
            }
          }
        })
        upstreamRes.on('end', () => {
          this.closeResponsesStream(clientRes, ids.responseId, ids.messageId)
        })
      },
    )
    upstreamReq.on('error', err => {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { message: `Bridge upstream error: ${err.message}` } }))
    })
    upstreamReq.write(outboundBody)
    upstreamReq.end()
  }

  private forwardChatDelta(
    clientRes: ServerResponse,
    messageId: string,
    delta: Record<string, unknown>,
    toolState: BridgeToolStreamState = createBridgeToolStreamState(),
  ): void {
    const content = delta.content
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning !== '') {
      this.writeSse(clientRes, 'response.reasoning.delta', {
        item_id: messageId,
        delta: reasoning,
      })
    }
    if (typeof content === 'string' && content !== '') {
      this.writeSse(clientRes, 'response.output_text.delta', {
        item_id: messageId,
        delta: content,
      })
    }
    const toolCalls = delta.tool_calls
    if (Array.isArray(toolCalls)) {
      for (const entry of toolCalls) {
        const tc = entry as { index?: unknown, id?: unknown, function?: { name?: unknown, arguments?: unknown } }
        const name = typeof tc.function?.name === 'string' && tc.function.name !== '' ? tc.function.name : undefined
        const args = typeof tc.function?.arguments === 'string' && tc.function.arguments !== '' ? tc.function.arguments : undefined
        if (name === undefined && args === undefined) continue
        let resolvedId: string | undefined
        if (typeof tc.index === 'number') {
          resolvedId = typeof tc.id === 'string' && tc.id !== '' ? tc.id : toolState.idByIndex.get(tc.index)
          if (resolvedId === undefined) {
            resolvedId = `call_${Math.random().toString(36).slice(2, 10)}`
          }
          toolState.idByIndex.set(tc.index, resolvedId)
        } else {
          resolvedId = typeof tc.id === 'string' && tc.id !== '' ? tc.id : undefined
          if (resolvedId === undefined) {
            resolvedId = `call_${Math.random().toString(36).slice(2, 10)}`
          }
        }
        if (name !== undefined && !toolState.seenIds.has(resolvedId)) {
          toolState.seenIds.add(resolvedId)
          const outputIndex = toolState.nextOutputIndex++
          this.writeSse(clientRes, 'response.output_item.added', {
            output_index: outputIndex,
            item: {
              id: resolvedId,
              type: 'function_call',
              name,
              arguments: '',
            },
          })
        }
        if (args !== undefined) {
          this.writeSse(clientRes, 'response.function_call_arguments.delta', {
            item_id: resolvedId,
            delta: args,
          })
        }
      }
    }
  }

  private openResponsesStream(clientRes: ServerResponse): { responseId: string, messageId: string } {
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const responseId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    this.writeSse(clientRes, 'response.created', {
      response: { id: responseId, status: 'in_progress' },
    })
    this.writeSse(clientRes, 'response.output_item.added', {
      output_index: 0,
      item: { id: messageId, type: 'message', role: 'assistant', content: [] },
    })
    this.writeSse(clientRes, 'response.content_part.added', {
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'text', text: '' },
    })
    return { responseId, messageId }
  }

  private closeResponsesStream(clientRes: ServerResponse, responseId: string, messageId: string): void {
    this.writeSse(clientRes, 'response.output_item.done', {
      output_index: 0,
      item: { id: messageId, type: 'message', status: 'completed' },
    })
    this.writeSse(clientRes, 'response.completed', {
      response: { id: responseId, status: 'completed' },
    })
    clientRes.write('data: [DONE]\n\n')
    clientRes.end()
  }

  private writeSse(res: ServerResponse, event: string, data: Record<string, unknown>): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  private convertInputToMessages(input: unknown): ChatMessage[] {
    if (typeof input === 'string') {
      return [{ role: 'user', content: input }]
    }
    if (!Array.isArray(input)) {
      return [{ role: 'user', content: 'Hello' }]
    }

    const messages: ChatMessage[] = []
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item })
        continue
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        const kind = record.type
        if (kind === 'function_call') {
          const callId = typeof record.call_id === 'string' && record.call_id !== '' ? record.call_id : typeof record.id === 'string' ? record.id : `call_${Math.random().toString(36).slice(2, 10)}`
          const fname = typeof record.name === 'string' ? record.name : ''
          const fargs = typeof record.arguments === 'string' ? record.arguments : ''
          if (fname !== '') {
            messages.push({ role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: fname, arguments: fargs } }] })
            continue
          }
        }
        if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
          const callId = typeof record.call_id === 'string' && record.call_id !== '' ? record.call_id : typeof record.id === 'string' ? record.id : ''
          const output = record.output
          const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
          messages.push({ role: 'tool', content: text, tool_call_id: callId })
          continue
        }
        const role = (item as { role?: string }).role || 'user'
        const content = (item as { content?: unknown }).content
        if (typeof content === 'string') {
          messages.push({ role, content })
        } else if (Array.isArray(content)) {
          const parts: ChatContentPart[] = []
          for (const part of content) {
            const mapped = toChatContentPart(part)
            if (mapped !== undefined) parts.push(mapped)
          }
          if (parts.some(part => part.type === 'image_url')) {
            messages.push({ role, content: parts })
          } else {
            const text = parts
              .filter((part): part is ChatTextPart => part.type === 'text')
              .map(part => part.text)
              .join('\n')
            messages.push({ role, content: text })
          }
        }
      }
    }
    return messages.length > 0 ? messages : [{ role: 'user', content: 'Hello' }]
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = 0
    }
  }
}
