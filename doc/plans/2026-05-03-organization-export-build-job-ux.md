---
title: Organization Export Build Job UX
date: 2026-05-03
kind: proposal
status: implemented
area: ui
entities:
  - organization_export_jobs
  - organization_portability
issue:
related_plans:
  - 2026-03-13-company-import-export-v2.md
supersedes: []
related_code:
  - ui/src/pages/OrganizationExport.tsx
  - ui/src/api/orgs.ts
  - server/src/routes/orgs.ts
  - server/src/services/knowledge-portability/organization-portability.ts
commit_refs: []
updated_at: 2026-05-03
---

# Organization Export Build Job UX

## Overview

Organization export currently behaves like a normal synchronous button action,
but the operation can be slow because Rudder builds a complete portability
package: organization metadata, agents, skills, projects, tasks, generated
assets, manifest data, and downloadable files. The UI should treat export as a
build job with visible progress, cancellation, retry, and a separate download
ready state.

## What Is The Problem?

The current export page starts expensive package preview work on page entry and
uses a full-page skeleton while waiting. Clicking export starts another
synchronous request and only changes the button label while the user waits.

Impact:

- users cannot tell whether Rudder is stuck or doing real work
- slow exports provide no stage, progress, cancel, or retry affordance
- the interaction hides the difference between selecting export contents,
  building the package, and downloading the finished artifact
- large organizations make this problem worse because tasks and generated files
  increase build time

## What Will Be Changed?

- Add lightweight in-memory export build jobs on the server.
- Add export job endpoints for create, status, cancel, and result retrieval.
- Report coarse export stages while the portability bundle is built.
- Update the Export page so the primary action is `Build export`.
- Show an inline build panel with progress, current stage, cancel, retry, and
  download-ready states.
- Keep final download separate from build completion.

## Success Criteria For Change

- Clicking `Build export` shows visible build state immediately.
- The UI shows meaningful stage progress while the package is being built.
- The user can cancel an in-progress export.
- Failed builds show the error and a retry action.
- Completed builds expose a clear `Download .zip` action.
- Changing file selection invalidates the completed build so stale packages are
  not downloaded.

## Out Of Scope

- Persistent export history.
- Cross-process or cross-restart job recovery.
- A durable `export_jobs` database table.
- Full server-side zip streaming.
- Rewriting the organization portability package format.

## Non-Functional Requirements

- Performance: export page interactions must render immediately even when the
  build itself is slow.
- Maintainability: job handling should stay small and local to organization
  portability rather than introducing a generic queue system.
- Accessibility / usability: progress state must be visible in text as well as
  in a bar.
- Observability: job status should expose stage, message, and file counts.

## User Experience Walkthrough

1. The operator opens Organization Structure > Export.
2. Rudder loads selectable package files and content preview as it does today.
3. The primary button reads `Build export`.
4. The operator chooses files and clicks `Build export`.
5. A build panel appears with a progress bar and current stage, for example
   `Rendering task files`.
6. While building, the operator can click `Cancel`.
7. If the build fails, the panel shows the error and `Retry build`.
8. If the build succeeds, the panel shows `Export ready` and `Download .zip`.
9. If the operator changes file selection after a successful build, the ready
   result is invalidated and the button returns to `Build export`.

## Implementation

### Product Or Technical Architecture Changes

Add a server-local export job manager. Each job owns:

- id
- org id
- status
- progress stage
- progress message
- completed and total units
- warnings and result when complete
- abort controller
- created and updated timestamps

Jobs live in memory with a short TTL. This matches the local-first server model
and avoids creating a persistent workflow before export history exists.

### Breaking Change

No breaking change. Existing synchronous export routes remain available.

### Design

New API shape:

```text
POST   /api/orgs/:orgId/exports/jobs
GET    /api/orgs/:orgId/exports/jobs/:jobId
DELETE /api/orgs/:orgId/exports/jobs/:jobId
GET    /api/orgs/:orgId/exports/jobs/:jobId/result
```

The portability service gains optional progress and abort hooks:

```ts
exportBundle(orgId, input, {
  signal,
  onProgress({ stage, completed, total, message })
})
```

Initial stages are coarse:

- collecting
- resolving_selection
- rendering_skills
- rendering_agents
- rendering_projects
- rendering_tasks
- generating_assets
- finalizing
- ready

The UI polls job status while the job is active. On completion, it fetches the
result and reuses the existing client-side zip download implementation.

### Security

New HTTP endpoints are organization-scoped and must reuse the existing
portability permission check. Board users can export; agent API keys can only
export for their own organization and only if the agent is CEO.

No remote APIs are introduced. Temporary package results are kept in process
memory and removed by TTL cleanup or cancellation.

## What Is Your Testing Plan (QA)?

### Goal

Prove that export build state is visible, cancelable, retryable, and does not
download stale selections.

### Prerequisites

Local development server with at least one organization containing agents and
tasks.

### Test Scenarios / Cases

- successful export job creation and status polling
- successful result retrieval after completion
- cancellation before completion
- failure status when bundle construction throws
- UI build panel states for active, failed, canceled, and complete jobs
- stale result invalidation after selection changes

### Expected Results

The user receives immediate feedback after starting export, sees progress while
waiting, can cancel or retry, and only downloads the artifact matching the
current selection.

### Pass / Fail

Pass:

- `pnpm exec vitest run server/src/__tests__/company-portability-routes.test.ts server/src/__tests__/company-branding-route.test.ts server/src/__tests__/companies-route-path-guard.test.ts server/src/__tests__/export-jobs.test.ts`
- `pnpm -r typecheck`
- `pnpm build`

Blocked by local embedded PostgreSQL initialization:

- `pnpm test:run`
- `RUDDER_E2E_RUN_ID=organization-export-build-job-3 pnpm test:e2e tests/e2e/organization-export-build-job.spec.ts`

Both blocked commands fail before the export workflow can be exercised, with
`Postgres init script exited with code 1` during embedded database bootstrap.

## Documentation Changes

- This proposal records the interaction and architecture decision.
- No operator docs change is required for this small UX iteration unless export
  job behavior becomes persistent.

## Open Issues

- Whether a future iteration should move zip creation server-side.
- Whether export jobs should be persisted once Rudder adds export history or
  ClipHub publishing workflows.
