import { describe, expect, it } from 'vitest'
import {
  mapToAntigravityModel,
  ANTIGRAVITY_AVAILABLE_MODELS,
  handleAntigravityRequest,
} from '../src/antigravity-forwarder.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'

describe('antigravity-forwarder', () => {
  it('maps known model aliases to internal Antigravity model IDs', () => {
    expect(mapToAntigravityModel('gemini-3.7-flash')).toBe('gemini-3.7-flash-tiered')
    expect(mapToAntigravityModel('gemini-2.5-flash')).toBe('gemini-3.6-flash-high')
    expect(mapToAntigravityModel('gemini-3.6-flash')).toBe('gemini-3.6-flash-high')
    expect(mapToAntigravityModel('gemini-2.5-pro')).toBe('gemini-pro-agent')
    expect(mapToAntigravityModel('models/gemini-2.5-pro')).toBe('gemini-pro-agent')
    expect(mapToAntigravityModel('claude-3-7-sonnet')).toBe('claude-sonnet-4-6')
    expect(mapToAntigravityModel('gemini-3.6-flash-high')).toBe('gemini-3.6-flash-high')
  })

  it('exposes Antigravity available models catalog', () => {
    expect(ANTIGRAVITY_AVAILABLE_MODELS.length).toBeGreaterThan(0)
    const flash = ANTIGRAVITY_AVAILABLE_MODELS.find(m => m.name.includes('gemini-3.6-flash-high'))
    expect(flash).toBeDefined()
    expect(flash?.supportedGenerationMethods).toContain('streamGenerateContent')
  })

  it('handles GET /api/antigravity/v1beta/models correctly', async () => {
    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/api/antigravity/v1beta/models',
      headers: {},
    }) as unknown as IncomingMessage

    let statusCode = 0
    let written = ''
    const headers: Record<string, string> = {}

    const res = {
      setHeader(k: string, v: string) { headers[k] = v },
      writeHead(code: number, h?: Record<string, string>) {
        statusCode = code
        if (h) Object.assign(headers, h)
      },
      end(data?: string) {
        if (data) written += data
      },
    } as unknown as ServerResponse

    await handleAntigravityRequest(req, res)

    expect(statusCode).toBe(200)
    expect(headers['Content-Type']).toBe('application/json')
    const parsed = JSON.parse(written) as { models: Array<{ name: string }> }
    expect(parsed.models).toBeDefined()
    expect(parsed.models.some(m => m.name.includes('gemini-3.6-flash-high'))).toBe(true)
  })
})
