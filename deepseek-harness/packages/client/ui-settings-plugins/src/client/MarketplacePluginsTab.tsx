import { useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AgentLoopCardState } from './agent-loop-card-controller.ts'
import type { BashCardState } from './bash-card-controller.ts'
import type { CardShell } from './card-form.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import type { SubagentModelSelectionCardState } from './subagent-model-selection-card-controller.ts'
import type { WebSearchCardState } from './web-search-card-controller.ts'
import css from './MarketplacePluginsTab.module.css'

/** Registration-side business face for the marketplace tab. */
export interface MarketplacePluginsTabInjected {
  hooks: {
    /** Shell card snapshot bound by the renderer as useBash. */
    bash: SnapshotStore<BashCardState>
    /** Agent-loop card snapshot bound by the renderer as useAgentLoop. */
    agentLoop: SnapshotStore<AgentLoopCardState>
    /** Web-search card snapshot bound by the renderer as useWebSearch. */
    webSearch: SnapshotStore<WebSearchCardState>
    /** Subagent card snapshot bound by the renderer as useSubagent. */
    subagent: SnapshotStore<SubagentModelSelectionCardState>
  }
}

/** Full component props assembled by the Settings slot renderer. */
export type MarketplacePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<MarketplacePluginsTabInjected>

type StatusKey =
  | 'marketplace.unavailable'
  | 'marketplace.saveFailed'
  | 'marketplace.saving'
  | 'marketplace.unsaved'
  | 'marketplace.ready'

/** Uniform status shared by every marketplace row. */
function baseStatus(shell: CardShell): StatusKey {
  if (!shell.available) return 'marketplace.unavailable'
  if (shell.failed) return 'marketplace.saveFailed'
  if (shell.saving) return 'marketplace.saving'
  if (shell.dirty) return 'marketplace.unsaved'
  return 'marketplace.ready'
}

type Translate = MarketplacePluginsTabProps['t']

/** Row model pairing static copy with live snapshots. */
interface MarketplaceRow {
  readonly id: string
  readonly titleKey: PluginsSettingsLocaleKey
  readonly descriptionKey: PluginsSettingsLocaleKey
  readonly shell: CardShell
  readonly detail: string | undefined
}

/** Live detail line for one row, if its card reports beyond the uniform shell. */
function detailFor(
  id: string,
  states: {
    webSearch: WebSearchCardState
    subagent: SubagentModelSelectionCardState
  },
  t: Translate,
): string | undefined {
  if (id === 'web-search-deepseek') {
    return t(states.webSearch.apiKeyConfigured ? 'marketplace.keySet' : 'marketplace.keyUnset')
  }
  if (id === 'subagent-model-selection') {
    return t(states.subagent.enabled ? 'marketplace.enabled' : 'marketplace.disabled')
  }
  return undefined
}

/**
 * Render the marketplace tab: searchable browse rows over the shipped cards.
 * @param props - composed slot props (card snapshot hooks plus the plugins locale seat).
 * @returns the marketplace tab tree.
 */
export function MarketplacePluginsTab({
  useBash,
  useAgentLoop,
  useWebSearch,
  useSubagent,
  t,
}: MarketplacePluginsTabProps) {
  const bash = useBash(state => state)
  const agentLoop = useAgentLoop(state => state)
  const webSearch = useWebSearch(state => state)
  const subagent = useSubagent(state => state)
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const states = { webSearch, subagent }
  const rows: readonly MarketplaceRow[] = [
    {
      id: 'shell',
      titleKey: 'bashTitle',
      descriptionKey: 'bashDescription',
      shell: bash,
      detail: detailFor('shell', states, t),
    },
    {
      id: 'agent-loop',
      titleKey: 'agentLoopTitle',
      descriptionKey: 'agentLoopDescription',
      shell: agentLoop,
      detail: detailFor('agent-loop', states, t),
    },
    {
      id: 'subagent-model-selection',
      titleKey: 'subagentModelSelectionTitle',
      descriptionKey: 'subagentModelSelectionDescription',
      shell: subagent,
      detail: detailFor('subagent-model-selection', states, t),
    },
    {
      id: 'web-search-deepseek',
      titleKey: 'webSearchTitle',
      descriptionKey: 'webSearchDescription',
      shell: webSearch,
      detail: detailFor('web-search-deepseek', states, t),
    },
  ]

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = rows.filter((row) => {
    if (normalizedQuery === '') return true
    return t(row.titleKey).toLocaleLowerCase().includes(normalizedQuery)
      || t(row.descriptionKey).toLocaleLowerCase().includes(normalizedQuery)
  })

  return (
    <div>
      <div className={css.search}>
        <input
          className={css.searchInput}
          type="text"
          value={query}
          aria-label={t('marketplace.search')}
          placeholder={t('marketplace.search.placeholder')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      {visible.length === 0 ? (
        <div className={css.empty} role="status">{t('marketplace.empty')}</div>
      ) : (
        <ul className={css.list} aria-label={t('marketplaceTab')}>
          {visible.map((row) => {
            const expanded = expandedId === row.id
            return (
              <li key={row.id} className={css.row}>
                <button
                  type="button"
                  className={css.rowButton}
                  aria-expanded={expanded}
                  onClick={() => { setExpandedId(current => current === row.id ? null : row.id) }}
                >
                  <span className={css.rowTitle}>{t(row.titleKey)}</span>
                  <span className={css.status}>{t(baseStatus(row.shell))}</span>
                </button>
                {expanded && (
                  <div className={css.detail}>
                    <p className={css.detailDescription}>{t(row.descriptionKey)}</p>
                    {row.detail !== undefined && <p className={css.detailMeta}>{row.detail}</p>}
                    <p className={css.configureHint}>{t('marketplace.configureHint')}</p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
