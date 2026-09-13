/** Pure flow-row grouping for consecutive same-round tool calls. No React. */

/** One ChatView flow row: a single node, or a run of same-round tool rows. */
export type FlowRow =
  | { readonly kind: 'node'; readonly key: string }
  | {
    readonly kind: 'tools'
    readonly key: string
    readonly keys: readonly string[]
    readonly turn: number
    readonly step: number
  }

/**
 * Fold runs of consecutive same-round tool-call rows into group rows so a
 * burst of tool calls reads as one summary line instead of N cards. A lone
 * tool keeps its own row; anything that is not a tool-call row, or that
 * leaves the round, breaks the run.
 * @param keys - flow order node keys.
 * @param toolCoords - round coordinates for tool-call keys, undefined otherwise.
 * @returns flow rows in the same order.
 */
export function groupFlowRows(
  keys: readonly string[],
  toolCoords: (key: string) => { turn: number; step: number } | undefined,
): FlowRow[] {
  const rows: FlowRow[] = []
  let run: string[] = []
  let runTurn = -1
  let runStep = -1
  const flush = (): void => {
    if (run.length === 0) return
    const [first] = run
    if (run.length === 1 || first === undefined) {
      for (const key of run) rows.push({ kind: 'node', key })
    } else {
      rows.push({ kind: 'tools', key: `tools:${first}`, keys: [...run], turn: runTurn, step: runStep })
    }
    run = []
  }
  for (const key of keys) {
    const coords = toolCoords(key)
    if (coords === undefined || (run.length > 0 && (coords.turn !== runTurn || coords.step !== runStep))) {
      flush()
      if (coords === undefined) {
        rows.push({ kind: 'node', key })
        continue
      }
      runTurn = coords.turn
      runStep = coords.step
    } else if (run.length === 0) {
      runTurn = coords.turn
      runStep = coords.step
    }
    run.push(key)
  }
  flush()
  return rows
}
