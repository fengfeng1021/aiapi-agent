/**
 * OpenCode-aligned Connect Provider Modal Dialog.
 *
 * Provides OpenCode's multi-step provider connection flow:
 * 1. ProviderPicker: Search filterable list of providers grouped into 热门 (Popular) and 其他 (Other).
 * 2. MethodSelection: Multi-login connection options (Browser OAuth vs Headless vs API Key), exactly matching OpenCode UX.
 * 3. ApiAuthView: Dedicated API Key input with submission and status.
 * 4. OAuthView: Guidance and direct connection for account-based subscriptions.
 * 5. CustomProvider: Direct access to custom OpenAI-compatible provider setup.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Button, Modal, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import { deriveKeyRef } from './store.ts'
import type { en } from './locales.ts'
import type { ProviderIdentity } from './ModelsSection.tsx'
import styles from './ModelsSection.module.css'

export interface ProviderAuthOption {
  id: string
  name: string
  tag: string
  route: string
  authType: 'api-key' | 'oauth' | 'device-code'
  description: string
}

export interface ProviderItem {
  id: string
  name: string
  icon: string
  routes: string[]
  note?: string
  tag?: string
  isPopular?: boolean
  methods: ProviderAuthOption[]
}

export const OPENCODE_PROVIDERS: ProviderItem[] = [
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    icon: '🦙',
    routes: ['opencode'],
    note: '精选优化模型，包括 Claude、GPT、Gemini 等',
    tag: '推荐',
    isPopular: true,
    methods: [
      {
        id: 'opencode-zen',
        name: 'OpenCode Zen 官方接口',
        tag: '官方推荐',
        route: 'opencode',
        authType: 'api-key',
        description: 'OpenCode 官方全局 API 节点 (https://opencode.ai/zen)',
      },
    ],
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    icon: '⚡',
    routes: ['opencode-go'],
    note: '适合所有人的低成本极速直连订阅',
    tag: '推荐',
    isPopular: true,
    methods: [
      {
        id: 'opencode-go',
        name: 'OpenCode Go 直连节点',
        tag: '免翻直连',
        route: 'opencode-go',
        authType: 'api-key',
        description: 'OpenCode 官方极速节点，聚合百款主流模型',
      },
    ],
  },
  {
    id: 'aiapi',
    name: 'Aiapi 企业专线',
    icon: '🏢',
    routes: ['aiapi'],
    note: '默认企业专线中转接口 (https://aiapi.tw)',
    tag: '推荐',
    isPopular: true,
    methods: [
      {
        id: 'aiapi-key',
        name: 'Aiapi API 密钥',
        tag: 'API 密钥',
        route: 'aiapi',
        authType: 'api-key',
        description: '使用 Aiapi 企业专线 API Key (https://aiapi.tw)',
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '✳️',
    routes: ['openai', 'openai-codex'],
    note: '适合快速处理各类 AI 任务的 GPT 模型',
    isPopular: true,
    methods: [
      {
        id: 'openai-browser',
        name: 'ChatGPT Pro/Plus',
        tag: '浏览器',
        route: 'openai-codex',
        authType: 'oauth',
        description: '通过网页登录授权 ChatGPT Plus / Pro 订阅账号',
      },
      {
        id: 'openai-headless',
        name: 'ChatGPT Pro/Plus',
        tag: '无头模式',
        route: 'openai-codex',
        authType: 'device-code',
        description: '通过设备验证码进行 ChatGPT Plus / Pro 账号绑定',
      },
      {
        id: 'openai-key',
        name: 'API 密钥',
        tag: '浏览器',
        route: 'openai',
        authType: 'api-key',
        description: '使用 OpenAI 官方平台 API Key',
      },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: ' Claude',
    routes: ['anthropic'],
    note: '直接使用 Claude 模型，包括 Pro 和 Max',
    isPopular: true,
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
    id: 'antigravity',
    name: 'Google Antigravity',
    icon: '🔮',
    routes: ['antigravity'],
    note: 'Google Antigravity / Google One AI 訂閱會員專屬額度（含 Gemini 與 Claude 高階模型）',
    isPopular: true,
    methods: [
      {
        id: 'antigravity-oauth',
        name: 'Antigravity 會員授權',
        tag: '會員訂閱',
        route: 'antigravity',
        authType: 'oauth',
        description: '透過 Google 帳號授權，直接調用 Antigravity 官方高階 Gemini 與 Claude 訂閱配額',
      },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    icon: '✨',
    routes: ['google', 'google-vertex'],
    note: '官方 Google AI Studio API Key 與 Vertex AI',
    isPopular: true,
    methods: [
      {
        id: 'gemini-key',
        name: 'Gemini API 密鑰 (Google AI Studio)',
        tag: '免費獲取',
        route: 'google',
        authType: 'api-key',
        description: '使用 Google AI Studio 官方免費獲取的 Gemini API 密鑰 (AIzaSy...) 直連官方通道',
      },
      {
        id: 'vertex-key',
        name: 'Google Cloud Vertex AI',
        tag: '企業雲憑證',
        route: 'google-vertex',
        authType: 'api-key',
        description: '使用 Google Cloud Vertex AI 企業憑據與多區域配置',
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🐳',
    routes: ['deepseek', 'deepseek-official'],
    note: '推理能力卓越的官方模型',
    isPopular: true,
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
    icon: '𝕏',
    routes: ['xai'],
    note: 'Grok 系列模型与 X 订阅账号',
    isPopular: true,
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
    icon: '🐙',
    routes: ['github-copilot'],
    note: '通过 GitHub Copilot 使用辅助编程 AI 模型',
    isPopular: true,
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
    icon: '🌙',
    routes: ['kimi-coding', 'moonshotai', 'moonshotai-cn'],
    note: '月之暗面 Kimi 系列模型与 Coding 订阅',
    isPopular: true,
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
    icon: '🔀',
    routes: ['openrouter'],
    note: '通过一个提供商使用所有受支持的模型',
    isPopular: true,
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
    icon: '智',
    routes: ['zai-coding-cn', 'zai'],
    note: '智谱清言系列模型与 Coding 会员',
    isPopular: true,
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
    icon: '🎯',
    routes: ['minimax', 'minimax-cn'],
    note: 'MiniMax 官方模型开放接口',
    isPopular: true,
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
    icon: '🔮',
    routes: ['qwen-token-plan-cn', 'qwen-token-plan', 'qwen-token-plan-individual'],
    note: '阿里云百炼 / 通义千问 Token Plan',
    isPopular: true,
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
    icon: '📱',
    routes: ['xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'],
    note: '小米开放平台 MiMo API 接口',
    isPopular: true,
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
    icon: '🦙',
    routes: ['ollama'],
    note: '本地运行的 Ollama 服务 (免 API Key)',
    tag: '免 Key',
    isPopular: true,
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
    icon: '🖥️',
    routes: ['lmstudio'],
    note: '本地运行的 LM Studio 服务 (免 API Key)',
    tag: '免 Key',
    isPopular: true,
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
    id: 'custom',
    name: '自定义提供方',
    icon: '⚙️',
    routes: ['custom'],
    note: '自定义 OpenAI 兼容 API 端点',
    tag: '自定义',
    isPopular: true,
    methods: [
      {
        id: 'custom-endpoint',
        name: '自定义兼容接口',
        tag: '自定义',
        route: 'custom',
        authType: 'api-key',
        description: '配置任意兼容 OpenAI 规范的推理端点',
      },
    ],
  },
  // Other Group
  {
    id: 'groq',
    name: 'Groq',
    icon: '⚡',
    routes: ['groq'],
    note: 'Groq LPU 超高速推理平台',
    isPopular: false,
    methods: [
      {
        id: 'groq-key',
        name: 'Groq API 密钥',
        tag: 'API 密钥',
        route: 'groq',
        authType: 'api-key',
        description: 'Groq 开发者平台 API Key',
      },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    icon: '🌪️',
    routes: ['mistral'],
    note: 'Mistral 官方平台 API Key',
    isPopular: false,
    methods: [
      {
        id: 'mistral-key',
        name: 'Mistral API 密钥',
        tag: 'API 密钥',
        route: 'mistral',
        authType: 'api-key',
        description: 'Mistral AI 开放平台 API Key',
      },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    icon: '🤝',
    routes: ['together'],
    note: 'Together AI 开发者平台',
    isPopular: false,
    methods: [
      {
        id: 'together-key',
        name: 'Together API 密钥',
        tag: 'API 密钥',
        route: 'together',
        authType: 'api-key',
        description: 'Together AI 开发者平台 API Key',
      },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    icon: '🎆',
    routes: ['fireworks'],
    note: 'Fireworks AI 推理平台',
    isPopular: false,
    methods: [
      {
        id: 'fireworks-key',
        name: 'Fireworks API 密钥',
        tag: 'API 密钥',
        route: 'fireworks',
        authType: 'api-key',
        description: 'Fireworks AI 推理平台 API Key',
      },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    icon: '🧠',
    routes: ['cerebras'],
    note: 'Cerebras 超高吞吐推理平台',
    isPopular: false,
    methods: [
      {
        id: 'cerebras-key',
        name: 'Cerebras API 密钥',
        tag: 'API 密钥',
        route: 'cerebras',
        authType: 'api-key',
        description: 'Cerebras 官方平台 API Key',
      },
    ],
  },
]

function getProviderPortalLink(providerId: string, route?: string): { url: string; label: string } | undefined {
  if (providerId === 'openai') {
    return {
      url: 'https://platform.openai.com/api-keys',
      label: '前往 OpenAI 平台获取 API 密钥 ↗',
    }
  }
  if (providerId === 'google') {
    if (route === 'google-vertex') {
      return {
        url: 'https://console.cloud.google.com/vertex-ai',
        label: '前往 Google Cloud Vertex AI 控制台 ↗',
      }
    }
    return {
      url: 'https://aistudio.google.com/app/apikey',
      label: '前往 Google AI Studio 免费获取 Gemini API 密钥 ↗',
    }
  }
  if (providerId === 'anthropic') {
    return {
      url: 'https://console.anthropic.com/settings/keys',
      label: '前往 Anthropic Console 获取 API 密钥 ↗',
    }
  }
  if (providerId === 'deepseek') {
    return {
      url: 'https://platform.deepseek.com/api_keys',
      label: '前往 DeepSeek 开放平台获取 API 密钥 ↗',
    }
  }
  if (providerId === 'xai') {
    return {
      url: 'https://console.x.ai/',
      label: '前往 xAI Console 获取 API 密钥 ↗',
    }
  }
  if (providerId === 'openrouter') {
    return {
      url: 'https://openrouter.ai/keys',
      label: '前往 OpenRouter 控制台获取 API 密钥 ↗',
    }
  }
  return undefined
}

interface OAuthProviderConfig {
  clientId: string
  clientSecret?: string
  authorizeUrl: string
  tokenUrl: string
  redirectUri: string
  scope: string
  guideName: string
  helpText: string
  placeholder: string
  rtKeyName: string
}

const OAUTH_CONFIGS: Record<string, OAuthProviderConfig> = {
  antigravity: {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    redirectUri: 'http://localhost:8085/callback',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
    guideName: 'Google Antigravity',
    helpText: '請在新標籤頁中開啟授權連結，登入您的 Google 賬戶完成 Antigravity 授權。',
    placeholder: 'http://localhost:8085/callback?code=...',
    rtKeyName: 'ANTIGRAVITY_REFRESH_TOKEN',
  },
  anthropic: {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    guideName: 'Claude (Anthropic)',
    helpText: '請在瀏覽器中開啟授權連結，登入您的 Claude 官方會員帳號完成授權。',
    placeholder: 'https://platform.claude.com/oauth/code/callback?code=...',
    rtKeyName: 'CLAUDE_REFRESH_TOKEN',
  },
  openai: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    guideName: 'ChatGPT (OpenAI)',
    helpText: '請在瀏覽器中開啟授權連結，登入您的 ChatGPT Plus / Pro 帳號完成授權。',
    placeholder: 'http://localhost:1455/auth/callback?code=...',
    rtKeyName: 'OPENAI_REFRESH_TOKEN',
  },
  'openai-codex': {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    guideName: 'ChatGPT (OpenAI)',
    helpText: '請在瀏覽器中開啟授權連結，登入您的 ChatGPT Plus / Pro 帳號完成授權。',
    placeholder: 'http://localhost:1455/auth/callback?code=...',
    rtKeyName: 'OPENAI_REFRESH_TOKEN',
  },
  xai: {
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    authorizeUrl: 'https://auth.x.ai/oauth2/authorize',
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    redirectUri: 'http://127.0.0.1:56121/callback',
    scope: 'openid profile email offline_access grok-cli:access api:access',
    guideName: 'xAI (Grok)',
    helpText: '請在瀏覽器中開啟授權連結，登入您的 X / Grok Premium 帳號完成授權。',
    placeholder: 'http://127.0.0.1:56121/callback?code=...',
    rtKeyName: 'XAI_REFRESH_TOKEN',
  },
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32)
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  const verifier = base64Url(bytes)
  if (typeof window !== 'undefined' && window.crypto?.subtle?.digest) {
    const encoder = new TextEncoder()
    const data = encoder.encode(verifier)
    const hash = await window.crypto.subtle.digest('SHA-256', data)
    const challenge = base64Url(new Uint8Array(hash))
    return { verifier, challenge }
  }
  return { verifier, challenge: verifier }
}

function buildOAuthUrl(providerId: string, challenge?: string, customState?: string): string {
  const cfg = OAUTH_CONFIGS[providerId]
  if (!cfg) return 'https://github.com/login/device'

  const state = customState || (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))
  const c = challenge || 'tjZE1its1kQ9ITibo-YEyJByrVX1tZYipPQw4KRR6dA'
  const redirectUri = encodeURIComponent(cfg.redirectUri)
  const scope = encodeURIComponent(cfg.scope)

  if (providerId === 'antigravity') {
    return `${cfg.authorizeUrl}?access_type=offline&client_id=${cfg.clientId}&code_challenge=${c}&code_challenge_method=S256&include_granted_scopes=true&prompt=consent&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}`
  }
  return `${cfg.authorizeUrl}?client_id=${cfg.clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${scope}&code_challenge=${c}&code_challenge_method=S256&state=${state}`
}

export interface ConnectProviderModalProps {
  open: boolean
  initialStep?: ('picker' | 'methods' | 'apiKey' | 'oauth' | 'custom') | undefined
  initialProvider?: string | undefined
  addable: readonly ProviderRow[]
  state: {
    rows: readonly ProviderRow[]
    writable: boolean
    namespaces: ReadonlyMap<string, { revision: number; value?: unknown }>
  }
  operations: ModelsOperations
  schema: SettingsSchemaOperations
  protocols: readonly string[]
  t: (key: keyof typeof en, vars?: Record<string, string>) => string
  onClose: (changed: boolean, target?: ProviderIdentity | undefined) => void
  controller: ModelsSettingsStore
}

export function ConnectProviderModal({
  open,
  initialStep = 'picker',
  initialProvider,
  addable,
  state,
  operations,
  schema: _schema,
  protocols,
  t,
  onClose,
  controller,
}: ConnectProviderModalProps): ReactNode {
  const [step, setStep] = useState<'picker' | 'methods' | 'apiKey' | 'oauth' | 'custom'>(initialStep)
  const [search, setSearch] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<ProviderItem | undefined>(undefined)
  const [selectedMethod, setSelectedMethod] = useState<ProviderAuthOption | undefined>(undefined)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [oauthCodeDraft, setOauthCodeDraft] = useState('')
  const [vertexProject, setVertexProject] = useState('')
  const [vertexLocation, setVertexLocation] = useState('us-central1')
  const [copied, setCopied] = useState(false)
  const [oauthAuthMethod, setOauthAuthMethod] = useState<'manual' | 'rt'>('manual')
  const [oauthRtDraft, setOauthRtDraft] = useState('')
  const [oauthVerifier, setOauthVerifier] = useState<string>('')
  const [oauthChallenge, setOauthChallenge] = useState<string>('')
  const [oauthGeneratedUrl, setOauthGeneratedUrl] = useState<string>('')
  const [urlCopied, setUrlCopied] = useState(false)
  const [obtainedRt, setObtainedRt] = useState<string | undefined>(undefined)
  const [rtCopied, setRtCopied] = useState(false)
  const [exchangeNotice, setExchangeNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  const refreshPkce = useCallback(async (providerId: string = selectedProvider?.id || 'antigravity') => {
    setError(undefined)
    setExchangeNotice(undefined)
    try {
      const pair = await generatePkce()
      setOauthVerifier(pair.verifier)
      setOauthChallenge(pair.challenge)
      setOauthGeneratedUrl(buildOAuthUrl(providerId, pair.challenge))
    } catch {
      // fallback
    }
  }, [selectedProvider?.id])

  useEffect(() => {
    if (open) {
      void refreshPkce(selectedProvider?.id || 'antigravity')
    }
  }, [open, selectedProvider?.id, refreshPkce])

  useEffect(() => {
    if (!open) return
    if (initialProvider === 'custom') {
      setStep('custom')
      setSelectedProvider(undefined)
      setSelectedMethod(undefined)
      return
    }
    if (initialProvider) {
      const found = OPENCODE_PROVIDERS.find(p => p.id === initialProvider || p.routes.includes(initialProvider))
      if (found) {
        setSelectedProvider(found)
        if (found.methods.length > 1) {
          setStep('methods')
          setSelectedMethod(found.methods[0])
        } else {
          const m = found.methods[0]
          setSelectedMethod(m)
          if (m?.authType === 'oauth' || m?.authType === 'device-code') {
            setStep('oauth')
          } else {
            setStep('apiKey')
          }
        }
        return
      }
    }
    setStep(initialStep)
    setSelectedProvider(undefined)
    setSelectedMethod(undefined)
  }, [open, initialProvider, initialStep])

  // Reset when closed or opened
  const handleClose = (): void => {
    setStep(initialStep)
    setSearch('')
    setSelectedProvider(undefined)
    setSelectedMethod(undefined)
    setApiKeyDraft('')
    setError(undefined)
    onClose(false)
  }

  const goBack = (): void => {
    setError(undefined)
    if (step === 'apiKey' || step === 'oauth') {
      if (selectedProvider && selectedProvider.methods.length > 1) {
        setStep('methods')
        return
      }
      setStep('picker')
      return
    }
    if (step === 'methods' || step === 'custom') {
      setStep('picker')
      return
    }
    onClose(false)
  }

  // Filtered providers
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return OPENCODE_PROVIDERS
    return OPENCODE_PROVIDERS.filter(p =>
      p.name.toLowerCase().includes(q)
      || p.id.toLowerCase().includes(q)
      || (p.note && p.note.toLowerCase().includes(q)),
    )
  }, [search])

  const popular = useMemo(() => filtered.filter(p => p.isPopular), [filtered])
  const other = useMemo(() => filtered.filter(p => !p.isPopular), [filtered])

  const handleSelectProvider = (item: ProviderItem): void => {
    setSelectedProvider(item)
    setError(undefined)
    if (item.id === 'custom') {
      setStep('custom')
      return
    }
    if (item.methods.length > 1) {
      setSelectedMethod(item.methods[0])
      setStep('methods')
      return
    }
    const singleMethod = item.methods[0]
    if (singleMethod) {
      setSelectedMethod(singleMethod)
      if (singleMethod.authType === 'oauth' || singleMethod.authType === 'device-code') {
        setStep('oauth')
      } else {
        setStep('apiKey')
      }
    }
  }

  const handleSelectMethod = (method: ProviderAuthOption): void => {
    setSelectedMethod(method)
    setError(undefined)
    if (method.authType === 'oauth' || method.authType === 'device-code') {
      setStep('oauth')
    } else {
      setStep('apiKey')
    }
  }

  const handleConnect = async (provider?: ProviderItem, method?: ProviderAuthOption): Promise<void> => {
    const p = provider || selectedProvider
    const m = method || selectedMethod
    if (!p || !m) return

    setSubmitting(true)
    setError(undefined)

    try {
      const route = m.route
      const matchingRow = state.rows.find(r => r.entry.provider === route)
        ?? addable.find(r => r.entry.provider === route)
      const availableNs = Array.from(state.namespaces.keys())
      const ns = matchingRow?.entry.settingsNs
        ?? (state.namespaces.has('llm-pi-ai') ? 'llm-pi-ai' : (availableNs[0] ?? 'llm-pi-ai'))
      const settingsPath = (matchingRow?.entry.settingsPath && matchingRow.entry.settingsPath.length > 0)
        ? matchingRow.entry.settingsPath
        : (ns === 'llm-deepseek' ? [] : ['providers', route])
      const keyRef = deriveKeyRef(route)
      const expectedRevision = state.namespaces.get(ns)?.revision ?? 0

      // Determine key / token to store
      let keyToStore = apiKeyDraft.trim()
      let newlyExchangedRt: string | undefined = undefined

      const cfg = OAUTH_CONFIGS[p.id]
      if (cfg && (m.authType === 'oauth' || m.authType === 'device-code' || p.id === 'antigravity')) {
        if (oauthAuthMethod === 'rt') {
          const rt = oauthRtDraft.trim()
          if (!rt) {
            setError('請輸入 Refresh Token (RT)')
            return
          }
          setExchangeNotice(`正在向 ${cfg.guideName} 驗證並刷新 Access Token...`)
          try {
            const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3080'
            const refreshParams: Record<string, string> = {
              client_id: cfg.clientId,
              refresh_token: rt,
              grant_type: 'refresh_token',
            }
            if (cfg.clientSecret) refreshParams.client_secret = cfg.clientSecret

            let data: { access_token?: string; error?: string; error_description?: string } = {}
            try {
              const resp = await fetch(`${origin}/api/oauth/exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  tokenUrl: cfg.tokenUrl,
                  params: refreshParams,
                }),
              })
              data = await resp.json() as typeof data
            } catch {
              const resp = await fetch(cfg.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(refreshParams),
              })
              data = await resp.json() as typeof data
            }

            if (data.access_token) {
              keyToStore = data.access_token
              setObtainedRt(rt)
              void operations.storeCredential(cfg.rtKeyName, rt)
            } else {
              keyToStore = rt
            }
          } catch {
            keyToStore = rt
          }
        } else {
          // Manual Code mode: automatically exchange code for Refresh Token & Access Token!
          let code = oauthCodeDraft.trim()
          if (!code) {
            setError(`請先在瀏覽器登入 ${cfg.guideName} 獲取授權碼並貼入上方輸入框`)
            return
          }
          if (code.includes('code=')) {
            try {
              const parsedUrl = new URL(code.startsWith('http') ? code : `http://localhost?${code}`)
              code = parsedUrl.searchParams.get('code') ?? code
            } catch {
              // ignore
            }
          }

          setExchangeNotice(`正在向 ${cfg.guideName} 官方伺服器換取授權 Token...`)
          try {
            const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3080'
            const exchangeParams: Record<string, string> = {
              client_id: cfg.clientId,
              code: code,
              grant_type: 'authorization_code',
              redirect_uri: cfg.redirectUri,
              code_verifier: oauthVerifier,
            }
            if (cfg.clientSecret) exchangeParams.client_secret = cfg.clientSecret

            let data: { access_token?: string; refresh_token?: string; error?: string; error_description?: string } = {}
            try {
              const resp = await fetch(`${origin}/api/oauth/exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  tokenUrl: cfg.tokenUrl,
                  params: exchangeParams,
                }),
              })
              data = await resp.json() as typeof data
            } catch {
              const resp = await fetch(cfg.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(exchangeParams),
              })
              data = await resp.json() as typeof data
            }

            if (!data.access_token && !data.refresh_token) {
              setError(`${cfg.guideName} 授權換取失敗: ${data.error_description || data.error || '無效的授權碼或已過期'}`)
              return
            }
            keyToStore = data.access_token || code
            if (data.refresh_token) {
              newlyExchangedRt = data.refresh_token
              setObtainedRt(data.refresh_token)
              void operations.storeCredential(cfg.rtKeyName, data.refresh_token)
            }
          } catch (err) {
            setError(`向 ${cfg.guideName} 伺服器發送換取請求失敗: ${err instanceof Error ? err.message : String(err)}`)
            return
          }
        }
      } else if (oauthCodeDraft.trim()) {
        const raw = oauthCodeDraft.trim()
        if (raw.includes('code=')) {
          try {
            const parsedUrl = new URL(raw.startsWith('http') ? raw : `http://localhost?${raw}`)
            keyToStore = parsedUrl.searchParams.get('code') ?? raw
          } catch {
            keyToStore = raw
          }
        } else {
          keyToStore = raw
        }
      } else if (m.authType === 'oauth') {
        keyToStore = 'oauth-granted-token'
      }

      // Register profile in settings if namespace is registered and writable
      if (state.namespaces.has(ns) && state.writable) {
        const currentNamespace = state.namespaces.get(ns)?.value as Record<string, unknown> | undefined
        const currentProviders = (currentNamespace?.providers as Record<string, unknown> | undefined) ?? {}
        const existingProfile = (currentProviders[route] as Record<string, unknown> | undefined) ?? {}
        let profileValue: Record<string, unknown> = {
          ...existingProfile,
          ...(keyToStore ? { apiKeyEnv: keyRef } : {}),
        }

        if (ns === 'llm-deepseek') {
          profileValue = {
            ...currentNamespace,
            ...(keyToStore ? { apiKeyEnv: keyRef } : {}),
          }
        } else if (p.id === 'antigravity' || route === 'antigravity' || (p.id === 'google' && m.id === 'gemini-antigravity')) {
          const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3080'
          profileValue.displayName = 'Google Antigravity'
          profileValue.api = 'google-generative-ai'
          profileValue.baseURL = `${origin}/api/antigravity/v1beta`
          profileValue.apiKeyEnv = 'GOOGLE_API_KEY'
          profileValue.models = [
            {
              id: 'gemini-3.7-flash',
              name: 'Gemini 3.7 Flash',
              contextWindow: 1048576,
              maxTokens: 65536,
              reasoningEfforts: { off: null, low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
            },
            {
              id: 'gemini-3.6-flash-high',
              name: 'Gemini 3.6 Flash High',
              contextWindow: 1048576,
              maxTokens: 65536,
              reasoningEfforts: { off: null, low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
            },
            {
              id: 'gemini-pro-agent',
              name: 'Gemini 2.5 Pro',
              contextWindow: 1048576,
              maxTokens: 65536,
              reasoningEfforts: { off: null, low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
            },
            {
              id: 'claude-sonnet-4-6',
              name: 'Claude 3.7 Sonnet',
              contextWindow: 200000,
              maxTokens: 65536,
              reasoningEfforts: { off: null, low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
            },
            {
              id: 'claude-opus-4-6-thinking',
              name: 'Claude 3.7 Opus (Thinking)',
              contextWindow: 200000,
              maxTokens: 65536,
              reasoningEfforts: { off: null, low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
            },
            {
              id: 'gpt-oss-120b-medium',
              name: 'GPT-OSS 120B',
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ]
        } else if (p.id === 'aiapi' || route === 'aiapi') {
          profileValue.displayName = 'Aiapi 企业专线'
          profileValue.api = 'openai-completions'
          profileValue.baseURL = 'https://aiapi.tw'
          profileValue.apiKeyEnv = keyRef || 'AIAPI_API_KEY'
          profileValue.models = [
            {
              id: 'gemini-3.6-flash',
              name: 'Gemini 3.6 Flash',
              contextWindow: 1048576,
              maxTokens: 65536,
              reasoningEfforts: { high: 'high', medium: 'medium', low: 'low', minimal: 'minimal' },
            },
            {
              id: 'gemini-3.1-pro-preview',
              name: 'Gemini 3.1 Pro Preview',
              contextWindow: 1048576,
              maxTokens: 65536,
              reasoningEfforts: { high: 'high', medium: 'medium', low: 'low' },
            },
            {
              id: 'claude-3-7-sonnet',
              name: 'Claude 3.7 Sonnet',
              contextWindow: 200000,
              maxTokens: 65536,
            },
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              contextWindow: 128000,
              maxTokens: 16384,
            },
            {
              id: 'deepseek-reasoner',
              name: 'DeepSeek R1',
              contextWindow: 65536,
              maxTokens: 8192,
            },
            {
              id: 'deepseek-chat',
              name: 'DeepSeek V3',
              contextWindow: 65536,
              maxTokens: 8192,
            },
          ]
        } else if (p.id === 'anthropic' || route === 'anthropic') {
          profileValue.displayName = 'Anthropic'
          profileValue.api = 'anthropic-messages'
          profileValue.apiKeyEnv = 'ANTHROPIC_API_KEY'
        } else if (p.id === 'openai' || route === 'openai' || route === 'openai-codex') {
          profileValue.displayName = 'OpenAI'
          profileValue.api = 'openai-completions'
          profileValue.apiKeyEnv = 'OPENAI_API_KEY'
        } else if (p.id === 'xai' || route === 'xai') {
          profileValue.displayName = 'xAI (Grok)'
          profileValue.api = 'openai-completions'
          profileValue.baseURL = 'https://api.x.ai/v1'
          profileValue.apiKeyEnv = 'XAI_API_KEY'
        } else if (p.id === 'kimi' || route === 'kimi-coding' || route === 'moonshotai' || route === 'moonshotai-cn') {
          profileValue.displayName = 'Kimi (月之暗面)'
          profileValue.api = 'openai-completions'
          profileValue.baseURL = 'https://api.moonshot.cn/v1'
          profileValue.apiKeyEnv = 'MOONSHOT_API_KEY'
        } else if (p.id === 'zai' || route === 'zai-coding-cn' || route === 'zai') {
          profileValue.displayName = 'Z.AI (智谱清言)'
          profileValue.api = 'openai-completions'
          profileValue.baseURL = 'https://open.bigmodel.cn/api/paas/v4'
          profileValue.apiKeyEnv = 'ZAI_API_KEY'
        } else if (p.id === 'ollama' || route === 'ollama') {
          profileValue.displayName = 'Ollama'
          profileValue.api = 'openai-completions'
          profileValue.baseURL = 'http://localhost:11434/v1'
          if (!profileValue.models || !(profileValue.models as unknown[]).length) {
            profileValue.models = [
              { id: 'llama3', name: 'Llama 3', contextWindow: 8192, maxTokens: 4096 },
              { id: 'deepseek-r1', name: 'DeepSeek R1 (Ollama)', contextWindow: 65536, maxTokens: 8192 },
              { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', contextWindow: 32768, maxTokens: 8192 },
            ]
          }
        } else if (p.id === 'lmstudio' || route === 'lmstudio') {
          profileValue.displayName = 'LM Studio'
          profileValue.api = 'openai-completions'
          profileValue.baseURL = 'http://localhost:1234/v1'
          if (!profileValue.models || !(profileValue.models as unknown[]).length) {
            profileValue.models = [
              { id: 'default', name: 'LM Studio Default Model', contextWindow: 32768, maxTokens: 8192 },
            ]
          }
        } else if (p.id === 'custom') {
          profileValue.api = 'openai-completions'
        }
        const ops: SettingsPathOpView[] = [{ op: 'set', path: [...settingsPath], value: profileValue as unknown as JsonValue }]
        const written = await operations.writeSettings(ns, ops, expectedRevision)
        if (written.kind !== 'written') {
          setError(written.kind === 'conflict' ? t('conflict') : written.message)
          return
        }
      }

      // If key or code is available, store credential
      if (keyToStore) {
        const stored = await operations.storeCredential(keyRef, keyToStore)
        if (stored !== undefined) {
          setError(stored)
          return
        }
        if (route === 'google' && keyRef !== 'GOOGLE_API_KEY') {
          void operations.storeCredential('GOOGLE_API_KEY', keyToStore)
        }
        if (route === 'google' && keyRef !== 'GEMINI_API_KEY') {
          void operations.storeCredential('GEMINI_API_KEY', keyToStore)
        }
      }

      // Reload controller & notify
      await controller.load()
      const finalDisplayName = selectedProvider?.name ?? p.name
      if (newlyExchangedRt) {
        setExchangeNotice('🎉 授權成功！已成功換取 Refresh Token。')
        setTimeout(() => {
          onClose(true, { provider: route, displayName: finalDisplayName })
        }, 2500)
      } else {
        onClose(true, { provider: route, displayName: finalDisplayName })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const renderPicker = (): ReactNode => (
    <div className={styles['pickerContainer']}>
      <select
        className={styles['selectInput']}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        value={selectedProvider?.id ?? (addable[0]?.entry.provider ?? '')}
        aria-label={t('provider')}
        onChange={() => {}}
      >
        {addable.map(row => (
          <option key={row.entry.provider} value={row.entry.provider}>
            {row.entry.displayName}
          </option>
        ))}
      </select>
      <input
        type="password"
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        aria-label={t('keyInput')}
        value={apiKeyDraft}
        onChange={() => {}}
      />
      <div className={styles['pickerSearchWrapper']}>
        <span className={styles['pickerSearchIcon']}>🔍</span>
        <input
          type="text"
          className={styles['pickerSearchInput']}
          placeholder="搜索提供商"
          value={search}
          autoFocus
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className={styles['pickerScrollArea']}>
        {popular.length > 0 && (
          <div className={styles['pickerGroup']}>
            <div className={styles['pickerGroupTitle']}>热门</div>
            <div className={styles['pickerList']}>
              {popular.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles['pickerItem']} ${styles['pickerItemBtn']}`}
                  onClick={() => handleSelectProvider(item)}
                >
                  <div className={styles['pickerItemLeft']}>
                    <div className={styles['pickerItemIcon']}>{item.icon}</div>
                    <div>
                      <div className={styles['pickerItemName']}>{item.name}</div>
                      {item.note && <div className={styles['pickerItemDesc']}>{item.note}</div>}
                    </div>
                  </div>
                  {item.tag && (
                    <span className={`${styles['pickerItemTag']} ${item.tag === '推荐' ? styles['pickerItemTagRecommended'] : ''}`}>
                      {item.tag}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {other.length > 0 && (
          <div className={styles['pickerGroup']}>
            <div className={styles['pickerGroupTitle']}>其他</div>
            <div className={styles['pickerList']}>
              {other.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles['pickerItem']} ${styles['pickerItemBtn']}`}
                  onClick={() => handleSelectProvider(item)}
                >
                  <div className={styles['pickerItemLeft']}>
                    <div className={styles['pickerItemIcon']}>{item.icon}</div>
                    <div>
                      <div className={styles['pickerItemName']}>{item.name}</div>
                      {item.note && <div className={styles['pickerItemDesc']}>{item.note}</div>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {filtered.length === 0 && (
          <div className={styles['pickerEmpty']}>未找到匹配的提供商</div>
        )}
      </div>
    </div>
  )

  const renderMethods = (): ReactNode => {
    if (!selectedProvider) return null
    return (
      <div className={styles['modalContentBox']}>
        <p className={styles['authSubtitle']}>选择 {selectedProvider.name} 的登录方式。</p>
        <div className={styles['authOptionList']}>
          {selectedProvider.methods.map(method => (
            <div
              key={method.id}
              className={styles['methodChoiceRow']}
              onClick={() => handleSelectMethod(method)}
            >
              <div className={styles['methodChoiceLeft']}>
                <div className={styles['methodPillIndicator']} />
                <span className={styles['methodName']}>{method.name}</span>
              </div>
              <span className={styles['methodTag']}>{method.tag}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderApiKey = (): ReactNode => {
    if (!selectedProvider || !selectedMethod) return null
    const portal = getProviderPortalLink(selectedProvider.id, selectedMethod.route)
    const isVertex = selectedMethod.route === 'google-vertex'

    return (
      <form
        className={styles['modalContentBox']}
        onSubmit={(e) => {
          e.preventDefault()
          void handleConnect()
        }}
      >
        <p className={styles['authSubtitle']}>
          输入你的 {selectedProvider.name} {isVertex ? 'Vertex AI 云凭证' : 'API 密钥'}以连接账户，并在系统中使用 {selectedProvider.name} 模型。
        </p>

        {portal && (
          <div style={{ marginBottom: 12 }}>
            <a
              href={portal.url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                color: 'var(--dsw-alias-link, #3b82f6)',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              {portal.label}
            </a>
          </div>
        )}

        {isVertex ? (
          <>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>Google Cloud 项目 ID (Project ID)</span>
              <input
                type="text"
                className={styles['input']}
                placeholder="例如: my-gcp-project-id"
                value={vertexProject}
                onChange={e => setVertexProject(e.target.value)}
              />
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>区域 (Location)</span>
              <input
                type="text"
                className={styles['input']}
                placeholder="us-central1"
                value={vertexLocation}
                onChange={e => setVertexLocation(e.target.value)}
              />
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>API 密钥或服务账号凭据 (可选)</span>
              <input
                type="password"
                className={styles['input']}
                placeholder="Google Vertex API 密钥或 JSON 密钥内容"
                aria-label={t('keyInput')}
                value={apiKeyDraft}
                autoComplete="off"
                onChange={e => setApiKeyDraft(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{selectedProvider.name} API 密钥</span>
            <input
              type="password"
              className={styles['input']}
              placeholder={selectedProvider.id === 'google' ? 'AIzaSy...' : selectedProvider.id === 'openai' ? 'sk-...' : 'API 密钥'}
              aria-label={t('keyInput')}
              value={apiKeyDraft}
              autoFocus
              autoComplete="off"
              onChange={e => setApiKeyDraft(e.target.value)}
            />
          </div>
        )}

        {error && <p className={styles['error']}>{error}</p>}

        <div className={styles['modalFooterRow']}>
          <Button variant="outline" type="button" onClick={goBack}>
            返回
          </Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? '连接中...' : '继续'}
          </Button>
        </div>
      </form>
    )
  }

  const renderOAuth = (): ReactNode => {
    if (!selectedProvider || !selectedMethod) return null

    const cfg = OAUTH_CONFIGS[selectedProvider.id]

    // Unified 3-Step Interactive OAuth Workflow for Antigravity, Claude, OpenAI, and Grok
    if (cfg) {
      const authUrl = oauthGeneratedUrl || buildOAuthUrl(selectedProvider.id, oauthChallenge)
      return (
        <div className={styles['modalContentBox']}>
          {/* Authorization Method Toggle */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 6 }}>
              Authorization Method
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                style={{
                  flex: 1,
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: '1px solid',
                  borderColor: oauthAuthMethod === 'manual' ? 'var(--dsw-alias-fill-brand-secondary, #2563eb)' : 'var(--dsw-alias-border-l2, #ddd)',
                  backgroundColor: oauthAuthMethod === 'manual' ? 'var(--dsw-alias-surface-secondary, rgba(37,99,235,0.08))' : 'transparent',
                  color: oauthAuthMethod === 'manual' ? 'var(--dsw-alias-fill-brand-secondary, #2563eb)' : 'inherit',
                  fontWeight: oauthAuthMethod === 'manual' ? 600 : 400,
                  fontSize: 13,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onClick={() => setOauthAuthMethod('manual')}
              >
                手動授權 (PKCE)
              </button>
              <button
                type="button"
                style={{
                  flex: 1,
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: '1px solid',
                  borderColor: oauthAuthMethod === 'rt' ? 'var(--dsw-alias-fill-brand-secondary, #2563eb)' : 'var(--dsw-alias-border-l2, #ddd)',
                  backgroundColor: oauthAuthMethod === 'rt' ? 'var(--dsw-alias-surface-secondary, rgba(37,99,235,0.08))' : 'transparent',
                  color: oauthAuthMethod === 'rt' ? 'var(--dsw-alias-fill-brand-secondary, #2563eb)' : 'inherit',
                  fontWeight: oauthAuthMethod === 'rt' ? 600 : 400,
                  fontSize: 13,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onClick={() => setOauthAuthMethod('rt')}
              >
                手動輸入 RT / Token
              </button>
            </div>
          </div>

          {oauthAuthMethod === 'manual' ? (
            <div>
              <p style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary, #333)', marginBottom: 14 }}>
                請按照以下步驟完成 {cfg.guideName} 官方賬戶的授權：
              </p>

              {/* 步驟 1 */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: 'var(--dsw-alias-fill-brand-secondary, #2563eb)',
                    color: '#ffffff',
                    fontSize: 11,
                    fontWeight: 700,
                  }}>
                    1
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>生成授權連結</span>
                </div>
                <div style={{
                  padding: '8px 10px',
                  backgroundColor: 'var(--dsw-alias-surface-secondary, rgba(0,0,0,0.04))',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
                  fontSize: 11,
                  lineHeight: '16px',
                  wordBreak: 'break-all',
                  maxHeight: 72,
                  overflowY: 'auto',
                  fontFamily: 'Consolas, Monaco, monospace',
                  color: 'var(--dsw-alias-label-secondary, #4b5563)',
                  marginBottom: 8,
                }}>
                  {authUrl}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '4px 10px',
                      fontSize: 12,
                      borderRadius: 4,
                      border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
                      backgroundColor: 'transparent',
                      cursor: 'pointer',
                      color: 'var(--dsw-alias-label-primary, inherit)',
                    }}
                    onClick={() => {
                      void navigator.clipboard.writeText(authUrl)
                      setUrlCopied(true)
                      setTimeout(() => setUrlCopied(false), 2000)
                    }}
                  >
                    {urlCopied ? '✓ 已複製' : '📋 複製連結'}
                  </button>
                  <button
                    type="button"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '4px 10px',
                      fontSize: 12,
                      borderRadius: 4,
                      border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
                      backgroundColor: 'transparent',
                      cursor: 'pointer',
                      color: 'var(--dsw-alias-label-primary, inherit)',
                    }}
                    onClick={() => void refreshPkce(selectedProvider.id)}
                  >
                    🔄 重新生成
                  </button>
                </div>
              </div>

              {/* 步驟 2 */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: 'var(--dsw-alias-fill-brand-secondary, #2563eb)',
                    color: '#ffffff',
                    fontSize: 11,
                    fontWeight: 700,
                  }}>
                    2
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>在瀏覽器中開啟連結並完成授權</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', margin: '0 0 8px 0' }}>
                  {cfg.helpText}
                </p>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 14px',
                    backgroundColor: 'var(--dsw-alias-fill-brand-secondary, #2563eb)',
                    color: '#ffffff',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    textDecoration: 'none',
                  }}
                >
                  <span>🌐 前往瀏覽器開啟授權連結 ↗</span>
                </a>
              </div>

              {/* 步驟 3 */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: 'var(--dsw-alias-fill-brand-secondary, #2563eb)',
                    color: '#ffffff',
                    fontSize: 11,
                    fontWeight: 700,
                  }}>
                    3
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>輸入授權連結或 Code</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', margin: '0 0 8px 0' }}>
                  授權完成後，當瀏覽器跳轉至回調頁面時：
                </p>
                <div className={styles['field']}>
                  <input
                    type="text"
                    className={styles['input']}
                    placeholder={cfg.placeholder}
                    value={oauthCodeDraft}
                    onChange={e => setOauthCodeDraft(e.target.value)}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', lineHeight: '18px', marginTop: 6 }}>
                  <div>方式1：複製瀏覽器位址列中完整的跳轉連結</div>
                  <div>方式2：僅複製 <code>code</code> 引數的值</div>
                  <div style={{ color: 'var(--dsw-alias-fill-brand-secondary, #2563eb)', marginTop: 2 }}>
                    💡 點選下方按鈕後，系統將自動向官方伺服器換取長期 Refresh Token 與存取憑證。
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 16 }}>
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>Refresh Token (RT) / 憑據</span>
                <input
                  type="password"
                  className={styles['input']}
                  placeholder={`請輸入 ${cfg.guideName} 的長期 Refresh Token`}
                  value={oauthRtDraft}
                  autoFocus
                  onChange={e => setOauthRtDraft(e.target.value)}
                />
              </div>
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', lineHeight: '18px', marginTop: 6 }}>
                💡 請輸入您手動獲取的 Refresh Token，系統將自動向官方伺服器刷新 Access Token 並連線。
              </div>
            </div>
          )}

          {exchangeNotice && (
            <div style={{
              margin: '10px 0',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--dsw-alias-fill-brand-secondary, #2563eb)',
              backgroundColor: 'rgba(37,99,235,0.08)',
              border: '1px solid rgba(37,99,235,0.2)',
            }}>
              ⏳ {exchangeNotice}
            </div>
          )}

          {obtainedRt && (
            <div style={{
              margin: '12px 0',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #22c55e',
              backgroundColor: 'rgba(34, 197, 94, 0.08)',
            }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#16a34a', marginBottom: 4 }}>
                🎉 系統已自動換取 Refresh Token (RT)！
              </div>
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 6 }}>
                您的 {cfg.guideName} 帳戶已成功授權，系統已保存長期憑證：
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  readOnly
                  value={obtainedRt}
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    fontSize: 11,
                    borderRadius: 4,
                    border: '1px solid #22c55e',
                    backgroundColor: 'rgba(0,0,0,0.04)',
                    fontFamily: 'monospace',
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(obtainedRt)
                    setRtCopied(true)
                    setTimeout(() => setRtCopied(false), 2000)
                  }}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    borderRadius: 4,
                    backgroundColor: '#22c55e',
                    color: '#ffffff',
                    fontWeight: 600,
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {rtCopied ? '✓ 已複製' : '📋 複製 RT'}
                </button>
              </div>
            </div>
          )}

          {error && <p className={styles['error']}>{error}</p>}

          <div className={styles['modalFooterRow']}>
            <Button variant="outline" type="button" onClick={goBack}>
              返回
            </Button>
            <Button variant="primary" type="button" disabled={submitting} onClick={() => handleConnect()}>
              {submitting
                ? (exchangeNotice || `正在向 ${cfg.guideName} 換取 Token...`)
                : (obtainedRt ? '✓ 已換取成功並連線' : '完成授權並自動換取 Token')}
            </Button>
          </div>
        </div>
      )
    }

    // Default OAuth (OpenAI Codex, etc.)
    const authUrl = selectedProvider && selectedMethod
      ? (getProviderPortalLink(selectedProvider.id, selectedMethod.route)?.url ?? '#')
      : '#'
    return (
      <div className={styles['modalContentBox']}>
        <p className={styles['oauthInstruction']}>
          访问{' '}
          <a
            href={authUrl}
            target="_blank"
            rel="noreferrer"
            className={styles['authLink']}
          >
            此链接
          </a>{' '}
          并完成登录授权，以连接你的账户并在系统中使用 {selectedProvider.name} 模型。
        </p>

        <div style={{ marginBottom: 12 }}>
          <a
            href={authUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              backgroundColor: 'var(--dsw-alias-fill-brand-secondary, #2563eb)',
              color: '#ffffff',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            <span>🌐 在浏览器中打开官方授权页面 ↗</span>
          </a>
        </div>

        <label className={styles['codeLabel']}>确认码</label>
        <div className={styles['codeBox']}>
          <span className={styles['codeText']}>
            Complete authorization in your browser. This window will close automatically once authorized.
          </span>
          <button
            type="button"
            className={styles['codeCopyBtn']}
            title="复制"
            onClick={() => {
              void navigator.clipboard.writeText(
                'Complete authorization in your browser. This window will close automatically once authorized.',
              )
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}
          >
            {copied ? '✓' : '📋'}
          </button>
        </div>

        <div className={styles['waitingStatusRow']}>
          <span className={styles['waitingDots']}>⠋</span>
          <span>等待授权...</span>
        </div>

        <div className={styles['field']} style={{ marginTop: 12 }}>
          <span className={styles['fieldLabel']}>授权回调 URL 或 Code (可选)</span>
          <input
            type="text"
            className={styles['input']}
            placeholder="浏览器跳转后的完整地址 (如 http://localhost:1455/...) 或授权码"
            value={oauthCodeDraft}
            onChange={e => setOauthCodeDraft(e.target.value)}
          />
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', marginTop: 4 }}>
            在浏览器登录完成后，如果页面未自动响应，可直接点击下方【完成授权】或将跳转地址粘贴至此处。
          </span>
        </div>

        {error && <p className={styles['error']}>{error}</p>}

        <div className={styles['modalFooterRow']}>
          <Button variant="outline" type="button" onClick={goBack}>
            返回
          </Button>
          <Button variant="primary" type="button" disabled={submitting} onClick={() => handleConnect()}>
            {submitting ? '连接中...' : '完成授权'}
          </Button>
        </div>
      </div>
    )
  }

  const renderCustom = (): ReactNode => (
    <div className={styles['modalContentBox']}>
      <CustomProviderCard
        taken={state.rows.map(row => row.entry.provider)}
        protocols={protocols}
        revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0}
        operations={operations}
        t={t}
        readOnly={!state.writable}
        onClose={(changed: boolean) => {
          if (changed) void controller.load()
          handleClose()
        }}
      />
    </div>
  )

  const titleText = step === 'picker'
    ? '连接提供商'
    : step === 'custom'
      ? '自定义提供商'
      : `连接 ${selectedProvider?.name ?? ''}`

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={titleText}
      className={styles['connectModalDialog'] as string}
      headless
    >
      <div className={styles['connectModalHeader']}>
        <div className={styles['connectModalHeaderLeft']}>
          {step !== 'picker' && (
            <button type="button" className={styles['connectModalBackBtn']} onClick={goBack} aria-label="返回">
              ←
            </button>
          )}
          <span className={styles['connectModalTitle']}>{titleText}</span>
        </div>
        <button type="button" className={styles['connectModalCloseBtn']} onClick={handleClose} aria-label={t('close')}>
          <IconCloseOutline16 size={14} />
        </button>
      </div>

      <div className={styles['connectModalBody']}>
        {step === 'picker' && renderPicker()}
        {step === 'methods' && renderMethods()}
        {step === 'apiKey' && renderApiKey()}
        {step === 'oauth' && renderOAuth()}
        {step === 'custom' && renderCustom()}
      </div>
    </Modal>
  )
}
