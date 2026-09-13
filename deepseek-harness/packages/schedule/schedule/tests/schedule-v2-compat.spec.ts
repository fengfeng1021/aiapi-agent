import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ScheduleId,
  ScheduleLogError,
  createAfterScheduleRecord,
  decodeScheduleChange,
  foldScheduleEvents,
  resolveScheduleMetadata,
  scheduleActiveStatus,
  scheduleView,
} from '../src/domain.ts'
import type { ScheduleRecord } from '../src/types.ts'

function scheduleEvent(data: unknown, seq = 0): SessionEvent {
  return { type: 'schedule/change', seq, time: 1, data } as SessionEvent
}

const AFTER_V1 = {
  version: 1,
  operation: 'create',
  schedule: {
    id: 'schedule-1', kind: 'after', prompt: 'check logs', afterSeconds: 30,
    scheduledAt: '2026-08-05T12:00:00.000Z',
  },
} as const

const AT_V1 = {
  version: 1,
  operation: 'create',
  schedule: {
    id: 'schedule-at', kind: 'at', prompt: 'join meeting',
    scheduledAt: '2026-08-06T01:00:00.000Z',
  },
} as const

const EVERY_V1 = {
  version: 1,
  operation: 'create',
  schedule: {
    id: 'schedule-every', kind: 'every', prompt: 'check metrics', everySeconds: 300,
    scheduledAt: '2026-08-05T12:05:00.000Z',
  },
} as const

const FULL_META = {
  title: 'Weekly review',
  project: 'harness',
  model: 'deepseek-chat',
  reasoning: 'high',
  notify: 'on-failure',
  paused: true,
} as const

describe('version-1 replay under the version-2 decoder', () => {
  it.each([AFTER_V1, AT_V1, EVERY_V1])('replays a version-1 create without injected metadata %#', (data) => {
    const decoded = decodeScheduleChange(data)
    expect(decoded).toEqual(data)
    if (decoded.operation !== 'create') throw new Error('expected create')
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded.schedule)).toBe(true)
    expect('meta' in decoded.schedule).toBe(false)
  })

  it('replays version-1 delete and dispatch envelopes without rewriting the version', () => {
    expect(decodeScheduleChange({ version: 1, operation: 'delete', id: 'schedule-1' }))
      .toEqual({ version: 1, operation: 'delete', id: 'schedule-1' })
    expect(decodeScheduleChange({ version: 1, operation: 'dispatch', id: 'schedule-1' }))
      .toEqual({ version: 1, operation: 'dispatch', id: 'schedule-1' })
    expect(decodeScheduleChange({
      version: 1,
      operation: 'dispatch',
      id: 'schedule-every',
      acceptedAt: '2026-08-05T12:05:00.000Z',
    })).toEqual({
      version: 1,
      operation: 'dispatch',
      id: 'schedule-every',
      acceptedAt: '2026-08-05T12:05:00.000Z',
    })
  })

  it('folds mixed version-1 events exactly as before', () => {
    expect(foldScheduleEvents([
      scheduleEvent(AFTER_V1, 0),
      scheduleEvent(AT_V1, 1),
      scheduleEvent({ version: 1, operation: 'delete', id: 'schedule-1' }, 2),
    ])).toEqual({
      active: [expect.objectContaining({ id: 'schedule-at' })],
      seenIds: ['schedule-1', 'schedule-at'],
    })
  })
})

describe('version-2 envelopes carrying record metadata', () => {
  it('round-trips a full-metadata create and freezes the metadata', () => {
    const data = {
      version: 2,
      operation: 'create',
      schedule: { ...AFTER_V1.schedule, meta: { ...FULL_META } },
    }
    const decoded = decodeScheduleChange(data)
    expect(decoded).toEqual(data)
    if (decoded.operation !== 'create') throw new Error('expected create')
    expect(Object.isFrozen(decoded.schedule)).toBe(true)
    expect(Object.isFrozen(decoded.schedule.meta)).toBe(true)
  })

  it.each(['at', 'every'] as const)('accepts metadata on %s records', (kind) => {
    const base = kind === 'at' ? AT_V1.schedule : EVERY_V1.schedule
    const decoded = decodeScheduleChange({
      version: 2,
      operation: 'create',
      schedule: { ...base, meta: { title: 'Titled' } },
    })
    expect(decoded).toEqual({
      version: 2,
      operation: 'create',
      schedule: { ...base, meta: { title: 'Titled' } },
    })
  })

  it('accepts a version-1-shaped record inside a version-2 envelope', () => {
    expect(decodeScheduleChange({ ...AFTER_V1, version: 2 })).toEqual({ ...AFTER_V1, version: 2 })
  })

  it('round-trips partial metadata carrying only a subset of keys', () => {
    const data = {
      version: 2,
      operation: 'create',
      schedule: { ...EVERY_V1.schedule, meta: { paused: true } },
    }
    const decoded = decodeScheduleChange(data)
    expect(decoded).toEqual(data)
    if (decoded.operation !== 'create') throw new Error('expected create')
    expect(decoded.schedule.meta).toEqual({ paused: true })
  })

  it('accepts version-2 delete and dispatch envelopes', () => {
    expect(decodeScheduleChange({ version: 2, operation: 'delete', id: 'schedule-1' }))
      .toEqual({ version: 2, operation: 'delete', id: 'schedule-1' })
    expect(decodeScheduleChange({ version: 2, operation: 'dispatch', id: 'schedule-1' }))
      .toEqual({ version: 2, operation: 'dispatch', id: 'schedule-1' })
  })

  it.each([
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: null } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: 'titled' } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { title: 'T', unknown: 1 } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { title: '' } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { title: ' padded ' } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { title: 42 } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { project: '' } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { model: '' } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { reasoning: ' ' } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { notify: 'sometimes' } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { paused: 'yes' } } },
    { ...AFTER_V1, version: 2, schedule: { ...AFTER_V1.schedule, meta: { title: 'T' }, extra: true } },
  ])('rejects malformed version-2 metadata %#', (data) => {
    expect(() => decodeScheduleChange(data)).toThrow(ScheduleLogError)
  })
})

describe('metadata presentation defaults', () => {
  it('resolves version-1 records to prompt-derived defaults', () => {
    const record = createAfterScheduleRecord(ScheduleId('schedule-1'), 'check logs', 30, 1_000)
    expect(resolveScheduleMetadata(record)).toEqual({
      title: 'check logs',
      notify: 'all',
      paused: false,
    })
    expect(scheduleActiveStatus(record)).toBe('active')
  })

  it('truncates long prompts to forty code points without splitting surrogates', () => {
    const prompt = `🔔${'x'.repeat(60)}`
    const record = createAfterScheduleRecord(ScheduleId('schedule-1'), prompt, 30, 1_000)
    const resolved = resolveScheduleMetadata(record)
    expect(Array.from(resolved.title)).toHaveLength(40)
    expect(resolved.title.startsWith('🔔')).toBe(true)
  })

  it('passes stored metadata through and keeps explicit unpaused records active', () => {
    const base = createAfterScheduleRecord(ScheduleId('schedule-1'), 'check logs', 30, 1_000)
    const record: ScheduleRecord = {
      ...base,
      meta: { title: 'Stored', project: 'harness', model: 'm', reasoning: 'low', notify: 'never', paused: false },
    }
    expect(resolveScheduleMetadata(record)).toEqual({
      title: 'Stored',
      project: 'harness',
      model: 'm',
      reasoning: 'low',
      notify: 'never',
      paused: false,
    })
    expect(scheduleActiveStatus(record)).toBe('active')
  })

  it('marks paused records paused while defaulting the remaining fields', () => {
    const base = createAfterScheduleRecord(ScheduleId('schedule-1'), 'check logs', 30, 1_000)
    const record: ScheduleRecord = { ...base, meta: { paused: true } }
    expect(resolveScheduleMetadata(record)).toEqual({
      title: 'check logs',
      notify: 'all',
      paused: true,
    })
    expect(scheduleActiveStatus(record)).toBe('paused')
  })

  it('carries stored metadata through the management view', () => {
    const base = createAfterScheduleRecord(ScheduleId('schedule-1'), 'check logs', 30, 1_000)
    const record: ScheduleRecord = { ...base, meta: { title: 'Stored' } }
    expect(scheduleView(record, 1_000)).toEqual({
      ...record,
      state: 'scheduled',
      deliveryMode: 'session-local',
    })
  })
})
