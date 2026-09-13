import { useEffect, useState, type ReactNode } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ToolGroup.module.css'

function groupInfo(nodes: ChatNodeStore, nodeKeys: readonly string[]): {
  count: number
  running: boolean
  callIds: readonly string[]
} {
  let count = 0
  let running = false
  const callIds: string[] = []
  for (const key of nodeKeys) {
    const node = nodes.get(key) as ChatNode | undefined
    if (node?.kind !== 'tool-call') continue
    count += 1
    const root = node.data.root
    callIds.push(root.callId)
    if (isRunningTool(root)) running = true
  }
  return { count, running, callIds }
}

/**
 * One collapsible summary row for a run of tool calls: settled runs collapse
 * to a count line, a running member keeps the line live, and expanding
 * reveals the ordinary tool rows underneath.
 */
export function ToolGroupSeat({
  groupKey, nodeKeys, useChat, selectedCallId, renderSeat, t,
}: {
  /** Stable row key derived from the run's first node. */
  readonly groupKey: string
  /** Member tool node keys in flow order. */
  readonly nodeKeys: readonly string[]
  readonly useChat: ChatViewSlotProps['useChat']
  /** Deep-link selection: expand when it names a member call. */
  readonly selectedCallId: string | undefined
  /** Render one member row exactly as the ungrouped flow would. */
  readonly renderSeat: (nodeKey: string) => ReactNode
  readonly t: ChatViewSlotProps['t']
}) {
  const nodes = useChat(snapshot => snapshot.nodes)
  const { count, running, callIds } = groupInfo(nodes, nodeKeys)
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  const open = override ?? running
  const callIdKey = callIds.join('\0')
  useEffect(() => {
    if (selectedCallId === undefined) return
    if (callIdKey.split('\0').includes(selectedCallId)) setOverride(true)
  }, [selectedCallId, callIdKey])
  if (count === 0) return null
  return (
    <div
      className={css.group}
      data-chat-flow-key={groupKey}
      data-chat-anchor-key={nodeKeys[0] ?? groupKey}
    >
      <DisclosureRow
        icon={<span className={css.dot} data-running={running || undefined} aria-hidden />}
        title={t(count === 1 ? 'tool.group.calls.one' : 'tool.group.calls.other', { count })}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOverride(value => !(value ?? running)) }}
        collapsedContent={running ? (<span className={css.running}>{t('tool.group.running')}</span>) : undefined}
      >
        {open ? <div className={css.members}>{nodeKeys.map(renderSeat)}</div> : null}
      </DisclosureRow>
    </div>
  )
}
