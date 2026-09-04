/**
 * The card that declares a provider pi-ai does not ship — an OpenAI-compatible
 * gateway, a self-hosted server, or a provider newer than the installed
 * catalog.
 *
 * This is a create, not an edit, which is why it is its own card rather than
 * the provider editor with extra fields: the route id is being *chosen* here,
 * and the settings address does not exist until it is. One `settings.mutate`
 * sets the whole profile at `providers.<route>`; the key travels separately
 * through `credentials/set` under the reference the profile records, exactly as
 * an existing provider's key does.
 *
 * The three fields a hand-declared route cannot default — endpoint, protocol,
 * and at least one model — are required here rather than at load, so the
 * failure names the field while the user is still looking at it.
 *
 * There is deliberately no reasoning-effort control, here or on the editor
 * card: effort is a per-MODEL capability, and the models under one provider
 * disagree about it, so a provider-scoped control can only be set to a value
 * some of them reject. The composer's model picker offers each model its own
 * levels instead.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import type { ModelDraft } from './ModelListEditor.tsx'
import { deriveKeyRef } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai'

/**
 * A route id usable as a settings key AND as the stem of a credential name.
 * The leading letter is the second half of that: `deriveKeyRef` uppercases the
 * id and replaces every non-alphanumeric run with `_`, and a credential
 * reference is a POSIX shell identifier, which cannot start with a digit. A
 * digit-leading id passes every check this card makes and then fails at the
 * credential seam with a raw regular expression the user cannot act on.
 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Props of {@link CustomProviderCard}. */
export interface CustomProviderCardProps {
  /** Route ids already declared, so the card refuses to shadow one. */
  taken: readonly string[]
  /** Wire protocols the adapter can serve, in the order it reports them. */
  protocols: readonly string[]
  /**
   * Revision of the `llm-pi-ai` user section this card opened at, sent with
   * the create so a route another tab declared meanwhile is a refusal rather
   * than a silent overwrite of its whole profile.
   */
  revision: number
  /** The Host operations this card writes and interrogates through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the card; `changed` reports whether a provider was created. */
  onClose: (changed: boolean) => void
}

export interface AuthOption {
  id: string
  name: string
  tag: string
  route: string
  baseURL: string
  api: string
  authType: 'api-key' | 'oauth' | 'device-code'
  description?: string
  lockedBaseURL?: boolean
}

export interface ProviderPreset {
  id: string
  name: string
  options: AuthOption[]
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    options: [
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        tag: '官方推荐 / 免翻直连',
        route: 'opencode-go',
        baseURL: 'https://opencode.ai/zen/go/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'OpenCode 官方极速接入节点，聚合百种主流模型',
      },
      {
        id: 'opencode-zen',
        name: 'OpenCode Zen',
        tag: '官方全局',
        route: 'opencode',
        baseURL: 'https://opencode.ai/zen/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'OpenCode 官方全局 API 节点',
      },
    ],
  },
  {
    id: 'aiapi',
    name: 'Aiapi (默认)',
    options: [
      {
        id: 'aiapi-key',
        name: 'Aiapi 企业接口',
        tag: 'API 密钥',
        route: 'aiapi',
        baseURL: 'https://aiapi.tw',
        api: 'openai-completions',
        authType: 'api-key',
        lockedBaseURL: true,
        description: 'Aiapi 默认企业中转服务',
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    options: [
      {
        id: 'openai-browser',
        name: 'ChatGPT Pro/Plus 浏览器',
        tag: '浏览器',
        route: 'openai-codex',
        baseURL: 'https://api.openai.com/v1',
        api: 'openai-completions',
        authType: 'oauth',
        description: '通过网页登录授权 ChatGPT Plus / Pro 订阅账号',
      },
      {
        id: 'openai-headless',
        name: 'ChatGPT Pro/Plus 无头模式',
        tag: '无头模式',
        route: 'openai-codex',
        baseURL: 'https://api.openai.com/v1',
        api: 'openai-completions',
        authType: 'device-code',
        description: '通过设备验证码进行 ChatGPT Plus / Pro 账号绑定',
      },
      {
        id: 'openai-key',
        name: 'API 密钥 浏览器',
        tag: 'API 密钥',
        route: 'openai',
        baseURL: 'https://api.openai.com/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '使用 OpenAI 官方平台 API Key',
      },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    options: [
      {
        id: 'claude-oauth',
        name: 'Claude Pro/Max 浏览器',
        tag: '浏览器',
        route: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        api: 'anthropic-messages',
        authType: 'oauth',
        description: '通过网页登录授权 Claude 官方会员账号',
      },
      {
        id: 'claude-key',
        name: 'API 密钥 浏览器',
        tag: 'API 密钥',
        route: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        api: 'anthropic-messages',
        authType: 'api-key',
        description: '使用 Anthropic 官方 API Key',
      },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    options: [
      {
        id: 'gemini-key',
        name: 'Gemini API 密钥',
        tag: 'API 密钥',
        route: 'google',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'Google AI Studio / Gemini API 密钥',
      },
      {
        id: 'vertex-key',
        name: 'Google Vertex AI',
        tag: '云凭证',
        route: 'google-vertex',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'Google Cloud Vertex AI 企业凭证',
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    options: [
      {
        id: 'deepseek-key',
        name: 'DeepSeek 官方 API 密钥',
        tag: 'API 密钥',
        route: 'deepseek',
        baseURL: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'DeepSeek 开放平台 API Key',
      },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    options: [
      {
        id: 'xai-oauth',
        name: 'Grok / X 订阅 浏览器',
        tag: '浏览器',
        route: 'xai',
        baseURL: 'https://api.x.ai/v1',
        api: 'openai-completions',
        authType: 'oauth',
        description: '通过 X / Grok Premium 订阅账号登录',
      },
      {
        id: 'xai-key',
        name: 'API 密钥 浏览器',
        tag: 'API 密钥',
        route: 'xai',
        baseURL: 'https://api.x.ai/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '使用 xAI 开发者平台 API Key',
      },
    ],
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    options: [
      {
        id: 'copilot-oauth',
        name: 'GitHub Copilot 账号登录',
        tag: 'OAuth 登录',
        route: 'github-copilot',
        baseURL: 'https://api.githubcopilot.com',
        api: 'openai-completions',
        authType: 'oauth',
        description: '通过 GitHub 账号授权 Copilot 订阅',
      },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    options: [
      {
        id: 'kimi-code-oauth',
        name: 'Kimi For Coding 订阅登录',
        tag: '订阅账号',
        route: 'kimi-coding',
        baseURL: 'https://api.moonshot.cn/v1',
        api: 'openai-completions',
        authType: 'oauth',
        description: '通过 Kimi 会员订阅账号登录',
      },
      {
        id: 'moonshot-key',
        name: 'Moonshot AI API 密钥',
        tag: 'API 密钥',
        route: 'moonshotai',
        baseURL: 'https://api.moonshot.cn/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '月之暗面开放平台 API Key',
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    options: [
      {
        id: 'openrouter-oauth',
        name: 'OpenRouter OAuth 授权',
        tag: '一键登录',
        route: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
        authType: 'oauth',
        description: '通过 OpenRouter 账号一键授权登录',
      },
      {
        id: 'openrouter-key',
        name: 'OpenRouter API 密钥',
        tag: 'API 密钥',
        route: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '使用 OpenRouter API Key',
      },
    ],
  },
  {
    id: 'zai',
    name: 'Z.AI (智谱清言)',
    options: [
      {
        id: 'zai-code-oauth',
        name: 'Z.AI Coding 会员登录',
        tag: '会员账号',
        route: 'zai-coding-cn',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        api: 'openai-completions',
        authType: 'oauth',
        description: '通过智谱清言会员账号登录',
      },
      {
        id: 'zai-key',
        name: 'Z.AI 官方 API 密钥',
        tag: 'API 密钥',
        route: 'zai',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        api: 'openai-completions',
        authType: 'api-key',
        description: '智谱 AI 开放平台 API Key',
      },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    options: [
      {
        id: 'minimax-key',
        name: 'MiniMax 官方 API 密钥',
        tag: 'API 密钥',
        route: 'minimax',
        baseURL: 'https://api.minimax.chat/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'MiniMax 开放平台 API Key',
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen (通义千问)',
    options: [
      {
        id: 'qwen-dashscope',
        name: '阿里云 DashScope API 密钥',
        tag: 'API 密钥',
        route: 'qwen-token-plan-cn',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '阿里云百炼 / 通义千问 DashScope API Key',
      },
    ],
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi (小米 MiMo)',
    options: [
      {
        id: 'xiaomi-key',
        name: 'Xiaomi MiMo API 密钥',
        tag: 'API 密钥',
        route: 'xiaomi',
        baseURL: 'https://api.xiaomi.com/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '小米开放平台 MiMo API Key',
      },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    options: [
      {
        id: 'ollama-local',
        name: 'Ollama 本地服务',
        tag: '本地免 Key',
        route: 'ollama',
        baseURL: 'http://localhost:11434/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '本地运行的 Ollama 服务 (默认端口 11434)',
      },
    ],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    options: [
      {
        id: 'lmstudio-local',
        name: 'LM Studio 本地服务',
        tag: '本地免 Key',
        route: 'lmstudio',
        baseURL: 'http://localhost:1234/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: '本地运行的 LM Studio 本地推理服务 (默认端口 1234)',
      },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    options: [
      {
        id: 'groq-key',
        name: 'Groq API 密钥',
        tag: 'API 密钥',
        route: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'Groq LPU 超高速推理平台',
      },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    options: [
      {
        id: 'mistral-key',
        name: 'Mistral API 密钥',
        tag: 'API 密钥',
        route: 'mistral',
        baseURL: 'https://api.mistral.ai/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'Mistral 官方平台 API Key',
      },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    options: [
      {
        id: 'together-key',
        name: 'Together API 密钥',
        tag: 'API 密钥',
        route: 'together',
        baseURL: 'https://api.together.xyz/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'Together AI 开发者云平台',
      },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    options: [
      {
        id: 'fireworks-key',
        name: 'Fireworks API 密钥',
        tag: 'API 密钥',
        route: 'fireworks',
        baseURL: 'https://api.fireworks.ai/inference/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'Fireworks AI 极速推理平台',
      },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    options: [
      {
        id: 'cerebras-key',
        name: 'Cerebras API 密钥',
        tag: 'API 密钥',
        route: 'cerebras',
        baseURL: 'https://api.cerebras.ai/v1',
        api: 'openai-completions',
        authType: 'api-key',
        description: 'Cerebras 晶圆级超高吞吐推理平台',
      },
    ],
  },
  {
    id: 'custom',
    name: '自定义',
    options: [
      {
        id: 'custom-endpoint',
        name: '自定义 OpenAI 兼容接口',
        tag: '自定义',
        route: '',
        baseURL: '',
        api: 'openai-completions',
        authType: 'api-key',
        description: '任何兼容 OpenAI / Completions 协议的私有网关或中转服务',
      },
    ],
  },
]

/**
 * Render the custom-provider creation card.
 * @param props - existing routes, protocol choices, wire faces, and copy.
 * @returns the creation card.
 */
export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, operations, t } = props
  // The write is checked against the revision on which this draft was opened.
  const [openedAt] = useState(() => props.revision)
  const [selectedPreset, setSelectedPreset] = useState<string>('custom')
  const [selectedAuthId, setSelectedAuthId] = useState<string>('custom-endpoint')
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? 'openai-completions')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const applyAuthOption = (option: AuthOption, presetId: string): void => {
    setSelectedPreset(presetId)
    setSelectedAuthId(option.id)
    if (presetId === 'custom') {
      setRoute('')
      setDisplayName('')
      setBaseURL('')
      setProtocol(protocols[0] ?? 'openai-completions')
    } else {
      let candidateRoute = option.route
      let candidateName = option.name.replace(/ \(默认\)$/, '')
      if (taken.includes(candidateRoute)) {
        let i = 2
        while (taken.includes(`${candidateRoute}-${i}`)) i++
        candidateRoute = `${candidateRoute}-${i}`
        candidateName = `${candidateName} ${i}`
      }
      setRoute(candidateRoute)
      setDisplayName(candidateName)
      setBaseURL(option.baseURL)
      setProtocol(protocols.includes(option.api) ? option.api : (protocols[0] ?? option.api))
    }
  }

  const applyPreset = (preset: ProviderPreset): void => {
    const firstOption = preset.options[0]
    if (firstOption) {
      applyAuthOption(firstOption, preset.id)
    }
  }
  /**
   * The profile write landed. Only the key write can still be outstanding, so
   * the fields that describe the provider are settled and the retry path is
   * the credential alone.
   */
  const [committed, setCommitted] = useState(false)
  const disabled = props.readOnly || busy
  /** Everything but the key stops being editable once the provider exists. */
  const profileDisabled = disabled || committed

  const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
  const routeTaken = taken.includes(route)
  // Rows are checked by the same per-row validator the editor cards use, so a
  // bad row is named by its position here too. Capacities have route-level
  // fallbacks; what a route cannot default is at least one model.
  const modelFailure = validateDeepSeekModels(models)
  const keyFailure = apiKeyFailure(keyDraft)
  // The typed key with paste whitespace removed. A blank field yields an empty
  // string, which the create path reads as "no key supplied" — a route may
  // legitimately authenticate through the provider's own ambient discovery.
  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && !routeInvalid && !routeTaken
    && baseURL.length > 0 && models.length > 0 && modelFailure === undefined
    && keyFailure === undefined
  // The one blocked gate worth a line under the form. A satisfied card says
  // nothing at all rather than printing an empty paragraph.
  const hint = failure !== undefined || ready
    // The key field prints its own failure directly beneath itself, so a card
    // blocked only by the key stays silent here rather than answering with the
    // next unmet gate — which is satisfied, and reads as a second, false fault.
    || keyFailure !== undefined
    // Same for the route id, and it must be tested rather than assumed: the
    // fallback arm below reads "no models yet", so an unmet route gate would
    // fall through to it and contradict the filled-in list right above.
    || route.length === 0 || routeInvalid || routeTaken
    ? undefined
    : baseURL.length === 0
      ? t('customNeedsBaseUrl')
      : modelFailure !== undefined
        ? `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`
        : t('customNeedsModels')

  /** Perform the create, returning a failure message or undefined. */
  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    if (!committed) {
      const profile = {
        ...displayName.length === 0 ? {} : { displayName },
        // The profile names the conventional reference only when this card is
        // about to store a key, matching the editor: a route declared with the
        // key left blank keeps its provider-native auth path (a credential
        // chain, ADC) instead of resolving a reference nothing ever sets.
        ...storesKey ? { apiKeyEnv: keyRef } : {},
        api: protocol,
        baseURL,
        models: models.map(model => ({ ...model })),
      }
      // `taken` is a snapshot too, so the id check alone cannot see a route
      // declared after this card opened; the revision makes that race a
      // `settings-conflict` instead of a write over the other profile.
      const written = await operations.writeSettings(
        NS,
        [{ op: 'set', path: ['providers', route], value: profile as JsonValue }],
        openedAt,
      )
      if (written.kind !== 'written') {
        return written.kind === 'conflict' ? t('conflict') : written.message
      }
      // The provider now exists. A retry after the key write below fails must
      // not re-run this mutate: the revision it holds is the one this write
      // just superseded, so the Host would answer `settings-conflict` and the
      // key could never be stored from this card at all.
      setCommitted(true)
    }
    if (storesKey) {
      const stored = await operations.storeCredential(keyRef, keyValue)
      // The profile landed; saying the key did not is the only honest report,
      // and the retry above now goes straight back to this write.
      if (stored !== undefined) return stored
    }
    return undefined
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await createOnce()
      if (outcome !== undefined) {
        setFailure(outcome)
        return
      }
      props.onClose(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('customTitle')}</span>
      </div>

      <div className={styles['presetContainer']}>
        <span className={styles['presetTitle']}>快捷提供商预设</span>
        <div className={styles['presetList']}>
          {PROVIDER_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className={`${styles['presetButton']} ${selectedPreset === preset.id ? styles['presetButtonActive'] : ''}`}
              disabled={profileDisabled}
              onClick={() => applyPreset(preset)}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      {(() => {
        const currentPreset = PROVIDER_PRESETS.find(p => p.id === selectedPreset)
        if (!currentPreset || currentPreset.options.length <= 1) return null
        return (
          <div className={styles['authSection']}>
            <p className={styles['authSubtitle']}>选择 {currentPreset.name} 的登录方式：</p>
            <div className={styles['authOptionList']}>
              {currentPreset.options.map(opt => {
                const active = selectedAuthId === opt.id
                return (
                  <div
                    key={opt.id}
                    className={`${styles['authOptionCard']} ${active ? styles['authOptionCardActive'] : ''}`}
                    onClick={() => !profileDisabled && applyAuthOption(opt, currentPreset.id)}
                  >
                    <div className={styles['authOptionLeft']}>
                      <div className={`${styles['authRadio']} ${active ? styles['authRadioActive'] : ''}`}>
                        {active && <div className={styles['authRadioInner']} />}
                      </div>
                      <div>
                        <div className={styles['authOptionTitle']}>{opt.name}</div>
                        {opt.description && <div className={styles['authOptionDesc']}>{opt.description}</div>}
                      </div>
                    </div>
                    {opt.tag && <span className={styles['authOptionTag']}>{opt.tag}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customRoute')}</span>
        <input
          className={styles['input']}
          type="text"
          value={route}
          placeholder="acme-gateway"
          aria-label={t('customRoute')}
          disabled={profileDisabled}
          onChange={(event) => { setRoute(event.target.value) }}
        />
      </div>
      {/* A rejected id reads as a fault, not as guidance — the same split the
          key field below already makes between its failure and its hint. */}
      {routeInvalid || routeTaken
        ? <p className={styles['error']}>{t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken')}</p>
        : <p className={styles['advancedHint']}>{t('customRouteHint')}</p>}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
        <input
          className={styles['input']}
          type="text"
          value={displayName}
          placeholder={route.length === 0 ? t('customDisplayName') : route}
          aria-label={t('customDisplayName')}
          disabled={profileDisabled}
          onChange={(event) => { setDisplayName(event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={baseURL}
          placeholder={t('customBaseUrlPlaceholder')}
          aria-label={t('baseUrl')}
          disabled={profileDisabled || selectedPreset === 'aiapi' || route === 'aiapi'}
          onChange={(event) => { setBaseURL(event.target.value) }}
        />
        {(selectedPreset === 'aiapi' || route === 'aiapi') && (
          <p className={styles['advancedHint']}>🔒 API 地址已锁定为 https://aiapi.tw</p>
        )}
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customApi')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={protocol}
          aria-label={t('customApi')}
          disabled={profileDisabled}
          onChange={(event) => { setProtocol(event.target.value) }}
        >
          {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <input
          className={styles['input']}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={t('keyPlaceholder')}
          aria-label={t('keyInput')}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        {/* A create card has no stored key to keep, so the blank case says
            what a blank field means here instead: this route may authenticate
            through the provider's own ambient discovery or OAuth. */}
        {keyFailure === undefined
          ? null
          : <p className={styles['error']}>{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
      </div>
      <ModelListEditor
        models={models}
        onChange={setModels}
        probe={{
          settingsNs: NS,
          baseURL,
          api: protocol,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
        }}
        probeBlocked={keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure}
        operations={operations}
        t={t}
        disabled={profileDisabled}
      />
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      {/* Only the gates with something to say render; the route-id gate has its
          own field-level hint, so its blocked state would print an empty line. */}
      {hint === undefined ? null : <p className={styles['advancedHint']}>{hint}</p>}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabelKey="create"
        submitBusyLabelKey="creating"
        onCancel={() => { props.onClose(committed) }}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
