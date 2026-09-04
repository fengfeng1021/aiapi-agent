import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelDraft } from './ModelListEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelCatalogModal.module.css'

export interface ModelCatalogModalProps {
  open: boolean
  providerName: string
  candidates: readonly LlmDiscoveredModel[]
  currentModels: readonly ModelDraft[]
  onClose: () => void
  onSave: (selectedModels: ModelDraft[]) => void
  t?: (key: keyof typeof en) => string
}

export const OPENCODE_OFFICIAL_MODELS: readonly ModelDraft[] = [
  // Grok / xAI
  { id: 'grok-4.6', name: 'Grok 4.6' },
  // GLM
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  // OpenAI
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' },
  // Moonshot Kimi
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6' },
  // LongCat
  { id: 'longcat-2.0', name: 'LongCat-2.0' },
  // MiMo
  { id: 'mimo-v2.5', name: 'MiMo-V2.5' },
  { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
  // MiniMax
  { id: 'minimax-m3', name: 'MiniMax M3' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
  // Muse
  { id: 'muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor' },
  // Qwen
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max' },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
  // DeepSeek
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp' },
  // Hunyuan
  { id: 'hy4-preview', name: 'Hy4 preview' },
  { id: 'hy3', name: 'Hy3' },
]

/** Strip redundant vendor prefixes from model display name (e.g. 'Z.ai: GLM 5.2' -> 'GLM 5.2') */
export function cleanModelDisplayName(name?: string, _id?: string): string | undefined {
  if (typeof name !== 'string' || name.trim().length === 0) return undefined
  // Strip vendor prefix e.g. "Z.ai: GLM 5.2", "DeepSeek: DeepSeek V4", "Tencent: Hy4", "Meta: Muse Spark", "MoonshotAI: Kimi"
  const cleaned = name.replace(/^(?:(?:[a-zA-Z0-9\s._-]+):\s+)/, '').trim()
  return cleaned.length > 0 ? cleaned : name
}

/** Categorize model ID and name by known brand prefixes and families. */
export function categorizeModelId(id: string, name?: string): string {
  const combined = `${id} ${name ?? ''}`.toLowerCase()
  if (combined.includes('deepseek')) return 'DeepSeek'
  if (combined.includes('glm') || combined.includes('chatglm') || combined.includes('zhipu') || combined.includes('z.ai')) return 'GLM (智谱)'
  if (combined.includes('kimi') || combined.includes('moonshot')) return 'Kimi (月之暗面)'
  if (combined.includes('hunyuan') || combined.includes('hy4') || combined.includes('hy3') || combined.includes('tencent')) return 'Hunyuan (腾讯混元)'
  if (combined.includes('minimax') || combined.includes('abab')) return 'MiniMax'
  if (combined.includes('mimo') || combined.includes('xiaomi')) return 'MiMo (小米)'
  if (combined.includes('muse')) return 'Muse (Meta)'
  if (combined.includes('meta') || combined.includes('llama')) return 'Meta'
  if (combined.includes('qwen') || combined.includes('qwq') || combined.includes('tongyi') || combined.includes('alibaba')) return 'Qwen (阿里通义)'
  if (combined.includes('claude') || combined.includes('anthropic')) return 'Anthropic'
  if (combined.includes('gpt') || combined.includes('o1') || combined.includes('o3') || combined.includes('o4') || combined.includes('o5') || combined.includes('openai') || combined.includes('chatgpt')) return 'OpenAI'
  if (combined.includes('gemini') || combined.includes('gemma') || combined.includes('google')) return 'Google (Gemini)'
  if (combined.includes('grok') || combined.includes('xai') || combined.includes('x-ai')) return 'xAI (Grok)'
  if (combined.includes('doubao') || combined.includes('seedance') || combined.includes('bytedance') || combined.includes('volcengine')) return 'Doubao (豆包)'
  if (combined.includes('longcat') || combined.includes('meituan')) return 'LongCat (美团)'
  if (combined.includes('mistral') || combined.includes('codestral') || combined.includes('pixtral') || combined.includes('ministral')) return 'Mistral'
  if (id.includes('/')) {
    const prefix = id.split('/')[0]
    if (prefix && prefix.length > 0) {
      return prefix.charAt(0).toUpperCase() + prefix.slice(1)
    }
  }
  return 'Other'
}

const BRAND_ORDER = [
  'DeepSeek',
  'GLM (智谱)',
  'Kimi (月之暗面)',
  'MiniMax',
  'MiMo (小米)',
  'Hunyuan (腾讯混元)',
  'Muse (Meta)',
  'Qwen (阿里通义)',
  'OpenAI',
  'Anthropic',
  'Google (Gemini)',
  'xAI (Grok)',
  'Doubao (豆包)',
  'LongCat (美团)',
  'Mistral',
  'Other',
]

function CheckIcon({ active }: { active: boolean }): ReactNode {
  return (
    <div className={`${styles.checkCircle} ${active ? styles.checkCircleActive : ''}`}>
      {active && (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M3.5 8.5L6.5 11.5L12.5 4.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  )
}

function GroupCheckIcon({ checked }: { checked: boolean }): ReactNode {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      className={`${styles.groupCheckBtn} ${checked ? styles.groupCheckBtnActive : ''}`}
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke={checked ? '#1677ff' : '#d2d2d7'}
        strokeWidth="1.8"
        fill={checked ? '#1677ff' : 'none'}
      />
      {checked && (
        <path
          d="M8 12L11 15L16 9"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

type TabKey = 'all' | 'new' | 'selected' | 'removed'

export function ModelCatalogModal(props: ModelCatalogModalProps): ReactNode {
  const { open, providerName, candidates, currentModels, onClose, onSave, t } = props

  const existingIdsSet = useMemo(
    () => new Set(currentModels.map(m => typeof m['id'] === 'string' ? m['id'] : '').filter(Boolean)),
    [currentModels],
  )

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (currentModels.length > 0) {
      return new Set(currentModels.map(m => typeof m['id'] === 'string' ? m['id'] : '').filter(Boolean))
    }
    return new Set(candidates.map(c => c.id))
  })

  useEffect(() => {
    if (open) {
      if (currentModels.length > 0) {
        setSelectedIds(new Set(currentModels.map(m => typeof m['id'] === 'string' ? m['id'] : '').filter(Boolean)))
      } else {
        setSelectedIds(new Set(candidates.map(c => c.id)))
      }
    }
  }, [open, candidates, currentModels])

  const allCandidatesSelected = candidates.length > 0 && selectedIds.size === candidates.length

  const toggleSelectAll = (): void => {
    if (allCandidatesSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(candidates.map(c => c.id)))
    }
  }

  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())

  // Tab count derivations
  const newCandidates = candidates.filter(c => !existingIdsSet.has(c.id))
  const selectedCandidates = candidates.filter(c => selectedIds.has(c.id))
  const removedCandidates = currentModels.filter(m => {
    const id = typeof m['id'] === 'string' ? m['id'] : ''
    return id && !candidates.some(c => c.id === id)
  })

  // Candidates filtered by active tab
  let tabPool: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>
  if (activeTab === 'new') {
    tabPool = newCandidates
  } else if (activeTab === 'selected') {
    tabPool = selectedCandidates
  } else if (activeTab === 'removed') {
    tabPool = removedCandidates.map(m => {
      const entry: { id: string; name?: string; contextWindow?: number; maxTokens?: number } = {
        id: typeof m['id'] === 'string' ? m['id'] : '',
      }
      if (typeof m['name'] === 'string') entry.name = m['name']
      if (typeof m['contextWindow'] === 'number') entry.contextWindow = m['contextWindow']
      if (typeof m['maxTokens'] === 'number') entry.maxTokens = m['maxTokens']
      return entry
    })
  } else {
    // 'all' - show all discovered candidates (or current models, or full official catalog)
    const source = candidates.length > 0
      ? candidates
      : (currentModels.length > 0 ? currentModels : OPENCODE_OFFICIAL_MODELS)
    tabPool = source.map(m => {
      const item: { id: string; name?: string; contextWindow?: number; maxTokens?: number } = {
        id: String(m.id || ''),
      }
      if (typeof m.name === 'string') item.name = m.name
      if (typeof m.contextWindow === 'number') item.contextWindow = m.contextWindow
      if (typeof m.maxTokens === 'number') item.maxTokens = m.maxTokens
      return item
    })
  }

  // Filter by search query
  const query = search.trim().toLowerCase()
  const filteredCandidates = query.length === 0
    ? tabPool
    : tabPool.filter(c => c.id.toLowerCase().includes(query) || c.name?.toLowerCase().includes(query))

  // Group filtered models
  const grouped = new Map<string, typeof tabPool>()
  for (const model of filteredCandidates) {
    const brand = categorizeModelId(model.id, model.name)
    const list = grouped.get(brand) ?? []
    list.push(model)
    grouped.set(brand, list)
  }

  // Sort groups by custom BRAND_ORDER
  const sortedGroupKeys = [...grouped.keys()].sort((a, b) => {
    const idxA = BRAND_ORDER.indexOf(a)
    const idxB = BRAND_ORDER.indexOf(b)
    if (idxA !== -1 && idxB !== -1) return idxA - idxB
    if (idxA !== -1) return -1
    if (idxB !== -1) return 1
    return a.localeCompare(b)
  })

  // Automatically expand all groups when opened or when candidates update
  useEffect(() => {
    if (open) {
      setExpandedGroups(new Set(sortedGroupKeys))
    }
  }, [open, candidates.length])

  if (!open) return null

  const toggleGroupExpand = (brand: string): void => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(brand)) {
        next.delete(brand)
      } else {
        next.add(brand)
      }
      return next
    })
  }

  const isGroupExpanded = (brand: string): boolean => {
    return expandedGroups.has(brand)
  }

  const toggleModel = (id: string): void => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleGroupSelect = (brand: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    const groupModels = grouped.get(brand) ?? []
    const allSelected = groupModels.every(m => selectedIds.has(m.id))
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allSelected) {
        for (const m of groupModels) next.delete(m.id)
      } else {
        for (const m of groupModels) next.add(m.id)
      }
      return next
    })
  }

  const handleSave = (): void => {
    const existingMap = new Map(currentModels.map(m => [typeof m['id'] === 'string' ? m['id'] : '', m]))
    const result: ModelDraft[] = []

    // 1. For each candidate that is selected in the modal:
    for (const candidate of candidates) {
      if (selectedIds.has(candidate.id)) {
        const existing = existingMap.get(candidate.id)
        const cleanName = cleanModelDisplayName(candidate.name, candidate.id)
        if (existing) {
          result.push({
            ...existing,
            ...(typeof existing.name === 'string' ? { name: cleanModelDisplayName(existing.name, typeof existing.id === 'string' ? existing.id : undefined) } : (cleanName ? { name: cleanName } : {})),
            ...(typeof existing.contextWindow === 'number' ? {} : (candidate.contextWindow ? { contextWindow: candidate.contextWindow } : {})),
            ...(typeof existing.maxTokens === 'number' ? {} : (candidate.maxTokens ? { maxTokens: candidate.maxTokens } : {})),
            ...(existing.reasoningEfforts ? {} : (candidate.reasoningEfforts ? { reasoningEfforts: candidate.reasoningEfforts } : {})),
          })
        } else {
          result.push({
            id: candidate.id,
            ...(cleanName ? { name: cleanName } : {}),
            ...(typeof candidate.contextWindow === 'number' ? { contextWindow: candidate.contextWindow } : {}),
            ...(typeof candidate.maxTokens === 'number' ? { maxTokens: candidate.maxTokens } : {}),
            ...(candidate.reasoningEfforts ? { reasoningEfforts: candidate.reasoningEfforts } : {}),
          })
        }
        existingMap.delete(candidate.id)
      }
    }

    // 2. Also keep any existing models that were selected but were not in the candidate pool
    for (const [id, existing] of existingMap.entries()) {
      if (selectedIds.has(id)) {
        result.push({ ...existing })
      }
    }

    onSave(result)
    onClose()
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="获取模型">
      <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <h3 className={styles.title}>{t ? t('fetchTitle') : '获取模型'}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                onClick={toggleSelectAll}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#1677ff',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  padding: '4px 8px',
                }}
              >
                {allCandidatesSelected
                  ? (t ? t('fetchDeselectAll') : '取消全选')
                  : (t ? t('fetchSelectAll') : '全选')}
              </button>
              <button
                type="button"
                className={styles.closeButton}
                onClick={onClose}
                aria-label="关闭"
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M4 4L12 12M12 4L4 12"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          <div className={styles.channelRow}>
            <span>渠道:</span>
            <span className={styles.channelName}>{providerName || 'Aiapi'}</span>
          </div>

          {/* Search bar */}
          <div className={styles.searchBox}>
            <span className={styles.searchIcon}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M7 12C9.76142 12 12 9.76142 12 7C12 4.23858 9.76142 2 7 2C4.23858 2 2 4.23858 2 7C2 9.76142 4.23858 12 7 12Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path d="M11 11L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="搜索模型..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Filter tabs */}
          <div className={styles.tabsContainer}>
            <button
              type="button"
              className={`${styles.tab} ${activeTab === 'all' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('all')}
            >
              全部模型 ({candidates.length || currentModels.length})
            </button>
            <button
              type="button"
              className={`${styles.tab} ${activeTab === 'new' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('new')}
            >
              新模型 ({newCandidates.length})
            </button>
            <button
              type="button"
              className={`${styles.tab} ${activeTab === 'selected' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('selected')}
            >
              已选模型 ({selectedCandidates.length})
            </button>
            {removedCandidates.length > 0 && (
              <button
                type="button"
                className={`${styles.tab} ${activeTab === 'removed' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('removed')}
              >
                已移除 ({removedCandidates.length})
              </button>
            )}
          </div>
        </div>

        {/* Body List */}
        <div className={styles.body}>
          {sortedGroupKeys.length === 0 ? (
            <div className={styles.emptyState}>
              <p>暂无符合条件的模型</p>
            </div>
          ) : (
            sortedGroupKeys.map(brand => {
              const groupModels = grouped.get(brand) ?? []
              const groupSelectedCount = groupModels.filter(m => selectedIds.has(m.id)).length
              const allInGroupSelected = groupModels.length > 0 && groupSelectedCount === groupModels.length
              const expanded = isGroupExpanded(brand)

              return (
                <div key={brand} className={styles.groupCard}>
                  <div
                    className={styles.groupHeader}
                    onClick={() => toggleGroupExpand(brand)}
                  >
                    <div className={styles.groupLeft}>
                      <span
                        className={`${styles.chevronIcon} ${!expanded ? styles.chevronIconRotated : ''}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                          <path
                            d="M4 6L8 10L12 6"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <span className={styles.groupTitle}>
                        {brand} ({groupModels.length})
                      </span>
                    </div>

                    <div className={styles.groupRight}>
                      <span className={styles.groupStatus}>
                        {groupSelectedCount} / {groupModels.length} selected
                      </span>
                      <button
                        type="button"
                        className={styles.groupCheckBtn}
                        onClick={e => toggleGroupSelect(brand, e)}
                        title={allInGroupSelected ? '取消全选' : '全选'}
                      >
                        <GroupCheckIcon checked={allInGroupSelected} />
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className={styles.groupContent}>
                      {groupModels.map(model => {
                        const checked = selectedIds.has(model.id)
                        return (
                          <label
                            key={model.id}
                            className={styles.modelItem}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleModel(model.id)}
                              style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                            />
                            <CheckIcon active={checked} />
                            <span className={styles.modelId} title={model.name ? `${cleanModelDisplayName(model.name, model.id)} (${model.id})` : model.id}>
                              {model.name && cleanModelDisplayName(model.name, model.id) !== model.id ? (
                                <>
                                  <span className={styles.modelName}>{cleanModelDisplayName(model.name, model.id)}</span>
                                  <span className={styles.modelSubId}> ({model.id})</span>
                                </>
                              ) : (
                                model.id
                              )}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.summaryBox}>
            已选 {selectedIds.size} 个模型
          </div>
          <div className={styles.footerActions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              {t ? t('cancel') : '取消'}
            </button>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSave}
            >
              {t ? t('fetchAdopt') : '保存模型'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
