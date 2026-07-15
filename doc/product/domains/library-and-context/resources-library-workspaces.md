---
title: Resources Library And Workspaces
domain: library-and-context
status: active
coverage: detailed
contract_ids:
  - CONTEXT.RESOURCES.001
  - LIBRARY.FILES.001
  - WORKSPACE.PROJECT.001
  - WORKSPACE.RUN.001
  - WORKSPACE.BACKUP.001
related_code:
  - server/src/home-paths.ts
  - packages/db/src/schema/organization_resources.ts
  - packages/db/src/schema/library_entries.ts
  - packages/db/src/schema/project_resource_attachments.ts
  - packages/db/src/schema/project_workspaces.ts
  - packages/db/src/schema/execution_workspaces.ts
  - server/src/services/resource-catalog.ts
  - server/src/services/library-entries.ts
  - server/src/services/organization-workspace-browser.ts
  - server/src/services/execution-workspace-policy.ts
  - server/src/services/execution-workspaces.ts
  - server/src/services/workspace-backups.ts
  - server/src/routes/orgs.ts
  - server/src/services/agent-run-context.ts
  - ui/src/pages/OrganizationResources.tsx
  - ui/src/components/ImagePreviewDialog.tsx
  - ui/src/components/InspectableImage.tsx
  - ui/src/context/ImagePreviewContext.tsx
  - ui/src/components/WorkspaceFilePreview.tsx
  - ui/src/components/WorkspacePdfPreview.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - desktop/src/ide-opener.ts
  - ui/src/pages/OrganizationWorkspaceBackups.tsx
  - ui/src/components/ProjectResourcesPanel.tsx
related_tests:
  - server/src/__tests__/home-paths.test.ts
  - server/src/__tests__/library-path-markdown.test.ts
  - server/src/__tests__/organization-workspace-browser.test.ts
  - server/src/__tests__/execution-workspace-policy.test.ts
  - server/src/__tests__/run-workspace-routes.test.ts
  - server/src/__tests__/agent-run-context.test.ts
  - server/src/__tests__/workspace-backups.test.ts
  - server/src/__tests__/workspace-backups-routes.test.ts
  - ui/src/pages/OrganizationWorkspaceFilesSidebar.test.tsx
  - ui/src/components/ImagePreviewDialog.test.tsx
  - ui/src/context/ImagePreviewContext.test.tsx
  - ui/src/components/WorkspaceFilePreview.test.tsx
  - ui/src/components/WorkspacePdfPreview.test.tsx
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - tests/e2e/organization-workspaces-image-preview.spec.ts
  - tests/e2e/organization-workspaces-launcher.spec.ts
  - tests/e2e/workspace-shell.spec.ts
  - tests/e2e/chat-side-panel.spec.ts
  - tests/e2e/workspace-backups.spec.ts
edit_policy: user_confirmed_only
---

# Resources Library And Workspaces

## CONTEXT.RESOURCES.001

Why:

- Project Context Resources define what background material is intentionally
  eligible for a run. They are a context admission layer, not a generic file
  dump.

Product model:

- Organization resources have kind, source type, locator, title, metadata, and
  organization scope.
- A project attaches resources with role, note, and ordering.
- Library-backed resources use normalized project/library locators so the same
  durable file can be reused without duplicate catalog entries.
- Agent run context injects attached project resources only when the run has
  project context.

Flow:

1. Operator creates or selects a Library/external resource.
2. Project attaches the resource with role and note.
3. Agent run context resolves the project.
4. Instruction context includes a Project Context Resources section with
   bounded resource facts and references.
5. The runtime can inspect the referenced Library file through agent-facing
   APIs/CLI when needed.

Invariants:

- Project resources are curated starting context, not the total knowledge
  boundary.
- Organization resources must not be injected into unrelated runs just because
  they exist.
- A Chat Work manifest Reference is not a Project Context Resource. It becomes
  eligible run context only after an operator explicitly creates/selects the
  resource and attaches it to the Project through this contract's flow.

Evidence:

- ProjectResourcesPanel shows attachment role/order/note.
- Agent run context tests assert resource prompt content.

## LIBRARY.FILES.001

Why:

- Library is where durable artifacts, plans, references, and reusable project
  files live. It must be editable and referenceable without exposing every
  internal agent/system directory as product content.

Product model:

- Library entries map stable ids/references to organization workspace files.
- In the default local-first Desktop/dev layout, organization workspace files
  live under a user-facing folder at `~/Documents/Rudder/<org-folder>`.
  Rudder stores the stable org-id-to-folder mapping in
  `~/Documents/Rudder/.rudder-organizations.json` so display names can remain
  human-readable while organization identity stays stable.
- Folder names are derived from organization name/url key/storage key, sanitized
  for local filesystems, and collision-resolved with numeric suffixes such as
  `org-name-2`.
- Operators and agents can list, read, create, update, delete, rename, and link
  allowed files.
- In Desktop shells, operators can launch the organization workspace in detected
  local IDE, terminal, or folder targets. Individual Library file rows can open
  the file in the system default app or a detected IDE. Messenger document
  previews additionally let operators reveal the current file in the platform
  file browser or open its containing directory in a detected terminal.
- Individual Library file rows expose file targets through an `Open In` action;
  full Library HTML previews and Messenger document previews expose file targets
  through an `Open` menu.
  `Default app` is a file-safe target that delegates to the operating system's
  configured default app for that file type; detected IDEs such as Cursor or VS
  Code remain explicit file targets. In Messenger document previews, folder and
  terminal entries are containing-directory targets: folder targets reveal the
  file, while terminal targets use the file's parent directory as cwd.
- Messenger Library file previews render supported documents inline, including
  PDF files through the validated workspace content endpoint. Their compact path
  breadcrumb exposes the complete Library-relative path on hover, and the
  `Open` menu includes `Open in Library` so the operator can move from adjacent
  inspection to the same file in the full Library work surface.
- Markdown files opened from Messenger render as directly editable documents in
  the Side Panel. Autosave uses the last confirmed server content as a write
  precondition so changes already visible at the server's final guarded read
  produce a conflict instead of being silently overwritten by a stale draft.
- HTML files in the full Library work surface and Messenger Side Panel follow
  `LIBRARY.WEB.PREVIEW.001` for multi-file rendering, the Connected default,
  the unified preview toolbar, isolated runtime boundaries, and static Offline
  fallback behavior.
- Image files shown in either the full Library work surface or a Messenger
  Library preview open through the shared application image overlay. The
  overlay provides explicit close, copy, and download actions, keeps the
  underlying Library route and selected file intact, and adds the Desktop-only
  reveal action when that capability exists.
- Protected roots such as agent instruction, skills, and managed directories
  are excluded from normal mentionable Library surfaces unless an explicit
  management flow owns them.
- Older organization workspace layouts are migrated into the mapped folder when
  Rudder can do so without unsafe overwrite.

Flow:

1. Rudder resolves or creates the organization folder mapping before exposing
   Library files.
2. Actor browses or edits Library through UI, CLI, or API.
3. Server normalizes and validates the path against workspace/protected-path
   rules.
4. Library entry cache/reference id is created or reused.
5. Markdown/reference rendering can turn the Library file into a stable link.
6. Project resources can attach eligible Library files as curated run context.
7. In Desktop shells, Rudder asks the Desktop bridge for available launcher
   targets and sends workspace/file open requests through that bridge rather
   than through the server file API.
8. From a Messenger Library preview, the operator can open the same validated
   file path in the full Library route without changing its organization scope.
9. A Markdown Side Panel edit saves only when its expected prior content still
   matches. A conflict pauses autosave, preserves the local draft, and lets the
   operator either retry the draft against the latest version (`Keep mine`) or
   replace it with the latest server content (`Use latest`). If a save response
   is ambiguous, Rudder rereads the file before deciding whether the save failed.
10. From either Library surface, selecting an image opens the shared image
   overlay without replacing the current Library route or Side Panel target.
11. Opening a supported HTML file delegates website rendering and inspection
    controls to `LIBRARY.WEB.PREVIEW.001` while Open continues to target the
    original validated Library file.

Invariants:

- Library references must stay stable enough for comments, chats, and docs to
  remain readable.
- Mapping identity is by organization id, not display name. Renaming an
  organization must not silently move or orphan its existing Library folder.
- If a mapped organization folder is missing after being established, Rudder
  must stop before creating an empty replacement and tell the operator to
  restore the mapped folder name/path or restore from a workspace backup.
- Protected paths are not ordinary Library content.
- Desktop launchers are operator-local conveniences. They must not bypass
  Library path validation, expose protected paths as ordinary entries, or imply
  that browser/server deployments can open files on the operator machine.
- Messenger file launcher menus distinguish file-open targets from
  containing-directory targets. Default apps and IDEs receive the validated file
  path; folder targets reveal that file and terminal targets receive its parent
  directory as cwd.
- `Open in Library` resolves only the current organization-scoped
  Library-relative file path; it must not expose or navigate to an absolute
  filesystem root.
- HTML preview Open actions must use the original validated Library path and
  must never pass a short-lived preview capability URL to Desktop or Library
  navigation targets.
- Inspectable Library images must not be routed into a Browser target or a new
  window. Loading, broken, and very small images must retain a non-overlapping
  close control alongside every available image action.
- Desktop bridge handlers must require the renderer-provided root to resolve
  inside the configured organization workspace home, then resolve both the root
  and file through filesystem real paths before opening either the file or its
  containing directory. Renderer-provided absolute roots and symlink targets are
  not trusted.
- The per-file `Default app` target must remain a Desktop bridge action, not a
  server-side filesystem open. It is unavailable in non-Desktop shells that
  cannot access the operator's local default application registry.
- Markdown autosave must not silently overwrite content changed after the
  editor's last confirmed read when that change is visible to the conditional
  save check. Dirty drafts remain local until a conditional save succeeds or the
  operator explicitly chooses the latest server version.
- Concurrent in-process writes to the same workspace file are serialized, while
  the expected-content precondition detects completed writes from other
  processes or windows before the guarded comparison. Arbitrary filesystem
  writers are not coordinated with Rudder; a write in the narrow interval
  between Rudder's final comparison and filesystem commit remains outside this
  guarantee.

Evidence:

- Home path tests cover friendly folder allocation, same-name suffixes,
  migration, mapping recovery, corrupt mapping failure, and missing mapped
  folder fail-fast behavior.
- Library path markdown tests cover reference generation.
- Organization workspace browser tests cover path safety and browser behavior.
- Desktop launcher unit and E2E coverage checks detected workspace targets,
  default-app/IDE file targets, containing-directory folder/terminal targets,
  path-escape rejection, and Library sidebar launcher placement.
- Organization workspace sidebar component tests cover the visible `Open In`
  label and `Default app` file target.
- Messenger Side Panel component and E2E coverage prove a Library document can
  use the same Desktop launcher menu and route terminal/folder actions through
  the validated containing-directory bridge.
- Messenger Side Panel component and E2E coverage prove PDF files render inline,
  long breadcrumbs reveal the complete Library path on hover, and `Open in
  Library` opens the selected file in the full Library work surface.
- Messenger Side Panel component and E2E coverage prove Markdown editing,
  autosave failure recovery, stale-write conflict detection, draft preservation,
  both conflict decisions, ambiguous-response confirmation, and in-flight save
  race handling.
- Shared image preview component tests cover Web and Desktop control-safe
  sizing, and Organization Workspaces E2E proves Library image inspection opens
  and exits through the application overlay.
- Website preview unit, server, and E2E coverage is owned by
  `LIBRARY.WEB.PREVIEW.001` and proves the shared toolbar and Open action in both
  the full Library work surface and Messenger Side Panel.

## WORKSPACE.PROJECT.001

Why:

- Project workspace selection determines where an agent works, what repository
  metadata it sees, and which Library/project files are local to the task.

Product model:

- A project can have multiple workspaces: local path, git repo,
  remote-managed, or non-git path.
- One workspace is primary. The first workspace defaults to primary; deleting
  or demoting primary reselects safely.
- Issue/project runs prefer project workspace context before falling back to
  organization workspace or agent home.

Flow:

1. Operator creates or updates project workspace.
2. Server validates path/provider metadata and primary uniqueness.
3. Agent run context resolves workspace for issue/project run.
4. Runtime receives cwd/workspace hints and project resource context.

Invariants:

- Primary workspace selection is deterministic.
- Workspace hints must not claim a cwd that the runtime cannot access.

Evidence:

- Organization Workspaces UI exposes workspace state.
- Agent run context tests cover workspace prompt/context output.

## WORKSPACE.RUN.001

Why:

- Execution workspaces are the boundary between a run and the files/branch it
  may mutate. Without this contract, shared, isolated, operator-branch, and
  agent-default strategies become hidden implementation details.

Product model:

- Run workspaces have mode, strategy, status, cwd, branch/provider metadata,
  project linkage, and archival state.
- Workspace policy resolves project default, issue override, and runtime
  fallback into the concrete run workspace.
- Archiving a run workspace is blocked while open issues still depend on it.
- Archive/cleanup stops runtime services and removes disposable artifacts when
  policy allows.

Flow:

1. Run admission/execution asks workspace policy for a workspace.
2. Policy resolves strategy and realizes the workspace.
3. Run stores workspace context for audit and navigation.
4. RunWorkspace detail and workspace services expose the terminal surface.
5. Archive/cleanup is allowed only after dependency checks pass.

Invariants:

- Run isolation strategy must be explicit and auditable.
- Workspace cleanup must not delete files still needed by open work.

Evidence:

- Execution workspace policy tests cover strategy resolution.
- Run workspace routes tests cover lifecycle and archive constraints.

## WORKSPACE.BACKUP.001

Why:

- Organization workspace backups are the operator's safety rail for local-first
  agent work. They need to be inspectable in Rudder and exportable to local
  disk so a specific version can be retained outside the rolling retention
  window.

Product model:

- Workspace backups are organization-scoped versions with status, trigger
  source, file count, byte size, checksum metadata, expiration, and a local
  artifact reference.
- Automatic backups use two freshness windows: while Rudder is running, the
  scheduler creates a new organization workspace backup only when the latest
  successful version is at least two hours old; on startup, Rudder uses a
  twenty-four-hour offline catch-up window so a stopped app does not create
  noisy catch-up versions on every launch.
- The board operator can create a manual version, browse and preview files from
  a succeeded/restored version, restore that version after Rudder creates a
  pre-restore safety backup, delete non-running versions from visible history,
  and download a selected succeeded/restored version to local disk as a zip
  archive of the backed-up workspace files.
- Rudder may keep an internal JSON backup artifact for browsing and restore,
  but the operator-facing download must be a zip file rather than the internal
  artifact format.
- Download returns the selected backup as an attachment only after the server
  verifies that the artifact exists, belongs to the requested organization, is
  not failed/running/deleted, and matches recorded checksum metadata when
  present.

Flow:

1. Operator opens Workspace backups and selects a concrete version.
2. Rudder keeps file browsing scoped to the selected version instead of the
   live workspace.
3. Operator downloads the selected version from the version details action.
4. Server packages the selected version's backed-up workspace files into a zip
   attachment for that organization/version.
5. Restore and delete remain separate explicit actions with their existing
   safety and retention semantics.

Invariants:

- Backup download must never bypass organization access checks.
- Failed, running, deleted, missing, invalid, or checksum-mismatched backup
  artifacts must not be downloaded.
- Downloading a backup is read-only; it must not mutate backup status,
  retention, workspace files, or activity history.
- Downloaded zip contents must preserve file paths and bytes from the selected
  backup version, including nested files and binary files.

Evidence:

- Workspace backup service tests cover version creation, browsing, restore,
  delete, download metadata, zip contents, and checksum failure.
- Workspace backup route tests cover attachment headers, board-only download,
  and artifact validation errors.
- Workspace backups E2E covers selecting a version, previewing a file,
  downloading the selected zip artifact, restore safety backup creation, and
  delete.
