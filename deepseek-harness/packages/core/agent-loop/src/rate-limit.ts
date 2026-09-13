/**
 * Transient gateway-throttling (bare HTTP 429) recognition and recovery
 * policy for turns served through the Codex App-Server backend.
 *
 * The throttling gateway sends no `Retry-After` header, so the deployment
 * waits out bursts with its own conservative backoff schedule instead of
 * hammering the endpoint. Quota exhaustion (`usage_limit_reached`,
 * `insufficient_quota`) is deliberately NOT matched: retrying a depleted
 * quota can never succeed.
 *
 * @module dsh-agent-loop/rate-limit
 */

/**
 * Backoff schedule for transient gateway throttling observed on a finished
 * Codex turn: five retries at 5s, 15s, 30s, 60s, then 120s.
 */
export const GATEWAY_RATE_LIMIT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000]

/**
 * Whether a finished-turn failure message reports transient gateway
 * throttling that is worth one more attempt after a backoff sleep. Matches
 * the Codex "exceeded retry limit, last status: 429" shape and other bare-429
 * wordings, while excluding quota/billing failures.
 * @param message - the failed turn's error message.
 * @returns true when a backoff retry may succeed.
 */
export function isGatewayRateLimitError(message: string): boolean {
  if (/usage[_ -]?limit|insufficient[_ -]?quota|\bquota\b/i.test(message)) return false
  return /\b429\b|rate[_ -]?limit/i.test(message)
}

/**
 * Append an actionable hint to a terminal gateway-throttling failure. The raw
 * message (with its request id) is preserved for diagnostics.
 * @param message - the failed turn's error message.
 * @returns the message users see when no retry budget remains.
 */
export function withRateLimitHint(message: string): string {
  if (!isGatewayRateLimitError(message)) return message
  return `${message}（网关限流 429：已自动退避重试仍失败。请稍后重试，或将模型切换到 aiapi 路由；同时避免多个高强度会话并发。）`
}
