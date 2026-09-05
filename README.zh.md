# Aiapi Agent

**Aiapi Agent** 是一個開放、不綁特定供應商的程式 coding agent：專業的執行
核心、可高度自訂的 DeepSeek 風格前端，以及多模型協同（MoA），一次到位。

- **引擎（Rust，`codex-rs/`）**——Codex harness 執行迴圈（工具、記憶、審核、
  沙箱），可接任意 OpenAI 相容的供應商／模型，內建完整的 MoA 多模型回合
  執行器，以及 Gemini 的 Google OAuth 登入。
- **前端＋桌面（`deepseek-harness/`）**——DeepSeek Harness 網頁 UI（React +
  Cordis 外掛，含 MoA 設定面板），瀏覽器跑 `pnpm dsh web`，Windows 桌面版
  跑 `pnpm run desktop:build` 產 MSI 安裝檔。
- **設定範例**——看 `examples/aiapi-config.toml` 和
  `docs/aiapi-integration.md`。

## 快速開始

### 後端 CLI（`aiapi`）

```powershell
# Windows（裝好 Rust 的 codex-rs checkout）
cargo build --profile release --bin aiapi-agent
.\target\release\aiapi-agent.exe --help

# Google 登入（Gemini，需先申請 Desktop OAuth 用戶端）：
$env:GOOGLE_OAUTH_CLIENT_ID = "<id>"
$env:GOOGLE_OAUTH_CLIENT_SECRET = "<secret>"
aiapi login --provider gemini

# 或用 API Key（見 examples/aiapi-config.toml）：
$env:GEMINI_API_KEY = "<key>"
$env:AIAPI_API_KEY = "<key>"
$env:DEEPSEEK_API_KEY = "<key>"
```

MoA（多個參考模型＋綜合模型）在 `~/.codex/config.toml` 的 `[moa]` 設定
（含 `reference_models` 和 `aggregator` 的 preset）；`active_preset` 留空
就是單模型模式。

### 前端（瀏覽器）

```sh
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

### 桌面版（Windows MSI，自行打包，未簽名）

```sh
cd deepseek-harness
pnpm run desktop:build -- --target x86_64-pc-windows-msvc
# 產物：apps/desktop/src-tauri/target/<triple>/release/bundle/msi/*.msi
```

未簽名版本內測安裝沒問題（SmartScreen 跳警告時選繼續執行即可）。
完整整合設計見 `docs/aiapi-integration.md`。

## 目錄結構

```
codex-rs/            Rust 引擎（Codex fork：core、cli、login、moa……）。
deepseek-harness/    網頁 UI＋桌面載體（DeepSeek Harness＋Tauri）。
docs/                整合設計（docs/aiapi-integration.md）。
examples/            設定範例（examples/aiapi-config.toml）。
scripts/             供應商遷移小工具。
```

## 出處與授權

- 引擎衍生自 [openai/codex](https://github.com/openai/codex)
  （Apache-2.0，見 `LICENSE`、`NOTICE`）。
- 前端衍生自
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  （MIT，見 `deepseek-harness/LICENSE`、
  `deepseek-harness/THIRD_PARTY_NOTICES.md`）。
- 桌面載體衍生自社群 Tauri fork。

本倉庫採用 [Apache-2.0 授權](LICENSE)。第三方元件授權如上所述，各自保留。

## 程式簽名

Windows 發佈版透過 [SignPath Foundation](https://signpath.org/) 開源免費
程式簽名計畫簽署。隱私政策見 [PRIVACY.md](PRIVACY.md)。
