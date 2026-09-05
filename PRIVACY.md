# Privacy Policy — Aiapi Agent

Last updated: 2026-09-05

Aiapi Agent (`https://github.com/fengfeng1021/aiapi-agent`) is a local-first
coding agent. This policy explains what data the software handles and where
that data lives.

## Data stored on your own machine

Aiapi Agent keeps all working data locally on the computer where you run it.
Nothing is sent to the Aiapi Agent developers — there is no Aiapi telemetry
server, and we operate no service that receives your data.

- **API keys and OAuth tokens.** Keys you enter (`GEMINI_API_KEY`,
  `AIAPI_API_KEY`, `DEEPSEEK_API_KEY`, …) live in your own environment
  variables or config files. Google OAuth tokens obtained via
  `aiapi login --provider gemini` are stored in `~/.codex/auth.json` on your
  machine. They are only ever sent to the model provider you configured, to
  authenticate your own requests.
- **Sessions and settings.** Conversations, provider settings, and MoA presets
  are stored locally (harness home directory, e.g. `~/.dsh`, and the app data
  directory of the desktop build).
- **Crash/diagnostic logs.** Login and runtime logs stay in local log
  directories (e.g. `codex-login.log`). They are only shared if you choose to
  send them to us when reporting an issue.

## Data sent to third parties (by your own configuration)

To answer your prompts, Aiapi Agent sends your prompts, relevant files, and
tool results to **the model provider you select** (OpenAI, Google, DeepSeek,
Aiapi, Ollama, …). Each provider applies its own privacy policy to that data.
Review your provider's policy before entering sensitive information, and
prefer local providers (Ollama, LM Studio) for confidential work.

## Updates

The desktop app checks GitHub Releases for new versions. That check reveals
only standard download metadata (app version, platform); no personal data is
included.

## Contact

Questions about this policy: open an issue at
`https://github.com/fengfeng1021/aiapi-agent/issues`.
