/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Smallest accepted content font size (px). */
export const FONT_SIZE_MIN = 12

/** Largest accepted content font size (px). */
export const FONT_SIZE_MAX = 17

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_FONT_SIZE = 14

/** Font families accepted for Latin-letter and digit rendering. */
export const LATIN_FONT_OPTIONS = ['Cascadia Mono', 'Noto Sans Mono'] as const

/** Latin/digit font persisted by the product font section. */
export type LatinFont = typeof LATIN_FONT_OPTIONS[number]

/** Field carrying the selected Latin/digit font family. */
export const LATIN_FONT_FIELD = 'latinFont'

/** Latin/digit font when the user-settings document has no override. */
export const DEFAULT_LATIN_FONT: LatinFont = 'Cascadia Mono'

/** Font families accepted for Chinese-character rendering. */
export const CJK_FONT_OPTIONS = ['Microsoft YaHei UI', 'Microsoft YaHei', 'Microsoft JhengHei UI', 'Microsoft JhengHei', 'Maple Mono CN'] as const

/** Chinese font persisted by the product font section. */
export type CjkFont = typeof CJK_FONT_OPTIONS[number]

/** Field carrying the selected Chinese font family. */
export const CJK_FONT_FIELD = 'cjkFont'

/** Chinese font when the user-settings document has no override. */
export const DEFAULT_CJK_FONT: CjkFont = 'Microsoft YaHei UI'

/** Adjustable weight window of one selectable font; null when the family is fixed-weight. */
export interface FontWeightSpec {
  /** Smallest selectable weight. */
  min: number
  /** Largest selectable weight. */
  max: number
  /** Slider step. */
  step: number
  /** Weight a fresh selection starts from. */
  default: number
}

/** Weight window of one Latin/digit family, or null for fixed-weight system fonts. */
export function latinWeightSpec(font: string): FontWeightSpec | null {
  return font === 'Noto Sans Mono' ? { min: 100, max: 900, step: 10, default: 400 } : null
}

/** Weight window of one Chinese family, or null for fixed-weight system fonts. */
export function cjkWeightSpec(font: string): FontWeightSpec | null {
  return font === 'Maple Mono CN' ? { min: 400, max: 700, step: 50, default: 500 } : null
}

/** Smallest accepted font weight. */
export const FONT_WEIGHT_MIN = 100

/** Largest accepted font weight. */
export const FONT_WEIGHT_MAX = 900

/** Latin/digit weight when the user-settings document has no override. */
export const DEFAULT_LATIN_WEIGHT = 400

/** Chinese weight when the user-settings document has no override. */
export const DEFAULT_CJK_WEIGHT = 500

/** Field carrying the Latin/digit font weight. */
export const LATIN_WEIGHT_FIELD = 'latinWeight'

/** Field carrying the Chinese font weight. */
export const CJK_WEIGHT_FIELD = 'cjkWeight'

/**
 * Narrow one wire or registry value to a persistable font weight.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is an integer weight within {@link FONT_WEIGHT_MIN}..{@link FONT_WEIGHT_MAX}.
 */
export function isFontWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= FONT_WEIGHT_MIN && value <= FONT_WEIGHT_MAX
}

/** Clamp one persisted weight into a font's window. */
function clampWeight(spec: FontWeightSpec, raw: number): number {
  return Math.min(spec.max, Math.max(spec.min, raw))
}

/**
 * Resolve the rendered Latin/digit weight: the persisted value clamped into
 * the family's window, or 400 for fixed-weight families (their persisted
 * value is memory for a later switch back, never rendering).
 * @param font - selected Latin/digit family.
 * @param raw - persisted raw weight.
 * @returns the weight the presenter and boot script apply.
 */
export function effectiveLatinWeight(font: string, raw: number): number {
  const spec = latinWeightSpec(font)
  return spec === null ? 400 : clampWeight(spec, raw)
}

/**
 * Resolve the rendered Chinese weight: the persisted value clamped into
 * the family's window, or 400 for fixed-weight families.
 * @param font - selected Chinese family.
 * @param raw - persisted raw weight.
 * @returns the weight the presenter and boot script apply.
 */
export function effectiveCjkWeight(font: string, raw: number): number {
  const spec = cjkWeightSpec(font)
  return spec === null ? 400 : clampWeight(spec, raw)
}

/** Conversation letter-spacing for one Chinese family. */
export const DEFAULT_CJK_LETTER_SPACING = '0em'

/**
 * Conversation letter-spacing pipeline, always neutral. CJK density for
 * Maple Mono CN rides its CJK-gated @font-face instead (unicode-range plus
 * size-adjust in styles/fonts.css): that narrows only Chinese advances,
 * while letter-spacing would also narrow Latin and digits. Kept as a
 * function so the presenter, the boot script, and the tests keep one call
 * site, and unused callers keep passing the family through.
 */
export function cjkLetterSpacing(_font: string): string {
  return '0em'
}

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Conversation content font size in px (integer within {@link FONT_SIZE_MIN}..{@link FONT_SIZE_MAX}). */
  fontSize: number
  /** Selected Latin/digit font family. */
  latinFont: LatinFont
  /** Selected Chinese font family. */
  cjkFont: CjkFont
  /** Persisted Latin/digit weight (renders only for adjustable families). */
  latinWeight: number
  /** Persisted Chinese weight (renders only for adjustable families). */
  cjkWeight: number
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: z.number().step(1).min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).default(DEFAULT_FONT_SIZE),
  [LATIN_FONT_FIELD]: z.union([...LATIN_FONT_OPTIONS]).default(DEFAULT_LATIN_FONT),
  [CJK_FONT_FIELD]: z.union([...CJK_FONT_OPTIONS]).default(DEFAULT_CJK_FONT),
  [LATIN_WEIGHT_FIELD]: z.number().step(1).min(FONT_WEIGHT_MIN).max(FONT_WEIGHT_MAX).default(DEFAULT_LATIN_WEIGHT),
  [CJK_WEIGHT_FIELD]: z.number().step(1).min(FONT_WEIGHT_MIN).max(FONT_WEIGHT_MAX).default(DEFAULT_CJK_WEIGHT),
})

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}

/**
 * Narrow one wire or registry value to a persistable Latin/digit font.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a selectable Latin/digit font.
 */
export function isLatinFont(value: unknown): value is LatinFont {
  return LATIN_FONT_OPTIONS.some(option => option === value)
}

/**
 * Narrow one wire or registry value to a persistable Chinese font.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a selectable Chinese font.
 */
export function isCjkFont(value: unknown): value is CjkFont {
  return CJK_FONT_OPTIONS.some(option => option === value)
}

/** Rendered font-weight axes derived from one Latin/Chinese pairing and their persisted weights. */
export interface FontWeightAxes {
  /** Body and interface axis: the effective Chinese weight. */
  body: number
  /** Code and terminal axis: the effective Latin/digit weight. */
  code: number
}

/**
 * Resolve the rendered weight axes: body follows the Chinese family, code
 * follows the Latin/digit family (Windows Terminal single-weight behavior
 * per axis; fixed-weight families render 400 while their persisted value is
 * kept as memory for a later switch back).
 * @param latinFont - selected Latin/digit family.
 * @param latinWeight - persisted Latin/digit weight.
 * @param cjkFont - selected Chinese family.
 * @param cjkWeight - persisted Chinese weight.
 * @returns the body and code weights the presenter and boot script apply.
 */
export function fontWeightAxes(latinFont: string, latinWeight: number, cjkFont: string, cjkWeight: number): FontWeightAxes {
  return { body: effectiveCjkWeight(cjkFont, cjkWeight), code: effectiveLatinWeight(latinFont, latinWeight) }
}

/** CSS font stacks built from one Latin and one Chinese family. */
export interface FontStacks {
  /** Interface-text stack (labels, rows, dialogs). */
  ui: string
  /** Code and terminal stack (commands, diffs, tool output). */
  code: string
}

/**
 * Build the interface and code font stacks for one Latin/Chinese pairing.
 * Windows Terminal parity: the Latin family leads, the Chinese family
 * follows, then platform fallbacks. No bare monospace tail: on Windows it
 * resolves CJK to SimSun.
 * @param latinFont - selected Latin/digit family.
 * @param cjkFont - selected Chinese family.
 * @returns the ui and code CSS font-family values.
 */
export function fontStacks(latinFont: string, cjkFont: string): FontStacks {
  const latin = '\'' + latinFont + '\''
  const chain = [cjkFont].concat(CJK_FONT_OPTIONS.filter(option => option !== cjkFont))
  const cjk = chain.map(family => '\'' + family + '\'').join(', ')
  return {
    ui: latin + ', ' + cjk + ', -apple-system, BlinkMacSystemFont, \'Segoe UI\', \'PingFang SC\', \'Hiragino Sans GB\', \'Helvetica Neue\', Helvetica, Arial, sans-serif',
    code: latin + ', ' + cjk + ', Consolas, \'Liberation Mono\', Menlo, Courier, \'PingFang SC\'',
  }
}
