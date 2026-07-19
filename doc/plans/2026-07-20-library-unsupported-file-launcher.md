---
title: Library unsupported-file launcher
date: 2026-07-20
kind: implementation
status: planned
area: ui
entities:
  - library_workspace
  - desktop_file_launcher
related_plans:
  - 2026-04-30-workspace-root-launcher.md
  - 2026-05-19-library-project-context-workspace-proposal.md
  - 2026-07-15-isolated-library-website-preview.md
supersedes: []
related_code:
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/components/workspaces/WorkspaceLaunchControls.tsx
  - ui/src/lib/workspace-preferences.ts
  - ui/src/lib/desktop-shell.ts
  - desktop/src/ide-opener.ts
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - tests/e2e/organization-workspaces-launcher.spec.ts
commit_refs: []
updated_at: 2026-07-20
---

# Library Unsupported-File Launcher

## Decision

Full Library will replace its terminal cannot-render message with a centered,
compact split launcher only when the selected file is a valid existing file and
no built-in preview or editor can present it. Eligibility is capability-based;
it is not a binary-file, MIME-family, or extension denylist. Existing
preview-only formats remain in their previews, and editable formats remain in
their editors.

In Rudder Desktop, the primary split action starts as `Default app`. A
different compatible target becomes the restored primary action only after that
target opens successfully and while it remains available. The menu can offer
the default app and detected IDEs as file targets, plus compatible folder and
terminal targets for the file's containing directory.

## Routing And Degradation

- Default-app and IDE actions reuse the validated Desktop file-open bridge.
- Folder and terminal actions reuse the validated containing-directory bridge;
  folder targets reveal the selected file and terminal targets open its parent
  directory as cwd.
- Failed launches surface an error and do not replace the last successful
  target.
- Browser/server surfaces keep an honest cannot-render state and do not render
  controls that claim to open local applications or directories.

## Scope

In scope:

- Full Library's resolved-file terminal presentation branch, after all existing
  preview and edit capabilities have been evaluated.
- A reusable centered split-launcher control, target compatibility helpers, and
  success-only local preference for its primary action.
- Default-app and IDE file launch routes plus folder and terminal
  containing-directory routes through the existing validated Desktop bridges.
- Unit, component, E2E, and rendered Desktop/Web evidence for the changed path.
- Synchronizing the authorized `LIBRARY.FILES.001` delta only after the behavior
  and its automated evidence have landed.

Out of scope:

- Changing which file formats the existing preview and editor paths support.
- Adding extension, MIME, or binary deny/allow lists to decide fallback
  eligibility.
- Changing server file APIs, workspace roots, protected-path rules, native file
  associations, or Desktop bridge validation.
- Redesigning Library row menus, Messenger previews, or the workspace-root
  launcher.
- Claiming local application launch support from browser/server deployments.

## Success Criteria

- A valid existing Full Library file with no preview or editor capability shows
  the compact centered split launcher in Desktop; loading, missing, invalid, and
  failed file requests keep their existing states.
- Preview-only and editable files never enter the launcher branch, including
  representative image/PDF, HTML, Markdown/code/CSV, and bounded read-only text
  cases.
- `Default app` is primary before any successful compatible choice. A successful
  IDE, folder, or terminal choice becomes primary and is restored only while it
  remains available; failed launches do not change the preference.
- Default-app and IDE choices receive the validated file path. Folder choices
  reveal the file, and terminal choices receive the validated parent directory
  as cwd.
- Web shows an accurate cannot-render state without inert local-launch controls.
- Automated E2E covers the real Desktop workflow and a representative negative
  branch, and final screenshots show both Desktop fallback and Web degradation.

## Implementation Sequence

1. **Write failing tests.** Add RED unit/component cases for capability gating,
   default selection, compatible-target restoration, success-only persistence,
   target routing, and Web degradation. Extend the Library launcher E2E with a
   valid unsupported fixture and preview/edit non-regression fixtures.
2. **Add preferences and the split component.** Define the fallback target
   union and compatibility resolver in the workspace preference layer. Store a
   target only after its launch promise succeeds. Build the compact primary
   action plus chevron menu in `WorkspaceLaunchControls`, including keyboard,
   loading, disabled, and error behavior.
3. **Integrate Full Library.** Derive fallback eligibility from the same
   presentation capabilities used by `OrganizationWorkspaces`, not new file
   classification. Render it only for a resolved valid file after preview and
   edit branches are exhausted. Dispatch default-app/IDE choices to the trusted
   file bridge and folder/terminal choices to the validated file-location
   bridge. Leave the current message in Web.
4. **Prove E2E and visuals.** Exercise default app, a detected IDE, folder,
   terminal, restored target, failed launch, and Web degradation. Verify a
   preview-only file and an editable file remain on their existing paths. Save
   temporary Desktop and Web screenshots outside the repository.
5. **Synchronize the product contract.** After implementation and tests exist,
   apply the explicitly authorized `LIBRARY.FILES.001` product-model, flow,
   invariant, traceability, and evidence delta using the actual landed code and
   test paths.
6. **Run verification.** Run `pnpm product-logic:check`, targeted preference,
   launcher component, Full Library, and Desktop bridge tests, the relevant E2E
   spec, visual inspection, and the repository lint/typecheck/test/build suite.
   Run `pnpm desktop:verify` if Desktop bridge, preload, main-process, startup,
   or packaging code changes.

## Risks And Mitigations

- **A fallback classification displaces a valid renderer.** Use explicit
  presentation-capability predicates shared with the render branches and lock
  preview-only, editable, and bounded read-only cases with regression tests.
- **A stale preference selects an unavailable or incompatible action.** Resolve
  the stored id against the current target set on every file and fall back to
  `Default app` without rewriting the preference until a launch succeeds.
- **A target receives the wrong filesystem scope.** Keep file and
  containing-directory targets as distinct types and dispatch only through the
  existing validated Desktop bridge methods; add route-argument assertions.
- **Loading or missing files look launchable.** Require a successful resolved
  file detail and existing workspace root before computing launcher eligibility.
- **Web implies a capability it cannot execute.** Gate the control on the
  required Desktop bridge functions and retain explicit Web fallback coverage.
- **The split control adds density or keyboard regressions.** Keep one compact
  centered action group, use named buttons/menu semantics, and verify focus,
  disabled, loading, narrow, and wide layouts visually and in component tests.
