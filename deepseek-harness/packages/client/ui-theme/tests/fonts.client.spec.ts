/**
 * CJK-gated Maple Mono CN faces: every Maple @font-face in fonts.css covers
 * only Chinese (unicode-range), so Latin and digits keep their own face and
 * advance untouched. Narrowing lives inside the font files (hmtx 1200->1000,
 * outlines untouched), never as CSS size-adjust: shrinking via size-adjust
 * also shrinks the glyphs, which is what this closes.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Expected static Maple Mono CN weights matching the weight slider window. */
const MAPLE_WEIGHTS = ['400', '500', '600', '700']

/** One @font-face block: family plus its declaration map. */
interface FontFace {
  family: string
  declarations: Map<string, string>
}

const fontsCss = readFileSync(fileURLToPath(new URL('../src/styles/fonts.css', import.meta.url)), 'utf8')

/**
 * Parse every @font-face block out of a stylesheet.
 * @param css - stylesheet text.
 * @returns one entry per @font-face block, in source order.
 */
function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = []
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, body = ''] of withoutComments.matchAll(/@font-face\s*\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>()
    for (const part of body.split(';')) {
      const trimmed = part.trim()
      if (!trimmed.includes(':')) continue
      const colon = trimmed.indexOf(':')
      declarations.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim())
    }
    faces.push({ family: declarations.get('font-family') ?? '', declarations })
  }
  return faces
}

describe('bundled font faces', () => {
  it('gates every Maple Mono CN face to CJK without shrinking the glyphs', () => {
    const maple = parseFontFaces(fontsCss).filter(face => face.family === '\'Maple Mono CN\'')
    expect(maple.map(face => face.declarations.get('font-weight'))).toEqual(MAPLE_WEIGHTS)
    for (const face of maple) {
      expect(face.declarations.has('size-adjust')).toBe(false)
      const range = face.declarations.get('unicode-range') ?? ''
      expect(range).toContain('U+4E00-9FFF')
      expect(range).not.toContain('U+0000-00FF')
      expect(range).not.toContain('FF61')
    }
  })

  it('leaves the Latin faces ungated and unscaled', () => {
    const latin = parseFontFaces(fontsCss).filter(face => face.family === '\'Noto Sans Mono\'')
    expect(latin.length).toBeGreaterThan(0)
    for (const face of latin) {
      expect(face.declarations.has('size-adjust')).toBe(false)
    }
  })
})
