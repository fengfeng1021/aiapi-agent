// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjection } from '../src/boot-theme.ts'
import type { CjkFont, LatinFont, ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(
  preference?: ThemePreference,
  fontSize?: number,
  latinFont?: LatinFont,
  cjkFont?: CjkFont,
  latinWeight?: number,
  cjkWeight?: number,
): void {
  const row = bootThemeInjection(preference, fontSize, latinFont, cjkFont, latinWeight, cjkWeight)
  if (row.kind !== 'script') throw new Error('theme bootstrap row is not a script')
  runInNewContext(row.text, { document, matchMedia: globalThis.matchMedia })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('color-scheme')
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.style.removeProperty('--dsh-content-font-size')
  document.body.style.removeProperty('--dsw-font-family')
  document.body.style.removeProperty('--ds-font-family-code')
  document.body.style.removeProperty('--dsw-font-weight')
  document.body.style.removeProperty('--ds-font-weight-code')
  document.body.style.removeProperty('--dsh-cjk-letter-spacing')
})

describe('theme bootstrap row', () => {
  it('is a body script row, so it runs before the shell mount', () => {
    mockSystemDark(false)
    const row = bootThemeInjection('dark')
    expect(row).toMatchObject({ kind: 'script', placement: 'body' })
    executeBootstrap('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    executeBootstrap('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, 'dark', true],
    [false, 'light', false],
  ] as const)('resolves system=%s to %s', (matches, colorScheme, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.style.colorScheme).toBe(colorScheme)
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the Windows Terminal font stacks and defaults them', () => {
    mockSystemDark(false)
    executeBootstrap('light', 14, 'Cascadia Mono', 'Microsoft YaHei UI')
    expect(document.body.style.getPropertyValue('--dsw-font-family')).toContain('Cascadia Mono')
    expect(document.body.style.getPropertyValue('--dsw-font-family')).toContain('Microsoft YaHei UI')
    expect(document.body.style.getPropertyValue('--ds-font-family-code')).toContain('Cascadia Mono')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsw-font-family')).toContain('Cascadia Mono')
  })

  it('writes the rendered weight axes and defaults them to 400', () => {
    mockSystemDark(false)
    executeBootstrap('light', 14, 'Noto Sans Mono', 'Maple Mono CN', 700, 600)
    expect(document.body.style.getPropertyValue('--dsw-font-weight')).toBe('600')
    expect(document.body.style.getPropertyValue('--ds-font-weight-code')).toBe('700')
    expect(document.body.style.getPropertyValue('--dsh-cjk-letter-spacing')).toBe('0em')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsw-font-weight')).toBe('400')
    expect(document.body.style.getPropertyValue('--ds-font-weight-code')).toBe('400')
    expect(document.body.style.getPropertyValue('--dsh-cjk-letter-spacing')).toBe('0em')
  })

  it('writes the durable content font size and defaults it to 14px', () => {
    mockSystemDark(false)
    executeBootstrap('light', 17)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('17px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
  })
})
