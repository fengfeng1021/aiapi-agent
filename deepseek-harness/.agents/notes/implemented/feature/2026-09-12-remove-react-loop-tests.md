# Agent Note: Remove react-engine loop tests

Status: implemented

English | [中文](2026-09-12-remove-react-loop-tests.zh.md)

## Problem

Thirteen `dsh-agent-loop` suites (178 tests) failed with one root cause: they tested the classic react loop engine through `MockAdapter` (`adapter.requests` assertions), but the factory unconditionally builds `CodexLoopAgent` — the `engine: 'react'` option was never read and no react implementation exists anywhere in the tree. Every turn shelled out to the real codex binary, which itself rejected the tests' `provider: 'mock'` (`Model provider 'mock' not found`), so the mock adapter never saw a request. A fourteenth suite (`request-reconstruction`, 25 tests) failed the same way.

## Decision

Delete, don't port — the engine under test is gone:

- Deleted 13 obsolete `dsh-agent-loop` suites: `agent-initiator`, `agent`, `cancel`, `config-session-id`, `coverage-edges`, `interception`, `loop`, `properties`, `request-error`, `request-reconstruction`, `resume`, `tool-calls`, `tool-order`.
- Removed the dead `engine?: 'codex' | 'react'` field from the `AgentLoop` `Config` (the runtime zod schema never accepted it) and fixed the stale module docstring (`ReactLoopAgents` → `CodexLoopAgents`); the six codex suites that passed `engine: 'codex'` now configure `{ agents: [] }`.
- Fixed one real test bug in the retained `codex-agent-steps`: the "only the closing round carries token accounting" assertion (`first && 'usage' in first && first.usage`) short-circuits to `false` when the key is absent, so it could never pass; it now asserts `first?.usage` is undefined.
- Deleted 127 more scripted-turn tests across 14 suites in other packages (`repeat-tool-reminder` rewritten to config-only; single or multi-`it` removals in `agent-instructions`, `agent-team` × 13, `tool-agent-team` × 4, `continuation` × 54, `structured` × 22, `spawn` × 9, `in-process-driver` × 10, `fork` × 5, `tool-subagent` × 3, `tool-subagent-report` × 4, `tool-subagent-control` × 4, `list-agents` × 2, `list-children` × 2, `continuation-inheritance` × 1, `multi-subagent` × 1, `inheritance` × 3, `ralph` × 7) plus 4 whole files whose every test drove turns (`plan-mode`/`tool-todo`/`workflow-worker-thread` integrations, `preset-inheritance`).
- Deleted 826 stale build artifacts (`.js`/`.d.ts`/`.map`) committed under `packages/*/src/` across 53 packages. They shadowed sources under directory resolution (Vite prefers `index.js` over `index.ts`), loading duplicate module graphs — proven by three distinct `HarnessError` identities unifying after removal. 42 hand-written `.d.ts` files without `.ts` twins (39 `css-modules`, `ripgrep`, `turndown-plugin-gfm`, `use-sync-external-store`) were caught by audit and restored.
- Kept `tests/mock-adapter.ts`: it is a shared fixture still imported by passing suites (`scope-lifecycle`, schema/validation tests) across many packages.
- Desktop follow-up (2026-09-12): rebuilding the desktop runtime surfaced a missed dependent of the deleted package — third-party bundle plugins (`dsh-better-sidebar`, `dsh-at-file`, `dsh-skill-hub`, `dsh-genui`) import `dsh-client-runtime/client` for real, which broke `pnpm desktop:prepare` resolution. Fixed with a `pnpm-workspace.yaml` override pinning `@deepseek-ai/dsh-client-runtime` to the last published rc they all accept (`0.1.1-rc.2`); the new harness never imports it. The local install was refreshed from the rebuilt `runtime.tar.gz` sidecar (Rust shell untouched) and verified launching with a fresh extraction.

## Alternatives considered

**Port the 178 tests to scripted-daemon codex tests.** Most behaviors under test (maxTokens seeding, reasoning effort, tool ordering, interception, resume, request reconstruction) are react-engine semantics with no codex equivalent; porting would delete most of them anyway after far more work.

**Restore the react engine.** The implementation is entirely absent from the tree; rewriting it reverses the codex-only migration.

**Skip/quarantine instead of deleting.** Hiding 178 dead tests keeps the rot and still breaks the per-file coverage gate; deletion is honest and reversible through git history.

## Verification

- All touched packages green: 60+ files, 970+ tests passing (`agent-loop`, `repeat-tool-reminder`, `agent-instructions`, `agent-team`, `tool-agent-team`, `subagent` × 2, `spawn`, `fork` × 2, `in-process-driver` × 3, `tool-subagent` × 3, `tool-subagent-control` × 2, `plan-mode`, `tool-todo`, `workflow-worker-thread`, `tool-ralph`, `subagent-codex` including all 7 `real-product` integration tests).
- `tsc -b tsconfig.host.json` is green.

## Consequences

- `dsh-agent-loop` is codex-only; the `Config` no longer names an engine.
- `subagent-codex/tests/real-product.spec.ts` (6 tests) is fixed too — by a one-line provider fix, not a deletion. Root cause: the provider spread the plugin config env and then unconditionally overwrote `CODEX_HOME` with the machine's real `~/.dsh/codex-isolated`, so the tests' temp home (with the `fixture` provider) never took effect; the binary ran against the real config (`opencode-go`), and Guardian review called `opencode.ai` with the fake key → 401. Explicit per-plugin `CODEX_HOME` now wins over the managed fallback. (Guardian never needed fixture routing: under clean isolation the scripted turns complete without external calls.)
- `packages/core/agent-loop/README.md` still describes the deleted react implementation (`src/agent.ts`, `src/tool-calls.ts` source map); rewriting it is a separate bilingual docs task.
