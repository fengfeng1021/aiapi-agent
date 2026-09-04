import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { MoaSettingsController } from '../src/client/store.ts'
import type { MoaPreset } from '../src/client/types.ts'

function createMockContext(): ClientContext {
  return {
    remote: {
      settings: {
        update: () => Promise.resolve({ ok: true }),
      },
    },
  } as unknown as ClientContext
}

describe('MoaSettingsController', () => {
  it('initializes with default built-in presets and enabled state', () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)
    const state = controller.store.getSnapshot()

    expect(state.status).toBe('ready')
    expect(state.enabled).toBe(true)
    expect(state.mode).toBe('balanced')
    expect(state.defaultPresetId).toBe('simple-balanced')
    expect(state.slots.slotA).toBeDefined()
    expect(state.slots.slotB).toBeDefined()
    expect(state.slots.slotC).toBeDefined()
    expect(state.presets.length).toBeGreaterThan(0)
    expect(state.presets[0]?.reference_models.length).toBeGreaterThan(0)
    expect(state.presets[0]?.aggregator).toBeDefined()
  })

  it('switches between speed, balanced, and quality modes', () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)

    controller.setMode('speed')
    expect(controller.store.getSnapshot().mode).toBe('speed')
    expect(controller.store.getSnapshot().defaultPresetId).toBe('simple-speed')

    controller.setMode('quality')
    expect(controller.store.getSnapshot().mode).toBe('quality')
    expect(controller.store.getSnapshot().defaultPresetId).toBe('simple-quality')
  })

  it('updates model slots and reflects in dynamic preset', () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)

    controller.setSlot('slotA', { provider: 'google', model: 'gemini-2.5-pro' })
    const state = controller.store.getSnapshot()
    expect(state.slots.slotA.model).toBe('gemini-2.5-pro')
    const activePreset = state.presets.find(p => p.id === state.activePresetId)
    expect(activePreset?.reference_models[0]?.model).toBe('gemini-2.5-pro')
  })

  it('toggles MoA enabled state', () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)

    controller.toggleEnabled(false)
    expect(controller.store.getSnapshot().enabled).toBe(false)

    controller.toggleEnabled(true)
    expect(controller.store.getSnapshot().enabled).toBe(true)
  })

  it('sets default and active preset', () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)

    controller.setDefaultPreset('deep-reasoning')
    const state = controller.store.getSnapshot()
    expect(state.defaultPresetId).toBe('deep-reasoning')
    expect(state.activePresetId).toBe('deep-reasoning')

    const deepPreset = state.presets.find(p => p.id === 'deep-reasoning')
    expect(deepPreset?.is_default).toBe(true)
  })

  it('creates, duplicates, and deletes a custom preset', () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)
    const initialCount = controller.store.getSnapshot().presets.length

    const custom: MoaPreset = {
      id: 'my-custom-moa',
      name: 'My Custom MoA',
      description: 'Test Preset',
      reference_models: [
        { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
        { provider: 'openai', model: 'gpt-5.4' },
      ],
      aggregator: { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
      reference_temperature: 0.7,
      aggregator_temperature: 0.3,
      max_tokens: 4096,
      enabled: true,
      is_default: false,
    }

    controller.openCreateModal()
    expect(controller.store.getSnapshot().isCreatingNew).toBe(true)

    controller.savePreset(custom)
    let state = controller.store.getSnapshot()
    expect(state.presets.length).toBe(initialCount + 1)
    expect(state.presets.some(p => p.id === 'my-custom-moa')).toBe(true)

    // Duplicate
    controller.duplicatePreset(custom)
    state = controller.store.getSnapshot()
    expect(state.presets.length).toBe(initialCount + 2)

    // Delete custom
    controller.deletePreset('my-custom-moa')
    state = controller.store.getSnapshot()
    expect(state.presets.some(p => p.id === 'my-custom-moa')).toBe(false)
  })

  it('runs interactive test in playground and returns structured outputs', async () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)

    const testPromise = controller.runTest('請設計一個高效能快取')
    expect(controller.store.getSnapshot().testRunning).toBe(true)

    await testPromise
    const state = controller.store.getSnapshot()
    expect(state.testRunning).toBe(false)
    expect(state.testResult).not.toBeNull()
    expect(state.testResult?.referenceOutputs.length).toBeGreaterThan(0)
    expect(state.testResult?.aggregatorOutput.output).toContain('MoA')
  })

  it('initializes with empty availableProviders when user has not bound any providers', () => {
    const ctx = createMockContext()
    const controller = new MoaSettingsController(ctx)
    expect(controller.store.getSnapshot().availableProviders).toEqual([])
  })

  it('syncs real model catalog from host when user binds providers', async () => {
    const ctx = {
      remote: {
        session: {
          modelCatalog: () => Promise.resolve({
            ok: true,
            value: {
              default: { provider: 'openrouter', model: 'anthropic/claude-3.7-sonnet' },
              routableProviders: ['openrouter'],
              groups: [
                {
                  id: 'openrouter',
                  name: 'OpenRouter',
                  models: [
                    {
                      id: 'anthropic/claude-3.7-sonnet',
                      name: 'Claude 3.7 Sonnet',
                      reasoning: { defaultEffort: 'medium', efforts: [{ id: 'high', name: 'High' }] },
                    },
                  ],
                },
              ],
              failures: [],
            },
          }),
        },
      },
    } as unknown as ClientContext

    const controller = new MoaSettingsController(ctx)
    await controller.syncProvidersFromHost()

    const state = controller.store.getSnapshot()
    expect(state.availableProviders.length).toBe(1)
    expect(state.availableProviders[0]?.provider).toBe('openrouter')
    expect(state.availableProviders[0]?.displayName).toBe('OpenRouter')
    expect(state.availableProviders[0]?.models[0]?.id).toBe('anthropic/claude-3.7-sonnet')
  })

  it('clears availableProviders when host catalog is empty (no bound providers)', async () => {
    const ctx = {
      remote: {
        session: {
          modelCatalog: () => Promise.resolve({
            ok: true,
            value: {
              default: { provider: '', model: '' },
              routableProviders: [],
              groups: [],
              failures: [],
            },
          }),
        },
      },
    } as unknown as ClientContext

    const controller = new MoaSettingsController(ctx)
    await controller.syncProvidersFromHost()

    const state = controller.store.getSnapshot()
    expect(state.availableProviders).toEqual([])
    expect(state.slots.slotA.provider).toBe('')
    expect(state.slots.slotA.model).toBe('')
  })
})
