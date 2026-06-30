---
title: Organization library folder names and backup zip downloads
status: in_progress
kind: implementation
area: library-and-context
entities:
  - organization
  - workspace_backup
  - library
---

# Organization Library Folder Names And Backup Zip Downloads

## Context

Organization workspaces currently default to
`~/Documents/Rudder/instances/<instance>/organizations/<org-storage-key>/workspaces`
when `RUDDER_HOME` is not explicitly set. That path is stable but opaque to a
local user who expects the Library files to live directly under a recognizable
organization folder.

Workspace backup download currently streams the internal JSON artifact. That is
useful for Rudder restore/browse internals, but it is not the expected local
download format for an operator who wants a portable copy of the Library folder.

Affected product contract IDs:

- `LIBRARY.FILES.001`
- `WORKSPACE.BACKUP.001`

`doc/product/**` is guarded. This plan records the implementation direction; the
Product Logic Registry should be updated only after explicit approval.

## Requirements

- Default org Library/workspace folder should be
  `~/Documents/Rudder/<org-folder>` for local Desktop/default-home use.
- Folder names should be human-readable and derived from the organization name.
- If two organizations collide, allocate suffixes such as `org-name-2`.
- Keep a local mapping file under `~/Documents/Rudder/` that maps organization
  ids to folder names.
- Preserve explicit `RUDDER_HOME` compatibility behavior.
- Migrate existing default Documents workspace roots and legacy instance-root
  workspace roots.
- Backup scheduler behavior:
  - while the app/server is running, scheduled backups are due every 2 hours;
  - when the app/server was not running, startup should only catch up if the
    latest backup is at least 24 hours old.
- Backup download should return a `.zip` containing the backed-up workspace
  folder contents, not the internal JSON artifact.

## Design

### Folder mapping

Use `~/Documents/Rudder/.rudder-organizations.json` as the mapping file for the
default workspace home. The file stores a versioned list of records:

```json
{
  "version": 1,
  "organizations": [
    {
      "instanceId": "default",
      "orgId": "...",
      "folderName": "acme",
      "orgName": "Acme",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

The mapping is local filesystem state, not a product database contract. It lets
Rudder preserve folder identity across organization renames while avoiding a DB
migration for local path preferences.

Folder allocation:

1. slugify org name, falling back to url key, then short org storage key;
2. reserve hidden/internal names and path-unsafe segments;
3. if the chosen name is already mapped to another org or exists as a real
   directory not owned by this org, allocate `-2`, `-3`, etc.

### Migration

For the default home only:

- canonical target: `~/Documents/Rudder/<folderName>`
- previous Documents root:
  `~/Documents/Rudder/instances/<instance>/organizations/<org-storage-key>/workspaces`
- legacy instance root:
  `~/.rudder/instances/<instance>/organizations/<org-storage-key>/workspaces`
- legacy full UUID root remains covered by existing storage-root migration.

When the mapped folder is missing but old roots exist, migrate/merge from old
roots. If the mapped folder is missing and no old root exists, fail fast with the
expected folder and mapping file paths instead of recreating an empty workspace.
The later user-facing missing-folder recovery prompt should be a Desktop startup
follow-up; this slice prevents silent data orphaning and leaves the existing
startup failure surface to show the recovery instructions.

### Backup cadence

Keep the scheduler tick hourly. At server startup, run scheduled backups with a
24-hour due interval so a closed app does not create many catch-up snapshots.
Subsequent runtime ticks use a 2-hour due interval.

### Zip download

Keep backup artifacts as JSON for browse/restore because the service already
uses JSON entries for path-safe preview and restore. Change download to build a
zip on demand from the selected artifact entries:

- filename: `<workspace-folder>-<backup-timestamp>.zip`
- content type: `application/zip`
- checksum header remains `X-Rudder-Archive-Sha256`, now for the generated zip
- internal paths are relative under the workspace folder name.

## Verification

- Unit coverage for folder mapping allocation, collision suffixes, migration
  from previous Documents root, and explicit `RUDDER_HOME` compatibility.
- Service tests for zip download contents and scheduled 2h/24h due policy.
- Route tests for zip attachment headers.
- Product logic check before handoff.
