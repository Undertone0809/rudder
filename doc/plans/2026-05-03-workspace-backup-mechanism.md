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

The recommended V1 is a local-first, org-scoped workspace snapshot service with
manual and scheduled backup, backup history, restore preview, and guarded full
restore. It should reuse the instance backup directory by default and stay
compatible with future S3 or full-instance disaster recovery work.

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
   workspace root into a compressed archive plus manifest.
2. A `workspace_backups` table for backup history, artifact metadata, manifest
   summary, status, trigger source, retention expiry, and restore audit links.
3. Board-only REST APIs under the organization workspace route:
   - `GET /api/orgs/:orgId/workspace/backups`
   - `POST /api/orgs/:orgId/workspace/backups`
   - `GET /api/orgs/:orgId/workspace/backups/:backupId/preview`
   - `POST /api/orgs/:orgId/workspace/backups/:backupId/restore`
4. A CLI surface for operational use:
   - `rudder workspace:backup --org <org-id-or-prefix>`
   - `rudder workspace:restore --org <org-id-or-prefix> --backup <id-or-file>`
5. A Workspaces page backup panel with:
   - last successful backup
   - manual "Back up now"
   - backup history
   - restore preview and confirmation
6. Instance config for scheduled workspace backups:
   - enabled
   - interval minutes
   - retention days
   - target directory
   - maximum archive size or warning threshold
7. Activity log events:
   - `organization.workspace_backup.created`
   - `organization.workspace_backup.failed`
   - `organization.workspace_backup.restored`

## Success Criteria For Change

- A board operator can create a backup for an organization's workspace from the
  UI and CLI.
- Scheduled backups run without blocking normal Rudder startup or heartbeat
  scheduling.
- Restoring a backup requires no active runs for that organization unless a
  force flag is explicitly used by CLI.
- Restore preview shows files that will be added, modified, deleted, or skipped.
- Restore creates a pre-restore backup automatically before replacing files.
- Backup artifacts include a manifest with org id, instance id, Rudder version,
  tree hash, file inventory, byte size, archive checksum, agent workspace key
  map, active run count, and warnings.
- Backup and restore events are visible in activity logs.
- Path traversal, symlink escape, and archive extraction attacks are blocked by
  tests.

## Out Of Scope

- Full instance disaster recovery that bundles database, storage assets, logs,
  secrets, and workspaces into one package.
- Cross-organization restore or importing a workspace backup into a different
  organization.
- Selective file-level restore in the first release.
- Git-style diff visualization for large binary files.
- Backup encryption key management beyond local file permissions and existing
  instance trust boundaries.
- Cloud object-storage backup as the only supported V1 path.

## Non-Functional Requirements

- Performance: stream archive creation and extraction; do not load full
  workspace trees into memory.
- Scalability: skip unchanged scheduled backups by comparing a tree hash or
  incremental file inventory signature.
- Availability: scheduled backup failure must not stop the server or agent
  scheduler.
- Security: do not follow symlinks outside the workspace root; do not extract
  archive paths outside a staging directory; write local backup artifacts with
  owner-only permissions where the platform supports it.
- Maintainability: keep the backup artifact manifest schema versioned.
- Observability: persist backup status, duration, size, file counts, warnings,
  and error messages.

## User Experience Walkthrough

1. The operator opens an organization's Workspaces page.
2. A compact backup panel shows the last successful backup and whether
   automatic backups are enabled.
3. The operator clicks "Back up now".
4. Rudder creates a snapshot in the background and shows status as running,
   succeeded, or failed.
5. When a backup is selected, Rudder can compute a restore preview against the
   live workspace.
6. Restore is disabled if that organization has active queued or running agent
   work.
7. When confirmed, Rudder creates a pre-restore backup, extracts the chosen
   archive into a staging directory, atomically swaps workspace contents where
   possible, reconciles workspace-backed skills, and logs activity.

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

Artifact layout for local default:

```text
~/.rudder/instances/<instance>/data/backups/workspaces/<org-id>/
  workspace-<org-id>-<YYYYMMDD-HHMMSS>.tar.zst
  workspace-<org-id>-<YYYYMMDD-HHMMSS>.manifest.json
```

If `zstd` is not available through a stable Node dependency, use `.tar.gz` in
V1 and leave compression pluggable.

### Breaking Change

No breaking product, API, runtime, or storage change is required. Existing
workspace paths remain canonical, existing database backup continues unchanged,
and organization import/export remains portability-focused.

### Design

Backup flow:

1. Resolve and ensure the org workspace root with existing home-path helpers.
2. Check active org runs and workspace operations. Manual backup may proceed
   with a warning; scheduled backup should record active run count in the
   manifest.
3. Walk the workspace tree with strict root containment.
4. Exclude known machine caches by default, such as `.DS_Store`, `.cache`,
   `node_modules`, and archive staging directories. Record exclusions in the
   manifest.
5. For each entry, record relative path, type, mode, size, mtime, sha256 for
   files below a practical threshold, and symlink metadata without following
   external targets.
6. Write archive and manifest to a temp path, fsync where practical, then rename
   into the final backup directory.
7. Insert or update the `workspace_backups` row and log activity.
8. Prune expired local artifacts for this org.

Restore flow:

1. Require board actor.
2. Block restore while the org has queued or running work unless CLI force is
   supplied.
3. Validate archive checksum and manifest schema.
4. Extract into an instance-local staging directory outside the live workspace.
5. Validate extracted paths before copying or swapping.
6. Create a pre-restore backup automatically.
7. Replace the live workspace tree with the staged tree.
8. Re-run workspace-backed skill reconciliation for org and agent skill roots.
9. Ensure canonical layout directories still exist.
10. Invalidate workspace browser state through normal query invalidation in UI.
11. Log restore activity with backup id, pre-restore backup id, file count, and
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
- CLI restore from an external archive must validate manifest org id unless the
  operator uses an explicit override.
- Do not follow symlinks outside the workspace root.
- Do not extract absolute paths or `..` segments.
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
- Service test: scheduled backup skips writing a duplicate archive when tree
  hash is unchanged.
- Restore preview test: reports add, modify, delete, and skip outcomes.
- Restore test: creates a pre-restore backup and restores files to the previous
  state.
- Restore guard test: active org run blocks restore.
- Security test: archive with absolute path, `..`, or symlink escape is
  rejected.
- API test: board can manage backups; agent and cross-org requests cannot.
- UI E2E: Workspaces page can trigger backup and show last successful backup.
- CLI test: `workspace:backup` creates a backup and prints JSON metadata with
  `--json`.

### Expected Results

- Backup artifacts are written under the instance backup directory.
- Database backup behavior is unchanged.
- Workspaces browser shows restored files after query invalidation.
- Activity log contains backup and restore events.

### Pass / Fail

Not run. This proposal defines the design and expected verification coverage;
implementation has not started.

## Documentation Changes

Update these docs when the feature lands:

- `doc/DEVELOPING.md`
- `doc/developing/LOCAL-OPERATIONS.md`
- `doc/DESKTOP.md`
- `doc/DATABASE.md` only to clarify that database backup is separate from
  workspace backup
- `doc/SPEC-implementation.md`
- `doc/CLI.md`

## Open Issues

- Decide whether automatic workspace backups should be enabled by default. The
  recommended default is enabled for local trusted deployments, every 24 hours,
  with duplicate-snapshot skipping and 30-day retention.
- Decide whether V1 should support operator-chosen exclusions in config or use
  only hardcoded safe defaults.
- Decide whether cloud deployments should store workspace backup archives
  through the storage provider in V1 or wait for a full backup provider
  abstraction.
- Decide whether restore should support a "restore into new organization" mode.
  The recommendation is no for V1 because workspace file paths depend on
  existing org and agent workspace keys.
