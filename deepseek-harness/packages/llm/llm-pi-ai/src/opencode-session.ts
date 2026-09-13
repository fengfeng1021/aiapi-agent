/**
 * OpenCode session attribution for provider requests.
 *
 * OpenCode Go routes and caches by conversation: every request must carry a
 * stable session id in `x-opencode-session`
 * (https://opencode.ai/docs/go/#where-can-i-use-it). Requests without one
 * cannot be routed efficiently and fail with `MissingSessionID`.
 *
 * @module dsh-llm-pi-ai/opencode-session
 */

/** Session header OpenCode Go reads for routing and prompt-cache affinity. */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/**
 * Decide the session header for one provider request. Only OpenCode-served
 * endpoints take it: every other gateway must never see another product's
 * routing header.
 * @param baseUrl - the resolved model endpoint this request targets.
 * @param sessionId - the harness session identity stamped by the loop, stable
 * per conversation.
 * @returns the header entry, or an empty record when the route is not
 * OpenCode-served or no session identity exists.
 */
export function opencodeSessionHeaders(
  baseUrl: string | undefined,
  sessionId: string | undefined,
): Record<string, string> {
  if (baseUrl === undefined || sessionId === undefined || sessionId.length === 0) return {}
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return {}
  }
  if (hostname !== 'opencode.ai' && !hostname.endsWith('.opencode.ai')) return {}
  return { [OPENCODE_SESSION_HEADER]: sessionId }
}
