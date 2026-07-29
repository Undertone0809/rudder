---
title: Local App Builder product requirements
date: 2026-07-29
kind: proposal
status: proposed
area: workspace
entities:
  - local_app_builder
  - desktop_local_apps
  - project_workspace
  - app_preview
issue:
related_plans:
  - 2026-07-23-messenger-work-packages-local-apps.md
  - 2026-07-15-isolated-library-website-preview.md
  - 2026-05-19-library-project-context-workspace-proposal.md
  - 2026-03-10-workspace-strategy-and-git-worktrees.md
supersedes: []
related_code:
  - desktop/src/local-apps-runtime.ts
  - desktop/src/local-apps-registry.ts
  - ui/src/lib/local-apps.ts
  - ui/src/context/SidePanelContext.tsx
  - server/src/services/execution-workspaces.ts
  - server/src/services/workspace-runtime.services.ts
  - packages/shared/src/types/work-product.ts
commit_refs:
  - "docs: propose local app builder requirements"
updated_at: 2026-07-29
---

# Local App Builder Product Requirements

## Overview

Rudder should let a user describe a small application in Chat, have an agent
create it inside a local project workspace, and review a live local preview
without leaving Rudder. The source, build process, application runtime, and
preview remain on the user's computer:

```text
Describe -> Plan -> Build -> Start local preview -> Review -> Revise -> Keep source
```

The proposed product name is **Local App Builder**. `Build an app` is the
user-facing action; `Local App` remains the runtime and saved-view term.

This is not a local clone of a cloud hosting platform. Rudder coordinates the
work, keeps the source and evidence, and controls a loopback-only development
process. It does not publish, deploy, create public URLs, provision remote
storage, or operate a hosted runtime. `Local` does not mean offline,
air-gapped, sandboxed, or confidential by default: the configured agent/model
provider, package manager, and application may still use the network.

The first release is a packaged macOS Desktop-only, `local_trusted` capability
built on Rudder's existing Project, organization workspace, Chat, Agent Run,
Browser, Artifact, and Desktop Local App contracts. Windows, Linux, Web, and
`authenticated` deployments render an honest unavailable state. The feature
should not introduce a second process manager or an operator preview browser.

## Product Decision Summary

The proposal makes the following opinionated decisions:

1. The primary entry point is Chat, with a `Build an app` action that starts or
   attaches a Project. There is no new top-level builder product in V1.
2. Source files live under `apps/<app-slug>` in the durable organization
   workspace and remain editable with Rudder, a terminal, or an IDE. Rudder does
   not hide source in an internal database.
3. V1 supports newly created browser applications served by one loopback
   development process. The default recipe is React, TypeScript, and Vite.
   Existing-project adoption is a post-V1 capability.
4. V1 applications may use browser-local persistence such as IndexedDB or
   localStorage. A generated backend, embedded database, authentication system,
   or multiple managed services is not part of V1.
5. The explicit `Build an app` action carries a pre-run disclosure and
   authorizes workspace file changes, package download, and package lifecycle
   scripts for the maintained recipe. A long-lived preview has a separate
   authorization boundary and starts only through the existing Desktop Local
   App trust review.
6. Once the preview definition is trusted and running, source edits use normal
   hot module replacement. A changed command, cwd, environment allowlist,
   readiness rule, or open path requires review again.
7. A preview URL is ephemeral local runtime state. The durable product is the
   source workspace plus run, review, screenshot, and artifact evidence.
8. Local-only describes the source, execution, and deployment boundary, not a
   promise of network isolation. Rudder must disclose each network-capable phase
   and must not label the workflow or runtime Offline.
9. One Project may own at most one Builder App in V1. Creating another app
   requires a new Project; Rudder never overwrites the existing binding.
10. Builder source is created directly under `apps/<app-slug>` in the durable
    organization workspace. Builder runs use the shared persistent workspace
    strategy for that source root; V1 does not build in a disposable worktree
    that would require an unimplemented promotion step.

## Local Boundary Matrix

| Surface | Location and durability | Network behavior |
| --- | --- | --- |
| Source and project files | Durable under the bound app root in the local organization workspace | Sent only where the selected agent/model provider and tools require; a cloud model may receive relevant source/context |
| Agent inference | Runs through a supported local Rudder adapter, but the configured model provider may be remote | Follows the provider selected by the operator |
| Dependency installation | Executes locally and changes only the selected workspace plus normal package-manager caches | May download packages and execute package lifecycle scripts after the Builder disclosure |
| Build and tests | Execute locally in the selected workspace | No Rudder cloud service; project tools may still make their own requests |
| Preview process and URL | Ephemeral on the current Desktop installation and loopback only | The generated application may make outbound requests when implemented to do so |
| Application browser data | Stored in the definition-specific local Electron partition | Not synchronized or backed up by Rudder |
| Publishing and hosting | Not provided | No tunnel, public URL, cloud runtime, hosted database, or deployment API |

Rudder should use `local build` and `local preview`, not `private`, `offline`, or
`sandboxed`, in user-facing copy unless those stronger properties are proven
for the selected provider, dependencies, and application.

Network disclosure is staged:

- Before the Build Run, the confirmation names the configured agent/model
  provider and warns that relevant prompts, context, and source may be sent to
  it. The operator can cancel or choose another configured local runtime/model.
- The same confirmation says that the maintained recipe may download packages
  and execute lifecycle scripts. Without confirmation, no Builder Run starts.
- The default generated app has no required external runtime dependency. If the
  brief requests an external API, hosted asset, or remote link, the compact
  brief and handoff name it; removing that dependency may change the requested
  functionality.
- Preview review states that the app is loopback-only for inbound access but may
  make outbound requests. V1 does not provide an outbound network kill switch.
- Network failure may block model inference or dependency installation. A
  generated app with no requested runtime dependency should continue to run
  after dependencies are installed; Rudder must not promise a fully offline
  build from an empty package cache.

## What Is The Problem?

Rudder can already ask an agent to write code, preserve files in a workspace,
preview static HTML artifacts, run a reviewed local development service, and
open a loopback app in an isolated Browser partition. These pieces do not yet
form one understandable product workflow.

Today a user must know how to:

- create or select the correct project workspace
- ask for a suitable application structure
- understand package managers and development scripts
- install dependencies
- configure a Local App definition
- choose readiness and open paths
- start the process
- find and preserve the preview beside the originating work
- distinguish durable source from an ephemeral localhost URL
- ask the agent to verify and revise the actual rendered result

That makes a common agent job feel like manual development operations. It also
creates avoidable safety risks: users may run an unreviewed command, bind a
service to a non-loopback interface, lose track of the owning process, or treat
a localhost URL as if it were a durable output.

The product opportunity is to turn those existing primitives into one
output-first loop. A non-expert should be able to ask for a tracker, dashboard,
calculator, internal tool, landing page, or small interactive prototype and
reach a working local preview without understanding the underlying runtime.

## Goals

### User Goals

- Describe an application in natural language.
- See a concrete plan when requirements materially affect data or interaction
  design, without being forced through a long setup form.
- Reach the first working local preview in one session.
- Keep the preview beside the Chat or Issue that produced it.
- Request changes conversationally and see them through live reload.
- Reopen the source and explicitly restart the app after Rudder restarts.
- Know what is local, what is durable, what can access the network, and what
  command will run.

### Product Goals

- Make a real application a first-class, reviewable work output.
- Increase completed end-to-end agent-work loops through Rudder.
- Reuse current workspace, run, Browser, Saved View, and Local App boundaries.
- Keep runtime authority in Desktop and organization relationships on the
  Server.
- Preserve the user's ability to leave Rudder and continue with normal local
  tools.

### Engineering Goals

- No shell-string execution for the long-lived preview process.
- No public, LAN, tunnel, or cloud exposure.
- No hidden process start during hydration, navigation, restore, or Desktop
  startup.
- No Local App launch command, launch cwd, environment value, PID, live port, or
  live URL persisted to the Server database. Existing organization/run
  workspace location records remain governed by their own contracts.
- No new framework-specific orchestration in core Server code.

## Non-Goals

V1 does not include:

- cloud deployment, public URLs, preview sharing, custom domains, or release
  promotion
- remote build workers, remote filesystems, or cloud sandboxes
- multi-user collaboration inside the generated application
- generated authentication, secrets management, payments, email, or third-party
  production integrations
- a managed backend, local API service, database server, migration runner, job
  worker, or multiple-process application
- native mobile, native desktop, browser-extension, or command-line application
  generation
- arbitrary language and framework support
- automatic conversion of every coding Chat into an app project
- unattended package installation or process start from a restored conversation
- a visual drag-and-drop editor
- a template marketplace
- a replacement for the IDE, terminal, Git, or source control

## Target Users And Jobs

### Non-technical maker

“Turn my workflow idea into an interactive prototype or lightweight
device-local tool on this computer.”

Typical outputs include a disposable personal tracker, form, calculator,
planner, dashboard, or structured note prototype. Apps that retain user-entered
data must include JSON export/import in V1; Rudder does not describe them as
backed up or suitable for irreplaceable records.

### Product or design operator

“Create a realistic interactive prototype I can inspect and iterate on before
engineering commits to it.”

Typical outputs include onboarding flows, settings surfaces, operational
dashboards, and responsive interaction prototypes.

### Developer

“Create a small frontend project, keep the source conventional, and let me move
between agent iteration and my normal tools.”

Typical outputs include internal tools, data viewers, component demos, and
frontend experiments.

## Core Product Model

### Builder Project

A Builder Project is a normal Rudder Project with:

- one durable source root under the organization workspace
- one compatible local runtime agent
- one application source root inside that workspace
- zero or one opaque Project-to-Local-App binding
- zero or one trusted Desktop Local App definition on the current installation
- related Chats, Issues, Runs, reviews, screenshots, and artifacts

`Builder Project` is a workflow label, not a new top-level organization object.
V1 adds an organization-scoped binding record with a unique `projectId`,
Library-relative `sourceRoot`, `desktopInstallationId`, `appPublicId`, and
`localBindingId`. It stores no launch command, absolute launch cwd, environment,
PID, port, live URL, or trust fingerprint. The Project and workspace remain the
canonical durable grouping; Desktop remains authoritative for definition and
process state.

### Build Run

A Build Run is a normal agent run whose intent is to create or revise the
application. It records the prompt, plan, file changes, validation evidence,
cost, and completion state. It does not own the long-lived preview process.

### Local Preview

A Local Preview is the existing Desktop Local App runtime:

- one reviewed structured executable and argument list
- one canonical cwd
- one dynamically allocated `127.0.0.1` port
- one readiness path and one open path
- one attested listener owned by the launched process tree
- one isolated Browser partition per Local App definition

Its definition and recovery descriptor are installation-local. PID/process
group, port, generation, and last known status may be persisted locally for
safe recovery; the live origin, log buffer, readiness attempts, tab, and
viewport are runtime-only.

### App Source

The app source is a normal directory under the durable organization workspace.
The initial recipe should create conventional files that work outside Rudder.
The builder must not depend on a proprietary source format.

### App Evidence

At successful handoff, the work surface should show:

- application name and current build summary
- source workspace and relative application path, hydrated locally on Desktop
- preview state: `Needs review`, `Starting`, `Running`, `Stopped`, or `Failed`
- `Start, open & verify`, `Start & open`, `Open`, `Stop`, `Restart`, and
  `Open source` actions as applicable
- latest successful build run
- at least one current screenshot after browser verification, materialized as
  an Agent-owned Chat attachment or a Run-backed `artifacts/...` Library file
- validation summary and any known limitations

The materialized screenshot is durable evidence. A screenshot that exists only
inside a Browser tool result is not. The loopback URL is not durable evidence.

## Scope And Functional Requirements

### 1. Entry And Project Setup

1. Chat exposes a `Build an app` action in the create/attach-work affordance.
2. Before dispatch, the action explains that the selected agent/model provider
   may receive relevant prompt, context, and source; that the build may download
   packages and execute package lifecycle scripts; and that generated code runs
   locally without a host-filesystem sandbox. Confirming this action authorizes
   those build-time operations for the maintained recipe, but does not authorize
   starting the long-lived preview.
3. The action asks only for decisions that cannot be inferred safely:
   - create a new Project or use the current Project
   - application name when it cannot be derived from the request
4. If the Project already has a Builder App binding, Rudder offers to continue
   that app or create a new Project. It never replaces the binding.
5. A new Builder App receives `apps/<app-slug>` under the durable organization
   workspace and a shared persistent Builder execution workspace before the
   agent runs.
6. If the current runtime cannot read and write the selected workspace, Rudder
   blocks with an actionable runtime/workspace choice.
7. Rudder must not run the builder in the organization root, agent home, or an
   unscoped temporary directory.

### 2. Requirement Capture

The agent should ask at most three grouped questions only when missing answers
materially change functionality or create a risky assumption. Otherwise it
should build a coherent first version using stated assumptions.

The builder captures a compact brief in the Chat transcript:

- user/job
- primary workflow
- essential screens or routes
- data that must persist on this device
- important constraints
- explicit exclusions

The brief is not a separate mandatory document or wizard in V1.

### 3. Project Creation

V1 uses a maintained, versioned React + TypeScript + Vite recipe. The recipe
must:

- start without cloud credentials
- bind only to the port and loopback host provided at runtime
- expose a deterministic readiness path
- support hot module replacement
- keep application data local to the Browser partition when persistence is
  requested
- include JSON export/import whenever it stores user-entered application data
- provide build, typecheck, and test scripts
- contain no telemetry, analytics, hosted fonts, or required external runtime
  dependency by default

Existing-project adoption is out of V1. Existing projects continue to use
ordinary coding work and the manual Desktop Local App workflow until the
post-V1 adoption phase defines compatibility and conflict rules.

### 4. Agent Build Protocol

The bundled builder procedure should:

1. inspect only the selected source root and relevant Project Context
2. create or update the compact brief
3. create the maintained recipe
4. implement one complete first version
5. install dependencies when required by the explicit build request
6. run the recipe's build, typecheck, and test scripts
7. derive a Local App definition draft from trusted project metadata
8. present the preview trust review
9. end the Build Run as `succeeded` with a result referencing the opaque App
   binding; move the composed Preview state to `needs_review`. Do not invent a
   new Agent Run state or keep a run paused indefinitely for a Desktop action
10. after an explicit `Start, open & verify`, create a separate, visible
    verification continuation run with its own budget/cost record
11. inspect the rendered app through an opaque, generation-scoped verification
    lease in a separate Agent Browser tab
12. fix blocking runtime or rendering failures through an explicit follow-up
    Build Run
13. materialize a current screenshot as a Chat attachment or Run-backed Library
    artifact and return a concise handoff

The procedure must not:

- silently start a long-lived process
- modify files outside the selected workspace
- use global package installation
- add deployment configuration
- add analytics or production credentials
- claim visual success without inspecting the running app

### 5. Preview Trust And Start

1. Server-persisted Chat state contains only the opaque Project/App binding,
   safe composed status, and actions. It contains no local path, command,
   arguments, environment names, port, or URL.
2. On the matching Desktop installation, the renderer uses the opaque binding
   to hydrate a local projection of the review summary through IPC. The
   authoritative approval remains the existing Desktop native reviewed-
   definition flow, which shows:
   - app name
   - source directory in user-understandable form
   - executable and arguments
   - inherited environment variable names, never values
   - readiness path and open path
   - local/network disclosure
3. Web, another Desktop, or a missing local binding shows unavailable and never
   reconstructs or replays the local fields.
4. Builder exposes `Start, open & verify` as its primary direct operator action
   and `Start & open` as a secondary action. Both approve the exact current
   Desktop definition and start it through the existing Local App runtime.
5. `Start, open & verify` additionally requests a normal verification
   continuation only after Desktop proves readiness and listener ownership.
   The new run has visible budget/cost attribution and may still be rejected by
   ordinary run admission or budget hard stops.
6. A trusted, unchanged definition may be started again with one action.
7. Hydration, route restore, reopening a Saved View, Desktop startup, and Chat
   replay never start it automatically.
8. A changed fingerprint returns to `Review changes`.
9. Dismissal leaves `preview_needs_review`; `Start & open` leaves
   `running_unverified`; start failure leaves `preview_failed`; Desktop
   unavailability leaves `preview_unavailable`. None silently dispatches an
   Agent Run.
10. Rudder must never offer a non-loopback bind, local-network share, or tunnel.

### 6. Attested Verification Lease

The existing Agent Browser cannot control the operator's Local App guest. V1
therefore adds a narrow bridge without sharing the operator's Browser partition:

1. After a successful direct start, Desktop creates an opaque lease bound to
   organization, Project, App binding, runtime generation, active verification
   run, and expiry.
2. The Server and run may persist/pass only the opaque lease id. The attested
   origin remains Desktop runtime state and the lease becomes invalid when the
   generation stops or changes.
3. A new high-level Agent Browser action opens the attested origin in a
   run-owned Agent Browser tab. The agent never receives process start/stop
   authority through this lease.
4. The verification tab uses a separate transient Agent Browser partition. It
   cannot inspect or modify the operator Local App guest's persistent browser
   data, cookies, or current page state.
5. Browser-local persistence is tested by creating test data and reloading
   inside the verification tab. This proves application behavior, not
   preservation of the operator's existing data.
6. Read, click, type, screenshot, and close follow normal run-scoped Browser
   auditing and tab limits. Navigation cannot retain Local App authority after
   leaving the attested origin.
7. The screenshot tool result must be materialized explicitly before it appears
   as durable work evidence.

### 7. Live Iteration

1. The running preview opens in Rudder's Local App Browser guest.
2. The preview can be kept in the current Messenger work package.
3. The user may continue in the originating Chat with requests such as “make
   the table denser” or “add an empty state.”
4. Each request creates a normal follow-up agent run against the same workspace.
5. File changes appear through the project's hot-reload behavior.
6. If a change requires a different runtime definition, Rudder does not stop
   the old generation automatically. It labels it `Running previous version`,
   disables Restart for that generation, and requires explicit Stop followed by
   `Review changes` before the new definition can start.
7. The agent verifies the requested behavior in the running preview when the
   change is user-visible.

### 8. Stop, Restart, Reopen, And Recovery

- `Stop` terminates the verified owned process group and updates all open views.
- `Restart` is available only for the same trusted definition.
- Closing a preview tab does not stop the app.
- Removing a Saved View does not stop the app.
- Normal Desktop quit stops owned app processes.
- After restart, the app is `Stopped`; an explicit user action is required.
- If ownership cannot be proven after a crash, the app becomes
  `orphaned_unverified`; Rudder must not guess which process to kill or start a
  competing process.
- Source remains available even when preview start fails.

### 9. Review And Completion

A build is not complete merely because files were written or the package build
passed. Completion requires:

- build and focused automated checks pass
- preview reaches readiness
- the primary user workflow is exercised in the real local Browser
- one compact-brief acceptance example representing an empty, invalid, or
  persisted-data state is exercised
- a current screenshot from the successful build revision and attested
  generation is materialized as an Agent Chat attachment or Run-backed Library
  artifact
- failures and limitations are named
- the user can open the source

The user may accept the result in Chat, request changes, or create/link an Issue
for structured follow-up. Acceptance does not publish or deploy anything.

## User Experience Walkthrough

### New App

1. The user opens Chat and says, “Build me a local client follow-up tracker.”
2. Rudder recognizes or the user selects `Build an app`.
3. Rudder creates a Project, durable app root, and shared persistent execution
   workspace, then attaches the Chat.
4. The agent records a compact brief and builds the first version using the
   maintained V1 recipe.
5. The agent completes dependency installation plus the recipe build,
   typecheck, and tests.
6. The Build Run ends and Chat shows a self-contained
   `Preview ready for review` block.
7. The user selects `Start, open & verify` after reviewing the local command
   and network disclosure in the Desktop-owned review flow.
8. Desktop starts the app on an allocated loopback port, verifies ownership and
   readiness, and opens it in Rudder.
9. Rudder starts a visible verification continuation run. It uses an opaque
   attested lease to inspect the app in a separate Agent Browser partition and
   materializes a screenshot plus validation summary.
10. The user asks, “Add an overdue filter and remember it.”
11. A follow-up run edits the same workspace. Hot reload updates the open app,
    and the agent verifies the filter plus the empty-result edge case.
12. The user accepts the result. Source, runs, review, and screenshot remain;
    the preview stops on request or when Desktop quits.

### Failure

1. Dependency installation fails, readiness times out, or the selected port is
   owned by an unexpected process.
2. The review block moves to `Failed` with bounded, safe diagnostics.
3. Source, previous evidence, and the user's place in Chat remain intact.
4. Retry does not add speculative install, migration, or cleanup commands.
5. The agent may propose a scoped fix; changed runtime details require review.

## Information Architecture And Design

V1 should fit Rudder's existing surfaces:

- **Chat main**: request, compact brief, progress, review block, acceptance
- **Chat Thread manifest**: materialized screenshot and durable Library/Chat
  outputs; the current contract does not treat a workspace directory as a
  manifest item
- **Side Panel / Messenger Main**: live Local App Browser guest
- **Project**: workspace binding and related work
- **Run detail**: exact agent activity, checks, evidence, and cost

Do not create a marketing-style builder canvas. The preview is the primary
output; controls and status should be compact operator chrome around it.
`Open source` uses a new Desktop-validated launcher for the bound relative app
root. It must reuse organization workspace realpath and protected-path checks
before opening that directory in a detected IDE, terminal, or file browser.

The actionable preview review block should contain its status, definition
summary, disclosure, failure state, and actions in one container. While it
requires trust review, the freeform composer should not compete as a second
primary action.

## State Model

Build and Preview are orthogonal state machines:

```text
Build:
not_started -> preparing -> building -> succeeded | failed

Preview:
unconfigured -> needs_review -> starting
  -> running_current | running_unverified | failed
running_current -> running_previous_version | stopped
running_previous_version -> stopped -> needs_review
any non-running state -> unavailable | orphaned_unverified
```

Build state belongs to Agent Runs. Preview state belongs to Desktop Local Apps.
A failed revision may coexist with a still-running previous preview; a
successful build may coexist with `needs_review`; and preview failure does not
invalidate successful source/build evidence. The Server stores only safe
composed state and opaque ids, while the matching Desktop hydrates the current
authoritative preview status.

## Data And Persistence

### Durable

- Project and Chat/Issue relationships
- organization and execution workspace metadata governed by existing workspace
  contracts
- opaque Project-to-Local-App binding
- agent runs, transcripts, costs, and review decisions
- source files under the bound durable organization workspace root
- screenshots and other Library artifacts
- opaque Saved View identity and Messenger group placement

### Desktop-local

- reviewed Local App definitions and trust fingerprints
- executable, argv, canonical cwd, inherited environment names
- persisted recovery descriptors including runtime generation, PID/process
  group, port, and last known status
- Browser partition and app-local browser data

### Runtime-only

- live origin/preview URL
- readiness attempts
- bounded live log buffer
- hot-reload connection
- live Browser tab and current viewport

The opaque Project-to-Local-App binding is a new organization-scoped Server
record because current Local App definitions and Saved Views contain no Project
identity. It must enforce one binding per Project in V1 without receiving
Desktop launch authority.

## Local Data Boundary

V1 supports browser-local persistence in the app's isolated Local App Browser
partition. This is suitable for private prototypes and single-device tools, but
it has important consequences:

- clearing the Local App Browser partition deletes app-local browser data
- deleting and recreating a Local App definition may change its partition and
  make previous app-local browser data unavailable
- opening the app in another browser does not share the same partition data
- source backup does not back up browser-local data
- Saved View synchronization does not synchronize application data

The UI must disclose this when the generated app stores user-entered data. The
V1 recipe must add JSON export/import whenever user data persists. Export/import
is application functionality rather than a Rudder-managed database or backup.

A later phase may add a single-process local backend with SQLite, explicit data
location, backup, migration, and recovery contracts. That phase should not be
smuggled into the V1 frontend recipe.

## Security And Trust Requirements

- V1 is available only in packaged macOS Rudder Desktop `local_trusted` mode.
- Only supported local runtimes with access to the selected workspace may run
  the builder.
- Long-lived processes use the existing reviewed Desktop Local App definition,
  structured executable/argv, loopback port allocation, listener ownership
  attestation, process-group cleanup, and isolated Browser partition.
- Generated code is untrusted local code. The trust review must say that it can
  read or modify files and data available to its process and inherited
  environment.
- Environment variable inheritance is deny-by-default except for the minimal
  runtime baseline and explicitly reviewed names. Values never appear in the
  renderer, Chat, transcript, or Server database.
- The recipe must not bind `0.0.0.0`, `::`, a LAN interface, or a stable public
  port.
- Loopback is not an authentication boundary. The random port and isolated
  Browser partition do not justify exposing secrets to the app.
- Package manager lifecycle scripts execute local code. The build run and trust
  copy in the `Build an app` confirmation must disclose dependency installation
  before it occurs.
- Rudder must not claim that the app is sandboxed from the host filesystem.
- App navigation must remain on the attested origin; external destinations open
  without retaining Local App authority.
- No cloud credentials, deployment tokens, tunnels, or remote publishing APIs
  are requested or generated by this workflow.

## Non-Functional Requirements

### Performance

- On a supported machine with dependencies already cached, median time from an
  accepted brief to first preview readiness should be under five minutes.
- Preview state changes should appear in the work surface within one second.
- Source edits should reach the open preview through HMR without a full Rudder
  page reload.

### Reliability

- One definition has at most one running generation.
- Start is single-flight and idempotent for repeated UI actions.
- A failed build cannot be presented as preview-ready.
- A failed preview cannot erase source or build evidence.
- Stop and Desktop quit must prove the owned process group is dead or surface an
  actionable failure.

### Usability

- A user can complete the first app without typing a command, port, readiness
  path, or framework name.
- Advanced runtime details are available in the trust review but do not dominate
  normal iteration.
- Every state has one clear next action.
- Local-only, network-connected, browser-local data, and non-durable URL
  semantics use plain language.

### Accessibility

- Builder status changes use live-region semantics without stealing focus.
- Preview actions are keyboard reachable and have stateful accessible names.
- The app preview remains usable at narrow Side Panel and wide Main widths.
- Generated apps must meet the existing Rudder browser-verification baseline
  for keyboard navigation, labels, contrast, and responsive layout.

### Observability

- Build runs preserve normal transcript, tool, cost, and result evidence.
- Desktop logs process lifecycle in bounded, redacted form.
- A new Desktop-to-Server evidence boundary may report idempotent
  organization/Project/App-binding events for definition reviewed, start
  requested, ready, stop requested, stopped, failed, verification requested,
  and accepted. Payloads contain event id, opaque binding id, safe state,
  timestamp, and actor only. They contain no definition fields, path, command,
  environment, PID, port, live URL, logs, or trust fingerprint.
- Existing Saved View mutations retain their current activity evidence.

## Success Metrics

Primary metric:

- weekly count of Local App Builder loops that reach a running, browser-verified
  preview and receive an accept or revision action

Supporting metrics:

- percentage of builder starts reaching first preview readiness
- median time from builder start to first preview
- percentage of previews requiring manual definition editing
- percentage of first previews that pass Browser verification
- revision loops per accepted app
- preview start failure rate by cause
- verified process cleanup success rate
- percentage of accepted apps reopened and explicitly restarted within 30 days

Guardrail metrics:

- unexpected non-loopback listeners: zero
- unreviewed process starts: zero
- Server-persisted Local App launch command, launch cwd, environment values,
  port, PID, and live URL: zero
- process ownership mismatches that still open a preview: zero

## Acceptance Criteria

### New App Happy Path

- From Chat, a user can create a Builder Project and workspace.
- A `claude_local`, `codex_local`, `opencode_local`, or `pi_local` agent with
  verified write access creates the V1 recipe and application.
- The maintained recipe fixture's `build`, `typecheck`, and `test` scripts each
  exit zero.
- The user reviews one structured Local App definition and starts it.
- Desktop proves the loopback listener belongs to the launched process tree.
- The app opens in the isolated Local App Browser guest.
- A verification continuation run opens the same attested generation through an
  opaque lease in a separate Agent Browser partition.
- The agent verifies the primary workflow and one compact-brief acceptance
  example representing an empty, invalid, or persisted-data state.
- Chat shows a current screenshot, an installation-aware `Open source` action,
  checks, and limitations. The Thread manifest does not invent a directory
  target.
- The screenshot is an Agent-owned Chat attachment or Run-backed Library file
  produced from the current successful build revision and runtime generation.
- When the app retains user-entered data, export produces a JSON file; after
  clearing or changing to a fresh Local App partition, import restores the
  exported records without access to the former partition.

### Revision

- A follow-up Chat request edits the same workspace.
- The open app updates through HMR without another trust review when the runtime
  definition is unchanged.
- User-visible changes receive a verification continuation or remain explicitly
  `running_unverified`.
- Changed runtime details invalidate trust and cannot start silently.

### Restart And Recovery

- Desktop restart leaves the source and Saved View intact but the runtime
  stopped.
- Reopening the Saved View does not execute anything.
- `Start & open` starts the unchanged trusted definition without dispatching an
  Agent Run; `Start, open & verify` dispatches a visible continuation after
  readiness.
- Failed readiness, unexpected listener ownership, and unverified orphan state
  never open a privileged Local App guest.

### Boundary

- No flow offers deploy, publish, share, tunnel, public URL, custom domain,
  remote database, or hosted authentication.
- Web and authenticated deployments show the Builder as unavailable rather
  than pretending they can control the Desktop host.
- Existing or multi-service projects show stable
  `builder_existing_project_unsupported` guidance to use ordinary coding work
  plus manual Local App configuration.

## Testing Plan

### Automated

- shared validators for builder intent, recipe metadata,
  opaque Local App references, and composed UI states
- Server tests for organization/Project/workspace scoping and activity evidence
- UI tests for entry, compact brief, trust review, states, actions, disclosures,
  and unavailable fallbacks
- Desktop tests for definition discovery, fingerprint invalidation, port/host
  injection, start single-flight, readiness, listener ownership, bounded logs,
  stop, quit, and orphan recovery
- agent procedure evals for ambiguous requirements, safe defaults, build
  failure, existing-project rejection, visual verification, and honest handoff
- E2E for the complete new-app flow and follow-up revision
- E2E for browser-local persistence plus clearing-data disclosure
- adversarial E2E for path escape, non-loopback bind, unexpected listener,
  changed definition, route restoration, and multiple open views
- packaged Desktop smoke with a repository fixture app

### Black-box Acceptance

Run the packaged Desktop product against a clean temporary Rudder instance:

1. create an organization and Builder Project
2. ask for a small tracker with persistent browser-local data
3. reach the trust review without typing development settings
4. start and use the real app
5. add data, reload, and confirm persistence
6. request a visible revision and confirm HMR
7. stop and prove the listener/process is gone
8. restart Desktop and prove the app remains stopped
9. explicitly restart and confirm source plus app-local data remain
10. export app data, clear or create a fresh Local App partition, import the
    JSON file, and confirm the records return
11. capture wide and narrow screenshots for review

The black-box verifier must also prove that the Agent verification tab cannot
see data created only in the operator Local App partition and that its screenshot
becomes a real attachment/artifact rather than remaining only in a tool result.

## Rollout

### Phase 0: Internal Recipe And Procedure

- create the maintained frontend recipe
- add the bundled Local App Builder procedure and evals
- reuse manual Local App trust/start
- validate with internal projects

### Phase 1: Guided Product Workflow

- add `Build an app` entry
- bind Chat, Project, Workspace, Build Run, Local App definition, and evidence
- add composed status and review block
- add real browser verification and screenshot handoff

### Phase 2: Adoption And Reopen

- adopt compatible existing single-process frontend projects
- improve Project discovery and app reopen
- add reliability and recovery telemetry

### Future Candidate: Local Full-stack

Consider one managed process containing frontend, local API, and SQLite only
after defining:

- application data location and ownership
- backup, export, restore, and delete behavior
- schema migration and rollback
- concurrency and corruption handling
- secrets and environment boundaries
- browser-to-local-API origin and request policy
- compatibility across macOS, Windows, and Linux

This is a separate product-logic proposal, not an implicit V1 extension.

## Dependencies

- organization workspace app-root selection and shared execution-workspace
  access
- organization workspace path validation and a subdirectory-safe Desktop
  launcher for `Open source`
- local agent runtime capable of editing the workspace
- Desktop Local Apps trust, process, readiness, attestation, and cleanup
- Rudder Browser for real preview inspection
- organization workspace plus the opaque Project/App binding for source identity
- Chat Thread manifest plus materialized Chat/Library artifacts for evidence
- Messenger Side Panel/Main and Saved Views for keeping the preview near work

## Risks And Mitigations

### “Local” is misunderstood as “sandboxed”

Mitigation: use explicit copy that generated code and dependencies run on the
computer with the reviewed process access. Never use a sandbox claim.

### Framework breadth destroys reliability

Mitigation: maintain one V1 recipe and reject existing-project adoption in V1.
Keep framework-specific logic in the recipe/procedure, not the core process
manager.

### Browser-local data is mistaken for backed-up project data

Mitigation: show a data-location disclosure and keep backup claims out of V1.
Require JSON export/import whenever the app retains user-entered data.

### Agent claims success after build only

Mitigation: require readiness, real Browser exercise, edge-case verification,
and screenshot evidence before completion.

### Restored work starts code unexpectedly

Mitigation: preserve the existing explicit `Start & open` invariant. Restore
only the source, view identity, and stopped state.

### The feature becomes a hidden cloud product roadmap

Mitigation: enforce the boundary in UI copy, acceptance tests, and product
contracts. Do not add deploy-shaped abstractions to the V1 data model.

## Product Logic Impact

This proposal does not edit the guarded Product Logic Registry. If approved for
implementation, the likely affected current contracts are:

- `WORKSPACE.PROJECT.001`
- `WORKSPACE.RUN.001`
- `LIBRARY.FILES.001`
- `LIBRARY.WEB.PREVIEW.001` only to clarify its static-artifact boundary
- `CHAT.THREAD.MANIFEST.001`
- `CHAT.SIDE.PANEL.001`
- `MESSENGER.SAVED.VIEWS.001`
- `AGENT.BROWSER.001`
- `DESKTOP.LOCAL.APPS.001`

The implementation will likely require a new logic contract, tentatively
`WORKSPACE.LOCAL.APP.BUILDER.001`, for the end-to-end builder workflow,
trust/start boundary, durable versus ephemeral evidence, and completion rule.

`LIBRARY.WEB.PREVIEW.001` remains the static/multi-file artifact preview and
evidence fallback. It does not serve the framework development process, supply
SPA history fallback, or replace Desktop Local Apps.

Explicit user authorization is required before changing `doc/product/**`.

## Documentation Changes If Approved

- add the new Product Logic Contract and registry/surface mappings after
  explicit authorization
- update Desktop and developing documentation for the Builder runtime boundary
- add user-facing documentation for build, preview, local data, restart, and
  source ownership
- add or update bundled-skill references alongside the builder procedure

## Open Issues For Product Discussion

The proposal recommends answers for the major V1 choices. The following points
should be confirmed before implementation:

1. **V1 persistence** — accept browser-local persistence with explicit export
   and backup limitations, or expand V1 into a local full-stack/SQLite product.
   Recommendation: keep browser-local persistence in V1.
2. **Preview start** — retain one explicit trust review with
   `Start, open & verify` / `Start & open`, or treat the original
   `Build an app` request as authority to auto-start the first reviewed recipe.
   Recommendation: retain the explicit first start.
3. **Product surface** — keep Chat + Project as the only V1 entry, or add a
   dedicated `Apps` navigation surface immediately. Recommendation: no new
   top-level surface until usage proves the need.
4. **Default recipe** — React + TypeScript + Vite, or another maintained single
   recipe. Recommendation: React + TypeScript + Vite because it fits the
   existing single-process preview boundary and conventional local tooling.
