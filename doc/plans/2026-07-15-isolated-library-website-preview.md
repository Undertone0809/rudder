---
title: Isolated Library website preview runtime
date: 2026-07-15
kind: proposal
status: completed
area: workspace
entities:
  - library_workspace
  - website_preview
  - preview_capability
issue:
related_plans:
  - 2026-05-19-library-project-context-workspace-proposal.md
  - 2026-06-30-org-library-folder-and-backup-zip.md
supersedes: []
related_code:
  - ui/src/lib/workspace-html-preview.ts
  - ui/src/components/WorkspaceHtmlPreview.tsx
  - ui/src/components/WorkspaceFilePreview.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - server/src/services/workspace-web-preview.ts
  - server/src/routes/orgs.ts
  - server/src/bootstrap/create-http-app.ts
  - server/src/__tests__/workspace-web-preview.test.ts
  - tests/e2e/organization-workspaces-image-preview.spec.ts
  - tests/e2e/chat-side-panel-html-preview.spec.ts
commit_refs: []
updated_at: 2026-07-15
---

# Isolated Library Website Preview Runtime

## Overview

Rudder should preview an HTML website artifact as a directory-scoped runnable
output instead of rendering only the text of one HTML file. Opening an HTML file
in Library or the Messenger Side Panel should preserve browser-native relative
paths for sibling CSS, JavaScript, images, fonts, and nested assets while keeping
agent-authored code isolated from the Rudder control plane.

The first delivery slice is a static website preview runtime on a distinct
Preview Host. It supports local website assets, starts in a disclosed Connected
mode for HTTPS dependencies, and offers a strict Offline mode. The Preview Host exposes only capability-scoped GET and
HEAD asset reads; Rudder APIs do not exist on that host. The frame does not
receive form submission, popups, downloads, top-level navigation, or connection
APIs such as `fetch()`, XHR, WebSocket, EventSource, or beacon.

Affected current product contract:

- `LIBRARY.FILES.001`

Proposed Product Logic delta:

- Add `LIBRARY.WEB_PREVIEW.001` as a `logic_contract` owned by
  `library-and-context`.
- Define the artifact root, Offline/Connected modes, capability lifetime,
  isolation boundary, supported resource types, visible failure states, and
  Library/Messenger parity.
- Keep `LIBRARY.FILES.001` as the file lifecycle and generic inline-document
  contract, and have it reference the new website-preview contract.

`doc/product/**` is guarded. This proposal records the concrete delta, but the
registry change remains deferred until the user explicitly authorizes editing
the Product Logic Registry.

## What Is The Problem?

The current HTML Preview uses `iframe.srcDoc` with a restrictive CSP and an
empty sandbox permission list. That is safe for standalone HTML reports with
inline styles, but it is not a website runtime:

- `styles.css` and other relative stylesheets cannot load.
- `script.js` cannot load or execute.
- relative images and nested asset paths have no artifact-directory URL base.
- external images, fonts, styles, and scripts are intentionally blocked.
- complete HTML documents are wrapped inside another generated HTML document.
- Library and Messenger show the same broken, unstyled fallback without
  explaining which dependencies were blocked.

The observed artifact contains `index.html`, `styles.css`, and `script.js` in
one directory and also references Google Fonts, Unpkg, and Unsplash. Both the
wide Library view and the narrow Messenger view therefore render raw document
structure instead of the produced website.

This violates Rudder's output-first goal: the files exist, but the operator
cannot inspect the actual result inside the work surface.

## What Will Be Changed?

- Treat the selected HTML file's parent directory as its website artifact root.
- Add a board-only API that creates a short-lived, read-only preview capability
  for one organization, artifact root, entry file, and network mode.
- Add a capability-authenticated asset route that serves files under that root
  without requiring board cookies.
- Route preview traffic through a distinct origin/Host. Local loopback instances
  default to `http://preview.localhost:<server-port>`; non-loopback deployments
  must configure an explicit Preview origin.
- On the Preview Host expose only the capability GET/HEAD route and return 404
  for `/api` and every other path. On the main application Host return 404 for
  the capability asset route.
- Load the website through iframe `src` rather than `srcDoc`.
- Run Offline with an empty sandbox permission list. Run Connected with
  `sandbox="allow-scripts"`. Neither mode receives `allow-same-origin`, so each
  document has a unique opaque origin.
- Serve strict response headers, correct MIME types, `nosniff`, no referrer,
  no-store caching, and a CSP derived from the selected network mode.
- Add `Offline` and `Connected` controls shared by Library and Messenger.
- Keep Preview/Source behavior and render unsaved HTML source through an
  in-memory entry-file override inside the preview capability.
- Show explicit loading, expired-session, missing-resource, and preview-start
  failure states. When the platform cannot provide stable Preview Host file
  validation, preserve a clearly disclosed static Offline `srcDoc` fallback.
- Preserve a direct Open action as an escape hatch for the system browser.

## Success Criteria For Change

- The reported `index.html` renders with its sibling `styles.css` and
  `script.js` in both Library and Messenger.
- Nested relative assets and CSS `url(...)` references remain inside the
  capability's artifact root and load with correct MIME types.
- Offline renders local HTML/CSS/images/fonts/media without executing scripts;
  it removes meta refresh and external link/navigation targets before serving
  HTML so the document cannot navigate itself out of the Preview Host.
- In Connected mode, inline, classic external, local classic, and local module
  scripts execute in the sandbox; preview code cannot read the Rudder parent DOM
  or cookies, and the Preview Host has no Rudder API routes.
- Offline mode makes no external network requests, including navigation-driven
  requests from meta refresh or external links.
- Connected mode loads HTTPS images, fonts, styles, scripts, and media by
  default while keeping its external-disclosure label visible; selecting
  Offline creates a new strict capability and blocks those requests.
- Attempts to read `..`, absolute paths, protected directories, dotfiles,
  non-regular files, or symlink targets outside the artifact root fail without
  revealing filesystem paths.
- Canonical symlink aliases cannot make protected roots or hidden files appear
  as ordinary artifact paths.
- Preview requests remain organization-scoped and a capability cannot be used
  for another organization or artifact directory.
- Expired or unknown capabilities return a bounded error document/status.
- Existing Markdown, CSV, image, PDF, source editing, and file-open flows do not
  regress.
- Automated E2E covers the real multi-file workflow plus isolation and expiry
  edge cases, and browser screenshots prove wide and narrow rendering.

## Out Of Scope

- Starting Vite, Next.js, Astro, or other development servers.
- Installing dependencies or building source projects on preview.
- Server-side rendering, application routing fallbacks, or SPA history rewrites.
- `fetch()`, XHR, WebSocket, EventSource, beacon, or other connection APIs from
  preview code in the first slice.
- Form submission, mail-client launch, popups, downloads, clipboard access,
  camera, microphone, geolocation, or top-level navigation.
- Persisting preview sessions across a Rudder restart.
- Treating an arbitrary parent Library directory as a deployable website when
  the selected entry is not an HTML file.
- Creating a preview session for HTML directly under the organization Library
  root. A website artifact must have a non-root parent directory so the
  capability never represents the whole organization root.
- Automatically enabling external network access based on artifact contents.

## Non-Functional Requirements

### Security

- Capabilities use at least 192 bits of randomness, expire after 30 minutes,
  are held only in process memory, and are pruned with a hard session-count cap.
- Session creation requires board access to the selected organization.
- Capability tokens are bearer secrets and must be redacted from success,
  access, error, and structured request logs. The Preview Host route bypasses
  ordinary URL logging or uses a tested token-redacting serializer.
- Asset delivery authenticates only through the unguessable capability and
  never relies on board cookies inside the sandbox.
- Session creation resolves and stores canonical organization and artifact
  roots through the organization workspace resolver. Every asset read
  re-resolves the current organization root, artifact root, and target through
  filesystem real paths so replacing the artifact directory with a symlink
  cannot escape either boundary.
- Preview serving rejects protected Library roots, dotfiles, non-regular files,
  device files, sockets, and directory listings.
- Preview routes never expose absolute filesystem paths in responses or logs.
- The sandbox omits same-origin, forms, popups, downloads, modals, pointer lock,
  storage access, and top-navigation permissions.
- Offline omits script permission and strips meta refresh plus external
  navigation targets from served HTML. Connected permits scripts and may let
  the frame navigate itself, but cannot navigate or access the Rudder parent.
- Offline CSP names the explicit Preview origin for capability-served resources
  plus data/blob where required. It does not rely on CSP `'self'`, because the
  sandboxed document has an opaque origin. Connected CSP adds HTTPS resource
  schemes but keeps `connect-src`, `form-action`, `frame-src`, and `object-src`
  disabled.
- Preview content must not receive Rudder API CORS headers.
- Capability assets needed by modules and fonts return
  `Access-Control-Allow-Origin: *` without credentials. The Preview Host never
  accepts credentialed cross-origin requests or mutating methods.

### Performance And Availability

- Asset serving streams or sends bounded files without reading an entire
  artifact directory into memory.
- The in-memory override is limited to the HTML file already accepted by the
  existing workspace file API payload limit.
- Sessions are created on entering Preview or changing network mode, not on
  every render.
- A server restart invalidates sessions cleanly; the UI can create a new one on
  reload.

### Maintainability

- One reusable HTML preview component owns session creation, network mode,
  reload, loading, and error behavior for Library and Messenger.
- One preview runtime service owns capability state and file-boundary checks.
- MIME and CSP policy are unit-tested pure helpers rather than inline route
  strings.

### Accessibility And Usability

- Offline/Connected is a labeled segmented mode control with clear selected
  state and tooltips.
- Loading and errors use status/alert semantics without resizing the stable
  preview surface.
- The narrow Messenger frame remains usable and offers the existing expanded
  Library/open paths.

## User Experience Walkthrough

1. The operator selects `artifacts/.../business-website-discovery/index.html`.
2. Rudder recognizes it as HTML and enters Preview mode.
3. The UI requests a Connected preview capability scoped to the selected file's
   parent directory and current unsaved HTML content, if any.
4. The iframe loads the capability entry URL. Relative `styles.css`,
   `script.js`, images, fonts, and nested paths resolve through the same
   capability route.
5. Connected starts visibly selected. HTTPS resources may load and artifact
   code can disclose preview-owned DOM/content through permitted HTTPS image,
   script, style, font, or media requests; the control label and tooltip keep
   this behavior visible.
6. The operator can select `Offline`. Rudder creates a new capability with the
   strict CSP and reloads the frame. Scripts stop executing, external resources
   are blocked, and navigation-producing markup is neutralized.
7. Switching to Source keeps the existing editor/read-only source behavior.
   Switching back creates a fresh preview using the latest draft HTML.
8. If the capability expires or an asset is missing, the frame or host surface
   shows a specific bounded error and offers Reload/Open. If stable opened-file
   validation is unavailable on the platform, the UI labels and renders the
   existing static Offline document as a compatibility fallback.
9. The existing `Open` actions continue to send the original filesystem file to
   the Desktop OS/IDE bridge. Rudder never opens a capability URL as a top-level
   browser page because that would remove the iframe sandbox boundary.
10. Messenger uses the same runtime at its narrower viewport, so normal website
   responsive rules determine the page layout.

## Implementation

### Product Or Technical Architecture Changes

Introduce three layers:

1. `workspace-web-preview` shared contract
   - request/response types and network-mode validator
2. server preview runtime
   - in-memory capability store
   - board-authorized session creation
   - pre-auth capability asset delivery
   - artifact-root and realpath enforcement
   - MIME/CSP/header policy
3. reusable UI preview surface
   - session lifecycle
   - Offline/Connected control
   - iframe and error states
   - Library/Messenger integration

Proposed endpoints:

```text
POST /api/orgs/:orgId/workspace/web-preview-sessions
  { entryPath, networkMode, htmlContent? }
  -> { previewUrl, networkMode, expiresAt }

GET|HEAD https://<preview-host>/workspace-preview/:capability/*assetPath
  -> capability-scoped asset bytes or bounded error response
```

Host dispatch is the outer boundary:

- Preview Host: mount only the capability asset route; return 404 for `/api`
  and every unmatched path; do not run board/session authentication.
- Main application Host: run the normal Rudder middleware/router stack; return
  404 for `/workspace-preview`.

The capability is the only credential available to the sandbox. Session
creation stays under the authenticated API router and existing organization
authorization. The session response derives the Preview origin from the local
loopback default or validated deployment configuration, never from an
untrusted Host header alone.

### Breaking Change

No storage, database, public CLI, or existing file API breaking change is
planned. HTML Preview behavior expands from static inline documents to isolated
website execution. Existing E2E that asserts no script execution and no network
requests must be replaced with mode-specific assertions.

### Design

#### Capability lifecycle

- Generate a base64url random token.
- Store `{orgId, artifactRoot, entryPath, networkMode, htmlOverride,
  canonicalOrgRoot, canonicalArtifactRoot, createdAt, expiresAt}` in a bounded
  map. Store only a token hash if lookup performance remains simple.
- Validate the entry is an existing HTML file inside an ordinary Library
  artifact path with a non-root parent directory before creating the session.
- Prune expired sessions on create/read and evict the oldest session when the
  cap is reached.
- Return an absolute preview URL so iframe loading does not depend on API client
  base-path behavior.

#### File resolution

- Decode the wildcard asset path once.
- Reject empty traversal segments, mixed/encoded traversal, NUL bytes, absolute
  paths, backslashes, dotfiles, directory targets, and non-regular files.
- Resolve the requested path relative to the artifact root.
- Re-resolve the organization root, artifact root, and target through `realpath`
  on every read and verify both containment boundaries after symlinks.
- Validate the path held by the opened file descriptor before reading bytes:
  Linux resolves `/proc/self/fd`, macOS resolves the descriptor through
  `/usr/sbin/lsof`, and unsupported environments fail closed into the static
  Offline UI fallback.
- Reapply protected-root and hidden-segment policy to the canonical artifact
  and target paths so visible symlink aliases cannot bypass Library policy.
- Return the in-memory HTML override only when the requested path exactly
  matches the session entry file.
- Return 404 for missing files and 403/422-style bounded HTML for rejected
  paths without leaking the host path.

#### Sandbox and CSP

The host iframe uses no script permission in Offline:

```html
<iframe sandbox="" referrerpolicy="no-referrer" />
```

Connected uses:

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" />
```

Offline CSP permits styles, images, fonts, media, and manifests from the
explicit Preview origin where browser loading semantics require it, and sets
`script-src 'none'` plus `worker-src 'none'`. It blocks connections, frames,
objects, forms, and external schemes. Before sending an Offline HTML response,
the server parses it and removes meta refresh plus external `href`/navigation
targets while preserving local paths and fragments.

Connected CSP additionally permits `https:` for scripts, styles, images, fonts,
and media. It still blocks `connect-src`, forms, frames, objects, and top-level
navigation through the iframe sandbox. HTTP external resources remain blocked.
Connected mode is not a confidentiality boundary for preview-owned content:
artifact code can encode that content into allowed HTTPS resource URLs.

Before serving Connected HTML, Rudder neutralizes download links by removing
their `href`, `download`, and `ping` attributes. Chromium can otherwise issue a
download request before the iframe sandbox rejects the download UI.

Because Connected frames have an opaque origin, local modules/fonts receive
wildcard CORS from capability assets with credentials disabled.

Local module scripts and fonts receive `Access-Control-Allow-Origin: *` only
from the capability asset route because the sandbox has an opaque origin.
Rudder API routes do not receive that header.

### Security

No new third-party dependency or remote service is required.

New HTTP endpoints are limited to session creation and capability asset reads.
The Preview Host accepts only GET and HEAD and has no API, authentication, UI,
or mutation router. Connected mode lets the browser contact artifact-declared
HTTPS origins only after the operator changes the mode. Rudder does not proxy
those resources, which avoids introducing an SSRF surface. Referrers remain
suppressed, but the operator is warned that preview-owned content can be sent to
those HTTPS origins.

The token is intentionally transient and read-only. It does not grant access to
the organization root, other directories, mutation endpoints, or board APIs.

## What Is Your Testing Plan (QA)?

### Goal

Prove rendering fidelity for a production-shaped multi-file website and prove
that the new execution surface cannot cross organization, artifact-root,
filesystem, or Rudder-control-plane boundaries.

### Prerequisites

- Dev server with embedded PostgreSQL or an isolated external E2E database.
- Two organizations with distinct Library roots.
- A fixture website containing HTML, CSS, JS, module JS, nested images/font,
  CSS `url(...)`, and HTTPS external resources.

### Test Scenarios / Cases

Unit/service:

- capability creation, expiry, pruning, and unknown token
- MIME mapping for HTML/CSS/JS/module/JSON/image/font/media
- Offline and Connected CSP output
- entry override applies only to the selected HTML file
- traversal, encoded traversal, absolute path, backslash, and NUL rejection
- symlink inside artifact root pointing outside the root
- artifact root replaced by a symlink after session creation
- cross-organization and sibling-directory access rejection
- protected root, dotfile, directory, FIFO/socket, and device-file rejection
- missing asset and unsupported entry behavior
- capability token redaction from success and failure logs
- Preview Host rejects POST/PUT/PATCH/DELETE and returns 404 for `/api`
- main application Host returns 404 for capability routes

Component:

- creates Connected session by default with persistent disclosure
- switches to Offline with a new session
- preserves Preview/Source behavior and current draft HTML
- shows stable loading/error/reload states
- uses `sandbox=""` in Offline and `sandbox="allow-scripts"` in Connected,
  always without `allow-same-origin`
- Library and Messenger both use the reusable component

E2E/black box:

- real local CSS changes computed layout and colors
- Offline local CSS/images render while local and inline scripts do not execute
- Offline strips meta refresh and external anchor/area navigation targets
- Connected real local JavaScript changes visible DOM state
- Connected local module script executes
- module imports and fonts with opaque `Origin: null` load through capability
  asset CORS without credentials
- nested image and CSS background load
- Offline makes zero external requests
- Connected loads an intercepted HTTPS image/style/script
- Preview Host `/api` is 404 and main Host capability paths are 404
- preview cannot read parent DOM or call a Rudder mutation endpoint
- `fetch`, XHR, beacon, form, ping, WebSocket, iframe, popup, download, and
  top-navigation attempts are blocked; Rudder mutation counters stay zero
- root-level HTML session creation is rejected
- Open actions receive the original filesystem file, never the capability URL
- wide Library and narrow Messenger screenshots show the rendered website
- expired/invalid session produces a recoverable error

### Expected Results

All supported local resources render in both surfaces. Connected resources load
only in Connected mode. Boundary attempts fail without data disclosure or
control-plane mutation. Existing non-HTML previews remain unchanged.

### Pass / Fail

- Unit/service tests: passed, including 21 server/config tests, 85 focused UI
  tests, and dedicated URL-normalization regressions for encoded TAB/LF/C0
  external schemes.
- Server typecheck: passed.
- E2E: passed. The final Chromium runs cover the adversarial multi-file Library
  flow, static Offline fallback navigation, Library/Messenger parity, and the
  existing Messenger HTML report regression (`4/4`), followed by a focused C0
  fallback rerun (`1/1`).
- Browser visual verification: passed at desktop and mobile widths. Evidence is
  stored outside the repository under `/tmp`.
- `pnpm lint`: passed before final hand-off changes; the final edits are covered
  by focused lint-compatible tests and the final lint run recorded at hand-off.
- `pnpm product-logic:check`: passed with 72 guarded contracts; no
  `doc/product/**` files were changed for this feature.
- Full repository typecheck/build: passed after concurrent `Layout.tsx` work
  settled. Production build emitted only the existing CSS pseudo-element and
  chunk-size warnings.
- Full `pnpm test:run`: 4,015 tests passed and 30 failed. Failures were outside
  this feature: Git/worktree/release timeouts, concurrent `ToastContext` mock
  drift, one chat-route assertion, and runtime-service/resource failures.
  Preview-focused tests and E2E are green.

## Documentation Changes

- This proposal records architecture and delivery scope.
- After explicit Product Logic Registry authorization:
  - add `doc/product/domains/library-and-context/website-preview.md`
  - register `LIBRARY.WEB_PREVIEW.001` as `logic_contract`
  - update `LIBRARY.FILES.001` and the surface-domain map to reference it
- No public `docs/` change is required unless website preview becomes part of
  onboarding or advertised Library behavior.

## Open Issues

- Local loopback uses `preview.localhost` on the same server port with strict
  Host dispatch. Non-loopback/private/public deployments require an explicit
  Preview origin whose ingress routes only to the preview Host branch.
- Linux with `/proc/self/fd` and macOS with `/usr/sbin/lsof` receive the full
  multi-file runtime. Windows and hardened Linux environments without stable
  descriptor-path resolution receive the labeled static Offline fallback until
  a native stable-file implementation is added.
- The first slice uses both a separate Preview Host and the sandbox's opaque
  origin, and forbids connection APIs. This is intentionally narrower than a
  general web-development server.
- Connected mode exposes the operator's network address to artifact-declared
  HTTPS resources. The selected mode, label, and tooltip are the disclosure;
  Offline is the strict opt-out.
- SPA route fallback and framework dev-server support need a separate proposal.
