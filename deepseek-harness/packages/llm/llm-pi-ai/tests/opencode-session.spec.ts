import { describe, expect, it } from 'vitest'
import { OPENCODE_SESSION_HEADER, opencodeSessionHeaders } from '../src/opencode-session.ts'

describe('opencodeSessionHeaders', () => {
  it('stamps the stable session id on OpenCode-served endpoints', () => {
    expect(opencodeSessionHeaders('https://opencode.ai/zen/go/v1', 'session-1')).toEqual({
      [OPENCODE_SESSION_HEADER]: 'session-1',
    })
    expect(opencodeSessionHeaders('https://opencode.ai/zen/v1', 'session-1')).toEqual({
      [OPENCODE_SESSION_HEADER]: 'session-1',
    })
  })

  it('matches OpenCode subdomains but nothing else', () => {
    expect(opencodeSessionHeaders('https://go.opencode.ai/v1', 's')).toEqual({ [OPENCODE_SESSION_HEADER]: 's' })
    expect(opencodeSessionHeaders('https://aiapi.tw/v1', 's')).toEqual({})
    expect(opencodeSessionHeaders('https://api.openai.com/v1', 's')).toEqual({})
    expect(opencodeSessionHeaders('https://opencode.ai.evil.example/v1', 's')).toEqual({})
  })

  it('stays silent without a session identity or a usable endpoint', () => {
    expect(opencodeSessionHeaders('https://opencode.ai/zen/go/v1', undefined)).toEqual({})
    expect(opencodeSessionHeaders('https://opencode.ai/zen/go/v1', '')).toEqual({})
    expect(opencodeSessionHeaders(undefined, 'session-1')).toEqual({})
    expect(opencodeSessionHeaders('not a url', 'session-1')).toEqual({})
  })
})
