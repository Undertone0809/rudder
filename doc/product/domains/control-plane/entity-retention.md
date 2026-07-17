---
title: Entity Archive Delete And Retention
domain: control-plane
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - CONTROL.ENTITY.RETENTION.001
related_code:
  - packages/db/src/schema/entity_tombstones.ts
  - packages/db/src/schema/entity_cleanup_jobs.ts
  - packages/db/src/schema/issues.ts
  - server/src/routes/chats.ts
  - server/src/routes/issues.mutations.ts
  - server/src/app.ts
  - server/src/services/chats.ts
  - server/src/services/issues.ts
  - server/src/services/entity-tombstones.ts
  - server/src/services/entity-run-cleanup.ts
  - server/src/services/entity-cleanup-jobs.ts
  - server/src/services/orphaned-assets.ts
  - server/src/services/activity.ts
  - server/src/services/automations.ts
  - server/src/services/calendar.ts
  - server/src/services/runtime-kernel/heartbeat.wakeup.ts
  - ui/src/pages/OrganizationSettings.tsx
related_tests:
  - packages/db/src/client.test.ts
  - server/src/__tests__/chat-routes.test.ts
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - server/src/__tests__/issues-service.test.ts
  - server/src/__tests__/messenger-service.test.ts
  - server/src/__tests__/activity-service.test.ts
  - server/src/__tests__/automations-service.test.ts
  - server/src/__tests__/heartbeat-paused-wakeups.test.ts
  - server/src/__tests__/heartbeat-run-concurrency.test.ts
  - tests/e2e/organization-settings-archived-chats.spec.ts
  - tests/e2e/organization-settings-archived-issues.spec.ts
related_plans: []
edit_policy: user_confirmed_only
---

# Entity Archive Delete And Retention

## CONTROL.ENTITY.RETENTION.001

## Contract Summary

Issue and Chat removal is a deliberate two-stage lifecycle. Archive is a
reversible visibility state; permanent delete is available only for archived
entities from Organization Settings. Delete removes entity-owned content and
execution records while retaining a minimal tombstone so stale references can
report that the entity was intentionally deleted.

## Intent / User Job

An operator needs to remove inactive work from every normal work surface
without immediately destroying it, inspect or restore that work from one
bounded settings surface, and permanently erase it only after a second explicit
decision. Agents following an old UUID or issue identifier need a clear deleted
signal instead of treating the missing entity as an unexplained lookup failure.

## Why / Design Reasoning

- Archive provides a reversible safety boundary and keeps inactive work out of
  boards, Messenger, search, Activity, approvals, agent context, and new run
  admission.
- Permanent delete is intentionally separated from active work actions so a
  routine task menu cannot destroy a work record in one click.
- A tombstone retains only enough identity to explain a stale reference. Full
  descriptions, messages, comments, attachments, runs, logs, and other
  entity-owned content must not survive as a hidden deleted entity.
- Physical objects and local logs can fail independently of the database
  transaction. Durable cleanup jobs let logical deletion complete while making
  physical cleanup retryable instead of silently abandoning it.

## Actors / Objects / State

- Board operator: archives active Issue or Chat work, and lists, restores, or
  permanently deletes archived work from Organization Settings.
- Agent/runtime actor: may encounter an old direct reference but must not
  receive archived entity context or start new work against it.
- Issue: keeps its work status and uses `archivedAt` as a separate reversible
  visibility marker.
- Chat conversation: uses the `archived` conversation status for the reversible
  visibility state.
- Tombstone: organization, entity type, UUID, title, optional issue number,
  deleting actor, and deletion time.
- Cleanup job: organization, physical artifact type/reference, attempt count,
  last error, and next retry time.

## Entry Points / Inputs

- Issue Detail `Archive Issue` action.
- Messenger or Chat `Archive` action for locally mutable conversations.
- Organization Settings `Chat` and `Issues` archived lists.
- Board-only restore and permanent-delete API mutations.
- Organization-scoped `Delete all` for archived, locally deletable Chats.
- Direct Issue or Chat lookup by a stale UUID or readable issue identifier.

## Product Logic Flow

1. Rudder locks the target entity before a lifecycle mutation and rechecks its
   organization, current archive state, hierarchy constraints, mutability, and
   active generation/run state.
2. Archive records the reversible state and activity evidence. It does not
   delete the entity's content.
3. Normal lists, direct reads, search, Messenger, Activity, approvals, agent
   startup/run context, and new wake/run admission exclude the archived entity.
   Board-only Organization Settings lists are the supported discovery surface.
4. Restore is initiated from Settings, rechecks the entity under lock, clears
   the archive state, and returns the entity to normal domain visibility.
5. Permanent delete is accepted only for an archived entity. Rudder rejects
   deletion while active work exists and enforces Issue hierarchy order.
6. In the delete transaction, Rudder creates the tombstone, removes
   entity-owned relational content and execution records, detaches
   organization-level accounting records from deleted entity/run identifiers,
   and enqueues physical artifact cleanup before deleting the entity row.
7. Rudder attempts physical object, run-log, workspace-operation-log, and
   runtime-service cleanup immediately. Successful cleanup removes its job;
   failure leaves a durable retry record with bounded exponential backoff.
8. A later direct lookup of the deleted UUID, or readable Issue identifier,
   returns HTTP `410` with `code: ENTITY_DELETED` and the minimal tombstone.
   Tombstones are not a user-browsable archive or a recovery source.
9. Bulk archived-Chat deletion locks and deletes only candidates in the viewed
   organization. Externally managed conversations are skipped and retained.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Archive active work | Entity is locally mutable and has no active generation/run; Issue hierarchy is archive-safe | Archive state and activity persist; entity disappears from normal surfaces | Archive must not delete content or leave the entity visible to agents | Lifecycle route/service tests and Settings E2E |
| Archive while work is active | Active Chat generation, active Issue work, queued/running wake, or pending terminal effects exist | Mutation returns a conflict and entity remains active | Archive must not race an in-flight run | Chat/Issue lifecycle and run cleanup tests |
| Restore archived work | Board operator uses Settings; parent Issue is active when restoring a child | Archive state clears and normal visibility returns | Agent/API knowledge of an old UUID must not bypass the Settings boundary | Settings E2E and route authorization tests |
| Delete active work | Entity is not archived | Permanent delete is unavailable/rejected | Active Chat or Issue menus must not expose destructive delete | Messenger/Issue UI tests and route tests |
| Delete archived work | Board operator confirms; no active work; hierarchy/mutability checks pass | Entity-owned content is removed, tombstone and cleanup jobs persist | Full deleted entity content must not remain queryable | Service tests, migration tests, Settings E2E |
| Follow stale reference | Tombstone matches direct UUID or readable Issue identifier | HTTP `410 ENTITY_DELETED` with minimal identity | Deleted work must not look active, archived, or recoverable | Chat/Issue route tests |
| Physical cleanup fails | Database deletion committed; object/log/service removal fails | Cleanup job remains and retries with recorded error/backoff | Logical deletion must not silently discard the only cleanup instruction | Cleanup job and route/service failure tests |
| Delete all archived Chats | Board confirms in one organization | All eligible archived local Chats in that organization are deleted; external-bound Chats and other organizations remain | Bulk delete must not cross organization or mutability boundaries | Archived Chat E2E plus Chat route/service tests |

## Actor-Visible Input

The operator sees `Archive`, not permanent `Delete`, on normal Issue and Chat
work surfaces. Organization Settings exposes searchable archived Chat and Issue
lists with restore and permanent-delete actions; the Chat list also exposes
`Delete all` with an explicit count and destructive confirmation.

An agent receives no archived entity in ordinary context or admission paths. If
it explicitly follows a stale deleted reference, the API response says that
the entity was deleted and includes only the tombstone identity.

## Operator-Visible Output

- Archive removes the entity from boards, normal Messenger/Chat lists, search,
  Activity, and other ordinary product surfaces.
- Restore removes the row from Settings and returns it to normal visibility.
- Permanent delete removes the archived row and cannot be undone.
- Bulk Chat deletion reports deleted and skipped-external counts.
- Cleanup retry state is operational evidence; it does not resurrect or expose
  the deleted entity.

## Persisted Evidence

- Archive markers, `issue.archived` / `issue.restored` activity, and
  `chat.updated` activity carrying the Chat lifecycle status while the entity
  exists.
- A minimal `entity_tombstones` row after permanent deletion.
- Organization-level deletion activity without retaining the deleted entity as
  an activity target.
- `entity_cleanup_jobs` rows until each physical artifact or runtime service is
  successfully removed.
- Detached organization accounting records may remain for aggregate financial
  integrity, but must not retain the deleted Issue or Run foreign-key identity.

## Canonical Scenarios

1. Archive and restore an Issue:
   - Trigger: operator archives an inactive leaf Issue, then opens Settings.
   - Expected state/action: the Issue is absent from the board and Messenger;
     restoring it clears `archivedAt`.
   - Visible output: the Issue moves into and then out of the archived list.
   - Evidence: Issue lifecycle routes and archived-Issue E2E.
2. Permanently delete an archived Chat:
   - Trigger: operator confirms delete from the Settings Chat row.
   - Expected state/action: messages, context, approvals, run records, and
     entity-owned attachments are removed; cleanup jobs cover physical files.
   - Visible output: Chat disappears from Settings; stale direct lookup returns
     `410 ENTITY_DELETED` with its title.
   - Evidence: Chat routes, cleanup failure tests, and archived-Chat E2E.
3. Reject unsafe Issue hierarchy deletion:
   - Trigger: operator attempts to archive a parent with active children or
     delete a parent that still has children.
   - Expected state/action: mutation conflicts and the parent remains.
   - Visible output: operator receives the hierarchy-order error.
   - Evidence: Issue service and lifecycle route tests.
4. Retry failed physical cleanup:
   - Trigger: storage or local log deletion fails after logical delete.
   - Expected state/action: cleanup job records the error and retries later.
   - Visible output: entity stays deleted; no hidden partial entity returns.
   - Evidence: Chat route storage-failure and cleanup-job tests.

## Invariants / Non-Goals

- Archive is reversible; permanent delete is not.
- Only archived Issue and Chat entities may be permanently deleted.
- Archived entities are discoverable only through board Organization Settings,
  not through ordinary product or agent surfaces.
- Permanent delete must not proceed while relevant generation, wake, run, or
  terminal effects are active.
- A tombstone is explanatory identity, not retained entity content, a recycle
  bin, search result, or restoration mechanism.
- Physical cleanup jobs must be written before the database loses the artifact
  references required to retry cleanup.
- Organization boundaries apply to list, restore, delete, tombstone lookup, and
  cleanup processing.
- This contract does not promise immediate physical deletion when an external
  store is unavailable; it promises durable retry until cleanup succeeds.

## Drift Boundaries

Update this contract when supported entity types, archive visibility,
permissions, delete prerequisites, tombstone fields, `410` response semantics,
bulk-delete scope, cleanup artifact classes, or retry guarantees change.

Storage provider implementation, worker interval, batch size, SQL ordering, and
UI layout are implementation details while the observable lifecycle and retry
guarantees remain unchanged.

## Traceability

Related plans:

- None. This contract records the shipped lifecycle behavior directly.

Related code:

- `packages/db/src/schema/entity_tombstones.ts`
- `packages/db/src/schema/entity_cleanup_jobs.ts`
- `server/src/services/entity-tombstones.ts`
- `server/src/services/entity-run-cleanup.ts`
- `server/src/services/entity-cleanup-jobs.ts`
- `server/src/services/activity.ts`
- `server/src/services/automations.ts`
- `server/src/services/calendar.ts`
- `server/src/services/runtime-kernel/heartbeat.wakeup.ts`
- `server/src/services/chats.ts`
- `server/src/services/issues.ts`
- `ui/src/pages/OrganizationSettings.tsx`

Related tests:

- `packages/db/src/client.test.ts`
- `server/src/__tests__/chat-routes.test.ts`
- `server/src/__tests__/issue-lifecycle-routes.test.ts`
- `server/src/__tests__/issues-service.test.ts`
- `server/src/__tests__/activity-service.test.ts`
- `server/src/__tests__/automations-service.test.ts`
- `server/src/__tests__/heartbeat-paused-wakeups.test.ts`
- `server/src/__tests__/heartbeat-run-concurrency.test.ts`
- `tests/e2e/organization-settings-archived-chats.spec.ts`
- `tests/e2e/organization-settings-archived-issues.spec.ts`

Known gaps:

- Full physical cleanup timing depends on external storage and local filesystem
  recovery; durable jobs preserve the retry obligation across failures.
