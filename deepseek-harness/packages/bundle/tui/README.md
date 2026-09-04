# @deepseek-ai/dsh-tui

English | [中文](README.zh.md)

Interactive terminal surface bundle for `dsh --profile tui`. Its [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md), supplies the terminal persona and tool-presentation setting, and inserts the stdio [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.md). The terminal frontend is a protocol client; stdout of the profile process is reserved exclusively for newline-delimited JSON-RPC frames.

This bundle deliberately does not copy the base agent tree. Credentials, settings, persistent sessions, workspace instructions, skills, filesystem and shell tools, permission policy, compaction, goals, workflows, and subagents all remain owned by `dsh-base`. The profile's `$DSH_HOME/profiles/tui/cordis.patch.yml` applies after this bundle, and the shared `$DSH_HOME/cordis.patch.yml` applies after the profile layer, so both can override its rows or insert external plugin rows. The standard profile watcher reapplies both user layers while the terminal runtime remains active.

## Model Experience

Indirectly, through the complete `dsh-base` composition and any later user plugin layers. This package changes only the surface persona and transport; the JSON-RPC server contributes no model prompt or tools.

#### KV Cache effect

The terminal persona becomes part of the system-prompt prefix. A user patch that replaces `system-prompt` changes that prefix and invalidates the affected cache; the transport itself has no cache effect.

## Known Limitations and Deferred Work

- **stdout is protocol-only** — a user plugin that writes ordinary text to stdout corrupts the JSON-RPC stream; diagnostics belong on stderr.
- **The terminal frontend owns human interaction rendering** — this bundle only exposes the current SDK protocol and does not itself implement approval or question prompts.
