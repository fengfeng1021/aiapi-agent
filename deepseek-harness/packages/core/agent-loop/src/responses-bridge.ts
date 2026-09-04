import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

export interface BridgeProviderTarget {
  id: string
  baseUrl: string
  apiKey?: string | undefined
}

/**
 * Lightweight in-process proxy that translates OpenAI `/v1/responses` protocol
 * into standard OpenAI `/v1/chat/completions` protocol.
 * Enables Codex App-Server to drive any chat completions API (DeepSeek, Ollama, Groq, etc.).
 */
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
        this.forwardAsChatCompletions(target, responsesPayload, res)
      } catch (err: unknown) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Malformed JSON payload' } }))
      }
    })
  }

  private forwardAsChatCompletions(
    target: BridgeProviderTarget,
    payload: Record<string, unknown>,
    clientRes: ServerResponse,
  ): void {
    const model = String(payload.model || 'default')
    const messages = this.convertInputToMessages(payload.input)
    const tools = payload.tools as unknown[] | undefined

    const chatPayload: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
      chatPayload.tools = tools
    }

    const targetUrl = new URL(
      target.baseUrl.endsWith('/chat/completions')
        ? target.baseUrl
        : `${target.baseUrl.replace(/\/v1\/?$/, '')}/v1/chat/completions`,
    )

    const isHttps = targetUrl.protocol === 'https:'
    const requester = isHttps ? httpsRequest : httpRequest

    const outHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (target.apiKey) {
      outHeaders.Authorization = `Bearer ${target.apiKey}`
    }

    const outboundBody = JSON.stringify(chatPayload)
    outHeaders['Content-Length'] = String(Buffer.byteLength(outboundBody))

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

        // Set up SSE stream back to Codex App-Server
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        const responseId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

        // Emit initial responses events
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
              const parsed = JSON.parse(jsonStr)
              const choice = parsed.choices?.[0]
              if (!choice) continue

              const delta = choice.delta || {}
              const content = delta.content || ''
              const reasoning = delta.reasoning_content || delta.reasoning || ''

              if (reasoning) {
                this.writeSse(clientRes, 'response.reasoning.delta', {
                  item_id: messageId,
                  delta: reasoning,
                })
              }

              if (content) {
                this.writeSse(clientRes, 'response.output_text.delta', {
                  item_id: messageId,
                  delta: content,
                })
              }

              // Tool calls translation
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name) {
                    this.writeSse(clientRes, 'response.output_item.added', {
                      output_index: 1,
                      item: {
                        id: tc.id || `call_${Math.random().toString(36).slice(2, 7)}`,
                        type: 'function_call',
                        name: tc.function.name,
                        arguments: '',
                      },
                    })
                  }
                  if (tc.function?.arguments) {
                    this.writeSse(clientRes, 'response.function_call_arguments.delta', {
                      item_id: tc.id,
                      delta: tc.function.arguments,
                    })
                  }
                }
              }
            } catch {
              // Ignore unparseable SSE line
            }
          }
        })

        upstreamRes.on('end', () => {
          this.writeSse(clientRes, 'response.output_item.done', {
            output_index: 0,
            item: { id: messageId, type: 'message', status: 'completed' },
          })
          this.writeSse(clientRes, 'response.completed', {
            response: { id: responseId, status: 'completed' },
          })
          clientRes.write('data: [DONE]\n\n')
          clientRes.end()
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

  private writeSse(res: ServerResponse, event: string, data: Record<string, unknown>): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  private convertInputToMessages(input: unknown): Array<{ role: string; content: string }> {
    if (typeof input === 'string') {
      return [{ role: 'user', content: input }]
    }
    if (!Array.isArray(input)) {
      return [{ role: 'user', content: 'Hello' }]
    }

    const messages: Array<{ role: string; content: string }> = []
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item })
      } else if (item && typeof item === 'object') {
        const role = (item as { role?: string }).role || 'user'
        const content = (item as { content?: unknown }).content
        if (typeof content === 'string') {
          messages.push({ role, content })
        } else if (Array.isArray(content)) {
          const text = content
            .map(c => (typeof c === 'string' ? c : (c as { text?: string })?.text || ''))
            .filter(Boolean)
            .join('\n')
          messages.push({ role, content: text })
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
