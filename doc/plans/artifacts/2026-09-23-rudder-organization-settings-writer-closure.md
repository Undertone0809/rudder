# Organization Settings Writer Closure

## Review Binding

- Review type: read-only semantic writer-closure audit. This artifact does not
  authorize source changes, owner handoff, commit, push, or release claims.
- Candidate source: `ceb08be24dcbf71ae110e55b9907deca54d91a0f`.
- Candidate tree: `5fea688abee9389723b307bbcbde1046fe7c3285`.
- Product-source equivalence: `d3287434fd1632d57086f329c69b5b07efd32c2b..ceb08be24dcbf71ae110e55b9907deca54d91a0f` contains only `desktop/scripts/rust-member-directory-smoke.mjs` and `desktop/scripts/smoke.mjs`; the server, UI, database, CLI, native, and migration paths reviewed here are unchanged from `d328`.
- `origin/main` at review: `38acc6fbe5c21c38c05a74cea19fbfe5123ea4cf`.
- Worktree state: parent-owned documentation and evidence files are dirty;
  those metadata changes are excluded from the source candidate identity.
- Scope: exact writers and readers for `name`, `description`, `status`,
  `budgetMonthlyCents`, `spentMonthlyCents`, `defaultChatIssueCreationMode`,
  `requireBoardApprovalForNewAgents`, `issuePrefix`, `brandColor`, and
  `logoAssetId`, plus issue-prefix aliases, Issue identifiers/counters, logo
  relations, asset rows, storage objects, receipts, activity, and outbox.

## Closure Standard

An `OrganizationSettingsCommand` is closed only when every supported first-party
entry point reaches the same organization-scoped authority, actor and
idempotency identity are bound server-side, all coupled rows commit or roll back
together, activity/receipt/outbox behavior is preserved, and stale writers fail
closed without disabling a supported downstream workflow. The create path,
existing-organization mutation path, import path, Chat proposal/approval path,
CLI/MCP path, and delete/recovery path must be considered separately.

The current source does **not** meet that definition for an organization-wide
command. Rust has a bounded branding component, not an organization settings
owner.

## Current Rust Boundary

The core contract in `native/crates/organization-mutation-core/src/lib.rs:126-247`
models `name`, `description`, `brandColor`, and `logoAssetId`, and binds actor,
organization, idempotency key, expected version, and fence epoch. Its state
machine also applies those four fields in memory at `:485-602`. That is not
durable authority by itself.

The real HTTP and SQLx adapter narrow the contract:

- `native/crates/server-foundation/src/lib.rs:1302-1389` requires an idempotency
  key and verified actor envelope, then rejects `name`, `description`, and
  `logoAssetId`, or a request without scalar `brandColor`, with
  `branding_scalar_brand_color_required`.
- `native/crates/d1-persistence/src/transaction.rs:81-129` repeats the same
  gate in `Metadata::branding`, so the persistence adapter cannot accidentally
  accept the other fields.
- `native/crates/d1-persistence/src/branding.rs:19-80` reads the organization
  and current logo projection, but its durable SQL updates only
  `organizations.brand_color`.
- `native/crates/d1-persistence/src/transaction.rs:744-870` advances the
  branding component fence and writes the branding activity row, immutable
  receipt, and organization mutation outbox in one SQLx transaction. This is a
  valid scalar branding boundary, not proof that all organization settings are
  Rust-owned.
- `server/src/services/rust-foundation-bridge.ts:322-350,547-593` starts the
  private child, creates a request-bound actor envelope, requires the caller's
  idempotency key, and forwards the authenticated request. The route handoff at
  `server/src/routes/orgs-rust-foundation.ts:151-198` starts/proves the child
  before changing the durable branding owner.

## Writer Evidence Table

The table records the current writer, transaction/fence, downstream meaning,
and closure result. `Node` means the current production authority remains the
TypeScript/Drizzle path; it does not mean every caller is equally safe.

| Target | Current real writers and callers | Transaction, fence, and identity | Downstream semantics | Closure result |
| --- | --- | --- | --- | --- |
| `name` | `server/src/services/orgs.ts:291-352` on create; `:354-470` on update; `server/src/routes/orgs.ts:1205-1240,1242-1312`; new/existing organization import at `server/src/services/knowledge-portability/organization-portability.import.ts:126-173`; Chat lightweight and approval handlers at `server/src/services/chats.ts:4753-4798,5001-5028`. | Existing update is one DB transaction and locks the Node organization fence at `orgs.ts:358-365`; create uses advisory uniqueness locking inside `createCompanyWithUniqueKeys` and provisions mutation rows in the create transaction. HTTP auth is route-bound; Chat validates same-org targets before calling the service. | Name is read by organization/UI/export surfaces and participates in create-derived URL-key defaults. Chat approval also needs its proposal/message/activity transition to survive an organization write. | Node-owned. Rust core modeling is not an active writer; Rust HTTP/SQLx reject name. A name handoff must account for Chat and import callers and preserve the existing transaction boundary. |
| `description` | Same generic organization create/update, import, and Chat proposal writers as `name`. | Same create/update fences and separate post-update route activity logging. Rust adapter rejects it. | User-visible organization description and portability data; no evidence supports silently dropping or deferring it when a supported mixed patch is accepted. | Node-owned; no Rust closure. |
| `status` | `organizationService.archive` at `server/src/services/orgs.ts:472-488`; budget hard-stop/resume paths at `server/src/services/budgets.ts:214-267`; generic service update is also reachable from supported Chat organization proposals. | Archive is a transaction with the Node organization fence. Budget status changes use `updateOrganizationWithNodeFence` (`budgets.ts:55-68`) in separate transactions from policy/incident work. | Runtime admission reads organization status in `budgets.ts:776-838`; heartbeat paths use that admission decision. Backup and other operational readers also distinguish active organizations. | Node-owned and semantically coupled to runtime/budget control. An org-wide Rust handoff that only makes a settings PATCH pass would strand budget pause/resume or archive behavior. |
| `budgetMonthlyCents` | `PATCH /api/orgs/:orgId/budgets` at `server/src/routes/costs.ts:291-323`; organization create at `server/src/routes/orgs.ts:1227-1238`; `budgetService.upsertPolicy` at `server/src/services/budgets.ts:483-600`; policy delete `:602-680`; budget incident raise/resume `:903-935`; import new organization initializes it at `organization-portability.import.ts:141-153`. | `organizations.update` is fenced, but `upsertPolicy` first writes `budget_policies` and then calls a separate fenced organization transaction (`budgets.ts:497-551`). The route itself updates the organization before the policy upsert (`costs.ts:295-320`). Delete is one transaction, while raise/resume again has separate policy and organization work. | The policy row controls hard-stop, incident, cancellation, and resume behavior; runtime admission observes policy and organization status. | Node-owned. A settings-only Rust writer cannot own this scalar without the policy, incident, cancellation, activity, and rollback contract. |
| `spentMonthlyCents` | `server/src/services/costs.ts:251-373` records cost events, rollups, agent spend, and organization spend. Organization reads recompute current-month spend from `cost_events` in `server/src/services/orgs.ts:123-155`; cost summaries read the ledger at `costs.ts:403-424`. | Cost event creation is one transaction, locks the Node organization fence at `costs.ts:266-268`, and updates both rollups and `organizations.spentMonthlyCents` at `:334-372`. Budget evaluation is a later replayable transaction at `:375-399`. | This is a ledger-maintained/cache-derived value used by cost and budget views, not an independently user-editable organization setting. | Not a safe command patch field. Keep it under the cost ledger authority; do not claim a Rust settings closure merely because the organization row contains the cached scalar. |
| `defaultChatIssueCreationMode` | Generic organization create/update and import. Chat entry points copy the organization default at `server/src/routes/chats.ts:2105-2139` and `server/src/routes/chats.stream-routes.ts:1147-1176`. | The setting write is in the Node organization transaction. Chat creation persists the selected mode in `chatConversations` through `server/src/services/chats.create.ts:45-89,125-230`; later auto-create behavior reads the persisted conversation mode at `server/src/routes/chats.ts:896-965`. | Changing the default affects future conversations only; it must not rewrite existing conversation modes. | Node-owned. A future component handoff needs generic HTTP, import, and Chat default-read coverage, while preserving the conversation transaction and approval behavior. |
| `requireBoardApprovalForNewAgents` | Generic organization create/update; import at `organization-portability.import.ts:141-173`; agent creation reads it at `server/src/routes/agents.management-routes.ts:175-202`. | Generic setting writes use the Node organization fence; create/import have their separate lifecycle transactions. Agent creation then creates the agent and possible approval record in later operations. | It changes the new-agent lifecycle: an agent actor becomes `pending_approval` instead of `idle`. It is not cosmetic organization metadata. | Node-owned. Rust ownership without agent-creation and approval delegation would disable or alter supported onboarding semantics. |
| `issuePrefix` | Create uniqueness allocation at `server/src/services/orgs.ts:201-259`; existing update at `:379-412`; existing-org import at `organization-portability.import.ts:164-173` and new-org create; issue lookup resolves aliases at `server/src/services/issues.ts:938-968`. | Create/update use the organization transaction plus `pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'))`; update validates current/alias ownership, inserts the old prefix alias, and rewrites all org Issue identifiers in the same transaction. | Prefix changes must preserve global route-key uniqueness, old identifier lookup, and every existing identifier projection. | Node-owned and tightly coupled to aliases and Issues. It cannot be split from a name/settings command without preserving this atomicity. |
| `brandColor` | Generic org/branding routes delegate to Rust only for an exact scalar request at `server/src/routes/orgs.ts:1265-1295,1314-1342`; otherwise Node `organizationService.update`. CLI direct command is `cli/src/commands/client/company-organization-commands.ts:70-93`; MCP direct capability is `cli/src/agent-v1-mcp-organization-project.ts:44-53,128-133`. | Node locks branding then organization fences when it writes the scalar. Rust uses the separate branding component fence, verifies actor/org/idempotency, checks owner/version/epoch, and atomically persists scalar SQL plus activity/receipt/outbox. | This is the current bounded Rust real-entry slice. | Scalar Rust component is closed at its claimed scope; the whole organization settings command is not. |
| `logoAssetId` | Logo upload creates external storage object then DB asset row at `server/src/routes/assets.ts:214-311`; generic organization update validates same-org asset, updates `organization_logos`, and deletes the previous asset DB row at `server/src/services/orgs.ts:414-463`; import does upload, asset create, then association at `organization-portability.import.ts:178-225`. | Asset DB insert is a fenced transaction (`server/src/services/assets.ts:6-24`), but storage upload precedes it. Association/relation is in the organization update transaction. `organization_logos` is one-per-org and one-per-asset (`packages/db/src/schema/organization_logos.ts:5-17`). | The relation, asset metadata row, provider object, content endpoint, portability export/import, and replacement/removal cleanup are one user-visible lifecycle. | Node-owned and incomplete as a standalone Rust slice. Rust HTTP rejects the field. Replacing/removing a logo deletes the old DB row but does not call `storage.deleteObject`; organization delete instead performs best-effort local workspace cleanup, not a provider-neutral object deletion protocol. |

## Companion Rows That Cannot Be Omitted

### Prefix aliases, Issue counters, and identifiers

`organization_issue_prefix_aliases` is globally unique by prefix and cascades from
its organization (`packages/db/src/schema/organization_issue_prefix_aliases.ts:4-14`).
`organizationService.update` performs alias conflict checks, inserts the previous
prefix, and rewrites all org Issue identifiers atomically at
`server/src/services/orgs.ts:386-412`.

Issue creation is another direct organization-row writer:

- `server/src/services/issues.ts:1062-1158` locks the Node organization fence,
  increments `organizations.issueCounter`, derives `issuePrefix-issueNumber`,
  and inserts the Issue in the same transaction.
- Alias lookup is org-bound in `issues.ts:938-968`.
- `cli/src/commands/worktree-merge.ts:56-75,689-815` is a separate first-party
  writer. It checks the same Node fence in its own target-DB transaction and
  increments `issueCounter` directly before inserting imported identifiers.

Flipping `organization_mutation_state.owner` to Rust while these writers remain
Node paths would make ordinary Issue creation, worktree merge, and any other
fenced organization writer fail with the existing owner conflict. That is a
feature outage, not successful migration evidence.

### Assets and storage objects

The organization relation is only one part of the asset lifecycle:

1. `storage.putFile` writes the provider object before `assetService.create`
   inserts the DB row (`server/src/storage/service.ts:90-130` and
   `server/src/routes/assets.ts:260-277`).
2. `organizationService.update` changes `organization_logos` and deletes a
   replaced asset row, but does not delete its provider object
   (`orgs.ts:438-463`).
3. `organizationService.remove` deletes relation and asset rows and then calls
   `removeOrganizationStorage` (`orgs.ts:490-568`; `home-paths.ts:1409-1452`),
   which removes local organization directories only.

A Rust DB relation writer would therefore not close logo ownership. The minimum
logo unit needs storage-provider identity, same-org validation, association,
compensation for upload/association failure, replacement/delete object cleanup,
import/export, restart/replay, and provider-neutral recovery evidence.

## Lifecycle Split: New Organization vs Existing Mutation

### New organization and pre-handoff

`POST /api/orgs` first rejects a non-null `brandColor` when required Rust mode
is enabled, then calls `organizationService.create` at
`server/src/routes/orgs.ts:1205-1217`. The create transaction inserts the
organization, `organization_mutation_state`, `organization_branding_mutation_state`,
default labels, workspace layout, and product analytics
(`server/src/services/orgs.ts:291-352`). It does not use an existing org fence;
it provisions the state rows for a new organization.

The route then performs branding handoff in a separate transaction, ensures
membership, logs `organization.created`, and may upsert the budget policy in
separate operations (`orgs.ts:1214-1238`). Therefore a successful create plus
branding handoff is not evidence that a multi-field `OrganizationSettingsCommand`
covered creation, membership, activity, budget policy, or recovery atomically.

New-organization portability follows the same split in
`organization-portability.import.ts:126-160`; when required branding mode is
active, the import rejects organization-inclusive settings at `:92-94` rather
than proving a Rust import writer.

### Existing organization mutation

A generic `PATCH /api/orgs/:orgId` or `/branding` first authenticates the
organization and board/CEO-agent actor. Under required Rust branding mode it
accepts only an exact scalar `brandColor` body, requires idempotency, and routes
through the private bridge. Mixed branding/non-branding requests are explicitly
rejected at `server/src/routes/orgs.ts:1265-1292,1317-1340`.

All other supported settings call `organizationService.update`, whose single DB
transaction performs the scalar organization update, prefix alias/Issue
identifier changes, logo relation/asset-row changes, and readback at
`server/src/services/orgs.ts:354-470`. Route activity is logged afterward via
`server/src/services/activity-log.ts:41-106`; that Node activity insert and
live-event publication are not part of the organization update transaction.

Chat lightweight and approval handlers call the same Node service from
`server/src/services/chats.ts:4735-4798,4984-5028`, but then update proposal or
approval/message state and activity as additional operations. They are therefore
additional supported writers and recovery boundaries, not incidental aliases of
HTTP PATCH.

## Activity, Receipt, and Outbox Semantics

The current scalar Rust slice has a stronger persistence contract than the Node
settings paths:

- Rust branding writes the component fence, activity, immutable receipt, and
  `organization_mutation_outbox` in one SQLx transaction
  (`native/crates/d1-persistence/src/transaction.rs:744-870`). Its replay path
  validates command fingerprint, receipt format, organization, version, fence,
  activity identity, and result at `:535-583`.
- Node `logActivity` inserts `activity_log` and then publishes a live event after
  the insert (`server/src/services/activity-log.ts:41-106`). Generic org update
  and archive route activity happens after their business transaction. No
  equivalent organization receipt/outbox is created for those Node settings
  writes.
- The organization mutation outbox publisher is a transitional delivery path
  for Rust activity rows (`server/src/services/organization-mutation-outbox.ts:150-209`),
  not evidence that Node settings writes have durable outbox semantics.

A future settings command must preserve the existing Node user-visible activity
and Chat approval transitions while introducing any Rust receipt/outbox. A
receipt for the organization row alone is insufficient if a Chat proposal is
left pending or if import/storage side effects are stranded after a restart.

## Actor, Organization, and Idempotency Boundaries

The existing Rust branding path is appropriately bound: the bridge creates the
request envelope from the authenticated Express actor and path/body, forwards a
stable caller idempotency key, and Rust verifies the organization, actor role,
agent organization, and fence scope before SQLx mutation. The organization
mutation fence rejects missing/invalid rows, counters, tokens, and non-`node`
owners at `server/src/services/organization-mutation-fence.ts:17-54`.

That evidence does not cover a proposed settings command's other writers:

- `organizationService.update` has a service-level org ID and fence but no
  command receipt or stable idempotency contract of its own.
- Chat proposals and approvals use source-specific message/approval state and
  call `organizationsSvc.update`; a Rust command would need to bind that source
  identity rather than accept a free-standing patch after approval.
- Portability import has board authorization and target-org checks, but its
  organization, storage, membership, and imported-object operations are
  multiple transactions with warnings/partial success.
- Asset upload has org access and fenced asset-row insertion, but storage object
  write and DB association are separate.

## Explicit Unclassified Gaps

These are unresolved evidence gaps, not claims that the behavior is absent:

1. No exact source audit here proves a complete provider-neutral compensation
   protocol for logo object leaks after upload, replacement, import, or failed
   association. The current source shows the DB-row/storage ordering and the
   missing cleanup call, so a future logo handoff must close it explicitly.
2. No exact source audit here proves that all arbitrary Chat operation proposal
   patch producers are constrained to a closed organization-settings field set;
   the approval consumers accept a typed object patch and delegate to the generic
   Node service. The two consumers are listed, but producer validation and
   restart recovery need their own acceptance evidence.
3. No Rust public writer exists for `status`, budget policy, cost ledger/spend,
   chat-default behavior, agent approval lifecycle, issue-prefix aliases, or
   Issue counter/identifier allocation. A native crate or private handler alone
   would not close those authorities.
4. No single transaction currently spans organization scalar settings with
   membership, budget policy, Chat proposal/approval state, portability objects,
   or external storage. This is a known boundary, not a reason to claim those
   workflows are broken; it is a reason not to overstate command closure.
5. CLI/MCP currently expose a direct scalar brand-color capability and
   organization import/delete/list flows, but no complete organization-settings
   command. The generic `cli/src/agent-v1-mcp-server.ts` dispatch and
   `cli/src/commands/client/project.ts` project paths do not establish an
   organization settings writer.
6. This artifact is a bounded writer audit, not a full repository semantic
   inventory and not evidence of full Rust backend completion, production
   verification, or release readiness.

## Smallest Safe Sequencing

1. Keep `organization_mutation_state.owner=node` for the organization-wide
   fence. Keep the existing scalar branding handoff isolated to
   `organization_branding_mutation_state`; do not flip the organization owner
   merely because a name PATCH works.
2. Treat `spentMonthlyCents` as a cost-ledger field and move it, if at all, with
   cost event, rollup, budget evaluation, pause/cancel, and admission semantics,
   not inside a cosmetic settings command.
3. The next migratable settings unit is the existing organization scalar
   transaction (initially name/description/default-chat mode/agent-approval
   policy only) **only after** every supported generic HTTP, Chat proposal and
   approval, import, and create path either delegates the same command or
   explicitly remains Node without splitting a mixed request. The command must
   retain organization-scoped actor binding, idempotency, and atomic activity/
   receipt/outbox behavior.
4. Do not split `issuePrefix` from its aliases, issue identifier rewrite, issue
   counter allocation, and worktree-merge writer. Do not split `logoAssetId` from
   same-org asset validation, external storage compensation, association, and
   cleanup. These are separate subsequent authority units unless the command
   deliberately preserves the existing combined transaction.
5. Close budget/status/runtime and Chat/agent lifecycle dependencies before any
   organization-wide owner handoff. The local acceptance for each unit must
   include stale-writer rejection, replay/conflict behavior, cross-org denial,
   restart/recovery, and unchanged downstream behavior. A settings-only pass is
   not evidence for those units.
6. After each component is independently closed, perform a final owner-graph
   reconciliation: every direct organization-row writer is delegated, drained,
   or still protected by a compatible component fence. Only then can an
   organization-wide command be considered for activation.

## Audit Conclusion

`OrganizationSettingsCommand` is **not closed** on `ceb08`. The only active Rust
organization writer is the scalar `brandColor` component. The remaining fields,
Issue/alias projections, budget/runtime/cost semantics, Chat/agent lifecycle,
import, and asset/storage lifecycle remain Node-owned or explicitly unclassified.
Activating a Rust organization-wide owner now would turn existing shared-fence
writers into conflicts or split coupled transactions, which would be a
regression rather than a migration.
