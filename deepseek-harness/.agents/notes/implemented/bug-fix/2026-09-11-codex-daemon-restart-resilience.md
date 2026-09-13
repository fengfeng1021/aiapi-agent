# Agent Note: Codex daemon restart resilience

Status: implemented

English | [中文](2026-09-11-codex-daemon-restart-resilience.zh.md)

## Problem

Two daemon-lifecycle gaps turned one transient app-server death into a permanently wedged Codex session. Observed in production: the app-server exited (-1), the daemon respawned, and every later turn failed with `thread not found` for the cached thread id — retries, new prompts, and restarts of the turn all failed until the whole Host process restarted.

1. `CodexLoopAgent` cached its Codex thread id forever. App-server threads live only in the serving process's memory (`turn/start` resolves ids against the in-memory map, never disk), so any daemon restart — crash, kill, Host reboot — permanently invalidates every cached id, and the agent retried the dead id on every turn.
2. `CodexAppServerDaemon.ensureStarted` latched a rejected start promise: one failed startup poisoned all later callers, which awaited the same rejection instead of retrying.

## Decision

- The daemon maps a `turn/start` wire rejection with code `-32600` and a `thread not found` message to a typed `CodexThreadGoneError` carrying the stale id. The code anchors the match (invalid request); the message narrows it to a missing thread rather than any malformed request.
- The agent catches that error for its own current id inside the attempt budget: it drops the id, creates a fresh thread, and drives the same input there. A miss naming another id, any other failure, or a second miss within the budget fails the turn loudly — recovery never loops.
- A failed `start()` clears `startPromise` (identity-compared, so a concurrent successful start is never clobbered), letting the next caller retry instead of awaiting a dead rejection.

## Alternatives considered

**Reload the thread from disk on miss.** The app-server deliberately keeps live threads in memory (disk holds rollouts, not runnable handles); teaching the daemon to rehydrate them would duplicate the server's session lifecycle. A fresh thread is cheaper and always consistent.

**Retry the stale id after respawn.** The new process can never know the old id however often it is asked — retries without recreation only burn the attempt budget.

**Match on message text alone.** Bare substring matching would misclassify unrelated `-32600` failures as thread loss and silently abandon live threads. The code-plus-message match keeps the classifier narrow.

## Verification

Agent specs pin heal-once-then-drive (call order, thread ids, completed turn with the recovered answer), loud failure on a double miss, passthrough of foreign ids and unrelated errors, and startup retry after a failed start (distinct errors prove separate attempts, no latch). Wire specs pin the mapping against a scripted app-server: thread-miss becomes `CodexThreadGoneError`, other invalid-request and other-code rejections pass through as `JsonRpcResponseError`.

## Consequences

- A daemon restart now costs one turn attempt and a fresh Codex thread (previous Codex-side context is not carried over), never a wedged session.
- `CodexThreadGoneError` is the single vocabulary for stale thread ids; new callers must handle it by recreating, never by retrying the id.
