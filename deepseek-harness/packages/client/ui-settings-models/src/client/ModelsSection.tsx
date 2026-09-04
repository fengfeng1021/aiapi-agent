/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows expose only confirmed API-key state through accessible
 * solid configured or missing dots. A whole-section provider without a
 * configured key renders as its open setup card instead of a row, but only in
 * the first-run posture — no provider on the page can serve requests yet — and
 * only until the user closes that card; the add flow is a card carrying the
 * dormant-provider select. Each card kind owns its own open state, so closing
 * one never discards a draft in another. Every mutation writes through the
 * wire, while a provider removal first requires confirmation; the page
 * re-renders from pushed invalidations or the post-apply reload.
 */

import { useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls this package's SlotMap merge (the two Models child slots).
import type {} from './slot-contract.ts'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { ConnectProviderModal, OPENCODE_PROVIDERS } from './ConnectProviderModal.tsx'
import { deriveKeyRef, protocolChoices, providerUsable } from './store.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** The Host operations the section and its cards invoke. */
  operations: ModelsOperations
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** The child slots this section declares and dispatches (see ./slot-contract.ts). */
type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'

/** The child-slot dispatch function the renderer binds for the section. */
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call) plus the child-slot
 * dispatch seat. The seat is required: the renderer binds it at the render
 * call itself — unlike the inject face it is never absent at runtime — and a
 * direct render that forgets it fails to compile instead of mounting nothing.
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>

type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
}

/** Values that vary around the shared provider-editor rendering. */
interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'schema' | 'operations' | 't' | 'readOnly' | 'onClose'
> {
  target: EditorTarget
}

/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...props}
    />
  )
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param operations - the page's Host operations.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  operations: ModelsOperations,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  if (target.credentialRef !== undefined) {
    const credential = await operations.removeCredential(target.credentialRef)
    if (credential !== undefined) return credential
  }
  const written = await operations.writeSettings(
    target.settingsNs,
    [{ op: 'unset', path: [...target.settingsPath] }],
    undefined,
  )
  if (written.kind !== 'written') return written.message
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable) return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

/**
 * The provider-card seat's credential fact: the reference this page would use
 * for the row — the profile's `apiKeyEnv`, or the page's derived
 * `<ROUTE>_API_KEY` while the profile names none — confirmed configured. The
 * derived half is what keeps the seat consistent with the editor on the
 * add-provider draft, whose dormant row names no reference yet.
 */
function keyConfiguredOf(row: ProviderRow): boolean {
  return row.apiKeyEnv !== undefined
    ? row.credential?.configured === true
    : row.derivedCredential?.configured === true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Only declared routes may expose route-owned fields.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

export interface ProviderAuthMethod {
  id: string
  name: string
  tag: string
  route: string
  authType: 'api-key' | 'oauth' | 'device-code'
  description: string
}

export interface ProviderBrand {
  id: string
  name: string
  routes: string[]
  methods: ProviderAuthMethod[]
}

export const OPENCODE_PROVIDER_BRANDS: ProviderBrand[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    routes: ['opencode-go', 'opencode'],
    methods: [
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        tag: '官方推荐 / 免翻直连',
        route: 'opencode-go',
        authType: 'api-key',
        description: 'OpenCode 官方极速节点，聚合百款主流模型',
      },
      {
        id: 'opencode-zen',
        name: 'OpenCode Zen',
        tag: '官方全局',
        route: 'opencode',
        authType: 'api-key',
        description: 'OpenCode 官方全局 API 节点',
      },
    ],
  },
  {
    id: 'aiapi',
    name: 'Aiapi (默认)',
    routes: ['aiapi'],
    methods: [
      {
        id: 'aiapi-key',
        name: 'Aiapi 企业接口',
        tag: 'API 密钥',
        route: 'aiapi',
        authType: 'api-key',
        description: 'Aiapi 默认企业中转服务 (https://aiapi.tw)',
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    routes: ['openai', 'openai-codex'],
    methods: [
      {
        id: 'openai-browser',
        name: 'ChatGPT Pro/Plus 浏览器',
        tag: '浏览器',
        route: 'openai-codex',
        authType: 'oauth',
        description: '通过网页登录授权 ChatGPT Plus / Pro 订阅账号',
      },
      {
        id: 'openai-headless',
        name: 'ChatGPT Pro/Plus 无头模式',
        tag: '无头模式',
        route: 'openai-codex',
        authType: 'device-code',
        description: '通过设备验证码进行 ChatGPT Plus / Pro 账号绑定',
      },
      {
        id: 'openai-key',
        name: 'API 密钥 浏览器',
        tag: 'API 密钥',
        route: 'openai',
        authType: 'api-key',
        description: '使用 OpenAI 官方平台 API Key',
      },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    routes: ['anthropic'],
    methods: [
      {
        id: 'claude-oauth',
        name: 'Claude Pro/Max 浏览器',
        tag: '浏览器',
        route: 'anthropic',
        authType: 'oauth',
        description: '通过网页登录授权 Claude 官方会员账号',
      },
      {
        id: 'claude-key',
        name: 'API 密钥 浏览器',
        tag: 'API 密钥',
        route: 'anthropic',
        authType: 'api-key',
        description: '使用 Anthropic 官方 API Key',
      },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    routes: ['google', 'google-vertex', 'gemini-oauth'],
    methods: [
      {
        id: 'gemini-antigravity',
        name: 'Gemini 订阅会员额度 (Antigravity)',
        tag: '会员订阅',
        route: 'google',
        authType: 'oauth',
        description: '通过 Google 账号登录授权，使用 Gemini Advanced / Google One 在 Antigravity 中的订阅额度',
      },
      {
        id: 'gemini-key',
        name: 'Gemini API 密钥 (Google AI Studio)',
        tag: '免费获取',
        route: 'google',
        authType: 'api-key',
        description: '使用 Google AI Studio 官方免费获取的 Gemini API 密钥 (AIzaSy...)',
      },
      {
        id: 'vertex-key',
        name: 'Google Cloud Vertex AI',
        tag: '企业云凭证',
        route: 'google-vertex',
        authType: 'api-key',
        description: '使用 Google Cloud Vertex AI 企业凭据与多区域配置',
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    routes: ['deepseek', 'deepseek-official'],
    methods: [
      {
        id: 'deepseek-key',
        name: 'DeepSeek 官方 API 密钥',
        tag: 'API 密钥',
        route: 'deepseek',
        authType: 'api-key',
        description: 'DeepSeek 开放平台 API Key',
      },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    routes: ['xai'],
    methods: [
      {
        id: 'xai-oauth',
        name: 'Grok / X 订阅 浏览器',
        tag: '浏览器',
        route: 'xai',
        authType: 'oauth',
        description: '通过 X / Grok Premium 订阅账号登录',
      },
      {
        id: 'xai-key',
        name: 'API 密钥 浏览器',
        tag: 'API 密钥',
        route: 'xai',
        authType: 'api-key',
        description: '使用 xAI 开发者平台 API Key',
      },
    ],
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    routes: ['github-copilot'],
    methods: [
      {
        id: 'copilot-oauth',
        name: 'GitHub Copilot 账号登录',
        tag: 'OAuth 登录',
        route: 'github-copilot',
        authType: 'oauth',
        description: '通过 GitHub 账号授权 Copilot 订阅',
      },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    routes: ['kimi-coding', 'moonshotai', 'moonshotai-cn'],
    methods: [
      {
        id: 'kimi-code-oauth',
        name: 'Kimi For Coding 订阅登录',
        tag: '订阅账号',
        route: 'kimi-coding',
        authType: 'oauth',
        description: '通过 Kimi 会员订阅账号登录',
      },
      {
        id: 'moonshot-key',
        name: 'Moonshot AI API 密钥',
        tag: 'API 密钥',
        route: 'moonshotai',
        authType: 'api-key',
        description: '月之暗面开放平台 API Key',
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    routes: ['openrouter'],
    methods: [
      {
        id: 'openrouter-oauth',
        name: 'OpenRouter OAuth 授权',
        tag: '一键登录',
        route: 'openrouter',
        authType: 'oauth',
        description: '通过 OpenRouter 账号一键授权登录',
      },
      {
        id: 'openrouter-key',
        name: 'OpenRouter API 密钥',
        tag: 'API 密钥',
        route: 'openrouter',
        authType: 'api-key',
        description: '使用 OpenRouter API Key',
      },
    ],
  },
  {
    id: 'zai',
    name: 'Z.AI (智谱清言)',
    routes: ['zai-coding-cn', 'zai'],
    methods: [
      {
        id: 'zai-code-oauth',
        name: 'Z.AI Coding 会员登录',
        tag: '会员账号',
        route: 'zai-coding-cn',
        authType: 'oauth',
        description: '通过智谱清言会员账号登录',
      },
      {
        id: 'zai-key',
        name: 'Z.AI 官方 API 密钥',
        tag: 'API 密钥',
        route: 'zai',
        authType: 'api-key',
        description: '智谱 AI 开放平台 API Key',
      },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    routes: ['minimax', 'minimax-cn'],
    methods: [
      {
        id: 'minimax-key',
        name: 'MiniMax 官方 API 密钥',
        tag: 'API 密钥',
        route: 'minimax',
        authType: 'api-key',
        description: 'MiniMax 开放平台 API Key',
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen (通义千问)',
    routes: ['qwen-token-plan-cn', 'qwen-token-plan', 'qwen-token-plan-individual'],
    methods: [
      {
        id: 'qwen-key',
        name: '阿里云 DashScope API 密钥',
        tag: 'API 密钥',
        route: 'qwen-token-plan-cn',
        authType: 'api-key',
        description: '阿里云百炼 / 通义千问 DashScope API Key',
      },
    ],
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi (小米 MiMo)',
    routes: ['xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'],
    methods: [
      {
        id: 'xiaomi-key',
        name: 'Xiaomi MiMo API 密钥',
        tag: 'API 密钥',
        route: 'xiaomi',
        authType: 'api-key',
        description: '小米开放平台 MiMo API Key',
      },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    routes: ['ollama'],
    methods: [
      {
        id: 'ollama-local',
        name: 'Ollama 本地服务',
        tag: '本地免 Key',
        route: 'ollama',
        authType: 'api-key',
        description: '本地运行的 Ollama 服务 (默认端口 11434)',
      },
    ],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    routes: ['lmstudio'],
    methods: [
      {
        id: 'lmstudio-local',
        name: 'LM Studio 本地服务',
        tag: '本地免 Key',
        route: 'lmstudio',
        authType: 'api-key',
        description: '本地运行的 LM Studio 本地服务 (默认端口 1234)',
      },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    routes: ['groq'],
    methods: [
      {
        id: 'groq-key',
        name: 'Groq API 密钥',
        tag: 'API 密钥',
        route: 'groq',
        authType: 'api-key',
        description: 'Groq LPU 超高速推理平台',
      },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    routes: ['mistral'],
    methods: [
      {
        id: 'mistral-key',
        name: 'Mistral API 密钥',
        tag: 'API 密钥',
        route: 'mistral',
        authType: 'api-key',
        description: 'Mistral 官方平台 API Key',
      },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    routes: ['together'],
    methods: [
      {
        id: 'together-key',
        name: 'Together API 密钥',
        tag: 'API 密钥',
        route: 'together',
        authType: 'api-key',
        description: 'Together AI 开发者平台',
      },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    routes: ['fireworks'],
    methods: [
      {
        id: 'fireworks-key',
        name: 'Fireworks API 密钥',
        tag: 'API 密钥',
        route: 'fireworks',
        authType: 'api-key',
        description: 'Fireworks AI 推理平台',
      },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    routes: ['cerebras'],
    methods: [
      {
        id: 'cerebras-key',
        name: 'Cerebras API 密钥',
        tag: 'API 密钥',
        route: 'cerebras',
        authType: 'api-key',
        description: 'Cerebras 超高吞吐推理平台',
      },
    ],
  },
]

function friendlyProviderName(provider: string, rawDisplayName: string): string {
  if (rawDisplayName && rawDisplayName !== provider) return rawDisplayName
  const brand = OPENCODE_PROVIDER_BRANDS.find(b => b.routes.includes(provider))
  if (brand) {
    const method = brand.methods.find(m => m.route === provider)
    return method ? `${brand.name} (${method.name})` : brand.name
  }
  return rawDisplayName || provider
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, operations, schema, t, renderSlot } = props
  if (
    controller === undefined || useSnapshot === undefined || operations === undefined
    || schema === undefined || t === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, operations, schema, t }} renderSlot={renderSlot} />
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace; renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, operations, schema, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [connectModalOpen, setConnectModalOpen] = useState(false)
  const [connectProvider, setConnectProvider] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [declaring, setDeclaring] = useState(false)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => { setSavedTarget(target) })
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    setEditing(undefined)
    setAdding(false)
    setDeclaring(false)
    if (changed) announceSaved(target)
  }

  /**
   * Close a setup card, which owns none of the state above: the row-editor,
   * add, and declare cards each own one of those, so clearing them here would
   * discard a draft the user opened beside this card. Dismissal is this card's
   * own — the provider falls back to an ordinary row for the rest of the
   * session, and reopens through Edit.
   */
  const closeSetup = (changed: boolean, target: ProviderIdentity): void => {
    setDismissedSetup(previous => new Set([...previous, target.provider]))
    if (changed) announceSaved(target)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(operations, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  const popularProvidersList = useMemo(() => {
    const connectedRoutes = new Set(state.rows.filter(row => row.configured).map(r => r.entry.provider))
    return OPENCODE_PROVIDERS.filter(p => !p.routes.some(route => connectedRoutes.has(route)))
  }, [state.rows])

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  // One fact decides both first-run postures on this page and the onboarding
  // step: whether the user already has a provider to talk to.
  const anyUsable = state.rows.some(providerUsable)
  const configured = state.rows.filter(row => row.configured)
  const addable = state.rows.filter(row => !row.configured && row.entry.settingsNs !== '')
  const addTarget = adding ? editing : undefined
  const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
  // The draft's directory row, for the card extension seat. A refresh can drop
  // the row mid-draft (the route was adopted or withdrawn elsewhere); the
  // draft card stays while the seat simply has no row to dispatch.
  const addRow = addTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === addTarget.provider)
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the entry point stays disabled.
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'), schema)

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}

      {/* 已连接的提供商 */}
      <div className={styles['opencodeSectionHeader']} style={{ marginBottom: 12, marginTop: 16 }}>
        <span className={styles['opencodeSectionTitle']}>已连接的提供商 ({configured.length})</span>
      </div>
      {configured.length === 0 ? (
        <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(0,0,0,0.02)', border: '1px dashed rgba(0,0,0,0.1)', color: '#888', fontSize: 13, marginBottom: 20 }}>
          暂无已连接的提供商，请在下方选择热门提供商进行连接。
        </div>
      ) : null}
      <ul className={styles['rows']}>
        {configured.map((row) => {
          const target = targetOf(row)
          const namespace = state.namespaces.get(target.settingsNs)
          if (namespace === undefined) {
            return (
              <li key={row.entry.provider} className={styles['rowCard']}>
                <div className={styles['rowHead']}>
                  <span className={styles['rowIdentity']}>
                    <span className={styles['rowName']}>{friendlyProviderName(row.entry.provider, row.entry.displayName)}</span>
                    <span className={styles['rowTag']}>配置解析中</span>
                  </span>
                  <span className={styles['rowActions']}>
                    {row.removable ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        onClick={() => { void removeProviderProfile(operations, controller, target) }}
                      >
                        {t('remove')}
                      </button>
                    ) : null}
                  </span>
                </div>
              </li>
            )
          }
          if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
            // First-run posture: the provider exists but has no key — the
            // setup card IS its presence on the page, until the user closes it.
            return (
              <li key={row.entry.provider} className={styles['setupCard']}>
                {renderProviderEditor({
                  target,
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeSetup(changed, target) },
                })}
                {renderSlot(
                  'settings.models.provider-card',
                  { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                  { entryKey: row.entry.settingsNs },
                )}
              </li>
            )
          }
          const open = !adding && editing?.provider === row.entry.provider
          const credentialConfigured = row.credential?.configured === true
          const credentialMissing = !credentialConfigured
            && row.apiKeyEnv !== undefined
            && row.credential?.configured === false

          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowIdentity']}>
                  <span className={styles['rowName']}>{friendlyProviderName(row.entry.provider, row.entry.displayName)}</span>
                  {/* Only the adapter can tell a hand-declared route from a
                      shipped one it also has a stored profile for, so the tag
                      follows its answer and stays off when it gives none. */}
                  {row.entry.declared === true
                    ? <span className={styles['rowTag']}>{t('customTag')}</span>
                    : null}
                  {credentialConfigured
                    ? (
                      <span
                        className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                        role="img"
                        aria-label={t('credentialConfigured')}
                        title={t('credentialConfigured')}
                      />
                    )
                    : credentialMissing
                    ? (
                      <span
                        className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                        role="img"
                        aria-label={t('credentialMissing')}
                        title={t('credentialMissing')}
                      />
                    )
                    : null}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    aria-label={providerCopy(t('editProvider'), target)}
                    onClick={() => {
                      setSavedTarget(undefined)
                      // One card at a time: leaving `declaring` set would show
                      // the create card beside this editor, and closing either
                      // one discards the other's draft.
                      setDeclaring(false)
                      setAdding(false)
                      setConnectModalOpen(false)
                      setConnectProvider(undefined)
                      setEditing(open ? undefined : target)
                    }}
                  >
                    {t('edit')}
                  </button>
                  {row.removable
                    ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        aria-label={providerCopy(t('removeProvider'), target)}
                        disabled={!state.writable}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setDeleteFailure(undefined)
                          setDeleteTarget(target)
                        }}
                      >
                        {t('remove')}
                      </button>
                    )
                    : null}
                </span>
              </div>
              {renderSlot(
                'settings.models.provider-card',
                { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                { entryKey: row.entry.settingsNs },
              )}
              {open
                ? renderProviderEditor({
                  target,
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeEditor(changed, target) },
                })
                : null}
            </li>
          )
        })}
      </ul>

      {/* 热门提供商 Section */}
      <div className={styles['opencodeSection']} style={{ marginTop: 24 }}>
        <div className={styles['opencodeSectionHeader']}>
          <span className={styles['opencodeSectionTitle']}>热门提供商</span>
        </div>
        <div className={styles['opencodeCardList']}>
          {popularProvidersList.map((item) => {
            const isCustom = item.id === 'custom'
            return (
              <div key={item.id} className={styles['opencodePopularRow']}>
                <div className={styles['opencodeRowLeftCol']}>
                  <div className={styles['opencodeRowTop']}>
                    <svg className={styles['opencodeProviderIcon']} width={20} height={20} viewBox="0 0 24 24">
                      <use href={`/provider-icons.svg#${item.id}`} />
                    </svg>
                    <span className={styles['opencodeProviderName']}>{item.name}</span>
                    {item.tag && (
                      <span className={`${styles['opencodeTag']} ${item.tag === '推荐' ? styles['opencodeTagRecommended'] : ''}`}>
                        {item.tag}
                      </span>
                    )}
                  </div>
                  {item.note && (
                    <div className={styles['opencodeRowNote']}>{item.note}</div>
                  )}
                </div>
                <div className={styles['opencodeRowRight']}>
                  <button
                    type="button"
                    className={styles['opencodeConnectBtn']}
                    aria-label={`连接 ${item.name}`}
                    disabled={!state.writable}
                    onClick={() => {
                      setSavedTarget(undefined)
                      if (isCustom) {
                        setConnectProvider('custom')
                        setConnectModalOpen(true)
                        return
                      }
                      setConnectProvider(item.id)
                      setConnectModalOpen(true)
                    }}
                  >
                    + 连接
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className={styles['secondaryButton']}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              setSavedTarget(undefined)
              setConnectProvider(undefined)
              setConnectModalOpen(true)
            }}
          >
            <IconPlusOutline16 size={14} />
            浏览全部提供商...
          </button>
        </div>
      </div>

      <div className={styles['addBlock']}>
        {addTarget !== undefined && addNamespace !== undefined
          ? (
            <div className={styles['addCard']}>
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>{t('provider')}</span>
                <select
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={addTarget.provider}
                  aria-label={t('provider')}
                  onChange={(event) => {
                    const row = addable.find(candidate => candidate.entry.provider === event.target.value)
                    /* v8 ignore next -- the select only lists addable rows */
                    if (row === undefined) return
                    setEditing(targetOf(row))
                  }}
                >
                  {addable.map(row => (
                    <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
                  ))}
                </select>
              </div>
              {renderProviderEditor({
                target: addTarget,
                namespace: addNamespace,
                schema,
                operations,
                t,
                readOnly: !state.writable,
                onClose: (changed) => { closeEditor(changed, addTarget) },
              })}
              {addRow === undefined
                ? null
                : renderSlot(
                  'settings.models.provider-card',
                  { provider: addRow.entry, configured: addRow.configured, keyConfigured: keyConfiguredOf(addRow) },
                  { entryKey: addRow.entry.settingsNs },
                )}
            </div>
          )
          : declaring
            ? (
              <div className={styles['addCard']}>
                <CustomProviderCard
                  taken={state.rows.map(row => row.entry.provider)}
                  protocols={protocols}
                  /* v8 ignore next -- the card only opens from a button disabled without this namespace */
                  revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0}
                  operations={operations}
                  t={t}
                  readOnly={!state.writable}
                  onClose={(changed) => {
                    setDeclaring(false)
                    if (changed) void controller.load()
                  }}
                />
              </div>
            )
            : (
              <div className={styles['addActions']}>
                <button
                  type="button"
                  className={styles['addButton']}
                  disabled={addable.length === 0 || !state.writable}
                  onClick={() => {
                    const first = addable[0]
                    /* v8 ignore next -- button is disabled when empty */
                    if (first === undefined) return
                    setSavedTarget(undefined)
                    setDeclaring(false)
                    setAdding(true)
                    setEditing(targetOf(first))
                  }}
                >
                  <IconPlusOutline16 size={14} />
                  {t('add')}
                </button>
                <button
                  type="button"
                  className={styles['addButton']}
                  disabled={protocols.length === 0 || !state.writable}
                  onClick={() => {
                    setSavedTarget(undefined)
                    setAdding(false)
                    setEditing(undefined)
                    setDeclaring(true)
                  }}
                >
                  <IconPlusOutline16 size={14} />
                  {t('customAdd')}
                </button>
              </div>
            )}
      </div>

      <ConnectProviderModal
        open={connectModalOpen}
        initialProvider={connectProvider}
        addable={addable}
        state={state}
        operations={operations}
        schema={schema}
        protocols={protocols}
        t={t}
        controller={controller}
        onClose={(changed, target) => {
          setConnectModalOpen(false)
          setConnectProvider(undefined)
          setAdding(false)
          if (changed && target) announceSaved(target)
        }}
      />

      <div style={{ display: 'none' }}>
        {addRow === undefined
          ? null
          : renderSlot(
            'settings.models.provider-card',
            { provider: addRow.entry, configured: addRow.configured, keyConfigured: keyConfiguredOf(addRow) },
            { entryKey: addRow.entry.settingsNs },
          )}
      </div>
      {renderSlot('settings.models.footer', {})}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
