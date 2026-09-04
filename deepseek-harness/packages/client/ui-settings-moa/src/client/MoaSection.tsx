import { useState, useEffect, useSyncExternalStore } from 'react'
import {
  IconBranchOutline16,
  IconEnhanceOutline16,
  IconRefreshOutline16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatReasoningLabel, type MoaSettingsController } from './store.ts'
import type { MoaMode, MoaModelSlot, ReasoningEffort } from './types.ts'
import { CustomSelect, type SelectOption } from './CustomSelect.tsx'
import { TactileSlider } from './TactileSlider.tsx'
import { MoaPlayground } from './MoaPlayground.tsx'
import type { zh } from './locales.ts'
import css from './MoaSection.module.css'

export interface MoaSectionInjected {
  controller: MoaSettingsController
  t: (key: keyof typeof zh) => string
}

export type MoaSectionProps = PropsRuntime<'settings.section'> & Partial<MoaSectionInjected>

export function MoaSection({ controller, t = (k: any) => k }: MoaSectionProps) {
  if (!controller) return null

  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const [activeTab, setActiveTab] = useState<'synergy' | 'playground'>('synergy')
  const [isSyncing, setIsSyncing] = useState(false)

  // Automatically sync model catalog from host on mount / view
  useEffect(() => {
    void controller.syncProvidersFromHost()
  }, [controller])

  const handleManualSync = async () => {
    setIsSyncing(true)
    try {
      await controller.syncProvidersFromHost()
    } finally {
      setTimeout(() => setIsSyncing(false), 300)
    }
  }

  const currentMode: MoaMode = state.mode || 'balanced'
  const slots = state.slots

  const handleProviderChange = (key: 'slotA' | 'slotB' | 'slotC', newProvider: string) => {
    controller.setSlot(key, { provider: newProvider, model: '', reasoning_effort: undefined })
  }

  const handleModelChange = (key: 'slotA' | 'slotB' | 'slotC', newModel: string) => {
    const current = slots[key]
    const providerCatalog = state.availableProviders.find(p => p.provider === current.provider)
    const targetModel = providerCatalog?.models.find(m => m.id === newModel)
    const newEffort = targetModel?.reasoning?.defaultEffort || targetModel?.reasoning?.efforts?.[0]?.id || undefined
    controller.setSlot(key, { ...current, model: newModel, reasoning_effort: newEffort })
  }

  const handleEffortChange = (key: 'slotA' | 'slotB' | 'slotC', effort: ReasoningEffort) => {
    const current = slots[key]
    controller.setSlot(key, { ...current, reasoning_effort: effort })
  }

  const providerOptions: SelectOption[] = state.availableProviders.map(p => ({
    value: p.provider,
    label: p.displayName,
  }))

  const renderSlotCard = (
    key: 'slotA' | 'slotB' | 'slotC',
    badgeText: string,
    badgeClass: string | undefined,
    slotData: MoaModelSlot,
    isActiveInMode: boolean
  ) => {
    const providerCatalog = state.availableProviders.find(p => p.provider === slotData.provider)
    const availableModels = providerCatalog?.models || []
    const modelOptions: SelectOption[] = availableModels.map(m => ({
      value: m.id,
      label: m.name,
      badge: m.reasoning ? '思考' : undefined,
    }))

    if (!modelOptions.some(m => m.value === slotData.model) && slotData.model) {
      modelOptions.unshift({ value: slotData.model, label: slotData.model })
    }

    const selectedModel = availableModels.find(m => m.id === slotData.model)
    const modelReasoning = selectedModel?.reasoning
    const hasReasoning = Boolean(modelReasoning && modelReasoning.efforts && modelReasoning.efforts.length > 0)

    const effortOptions: SelectOption[] = hasReasoning
      ? modelReasoning!.efforts.map(e => ({
          value: e.id,
          label: formatReasoningLabel(e.id, e.name),
        }))
      : []

    const currentEffort = slotData.reasoning_effort || (hasReasoning ? modelReasoning?.defaultEffort || modelReasoning?.efforts[0]?.id || '' : '')

    const hasNoProviders = providerOptions.length === 0

    return (
      <div className={`${css.compactSlotCard} ${isActiveInMode ? css.slotActive : css.slotInactive}`}>
        <div className={css.compactSlotHeader}>
          <span className={`${css.slotBadge} ${badgeClass ?? ''}`}>{badgeText}</span>
          {!isActiveInMode && (
            <span style={{ fontSize: '10px', color: '#9ca3af', fontStyle: 'italic' }}>
              (質量模式啟用)
            </span>
          )}
        </div>

        {/* Provider */}
        <div className={css.slotFieldRow}>
          <span className={css.slotFieldLabel}>供應商</span>
          <CustomSelect
            value={slotData.provider}
            onChange={p => handleProviderChange(key, p)}
            options={providerOptions}
            placeholder={hasNoProviders ? '尚未綁定任何供應商' : '請選擇供應商...'}
            disabled={hasNoProviders}
            disabledReason="請先至左側「模型」設定頁面綁定供應商 API 密鑰"
          />
        </div>

        {/* Model */}
        <div className={css.slotFieldRow}>
          <span className={css.slotFieldLabel}>模型</span>
          <CustomSelect
            value={slotData.model}
            onChange={m => handleModelChange(key, m)}
            options={modelOptions}
            placeholder={
              hasNoProviders
                ? '尚未綁定任何供應商'
                : slotData.provider
                  ? '請選擇模型...'
                  : '請先選擇供應商'
            }
            disabled={hasNoProviders || !slotData.provider || modelOptions.length === 0}
            disabledReason={
              hasNoProviders
                ? '請先至左側「模型」設定頁面綁定供應商 API 密鑰'
                : !slotData.provider
                  ? '請先選擇供應商'
                  : '該供應商暫無啟用模型'
            }
          />
        </div>

        {/* Reasoning Effort */}
        <div className={css.slotFieldRow}>
          <span className={css.slotFieldLabel}>思考程度</span>
          {hasNoProviders ? (
            <div className={css.disabledEffortBadge}>請先綁定供應商</div>
          ) : !slotData.provider ? (
            <div className={css.disabledEffortBadge}>請先選擇供應商</div>
          ) : !slotData.model ? (
            <div className={css.disabledEffortBadge}>請先選擇模型</div>
          ) : hasReasoning ? (
            modelReasoning!.efforts.length <= 4 ? (
              <div
                className={css.effortPillGroup}
                style={{ gridTemplateColumns: `repeat(${modelReasoning!.efforts.length}, 1fr)` }}
              >
                {modelReasoning!.efforts.map(eff => (
                  <button
                    key={eff.id}
                    type="button"
                    className={`${css.effortPill} ${currentEffort === eff.id ? css.effortPillActive : ''}`}
                    onClick={() => handleEffortChange(key, eff.id)}
                  >
                    {formatReasoningLabel(eff.id, eff.name)}
                  </button>
                ))}
              </div>
            ) : (
              <CustomSelect
                value={currentEffort}
                onChange={eff => handleEffortChange(key, eff)}
                options={effortOptions}
              />
            )
          ) : (
            <div className={css.disabledEffortBadge}>不支援思考 (標準模式)</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={css.section}>
      {/* Compact Hero Header */}
      <div className={css.hero} style={{ padding: '12px 18px' }}>
        <div className={css.heroContent}>
          <div className={css.heroTitleRow} style={{ marginBottom: 0 }}>
            <div className={css.heroIcon} style={{ width: '28px', height: '28px' }}>
              <IconEnhanceOutline16 size={16} />
            </div>
            <span className={css.heroTitle} style={{ fontSize: '16px' }}>{t('title')}</span>
          </div>
        </div>

        <div className={css.heroToggle} style={{ padding: '6px 12px' }} onClick={() => controller.toggleEnabled(!state.enabled)}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: state.enabled ? '#4f46e5' : '#6b7280' }}>
            {state.enabled ? '已啟用' : '已關閉'}
          </span>
          <button
            type="button"
            className={`${css.toggleSwitch} ${state.enabled ? css.checked : ''}`}
            aria-checked={state.enabled}
          >
            <span className={css.toggleThumb} />
          </button>
        </div>
      </div>

      {/* Notice if no providers connected */}
      {state.availableProviders.length === 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 14px',
          borderRadius: '8px',
          background: '#fffbeb',
          border: '1px solid #fef3c7',
          color: '#b45309',
          fontSize: '12px',
        }}>
          <IconWarningOutline16 size={16} />
          <span>
            尚未偵測到已連線的供應商。請先至左側「模型」設定頁面綁定 API 密鑰或啟用供應商，連線後將自動即時同步至此處席位。
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className={css.viewTabs} style={{ marginBottom: 0 }}>
        <button
          type="button"
          className={`${css.tabBtn} ${activeTab === 'synergy' ? css.activeTab : ''}`}
          onClick={() => setActiveTab('synergy')}
        >
          <IconBranchOutline16 size={14} />
          <span>⚡️ 盲區協同調度</span>
        </button>

        <button
          type="button"
          className={`${css.tabBtn} ${activeTab === 'playground' ? css.activeTab : ''}`}
          onClick={() => setActiveTab('playground')}
        >
          <IconEnhanceOutline16 size={14} />
          <span>{t('liveTest')}</span>
        </button>
      </div>

      {/* Main Synergy Configuration View */}
      {activeTab === 'synergy' && (
        <>
          {/* Truly Draggable Tactile Slider */}
          <TactileSlider
            mode={currentMode}
            onChange={m => controller.setMode(m)}
          />

          {/* Model Slots Grid */}
          <div className={css.slotsSection}>
            <div className={css.slotsSectionHeader}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className={css.slotsTitle}>協同席位 (3 席平等專家)</span>
                <button
                  type="button"
                  className={css.syncBtn}
                  onClick={handleManualSync}
                  title="從模型設定即時重新整理連線狀態"
                  style={{ opacity: isSyncing ? 0.6 : 1 }}
                >
                  <IconRefreshOutline16 size={12} className={isSyncing ? css.spinning : ''} />
                  <span>{isSyncing ? '同步中...' : '同步模型'}</span>
                </button>
              </div>
              <span className={css.slotsSubtitle}>
                與模型設定即時同步 · 僅顯示已連線且啟用的供應商與模型
              </span>
            </div>

            <div className={css.slotsGrid}>
              {renderSlotCard(
                'slotA',
                '● 席位 1',
                css.slotBadgeA,
                slots.slotA,
                true
              )}

              {renderSlotCard(
                'slotB',
                '● 席位 2',
                css.slotBadgeB,
                slots.slotB,
                true
              )}

              {renderSlotCard(
                'slotC',
                '● 席位 3',
                css.slotBadgeC,
                slots.slotC,
                currentMode === 'quality'
              )}
            </div>
          </div>
        </>
      )}

      {/* Playground View Tab */}
      {activeTab === 'playground' && (
        <MoaPlayground
          state={state}
          onRunTest={controller.runTest}
          onSelectPreset={controller.setTestingPresetId}
          t={t}
        />
      )}
    </div>
  )
}
