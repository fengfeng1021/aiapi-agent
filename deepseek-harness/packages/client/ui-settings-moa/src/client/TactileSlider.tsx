/**
 * Tactile, smoothly draggable slider for MoA mode scheduling.
 */

import { useState, useRef } from 'react'
import { IconEnhanceOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MoaMode } from './types.ts'
import css from './TactileSlider.module.css'

export interface TactileSliderProps {
  mode: MoaMode
  onChange: (mode: MoaMode) => void
}

const MODES: MoaMode[] = ['speed', 'balanced', 'quality']

const MODE_CONFIG: Record<MoaMode, { pct: number; label: string; tag: string; desc: string }> = {
  speed: {
    pct: 0,
    label: '⚡️ 效率優先',
    tag: '⚡️ 效率優先',
    desc: '又快又不出問題 · Peer 席位秒級掃描排版遮擋與邊界 Bug，極速交付',
  },
  balanced: {
    pct: 0.5,
    label: '⚖️ 均衡協同 (推薦)',
    tag: '⚖️ 均衡協同',
    desc: '快速前提下保證最高質量 · 雙席平等互補，核心實作與健壯性兼顧',
  },
  quality: {
    pct: 1.0,
    label: '🏆 質量攻堅',
    tag: '🏆 質量攻堅',
    desc: '三席平等合力攻堅 · 3 個模型獨立深入分析、交叉討論，消除盲區頑疾',
  },
}

export function TactileSlider({ mode, onChange }: TactileSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragPct, setDragPct] = useState<number | null>(null)

  const activeConfig = MODE_CONFIG[mode] || MODE_CONFIG.balanced
  const currentPct = isDragging && dragPct !== null ? dragPct : activeConfig.pct

  const calculatePctFromEvent = (clientX: number): number => {
    if (!trackRef.current) return 0
    const rect = trackRef.current.getBoundingClientRect()
    const raw = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(1, raw))
  }

  const snapPctToMode = (pct: number): MoaMode => {
    if (pct < 0.25) return 'speed'
    if (pct > 0.75) return 'quality'
    return 'balanced'
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setIsDragging(true)
    const pct = calculatePctFromEvent(e.clientX)
    setDragPct(pct)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return
    const pct = calculatePctFromEvent(e.clientX)
    setDragPct(pct)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return
    setIsDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
    const finalPct = dragPct !== null ? dragPct : activeConfig.pct
    setDragPct(null)
    const newMode = snapPctToMode(finalPct)
    onChange(newMode)
  }

  return (
    <div className={css.sliderContainer}>
      {/* Header Row */}
      <div className={css.headerRow}>
        <div className={css.titleWrap}>
          <div className={css.iconGlow}>
            <IconEnhanceOutline16 size={15} />
          </div>
          <span className={css.titleText}>協同檔位調度</span>
        </div>
        <div className={css.modeBadge}>{activeConfig.tag}</div>
      </div>

      {/* Interactive Track Area */}
      <div
        ref={trackRef}
        className={`${css.trackInteractiveArea} ${isDragging ? css.dragging : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className={css.trackBase}>
          {/* Active Fill */}
          <div
            className={css.trackFill}
            style={{ width: `${currentPct * 100}%` }}
          />

          {/* Stop Dots */}
          <div className={`${css.stopDot} ${currentPct >= 0 ? css.stopDotActive : ''}`} style={{ left: '0%' }} />
          <div className={`${css.stopDot} ${currentPct >= 0.5 ? css.stopDotActive : ''}`} style={{ left: '50%' }} />
          <div className={`${css.stopDot} ${currentPct >= 0.98 ? css.stopDotActive : ''}`} style={{ left: '100%' }} />

          {/* Draggable Knob */}
          <div
            className={`${css.knob} ${isDragging ? css.knobDragging : ''}`}
            style={{ left: `${currentPct * 100}%` }}
          >
            <div className={css.knobCore} />
          </div>
        </div>
      </div>

      {/* Labels Row */}
      <div className={css.labelsRow}>
        {MODES.map(m => {
          const cfg = MODE_CONFIG[m]
          const isActive = mode === m
          return (
            <button
              key={m}
              type="button"
              className={`${css.labelBtn} ${isActive ? css.labelBtnActive : ''}`}
              onClick={() => onChange(m)}
            >
              {cfg.label}
            </button>
          )
        })}
      </div>

      {/* One-Line Tagline */}
      <div className={css.tagline}>
        {activeConfig.desc}
      </div>
    </div>
  )
}
