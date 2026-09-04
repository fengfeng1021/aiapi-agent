/**
 * Types for Mixture-of-Agents (MoA) configuration and runtime.
 * Mirrors Hermes `D:\Hermes\config.yaml:moa` & `codex-rs/moa/src/lib.rs`.
 */

export type ReasoningEffort = string

export interface MoaModelSlot {
  provider: string
  model: string
  reasoning_effort?: string | undefined
}

export interface MoaPreset {
  id: string
  name: string
  description?: string
  reference_models: MoaModelSlot[]
  aggregator: MoaModelSlot
  reference_temperature: number
  aggregator_temperature: number
  max_tokens: number
  reference_max_tokens?: number
  enabled: boolean
  is_default?: boolean
}

export type MoaMode = 'speed' | 'balanced' | 'quality'

export interface SimpleMoaSlots {
  slotA: MoaModelSlot // 主力模型
  slotB: MoaModelSlot // 交叉協同模型
  slotC: MoaModelSlot // 決策裁決模型
}

export interface MoaSettings {
  enabled?: boolean
  mode?: MoaMode
  slots?: SimpleMoaSlots
  default_preset?: string
  active_preset?: string
  presets?: Record<string, MoaPreset>
}

export interface MoaTestTurnResult {
  referenceOutputs: Array<{
    provider: string
    model: string
    output: string
    durationMs: number
    status: 'pending' | 'running' | 'completed' | 'failed'
    error?: string
  }>
  aggregatorOutput: {
    provider: string
    model: string
    output: string
    durationMs: number
    status: 'pending' | 'running' | 'completed' | 'failed'
    error?: string
  }
}
