// @vitest-environment jsdom
/**
 * Inline projection of sent user text: decoration never breaks a single-line
 * message (bubble regression), and wire session forms fold to their label
 * (queue-row readability).
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { projectUserText, splitUserFileRefs } from '../src/user-text.tsx'

const project = (text: string, labels: readonly string[] = []) =>
  render(<div data-host>{projectUserText(text, labels)}</div>).container.querySelector('[data-host]')!

describe('projectUserText', () => {
  it('keeps a decorated single-line message on one line: every part is inline', () => {
    const host = project('反反复复 /dsh-acp-test @执行几个命令测试', ['执行几个命令测试'])
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.textContent).toBe('反反复复 /dsh-acp-test 执行几个命令测试')
    const chips = host.querySelectorAll('[data-ref-chip]')
    expect([...chips].map(c => c.getAttribute('data-ref-chip'))).toEqual(['skill', 'session'])
    // The whitespace between tokens survives as its own inline run.
    const runs = [...host.querySelectorAll('span')].filter(s => !s.hasAttribute('data-ref-chip') && s.closest('[data-ref-chip]') === null)
    expect(runs.map(r => r.textContent)).toEqual(['反反复复 ', ' '])
  })

  it('folds the wire session form to its label with the session glyph', () => {
    const host = project('看看 @[查看并分析图片](dsh-session:InNlc3Npb24tNDM0) 的结论')
    const chip = host.querySelector('[data-ref-chip="session"]')!
    expect(chip.textContent).toBe('查看并分析图片')
    expect(chip.getAttribute('title')).toBe('@[查看并分析图片](dsh-session:InNlc3Npb24tNDM0)')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(host.textContent).toBe('看看 查看并分析图片 的结论')
  })

  it('prefers the wire fold over the bare-token scan on the same range', () => {
    const host = project('@[a](dsh-session:x)', [])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(1)
    expect(host.querySelector('[data-ref-chip="session"]')!.textContent).toBe('a')
  })

  it('decorates recall-associated labels, files, folders, and quoted paths', () => {
    const host = project('@会话一 说 @src/deep/file.txt 与 @dir/ 与 @"a b.md"', ['会话一'])
    const kinds = [...host.querySelectorAll('[data-ref-chip]')].map(c =>
      [c.getAttribute('data-ref-chip'), c.textContent])
    expect(kinds).toEqual([
      ['session', '会话一'],
      ['file', 'file.txt'],
      ['folder', 'dir'],
      ['file', 'a b.md'],
    ])
  })

  it('repeated recall labels decorate every occurrence once', () => {
    const host = project('@再看 前情 @再看', ['再看', '再看'])
    expect(host.querySelectorAll('[data-ref-chip="session"]').length).toBe(2)
  })

  it('strips trailing punctuation and skips degenerate tokens', () => {
    const host = project('用 /plan。 试试 @。')
    const chips = [...host.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(c => c.textContent)).toEqual(['/plan'])
    expect(host.textContent).toBe('用 /plan。 试试 @。')
  })

  it('prefers the longer recall label when one nests inside another', () => {
    const host = project('@会话一 收尾', ['会话', '会话一'])
    const chips = [...host.querySelectorAll('[data-ref-chip="session"]')]
    expect(chips.map(c => c.textContent)).toEqual(['会话一'])
    expect(host.textContent).toBe('会话一 收尾')
  })

  it('falls back to the raw quoted label when the path has no basename', () => {
    const host = project('看 @"/" 下面')
    const chip = host.querySelector('[data-ref-chip="file"]')!
    expect(chip.textContent).toBe('"/"')
  })

  it('renders undecorated text as one inline run', () => {
    const host = project('纯文本，无引用')
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe('纯文本，无引用')
  })
})

describe('splitUserFileRefs', () => {
  it('lifts submit-appended absolute-path lines out of the text in order', () => {
    expect(splitUserFileRefs('檔名是什麼\n@C:\\dropped\\a.json\n@/home/user/b.json')).toEqual({
      text: '檔名是什麼',
      files: [
        { path: 'C:\\dropped\\a.json', name: 'a.json' },
        { path: '/home/user/b.json', name: 'b.json' },
      ],
    })
  })

  it('keeps prose, relative mentions, and typed paths in the text', () => {
    expect(splitUserFileRefs('看看 @src/main.ts 與 @foo')).toEqual({
      text: '看看 @src/main.ts 與 @foo',
      files: [],
    })
  })

  it('returns empty text for a message that is only references', () => {
    expect(splitUserFileRefs('@\\\\server\\share\\c.json')).toEqual({
      text: '',
      files: [{ path: '\\\\server\\share\\c.json', name: 'c.json' }],
    })
  })
})

describe('projectUserText links, code, and hashes', () => {
  it('linkifies a bare url as a safe external link', () => {
    const host = project('打开 http://127.0.0.1:8081/?token=abc 看看', [])
    const anchor = host.querySelector('a')!
    expect(anchor.getAttribute('href')).toBe('http://127.0.0.1:8081/?token=abc')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noreferrer noopener')
    expect(anchor.textContent).toBe('http://127.0.0.1:8081/?token=abc')
    expect(host.textContent).toBe('打开 http://127.0.0.1:8081/?token=abc 看看')
  })

  it('strips trailing sentence punctuation from urls', () => {
    const host = project('去 http://x/y。', [])
    expect(host.querySelector('a')!.getAttribute('href')).toBe('http://x/y')
    expect(host.textContent).toBe('去 http://x/y。')
  })

  it('renders backtick spans as code and never as links', () => {
    const host = project('用 `curl http://x/` 试试', [])
    expect(host.querySelectorAll('a').length).toBe(0)
    const code = host.querySelector('code')!
    expect(code.textContent).toBe('curl http://x/')
    expect(host.textContent).toBe('用 curl http://x/ 试试')
  })

  it('highlights hex hashes but leaves ordinary words alone', () => {
    const host = project('更新 6456c07df 成功，man main 不变', [])
    const codes = [...host.querySelectorAll('code')]
    expect(codes.map(c => c.textContent)).toEqual(['6456c07df'])
    expect(host.textContent).toBe('更新 6456c07df 成功，man main 不变')
  })
})
