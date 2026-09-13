import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCordisPluginOutline14, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteFailure, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS } from './locales.ts'
import buttonCss from './FooterAction.module.css'
import css from './SkillsMarketplace.module.css'

/** Session catalog result shared by the marketplace panel. */
export type SkillCatalogResult =
  | { readonly ok: true; readonly value: { readonly skills: readonly SkillEntry[] } }
  | { readonly ok: false; readonly error: RemoteFailure }

/** Injected catalog read contributed by the skill plugin body. */
export interface SkillsMarketplaceInjected {
  /** List one session's user-invocable skills over the generated Remote. */
  listSkills: (sessionId: SessionId, signal: AbortSignal) => Promise<SkillCatalogResult>
}

/** Sidebar primary entry opening the extensions panel. */
export type SkillsFooterActionProps =
  PropsRuntime<'sidebar.primary.action'> & InjectFace<SkillsMarketplaceInjected> & PropsLocale<'skill'>

type CatalogState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly skills: readonly SkillEntry[] }
  | { readonly status: 'error' }

const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Copy button with a sticky success label; parents key it by text to reset. */
function CopyButton({ text, idleLabel, doneLabel, disabled = false }: {
  text: string
  idleLabel: string
  doneLabel: string
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={css.actionButton}
      disabled={disabled}
      onClick={() => {
        void writeClipboard(text).then((ok) => {
          if (ok) setCopied(true)
        })
      }}
    >
      {copied ? doneLabel : idleLabel}
    </button>
  )
}

/** One marketplace row: name button plus an expandable detail with copy actions. */
function SkillRow({ skill, t }: { skill: SkillEntry; t: TranslateNS<typeof NS> }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <li className={css.row}>
      <button
        type="button"
        className={css.rowButton}
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.rowName}>{skill.name}</span>
        {!skill.modelInvocable && <span className={css.badge}>{t('menu.userOnly')}</span>}
      </button>
      {expanded && (
        <div className={css.detail}>
          <p className={css.detailDescription}>{skill.description}</p>
          <p className={css.detailMeta}>
            {skill.whenToUse !== undefined && skill.whenToUse !== ''
              ? `${t('marketplace.detail.whenToUse')}: ${skill.whenToUse}`
              : t(skill.modelInvocable ? 'marketplace.detail.modelOn' : 'marketplace.detail.modelOff')}
          </p>
          <div className={css.detailActions}>
            <CopyButton
              key={`/${skill.name} `}
              text={`/${skill.name} `}
              idleLabel={t('marketplace.copyInvoke')}
              doneLabel={t('marketplace.copied')}
            />
            <CopyButton
              key={skill.description}
              text={skill.description}
              idleLabel={t('marketplace.copyDescription')}
              doneLabel={t('marketplace.copied')}
            />
          </div>
        </div>
      )}
    </li>
  )
}

/** Skill Creator box: composes an installer prompt for the composer. */
function CreatorBox({ t }: { t: TranslateNS<typeof NS> }) {
  const [draft, setDraft] = useState('')
  const trimmed = draft.trim()
  return (
    <div className={css.creator}>
      <span className={css.creatorLabel}>{t('marketplace.creator.label')}</span>
      <div className={css.creatorRow}>
        <input
          className={css.creatorInput}
          type="text"
          value={draft}
          aria-label={t('marketplace.creator.label')}
          placeholder={t('marketplace.creator.placeholder')}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <CopyButton
          key={trimmed}
          text={`/skill-installer ${trimmed}`}
          idleLabel={t('marketplace.creator.add')}
          doneLabel={t('marketplace.copied')}
          disabled={trimmed === ''}
        />
      </div>
      <span className={css.creatorHint}>{t('marketplace.creator.hint')}</span>
    </div>
  )
}

/**
 * Render the extensions entry button and its marketplace panel.
 * @param props - primary owner width, the injected catalog read, the session seats, and the skill locale seat.
 * @returns the primary entry tree.
 */
export function SkillsFooterAction({ wide, useSessions, listSkills, t }: SkillsFooterActionProps) {
  const current = useSessions(state => state.current)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [nonce, setNonce] = useState(0)
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'idle' })
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
    if (!open || current === undefined) return
    const controller = new AbortController()
    setCatalog({ status: 'loading' })
    listSkills(current, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setCatalog(result.ok
        ? { status: 'ready', skills: result.value.skills }
        : { status: 'error' })
    }).catch(() => {
      if (!controller.signal.aborted) setCatalog({ status: 'error' })
    })
    return () => { controller.abort() }
  }, [open, current, listSkills, nonce])

  const label = t('sidebar.label')
  const skills = catalog.status === 'ready' ? catalog.skills : []
  const query = search.trim().toLowerCase()
  const visible = useMemo(
    () => query === ''
      ? skills
      : skills.filter(skill => skill.name.toLowerCase().includes(query)
        || skill.description.toLowerCase().includes(query)),
    [skills, query],
  )

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
        aria-label={label}
      >
        <div className={css.header}>
          <span className={css.title}>{label}</span>
          {catalog.status === 'ready' && (
            <span className={css.count}>{t('marketplace.count', { count: skills.length })}</span>
          )}
        </div>
        {current === undefined ? (
          <div className={css.status} role="status">{t('marketplace.noSession')}</div>
        ) : catalog.status === 'error' ? (
          <div className={css.status} role="alert">
            <span>{t('marketplace.failed')}</span>
            <span className={css.statusActions}>
              <button type="button" className={css.actionButton} onClick={() => { setNonce(value => value + 1) }}>
                {t('marketplace.retry')}
              </button>
            </span>
          </div>
        ) : (
          <>
            <div className={css.search}>
              <input
                className={css.searchInput}
                type="text"
                value={search}
                aria-label={t('marketplace.search')}
                placeholder={t('marketplace.search.placeholder')}
                onChange={(event) => { setSearch(event.target.value) }}
              />
            </div>
            {catalog.status === 'loading' || catalog.status === 'idle' ? (
              <div className={css.status} role="status">{t('marketplace.loading')}</div>
            ) : visible.length === 0 ? (
              <div className={css.status} role="status">{t('marketplace.empty')}</div>
            ) : (
              <ul className={css.list} aria-label={label}>
                {visible.map(skill => <SkillRow key={skill.name} skill={skill} t={t} />)}
              </ul>
            )}
            <CreatorBox t={t} />
            <div className={css.pluginsHint}>{t('marketplace.pluginsHint')}</div>
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
          <IconCordisPluginOutline14 size={wide ? 16 : 18} />
          {wide && <span className={buttonCss.label}>{label}</span>}
        </button>
      </Tooltip>
      {panel}
    </div>
  )
}
