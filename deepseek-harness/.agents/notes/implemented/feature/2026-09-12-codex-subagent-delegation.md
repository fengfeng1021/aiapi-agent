# Agent Note: Codex subagent delegation

Status: implemented

English | [中文](2026-09-12-codex-subagent-delegation.zh.md)

## Problem

Codex-driven turns (`CodexLoopAgent`) could not spawn or fork subagents: the Codex loop constructs its own agent type, so the `delegate` capability never rode along, and `turn/start` without MCP tools left the model with no way to call back into the host subagent service.

## Decision

Delegation rides `thread/start.dynamicTools` (gated behind the `experimentalApi` client capability, which the daemon declares at handshake) instead of a separate MCP bridge:

- `packages/core/agent-loop/src/codex-delegation.ts` (new): `delegateToolSpec()` publishes one `delegate(task, provider?)` function tool; `parseDelegateArguments()` validates the model JSON (non-empty task, `spawn` default, `fork` explicit, unknown providers rejected loudly); `executeDelegation()` runs it through the host subagent service with the owning turn's cancellation, mapping completed runs to success results and every other ending (refused start, infrastructure fault, non-completed stop, empty output) to failure text the model can read.
- `codex-server.ts`: every `thread/start` publishes the spec; `handleServerRequest` routes `item/tool/call` to the owning turn's `CodexThreadToolOwner`, answering the request with the owner result verbatim (`{ contentItems, success }` — matched by request id, no id echo, no case conversion, as proven against the live app-server). Calls with no thread id or no live owning turn fail loud as `-32603`.
- `codex-agent.ts`: each Codex turn installs a `toolOwner` that executes `delegate` against `loopCtx` subagents through the turn signal, and logs `dynamicToolCall` items as `tool/call` + `tool/result` session rows (failure rows carry `isError`).
- Wire keys are camelCase on the wire in both directions (`callId`, not `toolCallId`; params go out verbatim) — pinned by live traffic against codex 0.149.1.

## Alternatives considered

**Separate MCP server bridging delegation into the thread.** A second server process per turn adds lifecycle, auth, and failure surface for one tool; `dynamicTools` is the app-server's native slot for exactly this, and the live probe confirmed the model calls it and resumes on the direct response.

**Answer `item/tool/call` with a separate `response` message.** Live traffic shows the turn resumes on the direct JSON-RPC response alone (the model quoted the result verbatim and the turn completed); an extra message would be an unacknowledged protocol invention.

**Port the deleted `dsh-client-runtime` layer for delegation.** Unrelated: that package was unreferenced, unmounted, and upstream-removed (see the workspace-session-deletion note); delegation needs only the `dsh-subagent` service plus the loop context.

## Verification

- `codex-delegation.spec.ts` pins the spec shape, argument parsing/defaults/rejections, provider routing, result mapping (completed, non-completed, empty, start/result faults), and cancellation propagation.
- `codex-server-dynamic-tool.spec.ts` pins the full wire round trip against a scripted app-server (owner routing, verbatim result body, no-active-turn rejection, owner-failure rejection without breaking the turn).
- `codex-thread-instructions.spec.ts` pins the `dynamicTools` publication on `thread/start`.
- `codex-agent-dynamic-tool.spec.ts` pins the `tool/call` + `tool/result` session rows through a real `CodexLoopAgent` composition.
- A live turn against codex 0.149.1 forced a `delegate` call end to end: the model called it, the owner answered, and the model reported the result verbatim (`PINEAPPLE`).
- `tsc -b tsconfig.host.json` is green.

## Consequences

- Every Codex turn now offers `delegate`; `spawn` starts a fresh child, `fork` continues the conversation in the child.
- Codex turns require the `dsh-subagent` service in composition: without it the tool call fails loudly (`subagent service is unavailable`) instead of hanging.
- `CodexTurnItem` gains the live `status` field; `DynamicToolCallParams` uses the wire `callId`.
