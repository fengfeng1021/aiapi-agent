import { describe, expect, it } from 'vitest'
import { bridgeSessionHeaders, OPENCODE_SESSION_HEADER } from '../src/responses-bridge.ts'

const TURN_METADATA = JSON.stringify({ thread_id: 'thread-1', session_id: 'session-1', turn_id: 'turn-1' })

describe('bridgeSessionHeaders', () => {
  it('preserves an explicit OpenCode session header', () => {
    expect(bridgeSessionHeaders('https://opencode.ai/zen/v1', { [OPENCODE_SESSION_HEADER]: 's-1' })).toEqual({
      [OPENCODE_SESSION_HEADER]: 's-1',
    })
  })

  it('derives the session from Codex turn metadata, preferring the thread', () => {
    expect(bridgeSessionHeaders('https://opencode.ai/zen/go/v1', { 'x-codex-turn-metadata': TURN_METADATA })).toEqual({
      [OPENCODE_SESSION_HEADER]: 'thread-1',
      'x-codex-turn-metadata': TURN_METADATA,
    })
  })

  it('falls back to the metadata session id without a thread', () => {
    const metadata = JSON.stringify({ session_id: 'session-9' })
    expect(bridgeSessionHeaders('https://opencode.ai/zen/v1', { 'x-codex-turn-metadata': metadata })).toEqual({
      [OPENCODE_SESSION_HEADER]: 'session-9',
      'x-codex-turn-metadata': metadata,
    })
  })

  it('forwards turn metadata even when no session derives from it', () => {
    expect(bridgeSessionHeaders('https://opencode.ai/zen/v1', { 'x-codex-turn-metadata': 'not-json' })).toEqual({
      'x-codex-turn-metadata': 'not-json',
    })
  })

  it('sends nothing without any session identity', () => {
    expect(bridgeSessionHeaders('https://opencode.ai/zen/v1', {})).toEqual({})
  })

  it('never leaks internal identities to unrelated providers', () => {
    const incoming = { [OPENCODE_SESSION_HEADER]: 's-1', 'x-codex-turn-metadata': TURN_METADATA }
    expect(bridgeSessionHeaders('https://api.deepseek.com/v1', incoming)).toEqual({})
    expect(bridgeSessionHeaders('http://127.0.0.1:11434/v1', incoming)).toEqual({})
    expect(bridgeSessionHeaders('not a url', incoming)).toEqual({})
  })
})
