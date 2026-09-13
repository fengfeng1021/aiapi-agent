// @vitest-environment jsdom
/** FontSection behavior: both selector rows render, menus drive the font writes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { FontSection } from '../src/client/FontSection.tsx'
import type { FontSectionComponentProps } from '../src/client/FontSection.tsx'
import { createFontSectionStore } from '../src/client/settings-store.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'font.latin.title': 'Latin & digits',
  'font.latin.description': 'Font for code, commands and Latin text',
  'font.latin.preview': 'latin preview Aa 0123',
  'font.cjk.title': 'Chinese',
  'font.cjk.description': 'Font for Chinese text',
  'font.cjk.preview': 'chinese preview 0123',
  'font.weight.title': 'Weight',
  'font.weight.label': 'Adjust font weight',
  'font.note': 'weight note',
}

function mount(
  latin: 'Cascadia Mono' | 'Noto Sans Mono' = 'Cascadia Mono',
  cjk: 'Microsoft YaHei UI' | 'Maple Mono CN' = 'Microsoft YaHei UI',
  latinWeight = 400,
  cjkWeight = 500,
) {
  // Real store instance - the sanctioned zero-machinery path for tests.
  const store = createFontSectionStore().create()
  store.actions.sync(latin, cjk, latinWeight, cjkWeight, 0)
  const setLatinFont = vi.fn()
  const setCjkFont = vi.fn()
  const setLatinWeight = vi.fn()
  const setCjkWeight = vi.fn()
  const props = {
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setLatinFont,
    setCjkFont,
    setLatinWeight,
    setCjkWeight,
  } as unknown as FontSectionComponentProps
  render(<FontSection {...props} />)
  return { store, setLatinFont, setCjkFont, setLatinWeight, setCjkWeight }
}

describe('FontSection', () => {
  it('renders both selector rows with current values and the note', () => {
    mount()
    expect(screen.getByText('Latin & digits')).toBeDefined()
    expect(screen.getByText('Font for code, commands and Latin text')).toBeDefined()
    expect(screen.getByText('Chinese')).toBeDefined()
    expect(screen.getByText('Font for Chinese text')).toBeDefined()
    expect(screen.getByRole('button', { name: /Cascadia Mono/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Microsoft YaHei UI/ })).toBeDefined()
    expect(screen.getByText('weight note')).toBeDefined()
  })

  it('opens the Latin menu, selects, and closes', () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: /Cascadia Mono/ })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cascadia Mono' }))
    expect(b.setLatinFont).toHaveBeenCalledWith('Cascadia Mono')
    expect(b.setCjkFont).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the Chinese menu, selects, and closes', () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: /Microsoft YaHei UI/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Microsoft YaHei UI' }))
    expect(b.setCjkFont).toHaveBeenCalledWith('Microsoft YaHei UI')
    expect(b.setLatinFont).not.toHaveBeenCalled()
  })

  it('follows store changes', () => {
    const b = mount()
    act(() => { b.store.actions.sync('Noto Sans Mono', 'Maple Mono CN', 700, 600, 1) })
    expect(screen.getByRole('button', { name: /Maple Mono CN/ })).toBeDefined()
    expect(screen.getAllByRole('slider')).toHaveLength(2)
  })

  it('renders a live preview swatch per family', () => {
    mount()
    const latinPreview = screen.getByText('latin preview Aa 0123')
    expect(latinPreview.style.fontFamily).toContain('Cascadia Mono')
    const cjkPreview = screen.getByText('chinese preview 0123')
    expect(cjkPreview.style.fontFamily).toContain('Microsoft YaHei UI')
  })

  it('shows no weight slider for fixed-weight families', () => {
    mount()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('shows a weight slider per adjustable family and routes changes', () => {
    const b = mount('Noto Sans Mono', 'Maple Mono CN', 700, 600)
    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(2)
    expect((sliders[0] as HTMLInputElement).value).toBe('700')
    expect((sliders[1] as HTMLInputElement).value).toBe('600')
    expect(screen.getByText('700')).toBeDefined()
    expect(screen.getByText('600')).toBeDefined()
    fireEvent.change(sliders[0]!, { target: { value: '800' } })
    expect(b.setLatinWeight).toHaveBeenCalledWith(800)
    expect(b.setCjkWeight).not.toHaveBeenCalled()
    fireEvent.change(sliders[1]!, { target: { value: '650' } })
    expect(b.setCjkWeight).toHaveBeenCalledWith(650)
  })
})
