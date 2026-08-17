---
title: App Builder
domain: execution
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - APP.BUILDER.001
related_code:
  - packages/db/src/schema/app_builder_apps.ts
  - packages/shared/src/types/app-builder.ts
  - packages/shared/src/validators/app-builder.ts
  - server/src/services/app-builder.ts
  - server/src/routes/app-builder.ts
  - server/resources/bundled-skills/app-builder/SKILL.md
  - desktop/src/app-builder-ipc.ts
  - desktop/src/app-builder-manifest.ts
  - desktop/src/app-builder-data.ts
  - desktop/src/local-app-framework.ts
  - desktop/src/local-app-icon-discovery.ts
  - desktop/src/local-apps-runtime.ts
  - ui/src/pages/Apps.tsx
  - ui/src/components/AppBuilderAutoLaunchCoordinator.tsx
  - ui/src/lib/app-builder-launch.ts
  - ui/src/components/AppsContextSidebar.tsx
  - ui/src/lib/app-primary-rail.ts
  - ui/src/pages/InstanceExperimentalSettings.tsx
  - ui/src/components/PrimaryRail.tsx
related_tests:
  - packages/shared/src/validators/app-builder.test.ts
  - server/src/__tests__/app-builder-service.test.ts
  - server/src/__tests__/app-builder-routes.test.ts
  - server/src/__tests__/app-builder-status-script.test.ts
  - desktop/src/app-builder-controller.test.ts
  - desktop/src/app-builder-manifest.test.ts
  - desktop/src/app-builder-data.test.ts
  - desktop/src/app-builder-runner.test.ts
  - desktop/src/app-builder-ipc.test.ts
  - desktop/src/local-app-framework.test.ts
  - desktop/src/local-app-icon-discovery.test.ts
  - ui/src/pages/InstanceExperimentalSettings.test.tsx
  - ui/src/lib/app-builder-launch.test.ts
  - ui/src/lib/app-primary-rail.test.ts
  - ui/src/components/PrimaryRail.test.tsx
  - tests/e2e/app-builder.spec.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-29-app-builder-prd.md
  - doc/plans/2026-07-29-app-builder-implementation.md
edit_policy: user_confirmed_only
---

# App Builder

## APP.BUILDER.001

### Contract Summary

App Builder turns a natural-language request into a new or improved local web
product that can be used as a Rudder App. New Apps use one maintained full-stack
scaffold by default; existing web projects keep their framework and conventions.
It is a default Rudder capability. The top-level **Hub** destination is always
available in the Primary Rail, while the Apps workspace owns building, loading,
and running local Apps. Hub always returns to **Plugins** instead of remembering
the Apps workspace. Local Apps appear as app-only Plugins in **Hub > Plugins**
and remain directly openable through their existing `/apps/...` workspace
routes. An App appears as a removable Primary Rail item only after the operator
opens it; Apps Home itself is not a persistent rail destination.

To the operator, these websites are **Rudder Apps**. Underneath, they remain
ordinary local webpages rather than a new executable or packaging format.
Rudder Desktop owns the fixed setup/check process, reviewed local definition,
process lifecycle, loopback attestation, embedded App guest, and
development-data recovery. The Server stores organization-scoped App identity,
optional originating Chat, safe lifecycle state, and opaque Desktop binding
only.

The product name is **App Builder**, without “Local.” V1 has no Rudder cloud
build, hosting, publishing, public URL, tunnel, managed remote database, or
cross-device synchronization.

### Intent / User Job

- A non-technical operator can request a CRM, cold-email manager,
  marketing-data system, dashboard, tracker, or internal tool without choosing
  a framework, database, package manager, or process topology.
- A technical operator can inspect and edit generated source, use another
  stack independently, or register an existing local web App through the same
  Apps workspace.
- Any operator can load a frequently used local web project into Rudder Apps;
  an Agent may inspect and minimally prepare that project for safe discovery
  while preserving its existing framework and development workflow.
- App Builder and Desktop remain the execution and data owners. The Plugins
  domain supplies discovery and lifecycle context but does not start an App,
  reinterpret Codex `.app.json`, or delete App source or business data.
- Existing data is normal. The generated App owns its database, records,
  services, integrations, and background behavior. The Skill asks about
  synthetic, copied, redacted, snapshot, or direct data use only when the
  choice materially changes risk or behavior.

### Why / Design Reasoning

A fixed scaffold removes infrastructure questions from the default workflow
while keeping the result inspectable and independently editable. Chat remains
the requirements and coding surface. Apps supplies durable discovery and
direct application access without forcing users to create a Project.

The Server cannot safely own machine commands, absolute paths, ports, PIDs,
live URLs, or App business rows. Desktop therefore owns local execution and
attestation. A click on an App entry in **Hub > Plugins** or its Apps
workspace is direct operator intent to open its reviewed revision; a Server
record, Skill availability, background route hydration, or Messenger Saved
View remains non-authoritative.

### Actors / Objects / State

- **Operator**: describes an App, receives the verified result
  opened automatically, and uses Chat or the More menu for later improvements
  and infrequent management actions. Manual Local Apps still require definition
  review.
- **App Builder Skill**: creates or improves a web product from the business
  brief and prepares its source for Rudder Apps discovery.
- **App record**: organization-scoped identity, optional Chat, normalized
  source root, safe build state, and opaque Desktop binding.
- **Desktop runner**: fixed scaffold setup/check/start implementation.
- **Local App generation**: owned process tree, attested loopback target, and
  App-specific browser partition.
- **Generated App**: owns source, storage, domain records, integrations, and
  business behavior.

### Maintained V1 Stack

- Next.js App Router, React, TypeScript, and Tailwind CSS;
- Rudder-curated shadcn-style source components;
- application-owned SQLite with Drizzle, migrations, and Zod validation;
- Vitest, Playwright, a fixed health endpoint, and JSON import/export
  conventions;
- a versioned `rudder.app.json`; and
- a Rudder-owned Node/pnpm runner and structured Local App definition.

The maintained stack is the default for non-technical users, not a restriction
on independently authored Apps. Independently authored common Web projects use
the Desktop Local Apps compatibility baseline for direct package-manager
scripts, loopback readiness, and project/framework icon discovery. V1 does not
add a Rudder job scheduler, Secret vault/binding UI, immutable release
promotion, or production rollback UI.

### Entry Points / Inputs

- Top-level **Hub** Primary Rail destination with **Plugins**, **Skills**, and
  **Showcase** views.
- Organization-scoped, removable Primary Rail items for Apps the operator has
  opened.
- The Apps workspace request composer: **Turn ideas into applications**.
- Registered App list and sidebar **Add an App** menu:
  - **Build with Agent** opens a new Chat with an editable `$app-builder` brief.
  - **Add local web project** opens Desktop folder selection and definition
    review.
- Natural-language brief, selected organization, and active Agent.
- Normalized organization-workspace-relative `apps/<slug>` source root.
- Fixed scaffold revision and up-front disclosure that Rudder will build,
  verify, start locally, and open the managed App when it is ready.

### Product Logic Flow

1. Hub is available by default in the Primary Rail and always opens Plugins;
   visiting Apps never replaces that stable return destination. Opening Hub,
   Plugins, or Apps Home never starts a process or creates an App.
2. The Apps execution workspace uses Rudder's established workspace shell:
   Home/search/registered Apps in the context sidebar and Home or the active
   full-bleed webpage in the main content. Open Apps are represented once in
   the Primary Rail rather than duplicated in an Apps-local header tab strip.
   App management is
   progressively disclosed through a hover/focus More menu on each sidebar
   row; Apps has no persistent right runtime-control column. Subtle
   entry/rail/status motion respects reduced-motion preferences.
3. The context-sidebar **Add an App** menu separates creation from loading:
   **Build with Agent** navigates to a normal new Chat with an editable, unsent
   `$app-builder` prompt, while **Add local web project** opens the Desktop
   folder picker and existing definition-review flow. The menu explains that
   common local web projects can be loaded and used directly in Rudder.
4. Sending a brief from Apps Home reserves one organization-scoped App record under a unique
   `apps/<slug>` root, starts an ordinary Chat with `$app-builder` and the
   assigned App ID and source root in its first message, attaches the
   acknowledged Chat, and navigates to that Chat. The composer discloses that
   Rudder will build, verify, start locally, and open the App when ready. This
   flow neither creates nor requires a Project.
5. For new source, the Skill uses the maintained scaffold and implements the
   requested business workflow. For an existing local web project, it first
   inspects and preserves the framework, package manager, scripts, data
   boundary, and tests, then adds only the minimal launch/readiness configuration
   needed by Desktop discovery. If Chat cannot be acknowledged, a reserved App
   becomes failed rather than pretending that work started.
6. The Skill reports `building` with the authenticated run ID when work begins.
   It reports `verified_source_ready` only after development, debugging,
   required review, rendered verification, persistence checks, and durable
   evidence pass. The signal is tied to the originating App, Chat/source root,
   organization, and authenticated run. A prose response ending, question,
   blocker, cancellation, or partial result is never a completion signal.
7. A globally mounted Desktop coordinator claims `verified_source_ready` with
   compare-and-set semantics, validates the assigned source and manifest,
   installs and checks the locked graph, starts the owned generation, waits for
   readiness, and proves the loopback listener belongs to that generation.
   Only then may the App become ready and receive an opaque local binding.
   The coordinator opens that App directly and tells the operator that later
   improvements can continue in the originating Chat. No second registration
   button or blocking confirmation is required because the local execution
   behavior was disclosed when the build request was submitted.
8. If Desktop verification or startup fails, Rudder stops and removes only
   newly owned runtime material, preserves source and App data, marks the App
   `launch_failed`, and offers retry plus **Continue in Chat** recovery. It
   never claims the App opened.
9. Registered managed Apps and manually loaded local Apps appear together in
   the Apps navigation. Opening one creates or focuses one organization-scoped,
   closable Primary Rail item and directly opens its reviewed revision. Rudder
   reuses a running
   generation or automatically starts one, attests its listener, and renders
   the active webpage full-bleed through its isolated Desktop webview.
   Multiple opened Apps may remain in the rail and continue running.
10. Hover or keyboard focus reveals an App rail item's close control. Removing
   a background App removes only that rail entry without changing the current
   route. Removing the active App returns to **Hub > Plugins**. Removing or
   switching an App rail item closes or parks only the view and never stops the
   App. The process remains available in the background until Desktop shutdown,
   a bounded failure occurs, or the operator uses
   **Stop App** in the sidebar row's More menu. Background route hydration and
   Messenger Saved View navigation remain unable to start it. Reopening a
   removed App adds it to the rail again without creating a duplicate.
11. The sidebar More menu contains settings and infrequent lifecycle actions.
    While an App is running, **Copy App link** copies its current attested
    `http://127.0.0.1:<port>/...` URL and **Open in browser** sends that same URL
    to the system browser. It works only on the same computer while that
    generation remains available.

### State And Meaning

Build state is:

`preparing -> building -> verified_source_ready -> verifying -> ready | launch_failed`.

`failed` is reserved for work that stops before verified source is handed to
Desktop. Only `launch_failed` retains verified-launch provenance and may retry
directly into `verifying`; a generic `failed` App must continue through Chat and
a new authenticated build/verification handoff.

Compare-and-set transitions prevent a stale build or UI failure handler from
overwriting a newer owner. `verified_source_ready` is a run-scoped Agent
handoff, not a runtime-ready claim. `verifying` means the fixed Desktop path is
running real checks plus readiness and listener-ownership attestation. `ready`
does not claim production promotion, public deployment, or acceptance beyond
the recorded Agent and Desktop evidence.

Runtime state is installation-local and follows the Local Apps contract,
including `stopped`, `starting`, `running`, `stopping`, `failed`, and
ownership-unverified failure handling.

### Data Boundary

- Rudder never mirrors App business rows into its own database.
- The scaffold reserves distinct development and formal-data paths. Apps may
  adopt other application-owned storage or services through ordinary source
  changes.
- Snapshot/export/import/restore actions stop the bound App first and operate
  on managed development data only. They do not imply universal backup support
  for every independently authored App or replace formal data.
- Real-data access, schema changes, credentials, and external side effects are
  decisions in Chat and in the generated App. App Builder does not advertise a
  universal sandbox, Secret vault, production migration service, or hosted
  database.

### Decision Table

| Situation | Required behavior | Forbidden behavior |
| --- | --- | --- |
| User requests a CRM | Use maintained defaults and ask only material business/risk questions | Ask them to choose framework or process topology |
| User selects Build with Agent | Open a normal new Chat with an editable, unsent `$app-builder` brief | Send automatically, create a run, or start local code |
| User selects Add local web project | Open folder selection, discover the project, and show the existing launch-definition review | Run the project on folder selection or require the maintained scaffold |
| Agent improves an existing web project | Preserve its stack and add only minimal discovery configuration when needed | Replace it with the maintained scaffold merely to register it |
| Apps Home sends a brief | Reserve an org App, start normal Chat with `$app-builder`, attach Chat | Create or require a Project |
| Chat acknowledgement fails | Mark the reservation failed and show the cause | Claim the App is being built |
| App source is missing or invalid | Return to Chat with a causal failure | Generate generic source during Register |
| Agent finishes development and verification | Emit `verified_source_ready` with the authenticated originating run | Treat ordinary Chat completion or prose as authority |
| Desktop observes verified source | Claim it once, run the maintained typed lifecycle, then open the attested App | Require another registration confirmation or accept Agent-provided shell/cwd/port/env authority |
| Desktop checks or readiness fail | Mark `launch_failed`, clean up owned processes, preserve source/data, allow launch retry | Mark ready or open an unattested target |
| Agent/Chat stops before verified handoff | Mark `failed` and return to Chat | Offer direct runtime retry for unverified source |
| Foreign listener owns the port | Fail closed without killing it | Guess ownership |
| User clicks a registered App in Apps | Reuse or auto-start its reviewed generation and render the attested webpage | Require a separate Start step or open an unattested target |
| User opens an App | Add or focus one organization-scoped Primary Rail item | Permanently list every registered App in the rail or duplicate navigation in a header tab strip |
| Active App rail item is removed | Return to Hub > Plugins and keep the generation resident | Stop or restart the App |
| Background App rail item is removed | Remove that entry without changing the current route and keep the generation resident | Navigate away, stop, or restart either App |
| Background hydration or Messenger Saved View opens | Restore navigation state only | Start the App |
| User copies or externally opens the link | Use current attested loopback URL | Describe it as public, stable, or cross-device |
| User requests a public URL | Explain that V1 has no publication path | Create a tunnel or cloud deployment |

### Actor-Visible Input

- App name/brief through Apps Home.
- Sidebar Add menu with Build with Agent and Add local web project.
- Selected organization and available Agent.
- Up-front local-execution and automatic-open disclosure.
- App direct-open actions; settings, Stop, Copy, browser,
  Chat, source, and data management through the sidebar More menu.
- Hover/focus close action on each opened App's Primary Rail item.
- Material data/integration choices raised by the Skill.

### Operator-Visible Output

- Default Hub Primary Rail entry and an Apps execution workspace
  without a persistent right runtime-control column.
- Searchable registered App list, Home composer, and opened App rail items that
  remain available per organization until explicitly removed.
- A clear choice between starting an App Builder Chat and loading an existing
  local web project from the computer.
- Normal Chat containing the explicit `$app-builder` request.
- Full-bleed embedded webpage and same-computer browser link.
- Automatic transition from verified Chat work into the opened full-bleed App,
  with **Continue in Chat** available for iterative improvement.
- Causal failed/unavailable state with retry and Ask AI/Chat recovery; source
  access remains available from the registered row's More menu.
- Honest status when the current Desktop lacks the matching binding or runtime.

### Persisted Evidence

- Server: organization id, optional compatibility Project id, optional Chat id,
  name, relative source root, scaffold revision, safe build state/run ids, and
  an all-or-none opaque Desktop binding.
- Desktop: absolute App root, reviewed structured definition, generation,
  attested loopback target, App-specific partition, and managed development
  snapshots/import packages.
- App: source, application-owned database or services, domain records,
  migrations, and import/export behavior.

The official flow writes no Project relationship. Compatibility Project routes
and a nullable `projectId` may remain for existing callers, but they must not
create a hidden Project, drive the Apps UI, or become required App identity.
The Server never stores executable commands, absolute paths, PIDs, ports, live
URLs, App business rows, or Secret values.

### Canonical Scenarios

#### Cold-email manager

The operator opens Apps Home and describes contacts, sequences, replies, and
follow-ups. Rudder opens a normal
`$app-builder` Chat, the Skill
creates and verifies the App, and Desktop automatically verifies, starts, and
opens its local webpage. The operator can return to the same Chat to improve
it. Sending email remains application behavior and is not silently enabled by
App Builder.

#### Existing CRM data

The Skill asks only when direct records, a snapshot, or a redacted copy changes
risk or behavior. App-owned data stays outside Rudder's database; managed
development recovery does not claim to back up arbitrary external services.

#### Existing Vue project

The operator chooses **Build with Agent** to improve the existing product. The
Skill keeps Vue and the project's current package manager, changes the requested
workflow, and prepares a direct supported development script or minimal
`package.json` `rudder` metadata when discovery needs it. The operator then
chooses **Add local web project**, selects the folder, reviews the definition,
and registers the ordinary website as a Rudder App.

#### Same-computer browser

The operator clicks a registered App and Rudder automatically reuses or starts
its reviewed generation before showing the webpage. The operator uses the row
More menu to copy the attested link and open the same page in a regular browser
on that computer. Stopping or restarting the App may invalidate the copied
address.

### Invariants / Non-Goals

- App identity and list access are organization-scoped.
- The official App Builder path is independent of Project identity.
- Source is a normalized organization-workspace-relative `apps/<slug>` path.
- The first managed start is limited to the maintained template revision and
  Rudder-owned runner; it is not arbitrary Agent command authority.
- Automatic managed start requires an authenticated `verified_source_ready`
  handoff for the originating App and run; ordinary Chat or navigation state
  is non-authoritative.
- Manual Local Apps retain explicit first-review semantics. Once registered,
  opening them from Apps directly starts the reviewed revision.
- App links stay loopback-only and same-computer.
- Availability follows the user's supported Desktop platform rather than a
  macOS-only product rule; process ownership must still fail closed.
- V1 installs no OS service and provides no cloud/publication surface.

### Drift Boundaries

- Hub discovery, Skill availability, and Desktop Local App/App Builder
  admission are default capabilities with independent owning lifecycles.
- The managed exception remains fixed-template and fixed-runner scoped.
- Adding arbitrary stack or launch-command selection to the non-technical path
  requires a new product decision.
- Adding production promotion, a managed scheduler, Secret binding, or
  app-specific Agent Browser acceptance changes the state/evidence contract.
- Any public, tunneled, hosted, or cross-device URL is outside this contract.

### Traceability

- Product decision: `doc/plans/2026-07-29-app-builder-prd.md`.
- Delivery plan: `doc/plans/2026-07-29-app-builder-implementation.md`.
- Runtime base contract: `DESKTOP.LOCAL.APPS.001`.
- Organization source boundary: `LIBRARY.FILES.001`.
- Skill availability: `AGENT.SKILLS.001`.
