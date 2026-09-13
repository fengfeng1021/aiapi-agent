/** Host registration for the browser theme preference and pre-plugin palette. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { bootThemeInjection } from './boot-theme.ts'
import {
  DEFAULT_CJK_FONT, DEFAULT_CJK_WEIGHT, DEFAULT_FONT_SIZE, DEFAULT_LATIN_FONT, DEFAULT_LATIN_WEIGHT,
  DEFAULT_PREFERENCE, isFontWeight, THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema,
  type CjkFont, type LatinFont, type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

export {
  CJK_FONT_FIELD, CJK_FONT_OPTIONS, CJK_WEIGHT_FIELD, DEFAULT_CJK_FONT, DEFAULT_CJK_WEIGHT, DEFAULT_FONT_SIZE,
  DEFAULT_LATIN_FONT, DEFAULT_LATIN_WEIGHT, DEFAULT_PREFERENCE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN,
  FONT_WEIGHT_MAX, FONT_WEIGHT_MIN, LATIN_FONT_FIELD, LATIN_FONT_OPTIONS, LATIN_WEIGHT_FIELD,
  THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  cjkLetterSpacing, fontStacks, fontWeightAxes, isCjkFont, isFontWeight, isLatinFont,
  type CjkFont, type FontStacks, type FontWeightAxes, type LatinFont, type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

const THEME_NAMESPACE = THEME_SETTINGS_NAMESPACE

interface ThemeSectionSnapshot {
  preference: ThemePreference
  fontSize: number
  latinFont: LatinFont
  cjkFont: CjkFont
  latinWeight: number
  cjkWeight: number
}

/** Read the registered theme section or the schema defaults without a settings provider. */
function readSection(ctx: Context): ThemeSectionSnapshot {
  const fallback = {
    preference: DEFAULT_PREFERENCE,
    fontSize: DEFAULT_FONT_SIZE,
    latinFont: DEFAULT_LATIN_FONT,
    cjkFont: DEFAULT_CJK_FONT,
    latinWeight: DEFAULT_LATIN_WEIGHT,
    cjkWeight: DEFAULT_CJK_WEIGHT,
  }
  const settings = ctx.get('settings')
  if (settings === undefined) return fallback
  const section = settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  if (section === undefined) return fallback
  return {
    ...section,
    latinWeight: isFontWeight(section.latinWeight) ? section.latinWeight : DEFAULT_LATIN_WEIGHT,
    cjkWeight: isFontWeight(section.cjkWeight) ? section.cjkWeight : DEFAULT_CJK_WEIGHT,
  }
}

/**
 * Register the durable theme section when the optional settings service is
 * composed, and answer every index injection collection with the current
 * theme bootstrap row.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema)
  })
  ctx.on('webserver/index-inject', (table) => {
    const section = readSection(ctx)
    table.push(bootThemeInjection(
      section.preference, section.fontSize, section.latinFont, section.cjkFont,
      section.latinWeight, section.cjkWeight,
    ))
  })
}
