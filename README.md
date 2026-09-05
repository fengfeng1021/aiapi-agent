# Aiapi Agent

**Aiapi Agent** is an open, provider-agnostic coding agent: a professional
execution core, a customizable DeepSeek-style frontend, and Mixture-of-Agents
(MoA) multi-model collaboration in one package.

- **Engine (Rust, `codex-rs/`)** — Codex harness execution loop (tools,
  memory, review, sandbox) with any OpenAI-compatible provider/model, plus a
  full MoA turn executor and Google OAuth login for Gemini.
- **Frontend + Desktop (`deepseek-harness/`)** — DeepSeek Harness web UI
  (React + Cordis plugins, MoA settings panel included) running in the
  browser via `pnpm dsh web`, or as a Windows desktop app (Tauri MSI) via
  `pnpm run desktop:build`.
- **Config example** — see `examples/aiapi-config.toml` and
  `docs/aiapi-integration.md`.

## Quickstart

### Backend CLI (`aiapi`)

```powershell
# Windows (from a codex-rs checkout with Rust installed)
cargo build --profile release --bin aiapi-agent
.\target\release\aiapi-agent.exe --help

# Log in with Google (Gemini), needs a Desktop OAuth client:
$env:GOOGLE_OAUTH_CLIENT_ID = "<id>"
$env:GOOGLE_OAUTH_CLIENT_SECRET = "<secret>"
aiapi login --provider gemini

# Or use API keys (see examples/aiapi-config.toml):
$env:GEMINI_API_KEY = "<key>"
$env:AIAPI_API_KEY = "<key>"
$env:DEEPSEEK_API_KEY = "<key>"
```

MoA (multi-model advisors + aggregator) is configured in
`~/.codex/config.toml` under `[moa]` (presets with `reference_models` and an
`aggregator`); leave `active_preset` empty to run single-model turns.

### Frontend (browser)

```sh
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

### Desktop (Windows MSI, self-built, unsigned)

```sh
cd deepseek-harness
pnpm run desktop:build -- --target x86_64-pc-windows-msvc
# -> apps/desktop/src-tauri/target/<triple>/release/bundle/msi/*.msi
```

Unsigned builds install fine for internal testing (accept the SmartScreen
prompt). See `docs/aiapi-integration.md` for the full integration design.

## Repository layout

```
codex-rs/            Rust engine (Codex fork: core, cli, login, moa, ...).
deepseek-harness/    Web UI + desktop carrier (DeepSeek Harness + Tauri).
docs/                Integration design (docs/aiapi-integration.md).
examples/            Sample configs (examples/aiapi-config.toml).
scripts/             Provider migration helpers.
```

## Credits & License

- Engine derived from [openai/codex](https://github.com/openai/codex)
  (Apache-2.0; see `LICENSE`, `NOTICE`).
- Frontend derived from
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  (MIT; see `deepseek-harness/LICENSE`,
  `deepseek-harness/THIRD_PARTY_NOTICES.md`).
- Desktop carrier derived from the community Tauri fork
  (`desktop-shell` sources were ported onto `deepseek-harness/`; the stale
  snapshot directory is intentionally **not** part of this repository).

This repository is licensed under the [Apache-2.0 License](LICENSE).
Third-party components keep their own licenses as noted above.

## Code signing

Windows releases are code-signed through the
[SignPath Foundation](https://signpath.org/) free code-signing program for
open source projects. See [PRIVACY.md](PRIVACY.md) for the privacy policy.
