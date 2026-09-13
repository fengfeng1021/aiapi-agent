import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { UniversalResponsesBridge } from '../src/responses-bridge.js'

describe('UniversalResponsesBridge image input', () => {
  let mockChatServer: Server
  let mockChatPort = 0
  let receivedChatRequest: any = null

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      mockChatServer = createServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            receivedChatRequest = JSON.parse(body)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            })
            res.write('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"ok"}}]}\n\n')
            res.write('data: [DONE]\n\n')
            res.end()
          })
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      mockChatServer.listen(0, '127.0.0.1', () => {
        const addr = mockChatServer.address()
        if (addr && typeof addr === 'object') {
          mockChatPort = addr.port
          resolve()
        }
      })
    })
  })

  afterAll(() => {
    mockChatServer.close()
    UniversalResponsesBridge.getInstance().stop()
  })

  it('forwards input_image parts as chat image_url parts', async () => {
    const bridge = UniversalResponsesBridge.getInstance()
    const bridgePort = await bridge.start()
    bridge.registerTarget({
      id: 'mock-images-platform',
      baseUrl: `http://127.0.0.1:${mockChatPort}/v1`,
      apiKey: 'test-key',
    })

    const imageUrl = 'data:image/png;base64,iVBORw0KGgo='
    const res = await fetch(`http://127.0.0.1:${bridgePort}/bridge/mock-images-platform/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'describe this image' },
              { type: 'input_image', image_url: imageUrl, detail: 'high' },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    await res.text()

    expect(receivedChatRequest).toBeDefined()
    expect(receivedChatRequest.messages).toHaveLength(1)
    const content = receivedChatRequest.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toContainEqual({ type: 'text', text: 'describe this image' })
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: imageUrl, detail: 'high' } })
  })

  it('keeps pure-text input as a plain string', async () => {
    const bridge = UniversalResponsesBridge.getInstance()
    const bridgePort = await bridge.start()
    bridge.registerTarget({
      id: 'mock-images-platform',
      baseUrl: `http://127.0.0.1:${mockChatPort}/v1`,
      apiKey: 'test-key',
    })
    receivedChatRequest = null

    const res = await fetch(`http://127.0.0.1:${bridgePort}/bridge/mock-images-platform/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v3',
        input: [{ role: 'user', content: 'Say hi' }],
      }),
    })

    expect(res.status).toBe(200)
    await res.text()

    expect(receivedChatRequest).toBeDefined()
    expect(receivedChatRequest.messages).toEqual([{ role: 'user', content: 'Say hi' }])
  })
})