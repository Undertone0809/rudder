# Full Branding Next-Slice Boundaries

## Review Binding

- Review scope: D1 organization branding writes only. This is a read-only source audit and implementation preparation artifact; it does not authorize product edits, a worktree, a commit, or acceptance.
- Product source baseline: `d3287434fd1632d57086f329c69b5b07efd32c2b`.
- Current checkout at audit time: `ceb08be24dcbf71ae110e55b9907deca54d91a0f`.
- `origin/main`: `38acc6fbe5c21c38c05a74cea19fbfe5123ea4cf`.
- `d328..HEAD` contains only the parent-owned Desktop smoke harness delta in `desktop/scripts/rust-member-directory-smoke.mjs` and `desktop/scripts/smoke.mjs`; the product paths cited below are unchanged. The current plan files and delivery artifacts are unrelated dirty work and are not part of this artifact.
- The accepted current branding proof is scalar `brandColor` only. It is not evidence for organization name, logo bytes, logo association/removal, storage cleanup, or portability behavior.

## Decision

The next authority unit is **the existing organization settings database transaction plus every supported name writer**. A name/color-only Rust adapter is a useful private prerequisite, but cannot complete name handoff: the public API and Chat proposals can combine name with other settings, issue-prefix changes, or logo association in one existing database transaction.

Preserve that database atomicity in SQLx, including issue-prefix alias and Issue identifier projection, same-organization logo asset validation, relation changes, and old asset-row deletion. Splitting name and remaining fields between Rust and Node commits would change rollback and read visibility: an invalid issue-prefix alias must not leave a changed name. Blocking only intervening writers does not make such a split equivalent to the existing transaction.

External logo upload and object lifecycle remain separate explicit authorities. The organization update transaction itself performs only database operations; moving its association operation does not establish a complete Rust logo lifecycle. A complete logo slice still needs storage, compensation, cleanup, portability and restart evidence below.

Both supported Chat approval paths must dispatch the same settings command and preserve their approval/message effects. A durable intent may recover these currently separate effects, provided all competing decision/source writers serialize with it, Rust binds the mutation and receipt to the claimed intent, and downstream Issue/wakeup effects are replay-safe. This is not a distributed atomicity claim. The exact coordinator schema remains under implementation review.

## Current Surface Map

| Surface | Current real entry | Current writer and side effects | Authority evidence |
| --- | --- | --- | --- |
| HTTP generic organization patch | `server/src/routes/orgs.ts:1242-1312` (`PATCH /api/orgs/:orgId`) | Board uses `updateOrganizationSchema`; CEO agent uses `updateOrganizationBrandingSchema`; all non-Rust patches call `organizationService.update`. Name and `logoAssetId` currently stay on Node. | When required, only an exact `{ brandColor }` body is sent to Rust; mixed fields conflict at `server/src/routes/orgs.ts:1265-1294`. |
| HTTP branding patch | `server/src/routes/orgs.ts:1314-1360` (`PATCH /api/orgs/:orgId/branding`) | Existing non-scalar fields call the Node organization service. `logoAssetId: null` is the public API remove operation. | Rust branch is exact scalar `brandColor` only at `server/src/routes/orgs.ts:1317-1340`. |
| Node to private Rust bridge | `server/src/routes/orgs-rust-foundation.ts:151-198,200-214` | Starts/proves the child, hands off the branding fence, forwards the signed body, and reads the organization back through Node. | `scalarBrandColorPatchOnly` is literally one key; required bridge errors fail closed. |
| Rust HTTP route | `native/crates/server-foundation/src/lib.rs:1302-1385,1972-1980,2072-2078` | Verifies actor envelope and idempotency, parses the four-field branding patch, resolves the fence scope, and calls SQLx. | The Rust route accepts the full core patch shape but rejects `name`, `description`, `logoAssetId`, or omitted `brandColor` as `branding_scalar_brand_color_required` at `:1335-1347`. |
| UI organization name | `ui/src/pages/OrganizationSettings.tsx:145-159,410-415,581-601`; `ui/src/lib/organization-settings-patch.ts:1-7` | Save sends `{ name }` through `organizationsApi.update`, then invalidates organization queries. | Current path is generic Node HTTP; it has no Rust-required header or idempotency key. |
| UI logo upload/association | `ui/src/pages/OrganizationSettings.tsx:331-348,549-579`; `ui/src/api/assets.ts:21-28` | First `POST /api/orgs/:orgId/logo` uploads bytes and creates an asset, then `PATCH /api/orgs/:orgId` associates the asset. | There is no UI remove control in this path; API/import can send `logoAssetId: null`. |
| CLI branding | `cli/src/commands/client/company-organization-commands.ts:70-94` | `rudder org brand-color update` calls the branding route with required Rust authority and idempotency headers. | This is the only direct organization branding CLI capability. |
| CLI organization import | `cli/src/commands/client/company.ts:1168-1210` and portability service | Import can change name, brand color, and logo, but it is a batch organization path, not a dedicated Rust branding command. | `server/src/services/knowledge-portability/organization-portability.import.ts:92-94` rejects organization-inclusive imports when Rust branding is required; this is an explicit block, not proof of migration. |
| MCP branding | `cli/src/agent-v1-mcp-organization-project.ts:44-53,128-133` | `organization.brand_color.update` uses direct HTTP and has a CLI argument mapping. | No name or logo MCP capability exists. The descriptor/CLI contract is `contracts/rudder-agent-contract/v1.json:155-202`; generated mirrors include `cli/src/agent-v1-capabilities.generated.ts:40-50` and `packages/agent-runtime-utils/src/rudder-mcp-tool-descriptors.generated.descriptors-0.ts:97-112`. |

## Reusable Rust Implementation

The next name slice can reuse these pieces without redesign:

1. `native/crates/organization-mutation-core/src/lib.rs:126-225` already defines a deny-unknown-fields camelCase patch with `name`, nullable `description`, `brandColor`, and nullable `logoAssetId`, then binds actor, organization, idempotency, version, and fence context in `into_command`.
2. `native/crates/organization-mutation-core/src/lib.rs:455-602` already validates non-empty names, applies name changes, increments the component version, records idempotency, and returns a complete organization settings snapshot. The snapshot retains description, color, and logo state for receipt integrity.
3. `native/crates/d1-persistence/src/branding.rs:8-80` already locks the branding state, checks replay/freshness, reads organization state, reads the current logo projection, and persists the mutation through the existing effect boundary. The SQL update currently changes only `brand_color` at `:54-62`; name is the smallest real extension.
4. `native/crates/d1-persistence/src/transaction.rs:81-129` is the current adapter gate. It rejects `name`, `description`, and `logo_asset_id` at `:83-91`, but already has expected-receipt fields for all of them. `persist_branding` at `:744-870` writes the owner/version, activity, immutable receipt, and outbox in one SQLx transaction.
5. `server/src/services/rust-foundation-bridge.ts:322-337,547-593` already provides mode selection, per-start envelope key generation, signed organization-branding transport, and fail-closed bridge errors. The next slice must preserve the existing child key/restart behavior.
6. `server/src/services/organization-branding-fence.ts:23-91` already provides the row lock, owner validation, and idempotent Node-to-Rust handoff. `server/src/services/orgs.ts:490-505` already acquires this fence before organization deletion and refuses deletion when a Rust-owned component is active.

## Writer And Fence Inventory

### Name writers

- `server/src/services/orgs.ts:354-470` is the central Node update transaction. It currently locks the branding fence only when `brandColor` is present at `:359-361`; a future name-owned component must classify `name` before taking the organization-wide fence and fail closed when the component owner is Rust.
- `server/src/routes/orgs.ts:1242-1312` and `:1314-1360` are the public HTTP callers. A required Rust request must reject mixed branding/non-branding patches instead of partially applying the Node subset.
- `server/src/services/chats.ts:4735-4798` and `:4986-5026` approve arbitrary organization proposal patches through `organizationsSvc.update`. `server/src/services/chats.helpers.ts:202-217` only checks that `patch` is an object; it does not constrain branding keys. A supported approval whose patch changes `name` is therefore part of the name unit: both approval paths must dispatch the same Rust name command, then preserve the approval transition, proposal/message structured-payload update, system message, activity, and outbox/recovery behavior shown in those ranges. Only stale/direct Node writers may be rejected. A name unit that rejects supported Chat approval is explicitly incomplete.
- `server/src/services/knowledge-portability/organization-portability.import.ts:141-173` creates or updates organization name/settings through Node. Its existing required-mode rejection at `:92-94` is a historical safety guard for an incomplete capability, not a success criterion. It must not silently send a mixed import through Node; full branding completion remains blocked until import name handling is delegated with preserved batch semantics or is explicitly listed as an unresolved blocker.
- The UI name save is the generic route described above. There is no second UI name writer found in the production source.

### Logo and asset writers

- `server/src/routes/assets.ts:214-311` accepts the logo bytes, sanitizes SVG, calls `storage.putFile` at `:260-266`, then calls `assetService.create` at `:268-277` and logs `asset.created` at `:279-294`.
- `server/src/services/assets.ts:6-24` protects only the general `organization_mutation_state` while inserting the asset row. It has no branding-specific ownership check and has no asset deletion/compensation method.
- `server/src/routes/orgs.ts:1242-1360` and `server/src/services/orgs.ts:414-463` validate same-organization ownership, upsert/delete `organization_logos`, hydrate `logoUrl`, and delete the previous asset row when replacing/removing a logo. `server/src/services/orgs.ts:456-457` deletes the database row but does not call storage deletion.
- `packages/db/src/schema/organization_logos.ts:5-17` enforces one logo per organization and one organization per asset with unique indexes and cascading foreign keys. `packages/db/src/schema/assets.ts:5-25` stores provider, object key, content metadata, and organization ownership.
- Organization deletion at `server/src/services/orgs.ts:490-568` locks both fences, deletes `organization_logos` at `:548`, deletes all organization asset rows at `:550`, and then calls local `removeOrganizationStorage` at `:560-566`. `server/src/home-paths.ts:1409-1443` removes local organization directories; it is not a provider-neutral object deletion protocol.
- Object deletion is available in the Node abstraction at `server/src/storage/types.ts:31-61` and `server/src/storage/service.ts:90-130`, but the logo replacement/removal transaction does not use it. No matching Rust organization storage/asset crate or provider bridge was found under `native/crates` or `native/bins`.
- Because upload writes external storage before the asset row and later association, a failed fenced association can leave an object and/or asset row orphaned. A complete logo slice must add a bounded compensation or durable cleanup protocol; a database-only Rust logo relation is not a complete logo authority.

### Other relevant readers/exporters

- Organization reads hydrate `logoUrl` from `organizationLogos.assetId` in `server/src/services/orgs.ts:85-111,151-161`.
- Export reads the asset row and object bytes in `server/src/services/knowledge-portability/organization-portability.export.ts:355-373`; the manifest records `brandColor` and `logoPath` at `:662-669`.
- Import clears, uploads, creates, and associates logos in `server/src/services/knowledge-portability/organization-portability.import.ts:178-225`. This is a separate batch writer, not a safe implicit Rust delegation.
- The existing ledger records the same boundary: `doc/plans/2026-09-21-rudder-full-rust-backend-completion-ledger.yml:69-73` retains Node authority for organization name, logo relation, asset upload, and storage cleanup, and says logo storage/chat approval require a separate complete slice.

## Bounded Future Write Set: Name Slice

This is a preparation list for the next scheduled implementation, not a claim that the slice exists.

1. Extend the existing Rust branding adapter and SQLx update to allow a name-only command while preserving the current `brandColor` command. Update the expected receipt/details and SQL row update in `native/crates/d1-persistence/src/transaction.rs:81-129` and `native/crates/d1-persistence/src/branding.rs:19-80`.
2. Replace the scalar-only route predicate only after the expanded Rust command preserves every supported mixed settings transaction. Cover ordinary settings, issue-prefix aliases/Issue identifier projection and logo association/old asset-row deletion atomically. Until then, do not activate or claim the complete name handoff; an explicit conflict is protection for incomplete implementation, not acceptance.
3. Make stale direct Node name/color writers acquire the same branding lock before the general organization lock and fail closed after the Rust handoff. At minimum this includes the generic organization service and any direct route/service bypass. Do not apply that rejection rule to supported Chat approval: both approval paths must dispatch the same Rust name command, retain the approval transition, proposal/message payload update, system message, activity, outbox, idempotency, and restart recovery semantics. A missing approval adapter is a concrete blocker, not a permissible feature removal.
4. Add a direct, idempotent CLI/MCP name capability if CLI/MCP coverage is required for this slice. The bounded contract set is `contracts/rudder-agent-contract/v1.json`, `cli/src/commands/client/company-organization-commands.ts`, `cli/src/agent-v1-mcp-organization-project.ts`, focused tests, and generated outputs produced by `pnpm mcp-contract:generate` (generator: `scripts/generate-rudder-mcp-tool-descriptors.ts`). Do not make a generic MCP/CLI fallback the authority path.
5. Keep external logo upload/read/object cleanup explicit until the logo lifecycle has its own storage/compensation design. The DB association portion must participate in the expanded settings transaction for supported mixed patches. Restore organization import through that command with stable operation identity and preserved batch semantics; the existing import conflict remains an incomplete capability and cannot count toward full branding completion.

## Acceptance Packet For Name Slice

### Implementation coordination checkpoint

The isolated lane is `codex/rudder-branding-name-authority-20260923`, based on
`ceb08be24dcbf71ae110e55b9907deca54d91a0f`. Epicurus owns Rust command/persistence
and tests; Volta owns Node integration, DB schema/generation and focused tests.
The integration candidate remains unchanged while this lane develops.

- Introduce an independent `OrganizationSettingsCommand` with a new
  `organization_settings` receipt kind/format. Preserve the old branding
  command, fingerprint and receipt format. The settings command carries the
  supported patch and a closed audit-surface enum, rather than arbitrary SQL
  or arbitrary effect JSON.
- Reserve the next unreleased migration slot, 0175, for the coordinated schema
  addition. Inspect generated SQL against the existing manual migrations;
  never recreate earlier tables or rewrite Main migration identities.
- A proposed `organization_mutation_intents` row binds an immutable normalized
  patch, original actor, source identity, generation, fingerprint and stable
  idempotency key. It supports both `chat_lightweight` and `chat_approval`;
  approval-backed proposals retain their existing optional message reference.
- All affected decision writers and Rust use one lock order: approval source
  when present, proposal-message source when present, intent, organization
  mutation state, organization row, then the existing prefix/asset locks.
  Reject/revision/resubmit/source-edit paths must not race a claimed mutation.
- Rust re-reads the intent and source scope, checks the current claim token,
  lease and immutable fingerprint, and commits settings, receipt, audit/outbox
  and `rust_committed` intent state together. Rotating claim credentials are
  excluded from the stable idempotency key; stale attempts cannot mutate.
- Chat completion preserves proposal metadata/detached transcripts,
  conversation touch, system-message uniqueness and audit. Durable downstream
  targets and progress markers cover linked Issue changes and requester/agent
  wakeup enqueueing. A completion timestamp alone is not recovery evidence.
  External delivery remains at-least-once; durable enqueue idempotency is not
  exactly-once execution.
- Do not activate the organization-wide Rust owner while cost, budget, Issue
  or runtime writers would merely fail their existing fence. Their connected
  transactions require compatible delegation before handoff. The new command
  stays private until this dependency is closed without feature loss.

The following are the minimum real checks for a future implementation. They are not run by this audit.

### API and UI

- Real authenticated board and permitted CEO-agent `PATCH /api/orgs/:orgId/branding` name update reaches Rust, returns the same organization shape, increments the branding version, and persists after a fresh read.
- Generic `PATCH /api/orgs/:orgId` name and mixed settings updates use one Rust database transaction when required. Name plus a conflicting issue prefix or invalid logo asset rolls back every field/projection; successful mixed patches preserve existing output and atomic visibility.
- Foreign-organization agent requests remain `403`; invalid/absent idempotency, replay, conflicting reuse, stale version/fence, audit failure, and bridge/binary failure preserve current HTTP error behavior and make no Node fallback write.
- UI organization settings name save and reload observe the Rust-written name. External logo upload/read remains a separate authority; database association tests do not count as complete Rust logo lifecycle acceptance.

### Supported approval path

- Create a real organization-name proposal and exercise both supported approval handlers at `server/src/services/chats.ts:4735-4798` and `:4986-5026`. Approval must dispatch the same Rust command as direct HTTP, not call the stale Node organization writer.
- Read back the approval state, proposal structured payload, approval/system message, organization name, activity, receipt, and outbox. Inject audit/outbox failure and restart between command and post-approval side effects; verify the current approval/message recovery contract and no duplicate name mutation or message/activity side effects.
- The current handlers perform the organization write before some approval/message side effects. The implementation must bind the proposal/approval identity to a replay-safe Rust idempotency key and durable retry marker/outbox, or provide an equivalent transaction boundary, so a committed name cannot lose its approval transition or messages after interruption. A one-shot Rust call followed by best-effort Node messages is incomplete.
- A stale direct Node writer must return the existing ownership conflict before business mutation. A `403`/conflict from the supported approval workflow is a failure of this slice, not an acceptable retirement result.

### CLI and MCP

- The existing `organization.brand_color.update` CLI/MCP direct HTTP probe still passes, including replay/conflict and no CLI-fallback authority substitution.
- If the name capability is added, a real CLI invocation and a real MCP tool invocation must both reach the same Rust HTTP route, carry idempotency and required-authority headers, and show the persisted name. Generated contract checks must show the capability in the intended direct transport.
- `rudder company import` with organization settings is not a pass condition. The current rejection is historical protection for an incomplete capability. It must never silently update a Rust-owned name through `organizationService.update`; full branding remains incomplete until the import path either dispatches the required Rust command with preserved batch semantics or is recorded as an explicit unresolved blocker.

### Recovery and transactional proof

- PostgreSQL readback must show one versioned receipt, one activity row, and one outbox row for a new name mutation; a same-key replay must not duplicate any of them.
- Injected activity/outbox failure must roll back the organization name, component version, receipt, activity, and outbox together.
- Kill/restart the private Rust child around a committed request, then replay the same key and verify the original receipt and name without duplicate side effects; a child exit must clear the per-start key as already implemented.
- Race a stale Node writer against the Rust owner handoff and verify rejection before any business write. Keep the existing `organizationBrandingMutationState` owner/epoch/token evidence.

## Logo Slice Blockers And Later Acceptance

The later logo unit must not be opened as "logoAssetId in the Rust JSON" alone. Its bounded design must name one of these explicit ownership choices before implementation:

- Rust owns the complete asset lifecycle, including provider upload/read/delete and crash recovery; or
- Node remains an explicit storage/asset provisioning authority, with a Rust-owned association command plus a durable compensation/cleanup protocol for upload-success/association-failure and replacement/removal.

Either choice must cover, with real API, UI, CLI, and MCP or explicit unsupported-surface evidence: upload bytes, SVG/content validation, organization-scoped asset validation, association, replacement, remove (`null`), content readback, old object/asset cleanup, foreign-org rejection, duplicate/retry behavior, provider failure, process interruption, restart recovery, portability export/import, organization deletion, and chat approval writers. The `organization_logos` uniqueness and `assets` foreign keys must remain intact.

Until that packet exists, the truthful status is: **scalar `brandColor` Rust proof only; organization name and all logo/storage behavior remain Node-owned; full branding authority is incomplete.**

## Audit Limits

- No source, test, schema, generated contract, storage object, database, process, or runtime was modified.
- No tests or builds were run for this preparation artifact. The evidence above is from targeted source inspection at the bound refs; it is not a verifier PASS or a default-path claim.
