/**
 * Interactive Live Test Playground for Mixture-of-Agents.
 */

import {
  Button,
  IconBranchOutline16,
  IconEnhanceOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MoaStoreState } from './store.ts'
import type { zh } from './locales.ts'
import css from './MoaSection.module.css'

interface MoaPlaygroundProps {
  state: MoaStoreState
  onRunTest: (prompt: string, presetId: string) => Promise<void>
  onSelectPreset: (id: string) => void
  t: (key: keyof typeof zh) => string
}

export function MoaPlayground({ state, onRunTest, onSelectPreset, t }: MoaPlaygroundProps) {
  const prompt = state.testPrompt
  const activePreset = state.presets.find(p => p.id === (state.testingPresetId || state.activePresetId)) || state.presets[0]!

  const handleRun = () => {
    if (!prompt.trim() || state.testRunning) return
    void onRunTest(prompt.trim(), activePreset.id)
  }

  const handlePickExample = (text: string) => {
    state.testPrompt = text
    void onRunTest(text, activePreset.id)
  }

  return (
    <div className={css.playgroundCard}>
      <div className={css.pipelineHeader}>
        <div>
          <div className={css.sectionHeading}>{t('playgroundTitle')}</div>
          <div className={css.heroSubtitle}>{t('playgroundSubtitle')}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: '#6b7280' }}>測試方案：</span>
          <select
            className={css.select}
            value={activePreset.id}
            onChange={e => onSelectPreset(e.target.value)}
          >
            {state.presets.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Prompt input */}
      <div className={css.formGroup}>
        <textarea
          className={css.textarea}
          value={prompt}
          onChange={e => { state.testPrompt = e.target.value }}
          placeholder={t('promptPlaceholder')}
        />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11.5px', color: '#6b7280' }}>{t('examplePrompts')}</span>
            <button
              type="button"
              className={css.examplePill}
              onClick={() => handlePickExample(t('examplePrompt1'))}
            >
              Rust LRU 快取
            </button>
            <button
              type="button"
              className={css.examplePill}
              onClick={() => handlePickExample(t('examplePrompt2'))}
            >
              Attention vs MoE
            </button>
            <button
              type="button"
              className={css.examplePill}
              onClick={() => handlePickExample(t('examplePrompt3'))}
            >
              分散式死鎖修復
            </button>
          </div>

          <Button
            onClick={handleRun}
            disabled={!prompt.trim() || state.testRunning}
            style={{
              background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
              color: '#ffffff',
              fontWeight: 600,
            }}
          >
            <IconEnhanceOutline16 size={14} />
            <span>{state.testRunning ? t('running') : t('runTest')}</span>
          </Button>
        </div>
      </div>

      {/* Results view */}
      {state.testRunning && (
        <div style={{ padding: '32px', textAlign: 'center', background: '#f9fafb', borderRadius: '12px', border: '1px dashed #d1d5db' }}>
          <div style={{ fontSize: '15px', fontWeight: 600, color: '#4f46e5', marginBottom: '6px' }}>
            🔄 正在並行調用 {activePreset.reference_models.length} 個參考模型進行多維度推理...
          </div>
          <div style={{ fontSize: '12px', color: '#6b7280' }}>
            即將傳送至 Aggregator ({activePreset.aggregator.model}) 進行交叉審核與研判
          </div>
        </div>
      )}

      {state.testResult && !state.testRunning && (
        <div className={css.outputSection}>
          {/* Reference Layer outputs */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 700, color: '#374151' }}>
              <IconBranchOutline16 size={14} />
              <span>{t('refOutputsTitle')}</span>
            </div>

            <div className={css.refOutputGrid}>
              {state.testResult.referenceOutputs.map((res, i) => (
                <div key={i} className={css.refOutputCard}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', borderBottom: '1px solid #e5e7eb', paddingBottom: '4px' }}>
                    <span style={{ fontWeight: 700, color: '#4f46e5', fontSize: '12px' }}>
                      {res.model}
                    </span>
                    <span style={{ fontSize: '10px', color: '#6b7280', textTransform: 'uppercase' }}>
                      {res.provider} · {res.durationMs}ms
                    </span>
                  </div>
                  <div style={{ color: '#374151' }}>{res.output}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Aggregator Final Synthesis Output */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', fontWeight: 700, color: '#4f46e5' }}>
              <IconEnhanceOutline16 size={16} />
              <span>{t('aggOutputTitle')} ({state.testResult.aggregatorOutput.model})</span>
            </div>

            <div className={css.aggOutputCard}>
              <div style={{ whiteSpace: 'pre-wrap', color: '#1f2937' }}>
                {state.testResult.aggregatorOutput.output}
              </div>
              <div style={{ marginTop: '12px', padding: '8px 12px', background: 'rgba(99, 102, 241, 0.08)', borderRadius: '8px', fontSize: '12px', color: '#4338ca' }}>
                {t('synthesisSummary')}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
