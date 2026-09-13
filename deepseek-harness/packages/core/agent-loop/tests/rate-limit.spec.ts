import { describe, expect, it } from 'vitest'
import {
  GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS,
  isGatewayRateLimitError,
  withRateLimitHint,
} from '../src/rate-limit.ts'

const RATE_429 = 'exceeded retry limit, last status: 429 Too Many Requests, request id: a37a4c968d435ef0-PDX'

describe('isGatewayRateLimitError', () => {
  it('matches the Codex bare-429 turn failure', () => {
    expect(isGatewayRateLimitError(RATE_429)).toBe(true)
  })

  it('matches other bare-429 wordings', () => {
    expect(isGatewayRateLimitError('unexpected status 429: Too Many Requests')).toBe(true)
    expect(isGatewayRateLimitError('POST https://gateway.example/v1/responses failed with 429')).toBe(true)
    expect(isGatewayRateLimitError('rate_limit_exceeded: slow down')).toBe(true)
  })

  it('rejects quota and billing failures that retrying cannot heal', () => {
    expect(isGatewayRateLimitError('quota exceeded: billing hard limit')).toBe(false)
    expect(isGatewayRateLimitError('insufficient_quota: check plan and billing')).toBe(false)
    expect(isGatewayRateLimitError('You have hit your usage limit for codex. Switch to another model now.')).toBe(false)
    expect(isGatewayRateLimitError('exceeded retry limit, last status: 500 Internal Server Error')).toBe(false)
    expect(isGatewayRateLimitError('Codex turn failed')).toBe(false)
  })
})

describe('withRateLimitHint', () => {
  it('keeps the request id and appends actionable guidance for 429s', () => {
    const hinted = withRateLimitHint(RATE_429)
    expect(hinted).toContain('a37a4c968d435ef0-PDX')
    expect(hinted).toContain('网关限流')
    expect(hinted).toContain('aiapi')
    expect(hinted).toContain('已自动退避重试仍失败')
  })

  it('leaves unrelated failures untouched', () => {
    expect(withRateLimitHint('Codex turn failed')).toBe('Codex turn failed')
  })
})

describe('gateway 429 backoff schedule', () => {
  it('waits out bursts with a bounded conservative schedule', () => {
    expect(GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS).toEqual([5_000, 15_000, 30_000, 60_000, 120_000])
  })
})
