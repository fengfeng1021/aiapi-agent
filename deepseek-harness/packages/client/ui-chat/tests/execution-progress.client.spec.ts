// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  projectExecutionProgress,
  summarizeExecutionProgress,
  type ExecutionStep,
} from '../src/client/chat/execution-progress.ts'

describe('summarizeExecutionProgress', () => {
  it('reports empty as settled at 100', () => {
    expect(summarizeExecutionProgress([])).toEqual({
      total: 0,
      done: 0,
      running: 0,
      failed: 0,
      percent: 100,
      settled: false,
    })
  })

  it('counts streaming states and floors percent', () => {
    const steps: ExecutionStep[] = [
      { id: 'a', label: 'read', status: 'done' },
      { id: 'b', label: 'plan', status: 'running', detail: 'scanning 3 files' },
      { id: 'c', label: 'write', status: 'pending' },
    ]
    expect(summarizeExecutionProgress(steps)).toEqual({
      total: 3,
      done: 1,
      running: 1,
      failed: 0,
      percent: 33,
      settled: false,
    })
  })

  it('marks all-terminal lists settled at 100', () => {
    const steps: ExecutionStep[] = [
      { id: 'a', label: 'read', status: 'done' },
      { id: 'b', label: 'write', status: 'failed', detail: 'denied' },
    ]
    expect(summarizeExecutionProgress(steps)).toEqual({
      total: 2,
      done: 1,
      running: 0,
      failed: 1,
      percent: 100,
      settled: true,
    })
  })
})

describe('projectExecutionProgress', () => {
  it('passes streaming lists through in order by default', () => {
    const steps: ExecutionStep[] = [
      { id: 'a', label: 'read', status: 'done' },
      { id: 'b', label: 'plan', status: 'running' },
    ]
    expect(projectExecutionProgress(steps)).toEqual(steps)
  })

  it('collapses to terminal steps under reduced motion', () => {
    const steps: ExecutionStep[] = [
      { id: 'a', label: 'read', status: 'done' },
      { id: 'b', label: 'plan', status: 'running', detail: 'working' },
      { id: 'c', label: 'wait', status: 'pending' },
      { id: 'd', label: 'write', status: 'failed', detail: 'denied' },
    ]
    expect(projectExecutionProgress(steps, { reducedMotion: true })).toEqual([
      { id: 'a', label: 'read', status: 'done' },
      { id: 'd', label: 'write', status: 'failed', detail: 'denied' },
    ])
  })
})
