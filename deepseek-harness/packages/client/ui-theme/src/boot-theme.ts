/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference and content font size;
 * the browser resolves only `system`, then writes the same DOM fields
 * ui-layout's ThemePresenter owns after the client plugin tree activates.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_CJK_FONT, DEFAULT_CJK_WEIGHT, DEFAULT_FONT_SIZE, DEFAULT_LATIN_FONT, DEFAULT_LATIN_WEIGHT,
  DEFAULT_PREFERENCE, cjkLetterSpacing, fontStacks, fontWeightAxes, type CjkFont, type LatinFont, type ThemePreference,
} from './theme-settings.ts'

/** Build the inline script body for one schema-validated durable theme section. */
function bootThemeScript(
  preference: ThemePreference, fontSize: number, latinFont: LatinFont, cjkFont: CjkFont,
  latinWeight: number, cjkWeight: number,
): string {
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const stacks = ${JSON.stringify(fontStacks(latinFont, cjkFont))}
  const spacing = ${JSON.stringify(cjkLetterSpacing(cjkFont))}
  const weights = ${JSON.stringify(fontWeightAxes(latinFont, latinWeight, cjkFont, cjkWeight))}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', ${JSON.stringify(`${fontSize}px`)})
  document.body.style.setProperty('--dsw-font-family', stacks.ui)
  document.body.style.setProperty('--ds-font-family-code', stacks.code)
  document.body.style.setProperty('--dsw-font-weight', String(weights.body))
  document.body.style.setProperty('--ds-font-weight-code', String(weights.code))
  document.body.style.setProperty('--dsh-cjk-letter-spacing', spacing)
})()`
}

/**
 * The theme bootstrap as an injection row: an inline script immediately after
 * the opening body tag, before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSize - Current Host-backed content font size in px.
 * @returns the body script row.
 */
export function bootThemeInjection(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_FONT_SIZE,
  latinFont: LatinFont = DEFAULT_LATIN_FONT,
  cjkFont: CjkFont = DEFAULT_CJK_FONT,
  latinWeight: number = DEFAULT_LATIN_WEIGHT,
  cjkWeight: number = DEFAULT_CJK_WEIGHT,
): IndexInjection {
  return { kind: 'script', placement: 'body', text: bootThemeScript(preference, fontSize, latinFont, cjkFont, latinWeight, cjkWeight) }
}
