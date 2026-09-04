/**
 * Modal dialog for creating or editing MoA presets.
 */

import { useState } from 'react'
import {
  Button,
  IconPlusOutline16,
  IconTrashOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MoaModelSlot, MoaPreset } from './types.ts'
import type { ProviderModelCatalog } from './store.ts'
import type { zh } from './locales.ts'
import css from './MoaSection.module.css'

interface MoaPresetModalProps {
  open: boolean
  preset: MoaPreset | null
  isNew: boolean
  availableProviders: ProviderModelCatalog[]
  onSave: (preset: MoaPreset) => void
  onClose: () => void
  t: (key: keyof typeof zh) => string
}

export function MoaPresetModal({
  open,
  preset,
  isNew,
  availableProviders,
  onSave,
  onClose,
  t,
}: MoaPresetModalProps) {
  if (!preset) return null

  const [name, setName] = useState(preset.name)
  const [description, setDescription] = useState(preset.description || '')
  const [refModels, setRefModels] = useState<MoaModelSlot[]>(preset.reference_models || [])
  const [aggregator, setAggregator] = useState<MoaModelSlot>(preset.aggregator || { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' })
  const [refTemp, setRefTemp] = useState(preset.reference_temperature ?? 0.6)
  const [aggTemp, setAggTemp] = useState(preset.aggregator_temperature ?? 0.4)
  const [maxTokens, setMaxTokens] = useState(preset.max_tokens ?? 4096)
  const [error, setError] = useState<string | null>(null)

  const handleAddRefModel = () => {
    const firstProv = availableProviders[0]
    if (!firstProv) return
    const firstModel = firstProv.models[0]?.id || 'gpt-5.4'
    setRefModels([...refModels, { provider: firstProv.provider, model: firstModel }])
  }

  const handleUpdateRefModel = (index: number, provider: string, model: string) => {
    const updated = [...refModels]
    updated[index] = { provider, model }
    setRefModels(updated)
  }

  const handleRemoveRefModel = (index: number) => {
    if (refModels.length <= 1) {
      setError(t('refModelsMin'))
      return
    }
    setError(null)
    setRefModels(refModels.filter((_, i) => i !== index))
  }

  const handleSave = () => {
    if (!name.trim()) {
      setError(t('nameRequired'))
      return
    }
    if (refModels.length === 0) {
      setError(t('refModelsMin'))
      return
    }
    setError(null)
    onSave({
      ...preset,
      name: name.trim(),
      description: description.trim(),
      reference_models: refModels,
      aggregator,
      reference_temperature: refTemp,
      aggregator_temperature: aggTemp,
      max_tokens: maxTokens,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? t('newPreset') : `${t('editPreset')} · ${preset.name}`}
      description={t('subtitle')}
      closeLabel={t('cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave}>
            {t('save')}
          </Button>
        </>
      )}
    >
      <div className={css.modalForm}>
        {error && (
          <div style={{ padding: '8px 12px', background: '#fee2e2', color: '#b91c1c', borderRadius: '8px', fontSize: '12px' }}>
            {error}
          </div>
        )}

        {/* Name & Description */}
        <div className={css.formGroup}>
          <label className={css.formLabel}>{t('presetName')}</label>
          <input
            type="text"
            className={css.input}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例如：自訂全能協同方案"
          />
        </div>

        <div className={css.formGroup}>
          <label className={css.formLabel}>{t('presetDescription')}</label>
          <input
            type="text"
            className={css.input}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="例如：Claude 3.7 + GPT-5.4 雙重架構驗證"
          />
        </div>

        {/* Reference Models */}
        <div className={css.formGroup}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
            <label className={css.formLabel}>{t('refModelsConfig')}</label>
            <Button variant="outline" onClick={handleAddRefModel} style={{ fontSize: '11.5px', padding: '2px 8px' }}>
              <IconPlusOutline16 size={12} />
              <span>{t('addRefModel')}</span>
            </Button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {refModels.map((slot, idx) => {
              const curProv = availableProviders.find(p => p.provider === slot.provider) || availableProviders[0]
              return (
                <div key={idx} className={css.slotEditRow}>
                  <select
                    className={css.select}
                    value={slot.provider}
                    onChange={e => {
                      const newProv = availableProviders.find(p => p.provider === e.target.value)
                      handleUpdateRefModel(idx, e.target.value, newProv?.models[0]?.id || '')
                    }}
                  >
                    {availableProviders.map(p => (
                      <option key={p.provider} value={p.provider}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>

                  <select
                    className={css.select}
                    style={{ flex: 1 }}
                    value={slot.model}
                    onChange={e => handleUpdateRefModel(idx, slot.provider, e.target.value)}
                  >
                    {curProv?.models.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => handleRemoveRefModel(idx)}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}
                    title={t('deletePreset')}
                  >
                    <IconTrashOutline16 size={16} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        {/* Aggregator Model */}
        <div className={css.formGroup}>
          <label className={css.formLabel}>
            👑 {t('aggregatorConfig')}
          </label>
          <div className={css.slotEditRow} style={{ background: 'rgba(99, 102, 241, 0.05)', borderColor: 'rgba(99, 102, 241, 0.3)' }}>
            <select
              className={css.select}
              value={aggregator.provider}
              onChange={e => {
                const newProv = availableProviders.find(p => p.provider === e.target.value)
                setAggregator({ provider: e.target.value, model: newProv?.models[0]?.id || '' })
              }}
            >
              {availableProviders.map(p => (
                <option key={p.provider} value={p.provider}>
                  {p.displayName}
                </option>
              ))}
            </select>

            <select
              className={css.select}
              style={{ flex: 1 }}
              value={aggregator.model}
              onChange={e => setAggregator({ ...aggregator, model: e.target.value })}
            >
              {availableProviders.find(p => p.provider === aggregator.provider)?.models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Hyperparameters */}
        <div className={css.formGroup} style={{ borderTop: '1px solid #e5e7eb', paddingTop: '12px' }}>
          <label className={css.formLabel}>{t('hyperparameters')}</label>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
            <div className={css.sliderRow}>
              <span style={{ fontSize: '12px', color: '#4b5563' }}>{t('refTemperatureLabel')}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                className={css.sliderInput}
                value={refTemp}
                onChange={e => setRefTemp(parseFloat(e.target.value))}
              />
              <span className={css.sliderValue}>{refTemp.toFixed(2)}</span>
            </div>

            <div className={css.sliderRow}>
              <span style={{ fontSize: '12px', color: '#4b5563' }}>{t('aggTemperatureLabel')}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                className={css.sliderInput}
                value={aggTemp}
                onChange={e => setAggTemp(parseFloat(e.target.value))}
              />
              <span className={css.sliderValue}>{aggTemp.toFixed(2)}</span>
            </div>

            <div className={css.sliderRow}>
              <span style={{ fontSize: '12px', color: '#4b5563' }}>{t('maxTokensLabel')}</span>
              <select
                className={css.select}
                value={maxTokens}
                onChange={e => setMaxTokens(parseInt(e.target.value, 10))}
              >
                <option value={2048}>2048 Tokens</option>
                <option value={4096}>4096 Tokens (標準)</option>
                <option value={8192}>8192 Tokens (長文本/深度推理)</option>
                <option value={16384}>16384 Tokens</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
