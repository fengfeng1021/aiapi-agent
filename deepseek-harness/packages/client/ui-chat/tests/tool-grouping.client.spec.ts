// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { groupFlowRows } from '../src/client/chat/tool-grouping.ts'

describe('groupFlowRows', () => {
  it('leaves lone tools and non-tool rows alone', () => {
    const coords = (key: string) => key.startsWith('tool:') ? { turn: 1, step: 1 } : undefined
    expect(groupFlowRows(['user:1', 'tool:a', 'assistant:2'], coords)).toEqual([
      { kind: 'node', key: 'user:1' },
      { kind: 'node', key: 'tool:a' },
      { kind: 'node', key: 'assistant:2' },
    ])
  })

  it('folds consecutive same-round tools into one group row', () => {
    const coords = (key: string) => key.startsWith('tool:') ? { turn: 1, step: 2 } : undefined
    expect(groupFlowRows(['assistant:1', 'tool:a', 'tool:b', 'tool:c'], coords)).toEqual([
      { kind: 'node', key: 'assistant:1' },
      { kind: 'tools', key: 'tools:tool:a', keys: ['tool:a', 'tool:b', 'tool:c'], turn: 1, step: 2 },
    ])
  })

  it('breaks runs across rounds and non-tool rows', () => {
    const coords = (key: string): { turn: number; step: number } | undefined => {
      if (key === 'tool:a' || key === 'tool:b') return { turn: 1, step: 1 }
      if (key === 'tool:c' || key === 'tool:d') return { turn: 1, step: 2 }
      if (key === 'tool:e') return { turn: 2, step: 1 }
      return undefined
    }
    expect(groupFlowRows(
      ['tool:a', 'tool:b', 'assistant:1', 'tool:c', 'tool:d', 'tool:e', 'user:2'],
      coords,
    )).toEqual([
      { kind: 'tools', key: 'tools:tool:a', keys: ['tool:a', 'tool:b'], turn: 1, step: 1 },
      { kind: 'node', key: 'assistant:1' },
      { kind: 'tools', key: 'tools:tool:c', keys: ['tool:c', 'tool:d'], turn: 1, step: 2 },
      { kind: 'node', key: 'tool:e' },
      { kind: 'node', key: 'user:2' },
    ])
  })

  it('handles empty input', () => {
    expect(groupFlowRows([], () => undefined)).toEqual([])
  })
})
