---
title: Isolated Library Website Preview
domain: library-and-context
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - LIBRARY.WEB.PREVIEW.001
related_code:
  - packages/shared/src/types/organization.ts
  - packages/shared/src/validators/organization.ts
  - server/src/services/workspace-web-preview.ts
  - server/src/routes/orgs.ts
  - server/src/bootstrap/create-http-app.ts
  - ui/src/components/WorkspaceHtmlPreview.tsx
  - ui/src/components/WorkspaceFilePreview.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/Chat.side-panel.tsx
related_tests:
  - server/src/__tests__/workspace-web-preview.test.ts
  - ui/src/components/WorkspaceFilePreview.test.tsx
  - ui/src/lib/workspace-html-preview.test.ts
  - tests/e2e/organization-workspaces-image-preview.spec.ts
  - tests/e2e/chat-side-panel-html-preview.spec.ts
related_plans:
  - doc/plans/2026-07-15-isolated-library-website-preview.md
edit_policy: user_confirmed_only
---

# Isolated Library Website Preview

## LIBRARY.WEB.PREVIEW.001

## Contract Summary

Rudder renders an organization-scoped HTML Library artifact as a runnable,
multi-file website in both the full Library work surface and the Messenger Side
Panel. The website runs on an isolated Preview Host with a short-lived
capability, while one shared toolbar keeps view mode, network mode, file-open,
and reload actions together. A newly opened HTML artifact starts in `Preview`
and `Connected` mode.

## Intent / User Job

An operator reviewing agent output should be able to inspect the output as the
website the agent produced, including relative styles, scripts, modules, images,
fonts, and media. The operator can switch to source, opt into the stricter
Offline mode, reload the artifact, or open the original file locally without
leaving the current review context by accident.

## Why / Design Reasoning

A single-file `srcDoc` cannot faithfully render multi-file output, while serving
agent-authored HTML from Rudder's origin would give untrusted code
access to operator credentials and APIs. Rudder therefore uses a separate
Preview Host plus an opaque sandbox origin. Connected is the default because a
runnable website is the primary review job; Offline remains an explicit local-
assets-only safety mode. The controls belong in one toolbar because view,
network, open, and reload are all ways of inspecting the same artifact, not
separate document sections.

## Actors / Objects / State

- The board operator opens an HTML file from Library or a Library reference in
  Messenger.
- The organization workspace and validated Library-relative entry path identify
  the artifact root and entry document.
- A preview session stores a short-lived hashed capability, organization scope,
  canonical artifact root, entry path, network mode, expiry, and optional draft
  HTML override.
- UI state consists of `preview | source`, `connected | offline`, reload version,
  and loading, ready, or static-fallback status.

## Entry Points / Inputs

- Full Library file selection for `.html`, `.htm`, or `text/html` content.
- Messenger Side Panel Library-file references for the same file kinds.
- `POST /api/orgs/:orgId/workspace/web-preview-sessions` with validated entry
  path, network mode, and optional current draft HTML.
- The toolbar's Preview/Source control, current network-mode menu, Open menu,
  and reload action.

## Product Logic Flow

1. Rudder identifies a supported HTML Library file and opens it in Preview with
   Connected selected unless the operator explicitly changes the network mode.
2. One shared toolbar presents Preview/Source, the current network mode, Open,
   and reload together. In Source, network and reload controls are absent because
   no website runtime is active; Preview/Source and Open remain available.
3. The UI requests an organization-scoped preview session for the original
   Library-relative entry path and the current draft HTML when present.
4. The server validates organization scope, protected paths, canonical symlink
   boundaries, artifact-root limits, and stable opened-file identity before
   issuing a short-lived capability. Root-level HTML entries are rejected.
5. The Preview Host serves the entry and eligible relative assets only through
   that capability. Main-host API routes and preview capabilities on the main
   host remain unavailable.
6. Connected permits artifact scripts and external HTTPS resources inside the
   sandbox, while Rudder requests, credentials, top navigation, popups,
   downloads, connection APIs, and parent DOM access remain blocked.
7. Offline serves local assets with scripts and external requests blocked.
   Selecting a different network mode creates a new session; reload creates a
   fresh session without changing the selected file or parent route.
8. Open always targets the original validated Library file. In full Library it
   exposes available Desktop file targets; in the Side Panel it also includes
   Open in Library and supported containing-directory targets.
9. When stable file validation is unavailable, Rudder labels and renders a
   static Offline fallback with scripts, external resources, refresh, base URLs,
   navigation, ping, and download behavior removed.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Default website review | Supported HTML file opens | Preview, Connected, and one unified toolbar render | Defaulting to source or silently starting Offline | UI unit and Library/Messenger E2E |
| Connected | Operator keeps or selects Connected | Local multi-file assets, scripts, modules, and HTTPS resources render | Access to Rudder APIs, parent DOM, credentials, top navigation, popups, or connection APIs | Server tests and adversarial Library E2E |
| Offline | Operator selects Offline | Local assets render without scripts or external requests | Any external request or script execution | UI unit and Library/Messenger E2E |
| Source | Operator selects Source | Editable Library source or read-only Side Panel source renders with Preview/Source and Open | Starting a preview session or showing irrelevant network/reload controls | UI unit and E2E |
| Open | Operator opens the menu in either surface | Original validated file targets are shown; Side Panel includes Open in Library | Opening the capability URL or an absolute/unvalidated path | Side Panel component tests and Library E2E |
| Runtime unavailable | Stable opened-file validation cannot be guaranteed | Labeled static Offline fallback and retry remain visible | Falling back to a script-capable or externally navigable document | Server/UI tests and fallback E2E |
| Invalid capability or path | Token expired, host/path is wrong, or path escapes scope | Request is rejected without content | Serving protected, sibling-root, or main-host content | Server preview tests |

## Actor-Visible Input

The operator sees the selected HTML filename/path and one compact toolbar. The
toolbar always exposes Preview/Source and Open, shows `Connected` on a newly
opened preview, allows choosing Offline from the network menu, and exposes reload
only while Preview is active. Connected and Offline labels disclose their
runtime/network effect.

## Operator-Visible Output

The operator sees the rendered website or source in place without losing the
Library route or Messenger conversation. Loading, static fallback, and retry are
explicit. Open actions either list valid local targets, navigate from the Side
Panel to the organization-scoped Library path, or explain that local app targets
require Rudder Desktop.

## Persisted Evidence

Preview capabilities and selected UI modes are ephemeral and are not durable
product records. The Library files remain the durable artifact evidence; tests
and server logs provide implementation evidence. No raw capability token is
stored in the database or reused as a file-open target.

## Canonical Scenarios

1. Review a generated multi-file site in Library:
   - Trigger: Open `artifacts/site/index.html`.
   - Expected state/action: Connected preview loads relative CSS, JavaScript,
     modules, and images; all controls appear in one toolbar.
   - Visible output: The rendered site plus Connected, Open, and reload actions.
   - Evidence: Organization workspace website-preview E2E.
2. Inspect the same output beside a conversation:
   - Trigger: Open the HTML Library reference from a Messenger message.
   - Expected state/action: The Side Panel uses the same Connected preview and
     toolbar, and Open includes Open in Library.
   - Visible output: Website preview without replacing the Messenger route.
   - Evidence: Messenger HTML preview E2E.
3. Review without script or network execution:
   - Trigger: Choose Offline from the current network-mode menu.
   - Expected state/action: A new Offline session renders local assets only.
   - Visible output: Offline label; scripts and external assets do not run.
   - Evidence: Adversarial Library E2E.
4. Stable verification is unavailable:
   - Trigger: Session creation cannot verify stable opened-file identity.
   - Expected state/action: Render sanitized static Offline content and disable
     Connected until retry succeeds.
   - Visible output: Explicit fallback notice, Offline label, and Retry.
   - Evidence: Server/UI tests and static fallback E2E.

## Invariants / Non-Goals

- New HTML previews default to Connected; Offline is an explicit operator choice
  or a labeled failure fallback.
- An explicit Connected or Offline choice persists for the current file while
  the operator moves between Preview and Source; opening another file starts
  from Connected.
- Preview/Source, network mode, Open, and reload must not be scattered across
  separate action rows for an active HTML preview.
- The iframe must never receive `allow-same-origin`; Connected adds scripts only.
- Preview Host routing must never expose main-host API routes, auth, or cookies.
- Capabilities are short-lived, hashed at rest in memory, organization-scoped,
  and bound to canonical artifact roots and entry paths.
- Open uses the original validated file, never a capability URL.
- This contract does not promise SPA history fallback, framework dev servers,
  arbitrary root-level HTML entry points, or full multi-file runtime support on
  platforms without stable opened-file validation.

## Drift Boundaries

Changing the default network mode, sandbox permissions, Preview Host boundary,
capability lifetime/scope, supported asset behavior, toolbar interaction model,
fallback policy, or Open target semantics requires updating this contract.
Styling tokens, icon choices, and internal component decomposition do not require
an update when the observable behavior and security boundaries remain intact.

## Traceability

Related plans:

- `doc/plans/2026-07-15-isolated-library-website-preview.md`

Related code:

- `server/src/services/workspace-web-preview.ts`
- `server/src/routes/orgs.ts`
- `server/src/bootstrap/create-http-app.ts`
- `ui/src/components/WorkspaceHtmlPreview.tsx`
- `ui/src/components/WorkspaceFilePreview.tsx`
- `ui/src/pages/OrganizationWorkspaces.tsx`
- `ui/src/pages/Chat.side-panel.tsx`

Related tests:

- `server/src/__tests__/workspace-web-preview.test.ts`
- `ui/src/components/WorkspaceFilePreview.test.tsx`
- `ui/src/lib/workspace-html-preview.test.ts`
- `tests/e2e/organization-workspaces-image-preview.spec.ts`
- `tests/e2e/chat-side-panel-html-preview.spec.ts`

Known gaps:

- Windows and platforms without `/proc/self/fd` or macOS `lsof` stable-file
  validation use the static Offline fallback.
- SPA route fallback and framework dev-server behavior remain out of scope.
