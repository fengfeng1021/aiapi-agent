/** Pure GPT-style execution-progress projection. No React. */

/** Terminal-visible lifecycle of one execution step. */
export type ExecutionStepStatus = 'pending' | 'running' | 'done' | 'failed'

/** One user-visible execution step: identity plus status plus verbatim feedback. */
export interface ExecutionStep {
  readonly id: string
  readonly label: string
  readonly status: ExecutionStepStatus
  /** Verbatim model/user feedback for this step; kept verbatim, never localized. */
  readonly detail?: string
}

/** Aggregate counts derived from one step list. */
export interface ExecutionProgressSummary {
  readonly total: number
  readonly done: number
  readonly running: number
  readonly failed: number
  /** Integer 0-100; 100 only when every step is terminal. */
  readonly percent: number
  /** Whether any step still needs a live update. */
  readonly settled: boolean
}

/**
 * Fold one step list into aggregate counts.
 * @param steps - current user-visible steps in display order.
 * @returns totals plus an integer percent.
 */
export function summarizeExecutionProgress(steps: readonly ExecutionStep[]): ExecutionProgressSummary {
  let done = 0
  let running = 0
  let failed = 0
  for (const step of steps) {
    switch (step.status) {
      case 'done':
        done += 1
        break
      case 'running':
        running += 1
        break
      case 'failed':
        failed += 1
        break
      case 'pending':
        break
    }
  }
  const total = steps.length
  const terminal = done + failed
  const percent = total === 0 ? 100 : Math.floor((terminal * 100) / total)
  return {
    total,
    done,
    running,
    failed,
    percent,
    settled: total > 0 && terminal === total,
  }
}

/**
 * Project steps for render, honoring reduced motion.
 * Streaming callers pass the cumulative list; this function never reorders it.
 * @param steps - cumulative steps in display order.
 * @param options - reducedMotion collapses to terminal steps only.
 * @returns the render-visible step list.
 */
export function projectExecutionProgress(
  steps: readonly ExecutionStep[],
  options?: { readonly reducedMotion?: boolean },
): readonly ExecutionStep[] {
  if (options?.reducedMotion !== true) return steps
  return steps.filter(step => step.status === 'done' || step.status === 'failed')
}
