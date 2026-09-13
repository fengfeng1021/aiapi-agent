# Agent Note: Workspace session deletion

Status: implemented

English | [中文](2026-09-11-workspace-session-deletion.zh.md)

## Problem

Workspaces could only be unregistered (their sessions fell back to Ungrouped) and sessions could only be archived. There was no way to permanently delete a session's durable log, and no way to remove a workspace together with its sessions, so stale or sensitive history accumulated with no owner operation to clear it.

## Decision

Deletion is explicit at every layer, never a side effect of another mutation:

- Host (`dsh-api-workspace-controller`): `workspace/delete` accepts optional `cascadeSessions`, deleting every owned session first in registry order; new `workspace/deleteSession` removes one session's registry accounting and then its durable log. A live (attached) session is first closed through its owner (`sessionController.closeSession`) — the Agent stops, any in-flight turn is cancelled, and the Session leaves the store — before the log is deleted; a session live under another owner (subagent routing, another host API) has no closer and keeps the loud `session/live` rejection. A persistence failure mentioning an open session maps to `session/live`; any other persistence failure propagates unchanged.
- Host Session owner (`dsh-api-session-controller`): the Agent controller retains the factory `AgentHandle` for every Agent it resolves, so an explicit close can dispose exactly those Agents once; handles for sessions it never opened are absent and close is a no-op.
- Client object layer (`dsh-api-workspace-controller/client`): `delete` forwards the flag only when explicitly set; `deleteSession` prunes the row from every projected workspace and the archive set without waiting for the Host frame; the archive sweep clears a deleted current selection into the New Session view state. The superseded `dsh-client-runtime` object layer was deleted outright (unreferenced, unmounted, upstream-removed) rather than ported.
- Browser (`dsh-client-ui-workspace`): the workspace delete dialog gains an unchecked-by-default cascade checkbox; session rows gain a destructive menu entry behind a confirmation dialog stating irreversibility. Failures keep the dialog open for retry.
- Keyless rigs (`dsh-client-connection` fixture, session-controller `FakeApiClient`) implement the same semantics so the flow runs without a Host.

Cascade defaults to off everywhere: omitting the flag preserves the old retention behavior byte-for-byte.

## Alternatives considered

**Delete the log first, accounting second.** Reversing the order leaves a window where the registry still accounts an id whose log is gone; grouping surfaces would point at an unloadable session. Accounting-first keeps every intermediate state loadable.

**Fold deletion into archive.** Archive is reversible bookkeeping over retained logs; deletion destroys the log. Merging them would force every archive consumer to reason about disappearance and would break the archive set's append-only lineage.

**Keep rejecting live sessions.** The Host keeps every resolved Agent live for the process lifetime, so rejection would make deletion impossible for any session the user had ever opened — the exact desktop flow this feature exists for. Closing on the explicit, confirmed delete request stops the Agent and cancels the turn that the deletion discards anyway; a session whose owner is not the API Session controller still rejects, so the gate survives where the Host cannot close it.

## Verification

Host specs pin cascade ordering, close-before-delete through the Session owner, the still-live rejection, and both persistence-failure mappings. Session-controller specs pin the single-shot Agent close (a repeat close and a never-opened id are no-ops). Fixture specs pin cascade removal with archive pruning and session deletion of owned, unaccounted, and missing ids. Browser specs pin both dialogs (confirm, duplicate-submit block, failure retry) and the cascade checkbox value. `tsc -b` on both aggregates is green.

## Consequences

- Users can permanently clear sessions and workspaces; Ungrouped still receives sessions from non-cascade workspace deletion.
- Deleting a live session stops its Agent and cancels any in-flight turn; a session live under another owner still rejects with `session/live`.
- Deleting the open session lands on New Session; the log can never be reloaded afterwards.
- No undelete or unarchive path: recovery is restoring from outside the harness.
- The dead `dsh-client-runtime` package (zero importers, absent from every bundle and the shipped runtime, explicitly excluded from the boot manifest as an upstream-removed layer) was deleted instead of ported: its 59 standalone type errors are gone with it, and the registry table, generated config catalog, `pnpm-workspace.yaml` pin, and this note were updated to match. Its `prebuild` emitter (`scripts/emit-runtime-lib.mjs`) was removed in the same sweep — the workspace package no longer exists to emit entries for. Deleting rather than porting was chosen because porting unexecuted code buys no behavior and risks inventing semantics no consumer observes.
