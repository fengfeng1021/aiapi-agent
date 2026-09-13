// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ToolGroupSeat } from '../src/client/chat/ToolGroup.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

function runningTool(callId: string) {
  return {
    kind: 'tool-call',
    data: {
      root: { callId, name: 'bash', argsRaw: '{}', turn: 1, step: 1, time: 1_000, subCalls: [] },
    },
  } as unknown as ChatNode
}

function settledTool(callId: string) {
  return {
    kind: 'tool-call',
    data: {
      root: {
        kind: 'tool-result', seq: 3, time: 3_000, callId,
        call: { name: 'bash', argsRaw: '{}' }, callTime: 1_000,
        content: [], isError: false, subCalls: [],
      },
    },
  } as unknown as ChatNode
}

function mount(nodeKeys: readonly string[], nodes: ReadonlyMap<string, ChatNode>, overrides: {
  selectedCallId?: string | undefined
  renderSeat?: ((nodeKey: string) => React.ReactNode) | undefined
} = {}) {
  const useChat = ((selector: (snapshot: { nodes: ReadonlyMap<string, ChatNode> }) => unknown) =>
    selector({ nodes })) as never
  const renderSeat = overrides.renderSeat ?? ((nodeKey: string) => <div data-testid={`seat-${nodeKey}`} />)
  return render(
    <ToolGroupSeat
      groupKey="tools:tool:a"
      nodeKeys={nodeKeys}
      useChat={useChat}
      selectedCallId={overrides.selectedCallId}
      renderSeat={renderSeat}
      t={t}
    />,
  )
}

describe('ToolGroupSeat', () => {
  it('collapses settled runs to a count line and expands on demand', () => {
    const nodes = new Map<string, ChatNode>([['tool:a', settledTool('a')], ['tool:b', settledTool('b')]])
    const view = mount(['tool:a', 'tool:b'], nodes)
    expect(view.getByText('2 次工具调用')).toBeTruthy()
    expect(view.queryByTestId('seat-tool:a')).toBeNull()
    fireEvent.click(view.getByText('2 次工具调用'))
    expect(view.getByTestId('seat-tool:a')).toBeTruthy()
    expect(view.getByTestId('seat-tool:b')).toBeTruthy()
  })

  it('stays open while a member runs and names the live state', () => {
    const nodes = new Map<string, ChatNode>([['tool:a', settledTool('a')], ['tool:b', runningTool('b')]])
    const view = mount(['tool:a', 'tool:b'], nodes)
    expect(view.getByText('运行中…')).toBeTruthy()
    expect(view.getByTestId('seat-tool:a')).toBeTruthy()
  })

  it('expands when the deep-link selection names a member', () => {
    const nodes = new Map<string, ChatNode>([['tool:a', settledTool('a')], ['tool:b', settledTool('b')]])
    const view = mount(['tool:a', 'tool:b'], nodes, { selectedCallId: 'b' })
    expect(view.getByTestId('seat-tool:b')).toBeTruthy()
  })
})
