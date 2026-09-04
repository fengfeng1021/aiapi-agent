/**
 * Interactive Visual Pipeline of the active MoA preset.
 */

import {
  IconBranchOutline16,
  IconCheckOutline16,
  IconDataOutline16,
  IconEnhanceOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MoaMode, SimpleMoaSlots } from './types.ts'
import type { zh } from './locales.ts'
import css from './MoaSection.module.css'

interface MoaPipelineVisualizerProps {
  mode: MoaMode
  slots: SimpleMoaSlots
  t: (key: keyof typeof zh) => string
}

export function MoaPipelineVisualizer({ mode, slots, t }: MoaPipelineVisualizerProps) {
  return (
    <div className={css.pipelineContainer}>
      <div className={css.pipelineHeader}>
        <div className={css.sectionHeading}>
          {t('workflowFlowLabel')} · {mode === 'speed' ? '⚡️ 效率優先' : mode === 'quality' ? '🏆 質量攻堅' : '⚖️ 均衡協同'}
        </div>
        <span className={css.badge} style={{ background: 'rgba(99, 102, 241, 0.1)', color: '#6366f1' }}>
          {mode === 'speed' ? '雙席極速流水線 · 起草 + 秒級避坑' : mode === 'quality' ? '三席全能研判 · 平等討論攻堅' : '雙席平等互補 · 實作 + 健壯性對齊'}
        </span>
      </div>

      {/* Speed Mode Pipeline */}
      {mode === 'speed' && (
        <>
          <div className={css.pipelineStage}>
            <div className={css.stageTitle}>
              <IconDataOutline16 size={16} />
              <span>Step 1: 席位 1 快速起草</span>
            </div>
            <div className={css.stageDesc}>
              迅速構建核心代碼架構與功能實現，以最快速度輸出可用草案。
            </div>
            <div className={css.nodeGrid}>
              <div className={css.pipelineNode} style={{ border: '1.5px solid #10b981' }}>
                <div className={css.nodeIcon} style={{ background: '#ecfdf5', color: '#059669' }}>
                  <IconDataOutline16 size={16} />
                </div>
                <div className={css.nodeText}>
                  <span className={css.nodeModelName} style={{ color: '#059669', fontWeight: 700 }}>
                    {slots.slotA.model}
                  </span>
                  <span className={css.nodeProvider}>
                    🟢 協同席位 1 ({slots.slotA.provider})
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className={css.flowArrow}>
            <span>↓ 席位 2 進行秒級避坑快檢（排查樣式遮擋、邊界超出或基礎邏輯 Bug） ↓</span>
          </div>

          <div className={css.pipelineStage} style={{ borderColor: 'rgba(59, 130, 246, 0.3)', background: 'rgba(59, 130, 246, 0.03)' }}>
            <div className={css.stageTitle} style={{ color: '#2563eb' }}>
              <IconEnhanceOutline16 size={16} />
              <span>Step 2: 席位 2 快速查漏避坑（不精雕細琢）</span>
            </div>
            <div className={css.stageDesc}>
              專注排除單一模型容易忽略的低級錯誤與排版衝突，不進行多餘爭論，確保又快又不出問題。
            </div>
            <div className={css.pipelineNode} style={{ maxWidth: '340px' }}>
              <div className={css.nodeIcon} style={{ background: '#eff6ff', color: '#2563eb' }}>
                <IconBranchOutline16 size={16} />
              </div>
              <div className={css.nodeText}>
                <span className={css.nodeModelName}>{slots.slotB.model}</span>
                <span className={css.nodeProvider}>🔵 協同席位 2 ({slots.slotB.provider})</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Balanced Mode Pipeline */}
      {mode === 'balanced' && (
        <>
          <div className={css.pipelineStage}>
            <div className={css.stageTitle}>
              <IconBranchOutline16 size={16} />
              <span>Step 1: 雙席平等協同探索（功能實作 + 邊界防護）</span>
            </div>
            <div className={css.stageDesc}>
              兩席專家地位平等：一個側重功能實作設計，一個側重邊界條件與健壯性防護。
            </div>
            <div className={css.nodeGrid}>
              <div className={css.pipelineNode} style={{ border: '1.5px solid #10b981' }}>
                <div className={css.nodeIcon} style={{ background: '#ecfdf5', color: '#059669' }}>
                  <IconDataOutline16 size={16} />
                </div>
                <div className={css.nodeText}>
                  <span className={css.nodeModelName} style={{ color: '#059669', fontWeight: 700 }}>
                    {slots.slotA.model}
                  </span>
                  <span className={css.nodeProvider}>🟢 協同席位 1 ({slots.slotA.provider})</span>
                </div>
              </div>

              <div className={css.pipelineNode} style={{ border: '1.5px solid #3b82f6' }}>
                <div className={css.nodeIcon} style={{ background: '#eff6ff', color: '#2563eb' }}>
                  <IconBranchOutline16 size={16} />
                </div>
                <div className={css.nodeText}>
                  <span className={css.nodeModelName} style={{ color: '#2563eb', fontWeight: 700 }}>
                    {slots.slotB.model}
                  </span>
                  <span className={css.nodeProvider}>🔵 協同席位 2 ({slots.slotB.provider})</span>
                </div>
              </div>
            </div>
          </div>

          <div className={css.flowArrow}>
            <span>↓ 雙向交叉對齊，融合實作精華與安全防護 ↓</span>
          </div>

          <div className={css.pipelineStage} style={{ borderColor: 'rgba(99, 102, 241, 0.4)', background: 'rgba(99, 102, 241, 0.03)' }}>
            <div className={css.stageTitle} style={{ color: '#4f46e5' }}>
              <IconEnhanceOutline16 size={16} />
              <span>Step 2: 雙向互補對齊</span>
            </div>
            <div className={css.stageDesc}>
              取兩者長處消除盲區，在快速交付的前提下保證最高代碼質量。
            </div>
            <div className={css.pipelineNode} style={{ border: '1.5px solid #6366f1', maxWidth: '340px' }}>
              <div className={css.nodeIcon} style={{ background: 'linear-gradient(135deg, #6366f1, #3b82f6)', color: '#fff' }}>
                <IconEnhanceOutline16 size={16} />
              </div>
              <div className={css.nodeText}>
                <span className={css.nodeModelName} style={{ color: '#4f46e5', fontWeight: 700 }}>
                  雙席精華對齊
                </span>
                <span className={css.nodeProvider}>⚖️ 均衡協同融合</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Quality Mode Pipeline */}
      {mode === 'quality' && (
        <>
          <div className={css.pipelineStage}>
            <div className={css.stageTitle}>
              <IconBranchOutline16 size={16} />
              <span>Step 1: 三席平等獨立剖析（打破單一模型訓練盲區）</span>
            </div>
            <div className={css.stageDesc}>
              面對難以解決的頑疾問題或追求極致時，三位平等模型各自從不同訓練架構出發給出思路。
            </div>
            <div className={css.nodeGrid}>
              <div className={css.pipelineNode} style={{ border: '1.5px solid #10b981' }}>
                <div className={css.nodeIcon} style={{ background: '#ecfdf5', color: '#059669' }}>
                  <IconDataOutline16 size={16} />
                </div>
                <div className={css.nodeText}>
                  <span className={css.nodeModelName} style={{ color: '#059669', fontWeight: 700 }}>
                    {slots.slotA.model}
                  </span>
                  <span className={css.nodeProvider}>🟢 席位 1 ({slots.slotA.provider})</span>
                </div>
              </div>

              <div className={css.pipelineNode} style={{ border: '1.5px solid #3b82f6' }}>
                <div className={css.nodeIcon} style={{ background: '#eff6ff', color: '#2563eb' }}>
                  <IconBranchOutline16 size={16} />
                </div>
                <div className={css.nodeText}>
                  <span className={css.nodeModelName} style={{ color: '#2563eb', fontWeight: 700 }}>
                    {slots.slotB.model}
                  </span>
                  <span className={css.nodeProvider}>🔵 席位 2 ({slots.slotB.provider})</span>
                </div>
              </div>

              <div className={css.pipelineNode} style={{ border: '1.5px solid #a855f7' }}>
                <div className={css.nodeIcon} style={{ background: '#fdf4ff', color: '#9333ea' }}>
                  <IconBranchOutline16 size={16} />
                </div>
                <div className={css.nodeText}>
                  <span className={css.nodeModelName} style={{ color: '#9333ea', fontWeight: 700 }}>
                    {slots.slotC.model}
                  </span>
                  <span className={css.nodeProvider}>🟣 席位 3 ({slots.slotC.provider})</span>
                </div>
              </div>
            </div>
          </div>

          <div className={css.flowArrow}>
            <span>↓ 三方平等探討、互相質疑並補足彼此盲區 ↓</span>
          </div>

          <div className={css.pipelineStage} style={{ borderColor: 'rgba(168, 85, 247, 0.4)', background: 'rgba(168, 85, 247, 0.03)' }}>
            <div className={css.stageTitle} style={{ color: '#9333ea' }}>
              <IconEnhanceOutline16 size={16} />
              <span>Step 2: 三方合力攻堅與方案終極提煉</span>
            </div>
            <div className={css.stageDesc}>
              化解分歧與死角，融匯三方見解，徹底擊破單一模型訓練導致的盲區頑疾。
            </div>
            <div className={css.pipelineNode} style={{ border: '1.5px solid #a855f7', maxWidth: '340px' }}>
              <div className={css.nodeIcon} style={{ background: 'linear-gradient(135deg, #a855f7, #ec4899)', color: '#fff' }}>
                <IconEnhanceOutline16 size={16} />
              </div>
              <div className={css.nodeText}>
                <span className={css.nodeModelName} style={{ color: '#9333ea', fontWeight: 700 }}>
                  三方智慧終極提煉
                </span>
                <span className={css.nodeProvider}>🏆 極致無懈可擊方案</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Final Output */}
      <div className={css.flowArrow}>
        <span>↓ 輸出最終最優代碼解答 ↓</span>
      </div>

      <div className={css.pipelineStage} style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>
        <div className={css.stageTitle} style={{ color: '#15803d' }}>
          <IconCheckOutline16 size={16} />
          <span>{t('finalOutput')}</span>
        </div>
        <div className={css.stageDesc}>
          {mode === 'speed' && '又快又不出問題：經由 Peer 席位快速排查排版遮擋與邊界溢出，不精雕細琢，即刻可用。'}
          {mode === 'balanced' && '快速前提下保證最高質量：雙席平等互補，兼顧功能實現與邊界健壯性。'}
          {mode === 'quality' && '三席合力攻堅：三方平等探討質疑，打破單一模型盲區頑疾，達到最高質量。'}
        </div>
      </div>
    </div>
  )
}
