import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { UniversalResponsesBridge } from '../src/responses-bridge.ts'

describe('UniversalResponsesBridge parallel tool calls', () => {
  let mockServer: Server
  let mockPort = 0
  let receivedBody: any = null

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer = createServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            receivedBody = JSON.parse(body)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            })
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n')
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"read_file","arguments":"{\\"path\\":\\"b\\"}"}}]}}]}\n\n')
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"+"}}]}}]}\n\n')
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

  it('keeps parallel calls distinct and routes continuation args by index', async () => {
    const bridge = UniversalResponsesBridge.getInstance()
    const bridgePort = await bridge.start()
    bridge.registerTarget({
      id: 'parallel-mock',
      baseUrl: 'http://127.0.0.1:' + mockPort,
      apiKey: 'test-key',
    })

    const res = await fetch('http://127.0.0.1:' + bridgePort + '/bridge/parallel-mock/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'parallel-test',
        input: [{ role: 'user', content: 'read both' }],
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    const added = text.split('response.output_item.added').length - 1
    expect(added).toBeGreaterThanOrEqual(3)
    expect(text).toContain('call_a')
    expect(text).toContain('call_b')
    expect(text).toContain('"output_index":1')
    expect(text).toContain('"output_index":2')
    expect(receivedBody.tool_choice).toBe('auto')
  })

  it('preserves function_call history for the next turn', async () => {
    const bridge = UniversalResponsesBridge.getInstance()
    const bridgePort = await bridge.start()
    bridge.registerTarget({
      id: 'parallel-mock',
      baseUrl: 'http://127.0.0.1:' + mockPort,
      apiKey: 'test-key',
    })
    receivedBody = null

    const res = await fetch('http://127.0.0.1:' + bridgePort + '/bridge/parallel-mock/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'parallel-test',
        input: [
          { role: 'user', content: 'read it' },
          { type: 'function_call', call_id: 'call_a', name: 'read_file', arguments: '{"path":"a"}' },
          { type: 'function_call_output', call_id: 'call_a', output: 'file-a-content' },
        ],
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    await res.text()
    expect(receivedBody).toBeDefined()
    const messages = receivedBody.messages as Array<Record<string, unknown>>
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(JSON.stringify(assistant)).toContain('call_a')
    const toolMsg = messages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(JSON.stringify(toolMsg)).toContain('file-a-content')
  })
})