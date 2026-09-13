# Agent Note: Schedule management metadata

Status: implemented

English | [中文](2026-09-09-schedule-management-metadata.zh.md)

## Problem

A durable reminder carries only its rule and prompt, so management surfaces cannot show a display title, owning project, selected model, reasoning effort, notification policy, or paused state without reparsing prompts. Paused reminders additionally need a durable state that keeps them listed while guaranteeing they never fire or arm timers.

## Decision

Version-2 records keep the version-1 rule shapes and add one optional `meta` object (`title`, `project`, `model`, `reasoning`, `notify`, `paused`). The decoder reads envelope versions 1 and 2; version-1 records replay without injected metadata, and malformed version-2 metadata fails the fold loudly. Writers emit a version-2 envelope only when a record carries metadata and stay on version 1 otherwise; delete and dispatch envelopes always stay on version 1 because they carry no record. Old readers reject version-2 envelopes loudly, so the upgrade is one-way.

`schedule_create` accepts the six metadata fields beside its rule selector and validates them before the first persistence barrier; the tool output schema carries the same optional object. There is no update operation: changing metadata means deleting and recreating the reminder. The live owner treats paused records as invisible to every due branch — they neither dispatch nor arm timers — while they stay in the active set that listing, projection, and the sidebar manager read. Presentation resolves absent metadata to documented defaults (prompt-derived title, all-run notices, unpaused) without writing defaults back into the log.

## Alternatives considered

**Always write version-2 envelopes.** Uniform envelopes simplify the writer but reject every new write on old readers for no benefit; content-driven versions keep metadata-free creates readable everywhere.

**Add an update operation for metadata.** An in-place transition would need a new durable operation, fold transition, projection handling, and revision fencing for six independently editable fields. Delete plus create reuses the three existing terminal transitions and keeps the log append-only.

**Pause by deleting.** Deletion destroys the durable record and its id; a paused flag preserves the reminder, its history position, and its next target while the runtime guarantees silence.

**Adopt calendar or Cron recurrence.** Management metadata describes reminders; it does not change the fixed-rate recurrence boundary owned by the bounded fixed-rate decision.

**Expose client-initiated pause and delete RPCs.** Model tools own every Schedule mutation behind the persistence barrier; a client remote would duplicate that ordering authority. The sidebar manager stays read-only triage until such an authority exists.

## Verification

Package tests pin version-1 replay without injected metadata, version-2 round-trips, metadata input validation and normalization, conditional envelope versions, mixed-version folds and transitions, paused-aware due decisions with ordering and arming, and creation-anchor arithmetic at per-file 100% coverage. Tool tests pin metadata creates in version-2 envelopes, metadata-free creates in version-1 envelopes, and invalid metadata values. A runtime test pins that a paused reminder never dispatches while a live one fires. Focused client suites own the manager panel behavior. The generated tool catalog covers the new parameters.

## Consequences

- Management surfaces can title, filter, and explain reminders without reparsing prompts.
- Paused reminders are visible, silent, and timer-free; unpausing flows through delete plus create.
- Metadata-free logs stay byte-compatible with version-1 readers; metadata-carrying logs require current code.
- No update path means metadata edits are delete-plus-create cycles with new ids.
- Tool output grows one optional object; model prompts gain six documented parameters.
