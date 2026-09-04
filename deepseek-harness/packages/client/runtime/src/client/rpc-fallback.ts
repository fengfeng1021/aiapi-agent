/**
 * Local transport-failure helpers for the runtime object layer.
 *
 * Mirrors `transportError` from `@deepseek-ai/dsh-client-connection` and
 * `SESSION_SEARCH_RESULT_LIMIT` from `@deepseek-ai/dsh-api-session-controller`.
 * They are intentionally duplicated here instead of imported: client bundle
 * purity forbids feature-plugin value imports across packages (see
 * `verify-client-packages`), and both values are leaf-stable
 * (a 10-line pure function and the number 20). Keep in sync with the
 * canonical definitions when they change.
 */

/** Carrier-neutral failure returned by one logical RPC endpoint. */
export interface RpcFallbackFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Carrier-neutral result returned by one logical RPC endpoint. */
export type RpcFallbackResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcFallbackFailure }

/**
 * Convert a rejected transport operation into a generic failure result.
 * @param error - rejected transport value.
 * @returns an `internal` failure preserving the message.
 */
export function transportError<T>(error: unknown): RpcFallbackResult<T> {
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Maximum session-search results transported in one response. */
export const SESSION_SEARCH_RESULT_LIMIT = 20
