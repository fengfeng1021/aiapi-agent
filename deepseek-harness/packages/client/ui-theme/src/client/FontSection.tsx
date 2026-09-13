/**
 * Font section page: one Latin/digit selector row, one Chinese selector
 * row, each with a live preview swatch rendered in the selected family,
 * plus a weight slider for families with an adjustable window.
 * Registered by this package - the theme feature owns its own settings
 * surface.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CJK_FONT_OPTIONS, LATIN_FONT_OPTIONS, cjkWeightSpec, effectiveCjkWeight, effectiveLatinWeight,
  latinWeightSpec, type FontWeightSpec,
} from '../theme-settings.ts'
import type { createFontSectionStore } from './settings-store.ts'
import css from './FontSection.module.css'

/** Injected business face: the font and weight writes (t rides the standard locale seat). */
export interface FontSectionInjected {
  /** Switch the Latin/digit font family. */
  setLatinFont: (family: string) => void
  /** Switch the Chinese font family. */
  setCjkFont: (family: string) => void
  /** Change the Latin/digit weight (renders for adjustable families). */
  setLatinWeight: (weight: number) => void
  /** Change the Chinese weight (renders for adjustable families). */
  setCjkWeight: (weight: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsStore<ReturnType<typeof createFontSectionStore>>
  & PropsLocale<'settings.theme'> & FontSectionInjected

/** One font group model: selector copy, live preview, and the optional weight slider. */
interface FontGroupModel {
  titleKey: 'font.latin.title' | 'font.cjk.title'
  descKey: 'font.latin.description' | 'font.cjk.description'
  previewKey: 'font.latin.preview' | 'font.cjk.preview'
  value: string
  options: readonly string[]
  weight: number
  spec: FontWeightSpec | null
  open: boolean
  setOpen: (open: boolean) => void
  onSelect: (family: string) => void
  onWeight: (weight: number) => void
}

/**
 * Render the font section page.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function FontSection({ t, setLatinFont, setCjkFont, setLatinWeight, setCjkWeight, useStore }: FontSectionComponentProps) {
  const latin = useStore(s => s.latin)
  const cjk = useStore(s => s.cjk)
  const latinWeight = useStore(s => s.latinWeight)
  const cjkWeight = useStore(s => s.cjkWeight)
  const [openLatin, setOpenLatin] = useState(false)
  const [openCjk, setOpenCjk] = useState(false)
  const groups: readonly FontGroupModel[] = [
    {
      titleKey: 'font.latin.title',
      descKey: 'font.latin.description',
      previewKey: 'font.latin.preview',
      value: latin,
      options: LATIN_FONT_OPTIONS,
      weight: effectiveLatinWeight(latin, latinWeight),
      spec: latinWeightSpec(latin),
      open: openLatin,
      setOpen: setOpenLatin,
      onSelect: setLatinFont,
      onWeight: setLatinWeight,
    },
    {
      titleKey: 'font.cjk.title',
      descKey: 'font.cjk.description',
      previewKey: 'font.cjk.preview',
      value: cjk,
      options: CJK_FONT_OPTIONS,
      weight: effectiveCjkWeight(cjk, cjkWeight),
      spec: cjkWeightSpec(cjk),
      open: openCjk,
      setOpen: setOpenCjk,
      onSelect: setCjkFont,
      onWeight: setCjkWeight,
    },
  ]
  return (
    <div className={css.section}>
      {groups.map(group => (
        <div key={group.titleKey} className={css.group}>
          <div className={css.row}>
            <div className={css.rowText}>
              <div className={css.title}>{t(group.titleKey)}</div>
              <div className={css.desc}>{t(group.descKey)}</div>
            </div>
            <Menu
              open={group.open}
              onClose={() => { group.setOpen(false) }}
              items={group.options.map(option => ({ id: option, label: option }))}
              selectedId={group.value}
              onSelect={(id) => {
                group.onSelect(id)
                group.setOpen(false)
              }}
              align='end'
              portal
              anchor={(
                <button
                  type='button'
                  className={css.selector}
                  aria-haspopup='menu'
                  aria-expanded={group.open}
                  onClick={() => { group.setOpen(!group.open) }}
                >
                  {group.value}
                  <IconChevronDownOutline14 className={css.chevron} />
                </button>
              )}
            />
          </div>
          <div
            className={css.preview}
            style={{ fontFamily: `'${group.value}'`, fontWeight: group.weight }}
          >
            {t(group.previewKey)}
          </div>
          {group.spec !== null && (
            <label className={css.weightRow}>
              <span className={css.weightTitle}>{t('font.weight.title')}</span>
              <input
                type='range'
                className={css.slider}
                min={group.spec.min}
                max={group.spec.max}
                step={group.spec.step}
                value={group.weight}
                aria-label={t('font.weight.label')}
                onChange={(event) => { group.onWeight(Number(event.target.value)) }}
              />
              <span className={css.weightValue}>{group.weight}</span>
            </label>
          )}
        </div>
      ))}
      <div className={css.note}>{t('font.note')}</div>
    </div>
  )
}
