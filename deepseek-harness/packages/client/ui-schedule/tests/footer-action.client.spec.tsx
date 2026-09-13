// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  SchedulesFooterAction,
  type SchedulesFooterActionProps,
} from '../src/client/SchedulesFooterAction.tsx'
import { zh } from '../src/client/locales.ts'

const START = Date.parse('2026-08-25T12:00:00.000Z')
const SESSION = 'schedule-session' as SessionId

function record(
  id: string,
  kind: ScheduleRecord['kind'],
  scheduledAt: number,
  options: {
    prompt?: string
    afterSeconds?: number
    everySeconds?: number
    meta?: ScheduleRecord['meta']
  } = {},
): ScheduleRecord {
  const common = {
    id: ScheduleId(id),
    prompt: options.prompt ?? id,
    scheduledAt: new Date(scheduledAt).toISOString(),
  }
  if (kind === 'after') {
    return {
      ...common,
      kind,
      afterSeconds: options.afterSeconds ?? 30,
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    }
  }
  if (kind === 'every') {
    return {
      ...common,
      kind,
      everySeconds: options.everySeconds ?? 300,
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    }
  }
  return { ...common, kind, ...(options.meta === undefined ? {} : { meta: options.meta }) }
}

const MEETING = record('meeting', 'at', START + 3_600_000, { prompt: 'Join meeting' })
const METRICS = record('metrics', 'every', START + 300_000, {
  prompt: 'Check metrics',
  everySeconds: 300,
  meta: {
    title: '每週指標',
    project: 'harness',
    model: 'deepseek-chat',
    reasoning: 'high',
    notify: 'on-failure',
    paused: false,
  },
})
const OVERDUE = record('overdue', 'after', START - 60_000, {
  prompt: 'Check logs',
  meta: { notify: 'all' },
})
const PAUSED = record('paused', 'every', START + 600_000, {
  prompt: 'Paused task',
  everySeconds: 3600,
  meta: { title: '已暫停項目', notify: 'never', paused: true },
})
const OLD_PAUSED = record('old-paused', 'after', START - 120_000, {
  prompt: 'Old paused',
  meta: { notify: 'never', paused: true },
})
const RECORDS = [MEETING, METRICS, OVERDUE, PAUSED, OLD_PAUSED]

function mount(
  records: readonly ScheduleRecord[] | undefined,
  options: { noSession?: boolean } = {},
) {
  const current = options.noSession ? undefined : SESSION
  const schedule = records === undefined ? {} : { schedule: records }
  const useSessions = <T,>(select: (value: {
    current: SessionId | undefined
    byId: Record<string, { projectionValues?: { schedule?: readonly ScheduleRecord[] } }>
  }) => T): T => select({
    current,
    byId: current === undefined ? {} : { [current as string]: { projectionValues: schedule } },
  })
  const props = {
    wide: true,
    useSessions,
    t: makeTranslate(zh),
  } as unknown as SchedulesFooterActionProps
  return render(<SchedulesFooterAction {...props} />)
}

function openPanel(records: readonly ScheduleRecord[] | undefined) {
  mount(records)
  fireEvent.click(screen.getByRole('button', { name: '已排程' }))
  return screen.getByRole('dialog', { name: '已排程任务' })
}

function rowButton(title: string): HTMLElement {
  // Titles may equal their prompt fallback, so disambiguate by the title span.
  const name = screen
    .getAllByText(title)
    .find(node => node instanceof HTMLElement && node.className.includes('rowTitle'))
  const button = name?.closest('button') ?? null
  if (button === null) throw new Error('expected a schedule row button')
  return button
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  document.documentElement.lang = 'zh'
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('SchedulesFooterAction manager', () => {
  it('opens the panel with the title, count, and overdue-first rows', () => {
    const dialog = openPanel(RECORDS)
    expect(dialog.textContent).toContain('已排程任务')
    expect(screen.getByText('5 个提醒')).toBeTruthy()
    const rows = screen.getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Old paused'),
      expect.stringContaining('Check logs'),
      expect.stringContaining('每週指標'),
      expect.stringContaining('已暫停項目'),
      expect.stringContaining('Join meeting'),
    ])
  })

  it('counts a single record with the singular copy', () => {
    openPanel([MEETING])
    expect(screen.getByText('1 个提醒')).toBeTruthy()
  })

  it('renders icon-only on the rail and toggles closed', () => {
    const useSessions = <T,>(select: (value: unknown) => T): T => select({
      current: SESSION,
      byId: { [SESSION as string]: { projectionValues: { schedule: RECORDS } } },
    })
    const props = {
      wide: false,
      useSessions,
      t: makeTranslate(zh),
    } as unknown as SchedulesFooterActionProps
    render(<SchedulesFooterAction {...props} />)
    expect(screen.queryByText('已排程')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '已排程' }))
    expect(screen.getByRole('dialog', { name: '已排程任务' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '已排程' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('filters rows by triage state and collapses detail on switch', () => {
    openPanel(RECORDS)
    fireEvent.click(rowButton('Join meeting'))
    expect(screen.getByText(/2026/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '已逾期' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Check logs')).toBeTruthy()
    expect(screen.queryByText(/2026/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '已暂停' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('已暫停項目')).toBeTruthy()
    expect(screen.getByText('Old paused')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '等待中' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('filters rows by the search query across titles and prompts', () => {
    openPanel(RECORDS)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索提醒' }), { target: { value: 'meeting' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索提醒' }), { target: { value: '每週' } })
    expect(screen.getByText('每週指標')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索提醒' }), { target: { value: 'zzz' } })
    expect(screen.getByText('没有符合的提醒')).toBeTruthy()
  })

  it('expands rows into detail with stored metadata', () => {
    openPanel(RECORDS)
    fireEvent.click(rowButton('每週指標'))
    const metrics = rowButton('每週指標').closest('li')
    if (metrics === null) throw new Error('expected the metrics row')
    const metricsView = within(metrics)
    expect(metricsView.getByText('Check metrics')).toBeTruthy()
    expect(metricsView.getByText('项目: harness')).toBeTruthy()
    expect(metricsView.getByText('模型: deepseek-chat')).toBeTruthy()
    expect(metricsView.getByText('推理: high')).toBeTruthy()
    expect(metricsView.getByText('通知: 失败时')).toBeTruthy()
    fireEvent.click(rowButton('已暫停項目'))
    const paused = rowButton('已暫停項目').closest('li')
    if (paused === null) throw new Error('expected the paused row')
    expect(within(paused).getByText('已暂停')).toBeTruthy()
    expect(screen.getByText('通知: 从不')).toBeTruthy()
    expect(screen.queryByText('Check metrics')).toBeNull()
    fireEvent.click(rowButton('已暫停項目'))
    expect(screen.queryByText('通知: 从不')).toBeNull()
    fireEvent.click(rowButton('Check logs'))
    const overdue = rowButton('Check logs').closest('li')
    if (overdue === null) throw new Error('expected the overdue row')
    expect(within(overdue).getByText(/已逾期/, { selector: 'p' })).toBeTruthy()
  })

  it('shows no metadata rows for version-1 records', () => {
    openPanel(RECORDS)
    fireEvent.click(rowButton('Join meeting'))
    expect(screen.queryByText(/项目/)).toBeNull()
    expect(screen.queryByText(/通知/)).toBeNull()
  })

  it('shows empty states without a session or records', () => {
    mount(undefined, { noSession: true })
    fireEvent.click(screen.getByRole('button', { name: '已排程' }))
    expect(screen.getByText('开始一个会话后查看排程')).toBeTruthy()
    cleanup()
    mount(undefined)
    fireEvent.click(screen.getByRole('button', { name: '已排程' }))
    expect(screen.getByText('没有符合的提醒')).toBeTruthy()
  })

  it('closes on Escape and ignores other keys while closed', () => {
    openPanel(RECORDS)
    const trigger = screen.getByRole('button', { name: '已排程' })
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '已排程任务' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: '已排程任务' })).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('flips rows to overdue as the browser clock advances', () => {
    const soon = record('soon', 'at', START + 500, { prompt: 'Due soon' })
    const dialog = openPanel([soon])
    expect(dialog.textContent).toContain('1秒后')
    expect(screen.getByText(/1秒后/)).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByText(/已逾期 1秒/)).toBeTruthy()
  })
})
