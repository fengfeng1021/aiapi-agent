import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UniversalResponsesBridge } from '../src/responses-bridge.ts'
import { compileProvidersConfig } from '../src/codex-server.ts'

describe('codex providers config for chat-only suppliers', () => {
  const previousHome = process.env.CODEX_ISOLATED_HOME
  let codexHome = ''

  beforeAll(async () => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-config-'))
    process.env.CODEX_ISOLATED_HOME = codexHome
    await UniversalResponsesBridge.getInstance().start()
  })

  afterAll(() => {
    if (previousHome === undefined) {
      delete process.env.CODEX_ISOLATED_HOME
    } else {
      process.env.CODEX_ISOLATED_HOME = previousHome
    }
    UniversalResponsesBridge.getInstance().stop()
  })

  it('routes gemini and anthropic through the bridge as responses providers', () => {
    const result = compileProvidersConfig()
    const providers = result.providers
    const geminiBase = UniversalResponsesBridge.getInstance().getBridgeBaseUrl('gemini')
    const anthropicBase = UniversalResponsesBridge.getInstance().getBridgeBaseUrl('anthropic')
    expect(providers.gemini?.baseUrl).toBe(geminiBase)
    expect(providers.gemini?.wireApi).toBe('responses')
    expect(providers.anthropic?.baseUrl).toBe(anthropicBase)
    expect(providers.anthropic?.wireApi).toBe('responses')
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    expect(toml).toContain('[model_providers.gemini]')
    expect(toml).toContain('[model_providers.anthropic]')
    expect(toml).toContain('wire_api = "responses"')
  })
})
