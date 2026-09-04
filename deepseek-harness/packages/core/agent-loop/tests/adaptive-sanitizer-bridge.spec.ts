import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AdaptiveParamSanitizer } from '../src/param-sanitizer.js'
import { inferDefaultCapabilities, capabilityStore } from '../src/provider-probe.js'
import { UniversalResponsesBridge } from '../src/responses-bridge.js'

describe('Adaptive Parameter Sanitization and Universal Bridge', () => {
  it('infers reasoning capabilities for reasoning models and chat capabilities for chat models', () => {
    const sparkCap = inferDefaultCapabilities('opencode-go', 'muse-spark-1.3-contributor')
    expect(sparkCap.supportsReasoningEffort).toBe(true)
    expect(sparkCap.maxReasoningEffort).toBe('xhigh')
    expect(sparkCap.wireProtocol).toBe('responses')

    const deepseekCap = inferDefaultCapabilities('deepseek', 'deepseek-chat', 'https://api.deepseek.com/v1')
    expect(deepseekCap.supportsReasoningEffort).toBe(false)
    expect(deepseekCap.wireProtocol).toBe('chat')
  })

  it('sanitizes parameters according to model capabilities', () => {
    const sanitizedSpark = AdaptiveParamSanitizer.sanitize('opencode-go', 'muse-spark-1.3-contributor', 'xhigh')
    expect(sanitizedSpark.reasoningEffort).toBe('xhigh')
    expect(sanitizedSpark.strippedParams).not.toContain('reasoning_effort')

    const sanitizedChat = AdaptiveParamSanitizer.sanitize('deepseek', 'deepseek-chat', 'xhigh')
    expect(sanitizedChat.reasoningEffort).toBeUndefined()
    expect(sanitizedChat.strippedParams).toContain('reasoning_effort')
  })

  it('detects parameter compatibility errors accurately', () => {
    expect(AdaptiveParamSanitizer.isParamCompatibilityError('Unrecognized request argument: reasoning_effort')).toBe(true)
    expect(AdaptiveParamSanitizer.isParamCompatibilityError('Extra inputs are not permitted: reasoning_effort')).toBe(true)
    expect(AdaptiveParamSanitizer.isParamCompatibilityError('service_tier is not supported for this model')).toBe(true)
    expect(AdaptiveParamSanitizer.isParamCompatibilityError('Rate limit exceeded')).toBe(false)
    expect(AdaptiveParamSanitizer.isParamCompatibilityError('Invalid API key provided')).toBe(false)
  })

  it('learns from runtime failure and dynamically strips offending parameter', () => {
    const testProvider = 'test-custom-provider'
    const testModel = 'custom-hybrid-model'

    // Initially assume default capabilities
    capabilityStore.set(testProvider, testModel, {
      wireProtocol: 'responses',
      supportsReasoningEffort: true,
      supportsServiceTier: true,
      supportsDeveloperRole: true,
      maxTokensField: 'max_completion_tokens',
      supportsToolCalling: true,
    })

    const beforeLearning = AdaptiveParamSanitizer.sanitize(testProvider, testModel, 'high')
    expect(beforeLearning.reasoningEffort).toBe('high')

    // Simulate upstream platform rejecting reasoning_effort
    const learned = AdaptiveParamSanitizer.learnFromFailure(
      testProvider,
      testModel,
      '400 Bad Request: unrecognized request argument: reasoning_effort',
    )
    expect(learned.recovered).toBe(true)
    expect(learned.offendingParam).toBe('reasoning_effort')

    // Subsequent sanitize calls must strip reasoning_effort automatically
    const afterLearning = AdaptiveParamSanitizer.sanitize(testProvider, testModel, 'high')
    expect(afterLearning.reasoningEffort).toBeUndefined()
    expect(afterLearning.strippedParams).toContain('reasoning_effort')
  })

  describe('UniversalResponsesBridge protocol conversion', () => {
    let mockChatServer: Server
    let mockChatPort = 0
    let receivedChatRequest: any = null

    beforeAll(async () => {
      // Mock an upstream platform that only speaks standard /v1/chat/completions
      await new Promise<void>((resolve) => {
        mockChatServer = createServer((req, res) => {
          if (req.url === '/v1/chat/completions') {
            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', () => {
              receivedChatRequest = JSON.parse(body)
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              })
              // Send mock chat.completion.chunk SSE
              res.write('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello from mock chat platform!"}}]}\n\n')
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

    it('translates /responses requests into /chat/completions and streams responses SSE back', async () => {
      const bridge = UniversalResponsesBridge.getInstance()
      const bridgePort = await bridge.start()
      expect(bridgePort).toBeGreaterThan(0)

      bridge.registerTarget({
        id: 'mock-platform',
        baseUrl: `http://127.0.0.1:${mockChatPort}/v1`,
        apiKey: 'test-key',
      })

      // Send a Responses-formatted request to the bridge
      const responsesPayload = {
        model: 'deepseek-v3',
        input: [
          { role: 'user', content: 'Say hi' },
        ],
      }

      const res = await fetch(`http://127.0.0.1:${bridgePort}/bridge/mock-platform/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(responsesPayload),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      // Verify upstream received valid chat/completions format
      expect(receivedChatRequest).toBeDefined()
      expect(receivedChatRequest.model).toBe('deepseek-v3')
      expect(receivedChatRequest.messages).toEqual([{ role: 'user', content: 'Say hi' }])

      // Verify the client received translated /responses SSE events
      const text = await res.text()
      expect(text).toContain('event: response.created')
      expect(text).toContain('event: response.output_item.added')
      expect(text).toContain('Hello from mock chat platform!')
      expect(text).toContain('event: response.completed')
    })
  })
})
