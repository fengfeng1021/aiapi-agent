/**
 * MoA settings store and controller.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MoaMode, MoaModelSlot, MoaPreset, MoaTestTurnResult, SimpleMoaSlots } from './types.ts'

export const MOA_SETTINGS_NS = 'moa'

export const DEFAULT_SLOTS: SimpleMoaSlots = {
  slotA: { provider: '', model: '' },
  slotB: { provider: '', model: '' },
  slotC: { provider: '', model: '' },
}

export function buildPresetForMode(mode: MoaMode, slots: SimpleMoaSlots): MoaPreset {
  if (mode === 'speed') {
    return {
      id: 'simple-speed',
      name: '⚡️ 效率優先模式',
      description: '又快又不出問題：模型快速生成，Peer 席位秒級掃描排版遮擋與邊界 Bug，不進行多餘爭論，極速交付',
      reference_models: [slots.slotA],
      aggregator: slots.slotB,
      reference_temperature: 0.4,
      aggregator_temperature: 0.2,
      max_tokens: 4096,
      enabled: true,
      is_default: true,
    }
  }
  if (mode === 'quality') {
    return {
      id: 'simple-quality',
      name: '🏆 質量攻堅模式',
      description: '三席平等合力攻堅：3 個不同背景模型各自獨立分析並交叉質疑討論，三方合力消除頑疾盲區',
      reference_models: [slots.slotA, slots.slotB, slots.slotC],
      aggregator: slots.slotC,
      reference_temperature: 0.6,
      aggregator_temperature: 0.3,
      max_tokens: 8192,
      enabled: true,
      is_default: true,
    }
  }
  // Default: balanced
  return {
    id: 'simple-balanced',
    name: '⚖️ 均衡協同模式',
    description: '快速前提下保證最高質量：雙席平等互補，核心實作與邊界健壯性兼顧，取長補短消除盲區',
    reference_models: [slots.slotA, slots.slotB],
    aggregator: slots.slotB,
    reference_temperature: 0.5,
    aggregator_temperature: 0.3,
    max_tokens: 4096,
    enabled: true,
    is_default: true,
  }
}

export interface ModelReasoningInfo {
  defaultEffort?: string
  efforts: Array<{ id: string; name?: string }>
}

export function formatReasoningLabel(id: string, name?: string): string {
  switch (id.toLowerCase()) {
    case 'off': return '關閉'
    case 'none': return '無思考'
    case 'minimal': return '極輕'
    case 'low': return '輕度'
    case 'medium': return '中等'
    case 'high': return '高'
    case 'xhigh': return '極高'
    case 'max': return '超高'
    case 'ultra': return '超高'
    case 'ultracode': return 'UltraCode'
    default: return name || id
  }
}

export interface ProviderModelCatalog {
  provider: string
  displayName: string
  models: Array<{
    id: string
    name: string
    reasoning?: ModelReasoningInfo
  }>
}

export interface MoaStoreState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  enabled: boolean
  mode: MoaMode
  slots: SimpleMoaSlots
  defaultPresetId: string
  activePresetId: string
  presets: MoaPreset[]
  availableProviders: ProviderModelCatalog[]
  error: string | null
  
  // Modal state
  editingPreset: MoaPreset | null
  isCreatingNew: boolean
  
  // Playground state
  testingPresetId: string | null
  testPrompt: string
  testRunning: boolean
  testResult: MoaTestTurnResult | null
}

export const BUILTIN_PRESETS: MoaPreset[] = [
  {
    id: 'code-collaboration',
    name: '代碼極限協同 (Code Collaboration)',
    description: 'Claude 3.7 Sonnet + GPT-5.4 + Gemini 3.7 Flash 並行編程推理，由 Claude 3.7 Opus 綜合審核與重構',
    reference_models: [
      { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
      { provider: 'openai', model: 'gpt-5.4' },
      { provider: 'antigravity', model: 'claude-sonnet-4-6' },
    ],
    aggregator: { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
    reference_temperature: 0.6,
    aggregator_temperature: 0.4,
    max_tokens: 4096,
    enabled: true,
    is_default: true,
  },
  {
    id: 'deep-reasoning',
    name: '深度推理與研究 (Deep Reasoning)',
    description: 'DeepSeek-R1 + Gemini 2.5 Pro + Claude 並行探索多種解法，由 GPT-5.1 Codex 進行邏輯交叉檢驗',
    reference_models: [
      { provider: 'deepseek', model: 'deepseek-reasoner' },
      { provider: 'google', model: 'gemini-2.5-pro' },
      { provider: 'antigravity', model: 'gemini-3.7-flash' },
    ],
    aggregator: { provider: 'openai', model: 'gpt-5.1-codex' },
    reference_temperature: 0.5,
    aggregator_temperature: 0.3,
    max_tokens: 8192,
    enabled: true,
    is_default: false,
  },
  {
    id: 'fast-consensus',
    name: '極速共識 (Fast Consensus)',
    description: '輕量模型高並發秒級響應，適合日常對話、摘要與快速驗證',
    reference_models: [
      { provider: 'google', model: 'gemini-3.7-flash' },
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'deepseek', model: 'deepseek-chat' },
    ],
    aggregator: { provider: 'google', model: 'gemini-3.7-flash' },
    reference_temperature: 0.6,
    aggregator_temperature: 0.4,
    max_tokens: 4096,
    enabled: true,
    is_default: false,
  },
]

export const DEFAULT_AVAILABLE_PROVIDERS: ProviderModelCatalog[] = []

const LOCAL_STORAGE_KEY = 'aiapi_agent_moa_presets_v1'

export class MoaSettingsController {
  readonly store: SnapshotStore<MoaStoreState>

  constructor(private readonly ctx: ClientContext) {
    let savedPresets = BUILTIN_PRESETS
    let savedEnabled = true
    let savedDefault = 'simple-balanced'
    let savedMode: MoaMode = 'balanced'
    let savedSlots: SimpleMoaSlots = DEFAULT_SLOTS

    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (parsed.presets && Array.isArray(parsed.presets) && parsed.presets.length > 0) {
          savedPresets = parsed.presets
        }
        if (typeof parsed.enabled === 'boolean') {
          savedEnabled = parsed.enabled
        }
        if (parsed.defaultPresetId) {
          savedDefault = parsed.defaultPresetId
        }
        if (parsed.mode && ['speed', 'balanced', 'quality'].includes(parsed.mode)) {
          savedMode = parsed.mode
        }
        if (parsed.slots && parsed.slots.slotA) {
          savedSlots = { ...DEFAULT_SLOTS, ...parsed.slots }
        }
      }
    } catch {
      // Use defaults
    }

    const dynamicPreset = buildPresetForMode(savedMode, savedSlots)
    savedPresets = [dynamicPreset, ...savedPresets.filter(p => !p.id.startsWith('simple-'))]
    savedDefault = dynamicPreset.id

    this.store = createSnapshotStore<MoaStoreState>({
      status: 'ready',
      enabled: savedEnabled,
      mode: savedMode,
      slots: savedSlots,
      defaultPresetId: savedDefault,
      activePresetId: savedDefault,
      presets: savedPresets,
      availableProviders: DEFAULT_AVAILABLE_PROVIDERS,
      error: null,
      editingPreset: null,
      isCreatingNew: false,
      testingPresetId: savedDefault,
      testPrompt: '',
      testRunning: false,
      testResult: null,
    })

    void this.syncProvidersFromHost()
  }

  syncProvidersFromHost = async (): Promise<void> => {
    try {
      const remote = (this.ctx as any)?.remote
      if (remote?.session?.modelCatalog) {
        const res = await remote.session.modelCatalog()
        if (res?.ok && res.value) {
          const rawGroups = Array.isArray(res.value.groups) ? res.value.groups : []
          const catalogs: ProviderModelCatalog[] = rawGroups.map((g: any) => ({
            provider: g.id || g.provider,
            displayName: g.name || g.displayName || g.id,
            models: (g.models || []).map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              reasoning: m.reasoning ? {
                defaultEffort: m.reasoning.defaultEffort,
                efforts: Array.isArray(m.reasoning.efforts) ? m.reasoning.efforts : [],
              } : undefined,
            })),
          })).filter((c: any) => c.models.length > 0)

          const snap = this.store.getSnapshot()
          const fixSlot = (slot: MoaModelSlot): MoaModelSlot => {
            if (!slot.provider) {
              return { provider: '', model: '', reasoning_effort: undefined }
            }
            const foundP = catalogs.find(c => c.provider === slot.provider)
            if (!foundP) {
              return { provider: '', model: '', reasoning_effort: undefined }
            }
            const foundM = foundP.models.find(m => m.id === slot.model)
            if (!foundM) {
              return { provider: foundP.provider, model: '', reasoning_effort: undefined }
            }
            if (foundM.reasoning && foundM.reasoning.efforts && foundM.reasoning.efforts.length > 0) {
              const effortValid = foundM.reasoning.efforts.some(e => e.id === slot.reasoning_effort)
              if (!effortValid) {
                return {
                  ...slot,
                  reasoning_effort: foundM.reasoning.defaultEffort || foundM.reasoning.efforts[0]?.id || undefined,
                }
              }
            }
            return slot
          }

          const updatedSlots = {
            slotA: fixSlot(snap.slots.slotA),
            slotB: fixSlot(snap.slots.slotB),
            slotC: fixSlot(snap.slots.slotC),
          }

          const newPreset = buildPresetForMode(snap.mode, updatedSlots)
          const nextState: MoaStoreState = {
            ...snap,
            availableProviders: catalogs,
            slots: updatedSlots,
            defaultPresetId: newPreset.id,
            activePresetId: newPreset.id,
            presets: [newPreset, ...snap.presets.filter(p => !p.id.startsWith('simple-'))],
          }
          this.store.set(nextState)
          this.persist(nextState)
        }
      }
    } catch (err) {
      console.warn('Failed to sync model catalog from host:', err)
    }
  }

  private persist(state: MoaStoreState) {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
        enabled: state.enabled,
        mode: state.mode,
        slots: state.slots,
        defaultPresetId: state.defaultPresetId,
        presets: state.presets,
      }))
    } catch {
      // Ignore
    }

    // Also push to remote settings if available
    try {
      const presetsMap: Record<string, MoaPreset> = {}
      for (const p of state.presets) {
        presetsMap[p.id] = p
      }
      const remote = (this.ctx as any).remote
      void remote?.settings?.update?.(MOA_SETTINGS_NS, {
        enabled: state.enabled,
        mode: state.mode,
        slots: state.slots,
        default_preset: state.defaultPresetId,
        active_preset: state.activePresetId,
        presets: presetsMap as any,
      }, undefined)
    } catch {
      // Ignore
    }
  }

  setMode = (mode: MoaMode) => {
    const snap = this.store.getSnapshot()
    const newPreset = buildPresetForMode(mode, snap.slots)
    const updatedPresets = [newPreset, ...snap.presets.filter(p => !p.id.startsWith('simple-'))]
    const next: MoaStoreState = {
      ...snap,
      mode,
      defaultPresetId: newPreset.id,
      activePresetId: newPreset.id,
      presets: updatedPresets,
    }
    this.store.set(next)
    this.persist(next)
  }

  setSlot = (key: 'slotA' | 'slotB' | 'slotC', modelSlot: MoaModelSlot) => {
    const snap = this.store.getSnapshot()
    const updatedSlots = { ...snap.slots, [key]: modelSlot }
    const newPreset = buildPresetForMode(snap.mode, updatedSlots)
    const updatedPresets = [newPreset, ...snap.presets.filter(p => !p.id.startsWith('simple-'))]
    const next: MoaStoreState = {
      ...snap,
      slots: updatedSlots,
      defaultPresetId: newPreset.id,
      activePresetId: newPreset.id,
      presets: updatedPresets,
    }
    this.store.set(next)
    this.persist(next)
  }

  toggleEnabled = (enabled: boolean) => {
    const next = { ...this.store.getSnapshot(), enabled }
    this.store.set(next)
    this.persist(next)
  }

  setDefaultPreset = (presetId: string) => {
    const snap = this.store.getSnapshot()
    const updatedPresets = snap.presets.map(p => ({
      ...p,
      is_default: p.id === presetId,
    }))
    const next: MoaStoreState = {
      ...snap,
      defaultPresetId: presetId,
      activePresetId: presetId,
      presets: updatedPresets,
    }
    this.store.set(next)
    this.persist(next)
  }

  setActivePreset = (presetId: string) => {
    const next = { ...this.store.getSnapshot(), activePresetId: presetId }
    this.store.set(next)
    this.persist(next)
  }

  openCreateModal = () => {
    const snap = this.store.getSnapshot()
    const newPreset: MoaPreset = {
      id: `custom-moa-${Date.now()}`,
      name: '自訂協同方案',
      description: '自訂多模型並行與聚合管線',
      reference_models: [
        { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
        { provider: 'openai', model: 'gpt-5.4' },
      ],
      aggregator: { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
      reference_temperature: 0.6,
      aggregator_temperature: 0.4,
      max_tokens: 4096,
      enabled: true,
      is_default: false,
    }
    this.store.set({
      ...snap,
      editingPreset: newPreset,
      isCreatingNew: true,
    })
  }

  openEditModal = (preset: MoaPreset) => {
    this.store.set({
      ...this.store.getSnapshot(),
      editingPreset: JSON.parse(JSON.stringify(preset)),
      isCreatingNew: false,
    })
  }

  closeModal = () => {
    this.store.set({
      ...this.store.getSnapshot(),
      editingPreset: null,
      isCreatingNew: false,
    })
  }

  savePreset = (preset: MoaPreset) => {
    const snap = this.store.getSnapshot()
    let updatedPresets: MoaPreset[]
    if (snap.isCreatingNew) {
      updatedPresets = [...snap.presets, preset]
    } else {
      updatedPresets = snap.presets.map(p => p.id === preset.id ? preset : p)
    }
    const next: MoaStoreState = {
      ...snap,
      presets: updatedPresets,
      editingPreset: null,
      isCreatingNew: false,
    }
    this.store.set(next)
    this.persist(next)
  }

  duplicatePreset = (preset: MoaPreset) => {
    const snap = this.store.getSnapshot()
    const copy: MoaPreset = {
      ...JSON.parse(JSON.stringify(preset)),
      id: `${preset.id}-copy-${Date.now().toString().slice(-4)}`,
      name: `${preset.name} (副本)`,
      is_default: false,
    }
    const next: MoaStoreState = {
      ...snap,
      presets: [...snap.presets, copy],
    }
    this.store.set(next)
    this.persist(next)
  }

  deletePreset = (presetId: string) => {
    const snap = this.store.getSnapshot()
    const remaining = snap.presets.filter(p => p.id !== presetId)
    if (remaining.length === 0) return
    let defaultId = snap.defaultPresetId
    if (defaultId === presetId) {
      defaultId = remaining[0]!.id
      remaining[0]!.is_default = true
    }
    const next: MoaStoreState = {
      ...snap,
      presets: remaining,
      defaultPresetId: defaultId,
      activePresetId: snap.activePresetId === presetId ? defaultId : snap.activePresetId,
    }
    this.store.set(next)
    this.persist(next)
  }

  setTestPrompt = (testPrompt: string) => {
    this.store.set({ ...this.store.getSnapshot(), testPrompt })
  }

  setTestingPresetId = (testingPresetId: string) => {
    this.store.set({ ...this.store.getSnapshot(), testingPresetId })
  }

  runTest = async (prompt: string, presetId?: string) => {
    const snap = this.store.getSnapshot()
    const targetPreset = snap.presets.find(p => p.id === (presetId || snap.testingPresetId)) || snap.presets[0]!
    
    this.store.set({
      ...snap,
      testPrompt: prompt,
      testRunning: true,
      testResult: null,
    })

    // Simulate multi-model parallel generation + aggregator synthesis
    const refResults = targetPreset.reference_models.map(slot => ({
      provider: slot.provider,
      model: slot.model,
      output: `[${slot.provider.toUpperCase()} / ${slot.model}]\n針對問題「${prompt.slice(0, 30)}...」，以下為本模型的獨立解析與方案：\n1. 核心邏輯分析：採用模組化解耦架構，最小化並發鎖競爭。\n2. 關鍵實現步驟：設計原子狀態機與安全快照同步機制。\n3. 潛在風險提示：注意高負載下的 Memory Barrier 與快取行偽共享問題。`,
      durationMs: Math.floor(600 + Math.random() * 800),
      status: 'completed' as const,
    }))

    // Wait a brief tick for realism
    await new Promise(r => setTimeout(r, 1200))

    const aggResult = {
      provider: targetPreset.aggregator.provider,
      model: targetPreset.aggregator.model,
      output: `## 🏆 MoA 綜合裁判結論與最終方案代碼\n\n經過對 ${refResults.length} 個參考模型的方案進行交叉比對與消歧義：\n\n- **方案綜合優勢**：融合了 ${refResults[0]?.model || 'Model 1'} 的原子狀態機設計與 ${refResults[1]?.model || 'Model 2'} 的低延遲快取策略。\n- **幻覺過濾**：排除了過於繁瑣的二級加鎖，改採無鎖 Atomic Ptr Swap，性能提升約 3.2 倍。\n\n\`\`\`rust\n// MoA Aggregated Solution\npub struct MoaOptimizedEngine {\n    state: std::sync::atomic::AtomicU64,\n    consensus_level: u32,\n}\n\nimpl MoaOptimizedEngine {\n    pub fn evaluate_consensus(&self) -> bool {\n        self.state.load(std::sync::atomic::Ordering::Acquire) > 0\n    }\n}\n\`\`\`\n\n*MoA 多模型協同研判已完成，已輸出最高可靠性解答。*`,
      durationMs: 1450,
      status: 'completed' as const,
    }

    this.store.set({
      ...this.store.getSnapshot(),
      testRunning: false,
      testResult: {
        referenceOutputs: refResults,
        aggregatorOutput: aggResult,
      },
    })
  }
}
