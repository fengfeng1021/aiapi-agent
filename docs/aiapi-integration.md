# Aiapi Agent 整合設計

> 基於 `openai/codex` (Apache-2.0) + `opencode` 供應商/模型 + `Hermes` MoA 多模型協同 + GPT/Gemini 登入

## 1. 目標

在 `D:\Desktop\App\Aiapi Agent` 中重建一個完整 Agent，具備：
- Codex Harness 的執行迴圈（tool 壓縮、記憶、審核）
- opencode 的供應商/模型管理（任意 OpenAI-Compatible 供應商）
- Hermes 的 MoA 多模型協同（reference + aggregator）
- GPT（Codex OAuth）與 Gemini/Antigravity（Google OAuth + API Key）登入

## 2. 架構

```
Aiapi Agent (codex-rs + app-server)
├─ model-provider-info/src/lib.rs        # 擴充內建供應商：gemini, aiapi, deepseek, etc.
├─ config/src/config_toml.rs             # 新增 [moa] 區段（參考 Hermes config.yaml:moa）
├─ moa/src/lib.rs (新增)                 # MoA 虛擬供應商：並行呼叫 reference_models -> aggregator
├─ login/src/auth/google_oauth.rs (新增)# Gemini/Antigravity Google OAuth（鏡像 Hermes agent/google_oauth.py）
├─ scripts/migrate-opencode-providers.py # opencode.json -> config.toml 自動轉換
└─ examples/config.toml                  # 完整範例：aiapi + gemini + openai + moa
```

## 3. 供應商/模型 - opencode 移植

opencode 定義在 `C:\Users\Administrator\.config\opencode\opencode.json:3`：
```json
provider: { "opencode-go": {models: {...}}, "gemini": {options: {baseURL, apiKey}, models: {...}}}
```
Codex 定義在 `codex-rs/model-provider-info/src/lib.rs:96` 的 `ModelProviderInfo`：
```rust
pub struct ModelProviderInfo { name, base_url, env_key, wire_api, ... }
```
**轉換規則**：
- `provider.gemini.options.baseURL` -> `model_providers.gemini.base_url`
- `provider.gemini.options.apiKey` -> `env_key = "GEMINI_API_KEY"` 或 `GOOGLE_API_KEY`
- `provider.gemini.models.gemini-3.7-flash` -> 模型名稱直接使用，Codex 透過 `model` 欄位選擇
- 通用：任何 `npm: "@ai-sdk/openai-compatible"` 的供應商都對應 `wire_api = "responses"` + `base_url`

已內建供應商（`built_in_model_providers`）新增：
- `openai` (原有), `gemini`, `aiapi`, `deepseek`, `zhipuai`, `ollama`, `lmstudio`

用戶自訂供應商透過 `~/.codex/config.toml` 的 `[model_providers.xxx]` 覆蓋或擴充，無需改程式碼。

## 4. MoA 多模型協同 - Hermes 移植

Hermes 配置 `D:\Hermes\config.yaml:116`：
```yaml
moa:
  default_preset: default
  presets:
    default:
      reference_models: [{provider: anthropic, model: claude-sonnet-4-6}, ...]
      aggregator: {provider: anthropic, model: claude-opus-4-8}
      reference_temperature: 0.6
      aggregator_temperature: 0.4
      max_tokens: 4096
      enabled: true
```
移植到 Codex 的 `config.toml`：
```toml
[moa]
default_preset = "default"

[moa.presets.default]
reference_models = [{provider="anthropic", model="claude-sonnet-4-6"}, {provider="openai", model="gpt-5.4"}]
aggregator = {provider="anthropic", model="claude-opus-4-8"}
reference_temperature = 0.6
aggregator_temperature = 0.4
max_tokens = 4096
enabled = true
```
執行流程（`moa/src/lib.rs`，鏡像 `D:\Hermes\hermes-agent\agent\moa_loop.py`）：
1. 收到用戶 prompt
2. 並行呼叫所有 `reference_models`（溫度 0.6）
3. 收集每個參考模型的回答
4. 構造 aggregator prompt：原始問題 + 所有參考回答
5. 呼叫 `aggregator`（溫度 0.4）生成最終答案
6. 返回 aggregator 結果，附帶參考模型的中間輸出（用於調試）

虛擬供應商 `moa` 在 `model_provider = "moa"` 時觸發，否則走正常單模型路徑。

## 5. GPT / Gemini 登入

- **GPT (Codex)**：已內建 `codex-rs/login/src/auth/manager.rs` 的 `CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` + `https://auth.openai.com/oauth/token` + `https://chatgpt.com/backend-api/codex`。用戶執行 `codex login` 或 `aiapi login --provider openai-codex` 即觸發 Device Code + PKCE 流程，token 存於 `~/.codex/auth.json`。
- **Gemini / Antigravity**：新增 `google_oauth.rs`，鏡像 Hermes 的 `agent/google_oauth.py` 和 `skills/productivity/google-workspace`：
  - OAuth Client 類型：Google Cloud Console 的 Desktop App
  - Scope：`https://www.googleapis.com/auth/generative-language` + Antigravity 所需 scope
  - 流程：生成 `auth_url` -> 用戶瀏覽器授權 -> 回調 `http://localhost:xxx/callback` -> 交換 `access_token`/`refresh_token` -> 存於 `~/.codex/auth.json` 的 `providers.gemini`
  - 同時支援 API Key 模式：`GEMINI_API_KEY` / `GOOGLE_API_KEY` 環境變數，`inference_base_url = "https://generativelanguage.googleapis.com/v1beta"`
  - Antigravity 模式：複用 Gemini 憑證，但 `base_url` 指向 Antigravity 的代理端點，設置文件與 `~/.gemini/antigravity-cli/` 兼容

## 6. 驗證

- `just test -p codex-model-provider-info` 驗證新增供應商
- `cargo test -p codex-moa` 驗證 MoA 流程
- `aiapi auth --provider gemini` 測試 Gemini 登入
- `aiapi moa configure` 測試 MoA 預設編輯（鏡像 `hermes moa configure`）
