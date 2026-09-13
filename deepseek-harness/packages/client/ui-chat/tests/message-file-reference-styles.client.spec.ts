/**
 * Dropped-file presentation in the user turn: submit appends `@path` lines,
 * so the bubble keeps the prose and each extracted file gets its own bubble
 * whose long basename wraps inside its own width. jsdom has no layout, so the
 * spec reads the declarations that enforce both halves.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/chat/MessageItem.module.css', import.meta.url)),
  'utf8',
)

function declarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const rule = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(
    css.replace(/\/\*[\s\S]*?\*\//gu, ' '),
  )
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('user turn file presentation', () => {
  it('gives each dropped file its own wrapping bubble', () => {
    expect(declarations('.fileBubble')).toEqual(expect.arrayContaining([
      'background: var(--dsw-specific-bubble)',
      'overflow-wrap: anywhere',
    ]))
    expect(css).toContain('.fileBubbleIcon')
  })

  it('wraps typed file mentions at any character without overflowing the bubble', () => {
    const selector = ".bubble [data-ref-chip='file'],\n.bubble [data-ref-chip='folder']"
    expect(declarations(selector)).toEqual(expect.arrayContaining([
      'white-space: normal',
      'overflow-wrap: anywhere',
    ]))
  })
})
