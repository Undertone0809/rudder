---
title: Workspace backup mechanism
date: 2026-05-03
kind: proposal
status: proposed
area: workspace
entities:
  - org_workspace
  - workspace_backup
  - agent_workspace
issue:
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
  - 2026-04-20-remove-legacy-project-managed-workspace-paths.md
  - 2026-03-13-company-import-export-v2.md
  - 2026-02-20-storage-system-implementation.md
supersedes: []
related_code:
  - server/src/home-paths.ts
  - server/src/services/organization-workspace-browser.ts
  - packages/db/src/backup-lib.ts
  - cli/src/commands/db-backup.ts
  - server/src/index.ts
  - packages/shared/src/config-schema.ts
commit_refs: []
updated_at: 2026-05-03
---

# Workspace Backup Mechanism

## Overview

Rudder should add a first-class backup mechanism for organization workspaces:
the filesystem tree rooted at
`~/.rudder/instances/<instance>/organizations/<org-id>/workspaces`.

This is not a replacement for existing database backup. The current database
backup protects Postgres state under the active instance, while organization
workspaces hold file-backed work product, agent memory, agent-authored skills,
shared organization skills, plans, and other durable coordination files. Losing
that tree can erase useful agent work even when the database is recoverable.

The recommended first slice is a local-first, org-scoped workspace snapshot
service with manual backup, backup history, version browsing, and guarded full
restore. It should reuse the instance backup directory by default and stay
compatible with future scheduled backups, S3, CLI restore, and full-instance
disaster recovery work.

## What Is The Problem?

Current state:

- Database backups already exist and are scheduled by the server when enabled.
- Organization workspaces are fixed, system-owned filesystem roots under the
  Rudder instance.
- Agent personal workspaces live below `workspaces/agents/<workspace-key>`.
- Shared organization skills and plans live below `workspaces/skills` and
  `workspaces/plans`.
- The workspace browser can list, read, and edit files safely inside the org
  root, but it has no versioned safety net.
- Organization import/export is portability-oriented and explicitly not full
  backup or runtime-state restore.

Problem:

- A user or agent can damage or delete workspace files with no local recovery
  path.
- Existing database backup gives a false sense of safety because it does not
  capture the workspace filesystem tree.
- Import/export is the wrong abstraction because it is a human-readable package
  format, not an operational snapshot of all workspace bytes.

Impact:

- Agent loops can lose reusable plans, memory, private skills, shared skills,
  generated files, and other workspace-backed output.
- Restore is currently ad hoc: operators must manually copy filesystem folders,
  know the correct instance and org paths, and avoid corrupting active runs.

## What Will Be Changed?

Add a V1 workspace backup system with these surfaces:

1. A server-side `workspaceBackupService` that can snapshot one organization
   workspace root into a versioned local artifact plus manifest metadata.
2. A `workspace_backups` table for backup history, artifact metadata, manifest
   summary, status, trigger source, retention expiry, and restore audit links.
3. Board-only REST APIs under the organization workspace route:
   - `GET /api/orgs/:orgId/workspace/backups`
   - `POST /api/orgs/:orgId/workspace/backups`
   - `GET /api/orgs/:orgId/workspace/backups/:backupId/files`
   - `GET /api/orgs/:orgId/workspace/backups/:backupId/file`
   - `POST /api/orgs/:orgId/workspace/backups/:backupId/restore`
   - `DELETE /api/orgs/:orgId/workspace/backups/:backupId`
4. A single backup entry point in the organization Settings workspace card.
   Clicking it opens a dedicated workspace-backup browser instead of adding
   backup controls to the live Workspaces page.
5. Activity log events:
   - `organization.workspace_backup.created`
   - `organization.workspace_backup.failed`
   - `organization.workspace_backup.restored`
   - `organization.workspace_backup.deleted`

## Success Criteria For Change

- A board operator can create a backup for an organization's workspace from the
  Settings workspace card and dedicated backup browser.
- The backup browser uses the agreed three-column shape: files on the left,
  content in the center, versions and actions on the right.
- Restoring a backup requires no queued or running heartbeat runs for that
  organization.
- Restore creates a pre-restore backup automatically before replacing files.
- Backup artifacts include org id, instance id, tree hash, file inventory,
  byte size, artifact checksum, active run count, and warnings.
- Backup, restore, and delete events are visible in activity logs.
- Path traversal and symlink escape are blocked by tests.

## Out Of Scope

- Full instance disaster recovery that bundles database, storage assets, logs,
  secrets, and workspaces into one package.
- Cross-organization restore or importing a workspace backup into a different
  organization.
- Selective file-level restore in the first release.
- Git-style diff visualization for large binary files.
- CLI backup/restore.
- Backup encryption key management beyond local file permissions and existing
  instance trust boundaries.
- Cloud object-storage backup as the only supported V1 path.

## Non-Functional Requirements

- Performance: avoid shelling out to platform archive tools in the first slice;
  future large-workspace support should replace the JSON artifact with a
  streaming archive format.
- Scalability: record a tree hash and file inventory so scheduled/incremental
  backup can skip unchanged trees later.
- Security: do not follow symlinks outside the workspace root; do not restore
  paths outside a staging directory; write local backup artifacts with
  owner-only permissions where the platform supports it.
- Maintainability: keep the backup artifact manifest schema versioned.
- Observability: persist backup status, duration, size, file counts, warnings,
  and error messages.

## User Experience Walkthrough

1. The operator opens organization Settings and finds the existing Workspace
   card.
2. The card continues to show the read-only workspace root and the live
   workspace opener. It adds one backup entry point, `Backups`.
3. Clicking `Backups` leaves Settings and opens a dedicated workspace page at
   `/:orgPrefix/workspaces/backups`.
4. The backup browser uses the normal workspace shell: primary rail on the far
   left, then a dedicated three-column backup surface:
   - left: file tree for the selected backup
   - center: selected file content or binary metadata
   - right: backup versions, backup metadata, and version-level actions
5. The operator selects a backup version in the right column, then browses that
   version's files from the left column.
6. The center column updates as files are selected, similar to an IDE preview.
7. Version-level actions live in the right column:
   - `Back up now`
   - `Restore`
   - `Delete`
8. Restore is disabled if that organization has active queued or running agent
   work.
9. When confirmed, Rudder creates a pre-restore backup, writes the chosen
   version into a staging directory, swaps workspace contents where possible,
   ensures canonical workspace folders exist, and logs activity.

## Implementation

### Product Or Technical Architecture Changes

Add these backend modules:

- `server/src/services/workspace-backups.ts`
- `server/src/routes/workspace-backups.ts` or route handlers inside existing
  organization routes
- `packages/shared/src/types/workspace-backup.ts`
- `packages/shared/src/validators/workspace-backup.ts`
- `packages/db/src/schema/workspace_backups.ts`

Suggested table:

```text
workspace_backups
- id uuid pk
- org_id uuid not null
- status text not null
- trigger_source text not null
- artifact_provider text not null
- artifact_ref text not null
- archive_sha256 text
- tree_sha256 text
- file_count int
- byte_size bigint
- compressed_size bigint
- manifest jsonb
- warnings jsonb
- error text
- started_at timestamptz
- finished_at timestamptz
- expires_at timestamptz
- restored_from_backup_id uuid null
- created_by_user_id uuid null
- created_at timestamptz
- updated_at timestamptz
```

Artifact layout for the local first slice:

```text
~/.rudder/instances/<instance>/data/backups/workspaces/<org-id>/
  workspace-<org-id>-<YYYYMMDD-HHMMSS>-<backup-id-prefix>.json
```

The JSON artifact stores a schema version, manifest fields, directory entries,
and base64 file contents. This keeps the first implementation dependency-free;
large-workspace and scheduled-backup work should replace it with a streaming
archive format.

### Breaking Change

No breaking product, API, runtime, or storage change is required. Existing
workspace paths remain canonical, existing database backup continues unchanged,
and organization import/export remains portability-focused.

### Design

Backup flow:

1. Resolve and ensure the org workspace root with existing home-path helpers.
2. Count active org runs and record that count in the manifest. Manual backup
   may proceed while work is active because it does not mutate the workspace.
3. Walk the workspace tree with strict root containment.
4. Exclude known machine caches by default, such as `.DS_Store`, `.cache`,
   `node_modules`, and archive staging directories. Record exclusions in the
   manifest.
5. For each entry, record relative path, type, mode, size, mtime, sha256, and
   base64 file contents. Skip symlinks rather than following external targets.
6. Write the artifact to a temp path, then rename into the final backup
   directory.
7. Set `expires_at` to the default 30-day retention deadline.
8. Insert or update the `workspace_backups` row and log activity.

Scheduled policy:

- Active organizations get one scheduled workspace snapshot every 24 hours by
  default.
- The scheduler prunes expired workspace backup artifacts after 30 days.
- Manual and pre-restore backups use the same default retention window.
- Database backup remains a separate subsystem and is not included in workspace
  backup artifacts.

Restore flow:

1. Require board actor.
2. Block restore while the org has queued or running work.
3. Validate artifact checksum and manifest schema.
4. Materialize into an instance-local staging directory outside the live
   workspace.
5. Validate staged paths before swapping.
6. Create a pre-restore backup automatically.
7. Replace the live workspace tree with the staged tree.
8. Ensure canonical layout directories still exist.
9. Invalidate workspace browser state through normal query invalidation in UI.
10. Log restore activity with backup id, pre-restore backup id, file count, and
    warning count.

Consistency policy:

- Backups are crash-safe operational snapshots, not transactional filesystem
  checkpoints.
- The manifest records active run count and open warnings.
- Restore is stricter than backup and blocks active org work by default.
- Future work can add "pause organization and back up" as a guided action.

### Security

New HTTP endpoints are board-only and organization-scoped.

Important security rules:

- Never accept an arbitrary filesystem path from the browser for backup
  creation.
- Do not follow symlinks outside the workspace root.
- Do not restore absolute paths or `..` segments.
- Treat workspace backups as sensitive because they may contain agent memory,
  prompts, code, notes, and generated files.

## What Is Your Testing Plan (QA)?

### Goal

Prove that workspace backup and restore preserve organization workspace content
without violating org boundaries, path safety, or active-run guardrails.

### Prerequisites

- Embedded Postgres local instance.
- One organization with shared workspace files.
- One agent with a stable `workspaceKey` and files under its personal workspace.
- Workspace-backed org and agent skill files.

### Test Scenarios / Cases

- Service test: creates a backup of a workspace containing text files, binary
  files, nested directories, and agent workspace directories.
- Restore test: creates a pre-restore backup and restores files to the previous
  state.
- Restore guard test: active org run blocks restore.
- Security test: artifact with absolute path, `..`, or symlink escape is
  rejected.
- API test: board can manage backups; agent and cross-org requests cannot.
- UI E2E: organization Settings exposes one workspace backup entry point, and
  the dedicated backup browser can select a version, select a file, preview
  content, restore, and delete.

### Expected Results

- Backup artifacts are written under the instance backup directory.
- Database backup behavior is unchanged.
- Workspaces browser shows restored files after query invalidation.
- Activity log contains backup and restore events.

### Pass / Fail

Implemented first slice. Typecheck and build should pass before handoff; local
test execution is tracked in the task handoff because embedded Postgres can be
environment-dependent.

## Documentation Changes

Update these docs when the feature lands:

- `doc/DEVELOPING.md`
- `doc/developing/LOCAL-OPERATIONS.md`
- `doc/DESKTOP.md`
- `doc/DATABASE.md` only to clarify that database backup is separate from
  workspace backup
- `doc/SPEC-implementation.md`
- `doc/CLI.md` only when CLI backup/restore is implemented

## Open Issues

- Decide whether V1 should support operator-chosen exclusions in config or use
  only hardcoded safe defaults.
- Decide whether scheduled backups should skip duplicate tree hashes before
  writing a new artifact.
- Decide whether cloud deployments should store workspace backup archives
  through the storage provider in V1 or wait for a full backup provider
  abstraction.
- Decide whether restore should support a "restore into new organization" mode.
  The recommendation is no for V1 because workspace file paths depend on
  existing org and agent workspace keys.
