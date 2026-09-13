import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { UniversalResponsesBridge } from '../src/responses-bridge.ts'

describe('UniversalResponsesBridge Anthropic target', () => {
  let mockServer: Server
  let mockPort = 0
  let receivedHeaders: Record<string, string | string[] | undefined> = {}
  let receivedBody: any = null

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer = createServer((req, res) => {
        if (req.url === '/v1/messages') {
          receivedHeaders = { ...req.headers }
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            receivedBody = JSON.parse(body)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            })
            res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello-anthropic"}}\n\n')
            res.write('data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n')
            res.write('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Shanghai\\"}"}}\n\n')
            res.write('data: [DONE]\n\n')
            res.end()
          })
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address()
        if (addr && typeof addr === 'object') {
          mockPort = addr.port
          resolve()
        }
      })
    })
  })

  afterAll(() => {
    mockServer.close()
    UniversalResponsesBridge.getInstance().stop()
  })

  it('translates responses turns to Anthropic messages with images and tools', async () => {
    const bridge = UniversalResponsesBridge.getInstance()
    const bridgePort = await bridge.start()
    bridge.registerTarget({
      id: 'anthropic',
      baseUrl: 'http://127.0.0.1:' + mockPort,
      apiKey: 'test-key',
    })

    const res = await fetch('http://127.0.0.1:' + bridgePort + '/bridge/anthropic/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-test',
        input: [
          { role: 'system', content: 'You are concise' },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'describe' },
              { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('hello-anthropic')
    expect(text).toContain('get_weather')

    expect(receivedBody).toBeDefined()
    expect(receivedBody.model).toBe('claude-test')
    expect(receivedBody.max_tokens).toBe(8192)
    expect(receivedBody.stream).toBe(true)
    expect(receivedBody.system).toBe('You are concise')
    expect(receivedBody.messages).toHaveLength(1)
    expect(receivedBody.messages[0].content).toContainEqual({ type: 'text', text: 'describe' })
    expect(receivedBody.messages[0].content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    })
    expect(receivedBody.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ])

    expect(receivedHeaders['x-api-key']).toBe('test-key')
    expect(receivedHeaders['anthropic-version']).toBe('2023-06-01')
    expect(receivedHeaders.authorization).toBeUndefined()
  })
})
