// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  MarketplacePluginsTab,
  type MarketplacePluginsTabProps,
} from '../src/client/MarketplacePluginsTab.tsx'
import { zh } from '../src/client/locales.ts'
import type { AgentLoopCardState } from '../src/client/agent-loop-card-controller.ts'
import type { BashCardState } from '../src/client/bash-card-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import type { SubagentModelSelectionCardState } from '../src/client/subagent-model-selection-card-controller.ts'
import type { WebSearchCardState } from '../src/client/web-search-card-controller.ts'

function shell(): CardShell {
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
  }
}

function field(text = ''): CardFieldState {
  return { text, overridden: false, invalid: false }
}

function bashState(overrides: Partial<BashCardState> = {}): BashCardState {
  return { ...shell(), timeoutMs: field('60000'), maxOutputBytes: field('1000'), ...overrides }
}

function agentLoopState(overrides: Partial<AgentLoopCardState> = {}): AgentLoopCardState {
  return { ...shell(), maxParallelToolCalls: field('4'), ...overrides }
}

function webSearchState(overrides: Partial<WebSearchCardState> = {}): WebSearchCardState {
  return {
    ...shell(),
    baseURL: field(''),
    maxUses: field(''),
    apiKey: field(''),
    apiKeyConfigured: false,
    apiKeyWritable: true,
    ...overrides,
  }
}

function subagentState(overrides: Partial<SubagentModelSelectionCardState> = {}): SubagentModelSelectionCardState {
  return {
    ...shell(),
    enabled: false,
    candidates: [],
    catalogStatus: 'idle',
    catalogPartial: false,
    conflicted: false,
    ...overrides,
  }
}

interface CardStates {
  bash: BashCardState
  agentLoop: AgentLoopCardState
  webSearch: WebSearchCardState
  subagent: SubagentModelSelectionCardState
}

function mount(states: Partial<CardStates> = {}) {
  const full: CardStates = {
    bash: bashState(),
    agentLoop: agentLoopState(),
    webSearch: webSearchState(),
    subagent: subagentState(),
    ...states,
  }
  const props = {
    useBash: (select: (state: BashCardState) => unknown) => select(full.bash),
    useAgentLoop: (select: (state: AgentLoopCardState) => unknown) => select(full.agentLoop),
    useWebSearch: (select: (state: WebSearchCardState) => unknown) => select(full.webSearch),
    useSubagent: (select: (state: SubagentModelSelectionCardState) => unknown) => select(full.subagent),
    t: makeTranslate(zh),
  } as unknown as MarketplacePluginsTabProps
  return render(<MarketplacePluginsTab {...props} />)
}

function rowButton(title: string): HTMLElement {
  const button = screen.getByText(title).closest('button')
  if (button === null) throw new Error(`expected a row button for ${title}`)
  return button
}

afterEach(() => {
  cleanup()
})

describe('MarketplacePluginsTab', () => {
  it('renders four browse rows with ready badges', () => {
    mount()
    for (const title of ['终端', 'Agent 循环', 'Subagent', '网页搜索']) {
      expect(screen.getByText(title)).toBeTruthy()
    }
    expect(screen.getAllByText('就绪')).toHaveLength(4)
  })

  it('derives one badge per card state', () => {
    mount({
      bash: bashState({ dirty: true }),
      agentLoop: agentLoopState({ saving: true }),
      webSearch: webSearchState({ failed: true }),
      subagent: subagentState({ available: false }),
    })
    expect(screen.getByText('有未保存的修改')).toBeTruthy()
    expect(screen.getByText('保存中…')).toBeTruthy()
    expect(screen.getByText('保存失败')).toBeTruthy()
    expect(screen.getByText('未提供')).toBeTruthy()
    expect(screen.queryByText('就绪')).toBeNull()
  })

  it('filters rows by the search query', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索插件' }), { target: { value: '终端' } })
    expect(screen.getByText('终端')).toBeTruthy()
    expect(screen.queryByText('网页搜索')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索插件' }), { target: { value: 'zzz' } })
    expect(screen.getByText('没有符合的插件')).toBeTruthy()
  })

  it('expands one row at a time into detail with configure guidance', () => {
    mount()
    fireEvent.click(rowButton('终端'))
    expect(screen.getByText('限制 agent 运行的每一条命令。')).toBeTruthy()
    expect(screen.getByText('前往“插件配置”分页调整')).toBeTruthy()
    fireEvent.click(rowButton('网页搜索'))
    expect(screen.queryByText('限制 agent 运行的每一条命令。')).toBeNull()
    expect(screen.getByText('DeepSeek 搜索提供方。')).toBeTruthy()
    fireEvent.click(rowButton('网页搜索'))
    expect(screen.queryByText('DeepSeek 搜索提供方。')).toBeNull()
  })

  it('reports live subagent and credential states in detail', () => {
    mount({ subagent: subagentState({ enabled: true }), webSearch: webSearchState({ apiKeyConfigured: true }) })
    fireEvent.click(rowButton('Subagent'))
    expect(screen.getByText('已启用')).toBeTruthy()
    fireEvent.click(rowButton('网页搜索'))
    expect(screen.getByText('已配置密钥')).toBeTruthy()
  })

  it('reports disabled subagents and missing keys in detail', () => {
    mount()
    fireEvent.click(rowButton('Subagent'))
    expect(screen.getByText('已停用')).toBeTruthy()
    fireEvent.click(rowButton('网页搜索'))
    expect(screen.getByText('未配置密钥')).toBeTruthy()
  })
})
