import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import {
  IconAlarmClockOutline16, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  formatScheduleFrequency, formatScheduleLocalTime, formatScheduleRelative, orderScheduleRecords,
} from './ScheduleCatalogAction.tsx'
import { NS } from './locales.ts'
import buttonCss from './FooterAction.module.css'
import css from './ScheduleManager.module.css'

/** Sidebar foot entry opening the schedule manager panel. */
export type SchedulesFooterActionProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS>

/** Triage filter for the manager list. */
type ManagerFilter = 'all' | 'scheduled' | 'overdue' | 'paused'

const FILTERS: readonly ManagerFilter[] = ['all', 'scheduled', 'overdue', 'paused']

/** Filter label keys; active-state filters reuse the catalog status copy. */
const FILTER_LABELS = {
  all: 'manager.filter.all',
  scheduled: 'status.scheduled',
  overdue: 'status.overdue',
  paused: 'manager.paused',
} as const

/** Notification policy label keys. */
const NOTIFY_LABELS = {
  all: 'manager.notify.all',
  'on-failure': 'manager.notify.on-failure',
  never: 'manager.notify.never',
} as const

/** Whether a record matches the active triage filter at one wall-clock sample. */
function matchesFilter(record: ScheduleRecord, filter: ManagerFilter, now: number): boolean {
  const paused = record.meta?.paused === true
  switch (filter) {
    case 'all':
      return true
    case 'paused':
      return paused
    case 'overdue':
      return !paused && Date.parse(record.scheduledAt) <= now
    case 'scheduled':
      return !paused && Date.parse(record.scheduledAt) > now
  }
}

/**
 * Display title for one row: the stored title, or the prompt's leading text.
 * Presentation twin of the host `resolveScheduleMetadata` default, kept inline
 * because feature browser code must not value-import the host package.
 */
function displayTitle(record: ScheduleRecord): string {
  return record.meta?.title ?? Array.from(record.prompt).slice(0, 40).join('')
}

const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }
const SECOND_MS = 1_000

/** One manager row: title button plus an expandable detail over the durable record. */
function ManagerRow({ record, now, expanded, onToggle, t }: {
  record: ScheduleRecord
  now: number
  expanded: boolean
  onToggle: () => void
  t: TranslateNS<typeof NS>
}) {
  const overdue = Date.parse(record.scheduledAt) <= now
  const meta = record.meta
  return (
    <li className={css.row}>
      <button
        type="button"
        className={css.rowButton}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={css.rowTitle}>{displayTitle(record)}</span>
        {meta?.paused === true && <span className={css.badge}>{t('manager.paused')}</span>}
        <span className={css.rowMeta}>
          {formatScheduleFrequency(record, t)} · {formatScheduleRelative(record.scheduledAt, now, t)}
        </span>
      </button>
      {expanded && (
        <div className={css.detail}>
          <p className={css.detailPrompt}>{record.prompt}</p>
          <p className={css.detailMeta}>
            {formatScheduleLocalTime(record.scheduledAt, document.documentElement.lang)}
            {' · '}
            {t(overdue ? 'status.overdue' : 'status.scheduled')}
          </p>
          {meta?.project !== undefined && <p className={css.detailMeta}>{t('manager.meta.project')}: {meta.project}</p>}
          {meta?.model !== undefined && <p className={css.detailMeta}>{t('manager.meta.model')}: {meta.model}</p>}
          {meta?.reasoning !== undefined && <p className={css.detailMeta}>{t('manager.meta.reasoning')}: {meta.reasoning}</p>}
          {meta?.notify !== undefined && <p className={css.detailMeta}>{t('manager.meta.notify')}: {t(NOTIFY_LABELS[meta.notify])}</p>}
        </div>
      )}
    </li>
  )
}

/**
 * Render the schedule footer button and its manager panel.
 * @param props - foot owner width, the session seats, and the schedule locale seat.
 * @returns the footer entry tree.
 */
export function SchedulesFooterAction({ wide, useSessions, t }: SchedulesFooterActionProps) {
  const current = useSessions(state => state.current)
  const records = useSessions(state => current === undefined
    ? undefined
    : state.byId[current]?.projectionValues?.schedule)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ManagerFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelPosition = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef,
    side: 'bottom',
    gap: 5,
    margin: 16,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, SECOND_MS)
    return () => { window.clearInterval(timer) }
  }, [open])

  const label = t('footer.label')
  const ordered = useMemo(
    () => orderScheduleRecords(records ?? [], now),
    [records, now],
  )
  const query = search.trim().toLowerCase()
  const visible = ordered.filter(record => matchesFilter(record, filter, now)
    && (query === '' || displayTitle(record).toLowerCase().includes(query)
      || record.prompt.toLowerCase().includes(query)))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  const panel = open
    ? createPortal((
      <div
        ref={panelRef}
        className={css.panel}
        style={panelPosition ?? MEASURE_STYLE}
        role="dialog"
        aria-label={t('manager.title')}
      >
        <div className={css.header}>
          <span className={css.title}>{t('manager.title')}</span>
          <span className={css.count}>
            {t((records?.length ?? 0) === 1 ? 'trigger.one' : 'trigger.other', { count: records?.length ?? 0 })}
          </span>
        </div>
        {current === undefined ? (
          <div className={css.status} role="status">{t('manager.noSession')}</div>
        ) : (records ?? []).length === 0 ? (
          <div className={css.status} role="status">{t('manager.empty')}</div>
        ) : (
          <>
            <div className={css.controls}>
              <input
                className={css.searchInput}
                type="text"
                value={search}
                aria-label={t('manager.search')}
                placeholder={t('manager.search.placeholder')}
                onChange={(event) => { setSearch(event.target.value) }}
              />
              <div className={css.filters} role="group" aria-label={t('manager.title')}>
                {FILTERS.map(value => (
                  <button
                    key={value}
                    type="button"
                    className={css.filterButton}
                    data-active={filter === value ? 'true' : undefined}
                    aria-pressed={filter === value}
                    onClick={() => { setFilter(value); setExpandedId(null) }}
                  >
                    {t(FILTER_LABELS[value])}
                  </button>
                ))}
              </div>
            </div>
            {visible.length === 0 ? (
              <div className={css.status} role="status">{t('manager.empty')}</div>
            ) : (
              <ul className={css.list} aria-label={t('manager.title')}>
                {visible.map(record => (
                  <ManagerRow
                    key={record.id}
                    record={record}
                    now={now}
                    expanded={expandedId === record.id}
                    onToggle={() => { setExpandedId(current => current === record.id ? null : record.id) }}
                    t={t}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    ), document.body)
    : null

  return (
    <div ref={rootRef} className={buttonCss.root} onKeyDown={onKeyDown}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          ref={triggerRef}
          type="button"
          className={buttonCss.button}
          aria-label={label}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconAlarmClockOutline16 size={wide ? 16 : 18} />
          {wide && <span className={buttonCss.label}>{label}</span>}
        </button>
      </Tooltip>
      {panel}
    </div>
  )
}
