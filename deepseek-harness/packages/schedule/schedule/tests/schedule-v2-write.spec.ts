import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ScheduleId,
  ScheduleInputError,
  applyScheduleChanges,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  decodeScheduleChange,
  foldScheduleEvents,
  scheduleCreateVersion,
  validateScheduleMetadataInput,
} from '../src/domain.ts'
import { dueDecision } from '../src/runtime.ts'

function scheduleEvent(data: unknown, seq = 0): SessionEvent {
  return { type: 'schedule/change', seq, time: 1, data } as SessionEvent
}

function expectInputError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ScheduleInputError)
    expect((error as ScheduleInputError).code).toBe(code)
    return
  }
  throw new Error(`expected ScheduleInputError ${code}`)
}

describe('version-2 metadata input validation', () => {
  it('passes absent and empty metadata through as no metadata', () => {
    expect(validateScheduleMetadataInput(undefined)).toBeUndefined()
    expect(validateScheduleMetadataInput({})).toBeUndefined()
    expect(validateScheduleMetadataInput({ title: undefined, paused: undefined })).toBeUndefined()
  })

  it('validates and freezes a complete value with padding trimmed', () => {
    expect(validateScheduleMetadataInput({
      title: '  Weekly review  ',
      project: 'harness',
      model: 'deepseek-chat',
      reasoning: 'high',
      notify: 'on-failure',
      paused: false,
    })).toEqual({
      title: 'Weekly review',
      project: 'harness',
      model: 'deepseek-chat',
      reasoning: 'high',
      notify: 'on-failure',
      paused: false,
    })
    expect(validateScheduleMetadataInput({ paused: true })).toEqual({ paused: true })
  })

  it.each([
    [42, 'schedule metadata must be an object.'],
    [['titled'], 'schedule metadata must be an object.'],
    [{ unknown: 1 }, 'unknown schedule metadata field "unknown".'],
    [{ title: '' }, 'schedule metadata title must be a non-empty string.'],
    [{ title: 42 }, 'schedule metadata title must be a non-empty string.'],
    [{ project: '' }, 'schedule metadata project must be a non-empty string.'],
    [{ model: '' }, 'schedule metadata model must be a non-empty string.'],
    [{ reasoning: '  ' }, 'schedule metadata reasoning must be a non-empty string.'],
    [{ notify: 'sometimes' }, 'schedule metadata notify must be all, on-failure, or never.'],
    [{ paused: 'yes' }, 'schedule metadata paused must be a boolean.'],
  ])('rejects metadata %#', (value, message) => {
    expectInputError(() => validateScheduleMetadataInput(value), 'invalid_rule')
    try {
      validateScheduleMetadataInput(value)
      throw new Error('expected rejection')
    } catch (error: unknown) {
      expect((error as Error).message).toBe(message)
    }
  })
})

describe('version-2 record creation', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')

  it('carries validated metadata on every rule and freezes it', () => {
    const meta = validateScheduleMetadataInput({ title: 'Titled', notify: 'never' })
    const after = createAfterScheduleRecord(ScheduleId('after'), 'check logs', 30, now, meta)
    const at = createAtScheduleRecord(ScheduleId('at'), 'join', '2026-08-06T01:00:00Z', now, meta)
    const every = createEveryScheduleRecord(ScheduleId('every'), 'metrics', 300, now, meta)
    for (const record of [after, at, every]) {
      expect(record.meta).toEqual({ title: 'Titled', notify: 'never' })
      expect(Object.isFrozen(record.meta)).toBe(true)
      expect(scheduleCreateVersion(record)).toBe(2)
    }
  })

  it('leaves metadata-free records version-1 shaped', () => {
    const record = createAfterScheduleRecord(ScheduleId('plain'), 'check logs', 30, now)
    expect('meta' in record).toBe(false)
    expect(scheduleCreateVersion(record)).toBe(1)
  })
})

describe('mixed-version durable replay', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')

  it('folds version-2 creates beside version-1 records', () => {
    const meta = validateScheduleMetadataInput({ title: 'Titled', paused: false })
    const v2 = createEveryScheduleRecord(ScheduleId('v2'), 'metrics', 300, now, meta)
    const v1 = createAfterScheduleRecord(ScheduleId('v1'), 'check logs', 30, now)
    const folded = foldScheduleEvents([
      scheduleEvent({ version: 2, operation: 'create', schedule: v2 }, 0),
      scheduleEvent({ version: 1, operation: 'create', schedule: v1 }, 1),
    ])
    expect(folded.active.map(record => record.id)).toEqual(['v2', 'v1'])
    expect(folded.active[0]).toMatchObject({ meta: { title: 'Titled' } })
    expect('meta' in (folded.active[1] as object)).toBe(false)
  })

  it('skips foreign session events and reuses the shared transition entry', () => {
    const meta = validateScheduleMetadataInput({ title: 'Titled' })
    const v2 = createAfterScheduleRecord(ScheduleId('v2'), 'check logs', 30, now, meta)
    const folded = foldScheduleEvents([
      { type: 'user/message', seq: 0, time: 1, data: {} } as SessionEvent,
      scheduleEvent({ version: 2, operation: 'create', schedule: v2 }, 1),
    ])
    expect(folded.active.map(record => record.id)).toEqual(['v2'])
    expect(applyScheduleChanges(folded, [])).toEqual(folded)
  })

  it('applies version-1 delete and dispatch transitions to version-2 records', () => {
    const meta = validateScheduleMetadataInput({ title: 'Titled' })
    const v2 = createAfterScheduleRecord(ScheduleId('v2'), 'check logs', 30, now, meta)
    expect(decodeScheduleChange({ version: 2, operation: 'create', schedule: v2 })).toEqual({
      version: 2,
      operation: 'create',
      schedule: v2,
    })
    const folded = foldScheduleEvents([
      scheduleEvent({ version: 2, operation: 'create', schedule: v2 }, 0),
      scheduleEvent({ version: 1, operation: 'dispatch', id: 'v2' }, 1),
    ])
    expect(folded).toEqual({ active: [], seenIds: ['v2'] })
  })
})

describe('paused-aware due decisions', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')

  it('holds paused records out of every branch without arming for them', () => {
    const pausedAfter = createAfterScheduleRecord(ScheduleId('held'), 'held', 30, now - 60_000, { paused: true })
    expect(dueDecision({ active: [pausedAfter], seenIds: [pausedAfter.id] }, now)).toEqual({ kind: 'wait' })
    const pausedEvery = createEveryScheduleRecord(ScheduleId('held-every'), 'held', 300, now - 600_000, {
      paused: true,
    })
    expect(dueDecision({ active: [pausedEvery], seenIds: [pausedEvery.id] }, now)).toEqual({ kind: 'wait' })
  })

  it('fires unpaused records beside paused ones', () => {
    const paused = createAfterScheduleRecord(ScheduleId('held'), 'held', 30, now - 60_000, { paused: true })
    const live = createAfterScheduleRecord(ScheduleId('live'), 'live', 30, now - 30_000)
    const decision = dueDecision({ active: [paused, live], seenIds: [paused.id, live.id] }, now)
    expect(decision).toEqual({ kind: 'one-shot', record: live })
  })

  it('orders same-branch records by target, then creation', () => {
    const first = createAfterScheduleRecord(ScheduleId('first'), 'first', 30, now - 120_000)
    const second = createAfterScheduleRecord(ScheduleId('second'), 'second', 30, now - 30_000)
    expect(dueDecision(
      { active: [second, first], seenIds: [second.id, first.id] },
      now,
    )).toEqual({ kind: 'one-shot', record: first })
    const slow = createEveryScheduleRecord(ScheduleId('slow'), 'slow', 600, now - 600_000)
    const fast = createEveryScheduleRecord(ScheduleId('fast'), 'fast', 300, now - 600_000)
    const batch = dueDecision({ active: [slow, fast], seenIds: [slow.id, fast.id] }, now)
    expect(batch).toEqual({
      kind: 'every',
      acceptedAt: new Date(now).toISOString(),
      reminders: [
        { record: fast, occurrenceAt: '2026-08-05T12:00:00.000Z' },
        { record: slow, occurrenceAt: '2026-08-05T12:00:00.000Z' },
      ],
    })
  })

  it('arms only for unpaused future targets', () => {
    const paused = createAtScheduleRecord(ScheduleId('held'), 'held', '2026-08-05T13:00:00Z', now - 60_000, {
      paused: true,
    })
    const live = createAtScheduleRecord(ScheduleId('live'), 'live', '2026-08-05T14:00:00Z', now - 60_000)
    const early = createAtScheduleRecord(ScheduleId('early'), 'early', '2026-08-05T12:30:00Z', now - 60_000)
    const later = createAtScheduleRecord(ScheduleId('later'), 'later', '2026-08-05T15:00:00Z', now - 60_000)
    expect(dueDecision(
      { active: [paused, live, early, later], seenIds: [paused.id, live.id, early.id, later.id] },
      now,
    )).toEqual({ kind: 'wait', target: Date.parse('2026-08-05T12:30:00.000Z') })
    expect(dueDecision({ active: [paused], seenIds: [paused.id] }, now)).toEqual({ kind: 'wait' })
  })

  it('breaks exact target ties in creation order', () => {
    const first = createAtScheduleRecord(ScheduleId('first'), 'first', '2026-08-05T11:00:00Z', now - 7_200_000)
    const second = createAtScheduleRecord(ScheduleId('second'), 'second', '2026-08-05T11:00:00Z', now - 7_200_000)
    expect(dueDecision(
      { active: [second, first], seenIds: [second.id, first.id] },
      now,
    )).toEqual({ kind: 'one-shot', record: second })
  })
})
