// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  SkillsFooterAction,
  type SkillCatalogResult,
  type SkillsFooterActionProps,
} from '../src/client/SkillsFooterAction.tsx'
import { zh } from '../src/client/locales.ts'

const SKILLS: SkillEntry[] = [
  { name: 'commit-helper', description: 'Commit flow.', whenToUse: 'reviews', modelInvocable: true },
  { name: 'deploy', description: 'Deploy flow.', modelInvocable: true },
  { name: 'flat-note', description: 'Flat note.', whenToUse: '', modelInvocable: true },
  { name: 'user-only-skill', description: 'User surface only.', modelInvocable: false },
]

const OK: SkillCatalogResult = { ok: true, value: { skills: SKILLS } }

type ListSkills = SkillsFooterActionProps['listSkills']

function mount({ wide = true, current = 's1', noSession = false, listSkills }: {
  wide?: boolean
  current?: string
  noSession?: boolean
  listSkills: ListSkills
}) {
  const session = noSession ? undefined : (current as SessionId | undefined)
  const useSessions = <T,>(select: (value: { current: SessionId | undefined }) => T): T => select({
    current: session,
  })
  const props = {
    wide,
    useSessions,
    listSkills,
    t: makeTranslate(zh),
  } as unknown as SkillsFooterActionProps
  return render(<SkillsFooterAction {...props} />)
}

function openPanel(listSkills: ListSkills) {
  mount({ listSkills })
  fireEvent.click(screen.getByRole('button', { name: '外掛程式' }))
  return screen.getByRole('dialog', { name: '外掛程式' })
}

const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SkillsFooterAction marketplace', () => {
  it('opens the panel with the title, count, skill rows, and plugins signpost', async () => {
    const listSkills = vi.fn<ListSkills>(async () => OK)
    const dialog = openPanel(listSkills)
    expect(dialog.textContent).toContain('外掛程式')
    expect(await screen.findByText('4 个技能')).toBeTruthy()
    for (const skill of SKILLS) {
      expect(screen.getByText(skill.name)).toBeTruthy()
    }
    expect(screen.getByText('外掛程式在「设置 → 插件」中管理')).toBeTruthy()
    expect(listSkills).toHaveBeenCalledTimes(1)
  })

  it('renders icon-only on the rail and toggles closed', async () => {
    const listSkills = vi.fn<ListSkills>(async () => OK)
    mount({ wide: false, listSkills })
    expect(screen.queryByText('外掛程式')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '外掛程式' }))
    expect(await screen.findByText('外掛程式')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '外掛程式' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows loading while the catalog is in flight', () => {
    let release!: (value: SkillCatalogResult) => void
    const gate = new Promise<SkillCatalogResult>((resolve) => {
      release = resolve
    })
    const listSkills = vi.fn<ListSkills>(() => gate)
    openPanel(listSkills)
    expect(screen.getByText('正在加载技能…')).toBeTruthy()
    release(OK)
  })

  it('shows the error state and retries into the list', async () => {
    const listSkills = vi.fn<ListSkills>(async () => OK)
    listSkills.mockResolvedValueOnce({
      ok: false,
      error: { code: 'gateway/internal', message: 'boom' },
    } as SkillCatalogResult)
    openPanel(listSkills)
    expect(await screen.findByText('技能目录读取失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('4 个技能')).toBeTruthy()
    expect(listSkills).toHaveBeenCalledTimes(2)
  })

  it('shows the error state when the fetch rejects', async () => {
    const listSkills = vi.fn<ListSkills>(async () => OK)
    listSkills.mockRejectedValueOnce(new Error('boom'))
    openPanel(listSkills)
    expect(await screen.findByText('技能目录读取失败')).toBeTruthy()
  })

  it('skips the fetch without a current session', () => {
    const listSkills = vi.fn<ListSkills>(async () => OK)
    mount({ listSkills, noSession: true })
    fireEvent.click(screen.getByRole('button', { name: '外掛程式' }))
    expect(screen.getByText('开始一个会话后即可浏览技能')).toBeTruthy()
    expect(listSkills).not.toHaveBeenCalled()
  })

  it('filters rows by the search query', async () => {
    openPanel(async () => OK)
    await screen.findByText('4 个技能')
    fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), { target: { value: 'deploy' } })
    expect(screen.getByRole('button', { name: 'deploy' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'commit-helper' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), { target: { value: 'zzz' } })
    expect(screen.getByText('没有符合的技能')).toBeTruthy()
  })

  it('expands rows into detail with policy and guidance lines', async () => {
    openPanel(async () => OK)
    await screen.findByText('4 个技能')
    fireEvent.click(screen.getByRole('button', { name: 'commit-helper' }))
    expect(screen.getByText('使用时机: reviews')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'deploy' }))
    expect(screen.getByText('模型可用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'flat-note' }))
    expect(screen.getAllByText('模型可用')[1]).toBeTruthy()
    expect(screen.getByText('仅用户')).toBeTruthy()
    const userRow = screen.getByText('user-only-skill').closest('button')
    if (userRow === null) throw new Error('expected the user-only row button')
    fireEvent.click(userRow)
    expect(screen.getByText('仅用户可用')).toBeTruthy()
  })

  it('copies the invoke text and the description', async () => {
    openPanel(async () => OK)
    await screen.findByText('4 个技能')
    fireEvent.click(screen.getByRole('button', { name: 'deploy' }))
    fireEvent.click(screen.getByRole('button', { name: '复制调用' }))
    expect(writeText).toHaveBeenCalledWith('/deploy ')
    expect(await screen.findAllByText('已复制')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '复制描述' }))
    expect(writeText).toHaveBeenCalledWith('Deploy flow.')
  })

  it('composes an installer prompt from the creator box', async () => {
    openPanel(async () => OK)
    await screen.findByText('4 个技能')
    const add = screen.getByRole('button', { name: '新增' })
    expect(add.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '新增 skill' }), { target: { value: 'my helper' } })
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    expect(writeText).toHaveBeenCalledWith('/skill-installer my helper')
    expect(await screen.findByText('复制后粘贴到对话框发送')).toBeTruthy()
    expect(await screen.findByText('已复制')).toBeTruthy()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    openPanel(async () => OK)
    await screen.findByText('4 个技能')
    const dialog = screen.getByRole('dialog', { name: '外掛程式' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: '外掛程式' })).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '外掛程式' }))
  })

  it('leaves the idle label when the clipboard refuses the write', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    openPanel(async () => OK)
    await screen.findByText('4 个技能')
    fireEvent.click(screen.getByRole('button', { name: 'deploy' }))
    fireEvent.click(screen.getByRole('button', { name: '复制调用' }))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('/deploy ')
    })
    expect(screen.queryByText('已复制')).toBeNull()
  })

  it('drops a late rejection after unmount without updating state', async () => {
    let reject!: (reason: unknown) => void
    const gate = new Promise<SkillCatalogResult>((_resolve, rejectGate) => {
      reject = rejectGate
    })
    const listSkills = vi.fn<ListSkills>(() => gate)
    const view = mount({ listSkills })
    fireEvent.click(screen.getByRole('button', { name: '外掛程式' }))
    view.unmount()
    reject(new Error('late'))
    await gate.catch(() => {})
    expect(listSkills).toHaveBeenCalledTimes(1)
  })

  it('drops a late resolution after unmount without updating state', async () => {
    let resolve!: (value: SkillCatalogResult) => void
    const gate = new Promise<SkillCatalogResult>((resolveGate) => {
      resolve = resolveGate
    })
    const listSkills = vi.fn<ListSkills>(() => gate)
    const view = mount({ listSkills })
    fireEvent.click(screen.getByRole('button', { name: '外掛程式' }))
    view.unmount()
    resolve(OK)
    await gate
    expect(listSkills).toHaveBeenCalledTimes(1)
  })
})
