/**
 * Appearance and font-size row slot stores: mirrors of the theme service
 * snapshot. The plugin's apply-world change listener is the only writer; the
 * row components read via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  DEFAULT_CJK_FONT, DEFAULT_CJK_WEIGHT, DEFAULT_FONT_SIZE, DEFAULT_LATIN_FONT, DEFAULT_LATIN_WEIGHT,
  type CjkFont, type LatinFont, type ThemePreference,
} from '../theme-settings.ts'

/** Store state mirrored from the theme snapshot. */
export interface AppearanceRowState {
  /** Persisted preference (selection state reads this, never the resolved active theme). */
  preference: ThemePreference
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type AppearanceRowActions = {
  sync: (draft: AppearanceRowState, preference: ThemePreference, revision: number) => void
}

/**
 * Declares the Appearance row state and write surface.
 * @returns the store handle.
 */
export function createAppearanceRowStore(): EngineStoreHandle<AppearanceRowState, AppearanceRowActions> {
  return defineStore({
    init: (): AppearanceRowState => ({ preference: 'system', revision: -1 }),
    actions: {
      sync: (d, preference: ThemePreference, revision: number) => {
        if (revision <= d.revision) return
        d.preference = preference
        d.revision = revision
      },
    },
  })
}

/** Store state mirrored from the theme snapshot's font size. */
export interface FontSizeRowState {
  /** Persisted content font size in px. */
  fontSize: number
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type FontSizeRowActions = {
  sync: (draft: FontSizeRowState, fontSize: number, revision: number) => void
}

/**
 * Declares the font-size row state and write surface.
 * @returns the store handle.
 */
export function createFontSizeRowStore(): EngineStoreHandle<FontSizeRowState, FontSizeRowActions> {
  return defineStore({
    init: (): FontSizeRowState => ({ fontSize: DEFAULT_FONT_SIZE, revision: -1 }),
    actions: {
      sync: (d, fontSize: number, revision: number) => {
        if (revision <= d.revision) return
        d.fontSize = fontSize
        d.revision = revision
      },
    },
  })
}

/** Store state mirrored from the theme snapshot font families and weights. */
export interface FontSectionState {
  /** Persisted Latin/digit family. */
  latin: LatinFont
  /** Persisted Chinese family. */
  cjk: CjkFont
  /** Persisted Latin/digit weight (renders only for adjustable families). */
  latinWeight: number
  /** Persisted Chinese weight (renders only for adjustable families). */
  cjkWeight: number
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type FontSectionActions = {
  sync: (draft: FontSectionState, latin: LatinFont, cjk: CjkFont, latinWeight: number, cjkWeight: number, revision: number) => void
}

/**
 * Declares the font section state and write surface.
 * @returns the store handle.
 */
export function createFontSectionStore(): EngineStoreHandle<FontSectionState, FontSectionActions> {
  return defineStore({
    init: (): FontSectionState => ({
      latin: DEFAULT_LATIN_FONT, cjk: DEFAULT_CJK_FONT,
      latinWeight: DEFAULT_LATIN_WEIGHT, cjkWeight: DEFAULT_CJK_WEIGHT, revision: -1,
    }),
    actions: {
      sync: (d, latin: LatinFont, cjk: CjkFont, latinWeight: number, cjkWeight: number, revision: number) => {
        if (revision <= d.revision) return
        d.latin = latin
        d.cjk = cjk
        d.latinWeight = latinWeight
        d.cjkWeight = cjkWeight
        d.revision = revision
      },
    },
  })
}
