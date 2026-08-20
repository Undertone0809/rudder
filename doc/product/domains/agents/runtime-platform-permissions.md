---
title: Runtime Platform Permissions
domain: agents
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - AGENT.RUNTIME.PERMISSIONS.001
related_code:
  - packages/agent-runtime-utils/src/rudder-mcp.ts
  - packages/agent-runtime-utils/src/server-utils.cli.ts
  - packages/shared/src/types/mcp.ts
  - packages/shared/src/validators/mcp.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/cursor-local/src/server/execute.ts
  - packages/agent-runtimes/gemini-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/managed-workspace-preflight.ts
  - server/src/services/mcp/managed-client.ts
  - server/src/services/mcp/managed-connections.ts
  - server/src/services/mcp/managed-runtime.ts
  - server/src/services/mcp/oauth.ts
  - server/src/services/mcp/oauth-provider.ts
  - server/src/services/mcp/provider-registry.ts
  - server/src/routes/managed-mcp-connections.ts
  - desktop/src/main.ts
  - desktop/src/navigation-guard.ts
  - desktop/src/preload.ts
  - desktop/src/system-permissions.ts
  - ui/src/lib/desktop-shell.ts
  - ui/src/pages/InstanceNotificationsSettings.tsx
  - desktop/scripts/after-pack.mjs
related_tests:
  - packages/agent-runtime-utils/src/server-utils.test.ts
  - packages/shared/src/validators/mcp.test.ts
  - scripts/managed-mcp-product-contract.test.mjs
  - server/src/__tests__/managed-mcp-connections-service.test.ts
  - server/src/__tests__/managed-mcp-runtime-routes.test.ts
  - server/src/__tests__/managed-mcp-oauth-service.test.ts
  - server/src/services/mcp/managed-mcp-oauth-provider.test.ts
  - server/src/services/mcp/provider-registry.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - server/src/__tests__/claude-local-execute.test.ts
  - server/src/__tests__/cursor-local-execute.test.ts
  - server/src/__tests__/gemini-local-execute.test.ts
  - server/src/__tests__/opencode-local-execute.test.ts
  - server/src/__tests__/pi-local-execute.test.ts
  - server/src/__tests__/managed-workspace-preflight.test.ts
  - server/src/__tests__/agent-run-context.test.ts
  - desktop/src/navigation-guard.test.ts
  - desktop/src/preload.browser.test.ts
  - desktop/src/system-permissions.test.ts
  - ui/src/pages/InstanceNotificationsSettings.test.tsx
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-06-21-product-logic-registry.md
  - doc/plans/2026-06-26-local-runtime-operator-home-default.md
  - doc/plans/2026-07-12-built-in-browser.md
  - doc/plans/2026-07-23-managed-mcp-oauth-integrations.md
  - doc/plans/2026-07-25-managed-mcp-access-and-interactions.md
  - doc/plans/2026-08-07-github-managed-mcp.md
  - doc/plans/2026-08-07-github-mcp-pat.md
  - doc/plans/2026-07-24-org-skill-runtime-materialization-fix.md
edit_policy: user_confirmed_only
---

# Runtime Platform Permissions

## AGENT.RUNTIME.PERMISSIONS.001

## Contract Summary

Local runtime adapters must treat operating-system permissions and filesystem
capabilities as part of the agent runtime contract. A supported runtime should
not fail because Rudder assumed a Unix-only filesystem behavior on Windows, or
because an adapter silently mixed the managed runtime home with the operator's
credential home.

Rudder must normalize platform differences before invoking the provider, record
recoverable permission substitutions, and surface non-recoverable permission
failures as operator-actionable errors.

## Intent / User Job

Operators expect a Rudder agent configured on macOS, Linux, or Windows to run
with the same product semantics: the child process uses the operator's normal
local home by default, while Rudder keeps provider-specific runtime state,
selected skills, sessions, and temporary files under adapter-owned managed
state. They should not need to know whether a provider adapter uses symlinks,
junctions, copied directories, provider home variables, temporary homes, or
prompt injection unless a repair action is required.

## Why / Design Reasoning

Rudder local runtimes cross two boundaries at the same time:

- the product boundary between the agent's managed workspace and the human
  operator's host machine
- the platform boundary between POSIX filesystems and Windows filesystem
  permissions

The current design favors operator-home process execution for local trusted
runtimes, with provider-owned state split into explicit adapter variables such
as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, or
`PI_CODING_AGENT_*`. That lets local commands see the same package managers,
editor state, shell config, and authenticated host CLIs the operator normally
uses, without copying broad credential and tooling directories into a Rudder
managed home. The tradeoff is that skills, provider config, sessions, and
temporary runtime material must be materialized separately and
platform-aware.

The key platform rule is that Windows directory symlink creation can require
Developer Mode or elevated privileges. Rudder must not make ordinary Windows
users run the product as administrator just to load skills or share read-only
credential entries. When a runtime needs directory indirection on Windows, the
preferred behavior is a platform-safe substitute such as a directory junction
or copied directory. If a substitute is impossible or unsafe, the run should
produce a clear permission/configuration error before provider execution.

Built-in Browser adds a separate host-data boundary. Supported local runtimes
may receive a managed capability flag and high-level Browser tools, but they do
not receive the Browser profile path, cookies, Desktop Broker credential, or
permission to discover Browser state from the operator home. The shared website
profile belongs to Desktop, not to adapter-managed runtime state.

Managed external MCP adds distinct OAuth token, runtime identity, network,
STDIO process, and environment variable boundaries. Provider tokens and
temporary OAuth material remain encrypted on the Rudder server. GitHub uses the
same server-side OAuth grant boundary: the server-configured GitHub OAuth App
client starts the official PKCE flow, exchanges the callback code, and injects
the resulting provider credential only at the upstream proxy. A runtime
receives only a run-scoped proxy identity and provider-neutral tool descriptors;
it never receives provider access/refresh tokens, client secrets, PKCE
verifiers, or organization secret identifiers. Organization and Agent
connections for the same provider have independent grants. Runtime source
resolution selects the owner Agent's non-revoked connection before the
Organization connection; explicit `No access` blocks fallback, while
revocation restores an available Organization source.
The runtime authorization boundary also includes a persisted run-start policy
snapshot. Current binding and provider policy can immediately reduce that
snapshot, while permission increases wait for the next run.

A Codex Plugin manifest is package metadata, not runtime permission authority.
Plugin inspection starts no process and contacts no endpoint. A Plugin-provided
Skill reaches a Run only through normal Agent selection and current Plugin
enablement; a Plugin-provided MCP definition reaches a Run only after managed
connection policy, credentials, activation, and Agent access have succeeded.

Rudder Account authentication is an independent admission predicate. A valid
user or Local Server session identifies who may access data; it does not grant
Desktop Bridge, Browser, filesystem, IDE, Local App, or runtime capability.
Authenticated Desktop retains only the local capabilities proven by its
Desktop context, attestation, settings, and run-scoped authorization. An
ordinary authenticated browser receives none of those capabilities merely
because it represents the same user.

## Actors / Objects / State

- Operator: the human whose machine, local CLIs, provider credentials, and
  filesystem permissions host the local runtime.
- Runtime agent: the adapter-invoked process running as the selected Rudder
  agent.
- Adapter-managed runtime state: Rudder-created adapter state for an adapter,
  such as managed Codex, Claude, Cursor, Gemini, OpenCode, or Pi config,
  selected skills, narrow provider-native auth/session materialization,
  isolated Git policy files, sessions, and temporary runtime files.
- Operator home: the host user's real home. Local trusted runtime child
  processes use this as `HOME` and `USERPROFILE` by default, and Rudder also
  exposes it as `RUDDER_OPERATOR_HOME` for explicit boundary visibility.
- Skill source directory: bundled, organization, global/user, or agent-home
  skill directory selected for a run.
- Materialized skill directory: the provider-visible skill location created by
  symlink, junction, copy, native config, prompt injection, or another
  adapter-specific mechanism.
- Credential bridge: a legacy or explicit managed-state entry, shell shim, git
  config, or env var that lets a local CLI use operator authenticated state
  when the child process is not already running with operator `HOME`.
- Platform capability: filesystem and process capability that differs by OS,
  including symlink privileges, path syntax, case behavior, home variables,
  executable lookup, process termination, and installer/package copying.
- Browser capability input: Rudder-owned enabled state projected as managed
  runtime environment/config for supported `local_trusted` adapters.
- Agent Browser lease: Desktop-owned, in-memory tab control scoped to the
  authenticated organization, agent, run, and tab, independent of child
  process filesystem access.
- External MCP grant: organization credential boundary associated with the
  authorizing Rudder user and provider subject/scope, but distinct from both
  identities.
- External MCP proxy identity: short-lived run-scoped authorization used only
  between the runtime adapter and Rudder's proxy.
- Custom MCP process/network target: operator-supplied STDIO command or
  Streamable HTTP endpoint validated against the active deployment mode and
  administrator policy before discovery or dispatch.
- Desktop shell: the privileged local bridge that reports macOS runtime
  permission status and opens fixed operating-system permission panes.
- Desktop permission id: one of the fixed `fullDiskAccess`, `accessibility`, or
  `automation` identifiers accepted by the dedicated settings bridge.

## Entry Points / Inputs

- Local adapter execution for Claude, Codex, Cursor, Gemini, OpenCode, and Pi.
- Adapter environment tests and model/listing probes.
- Runtime skill sync, skill listing, or temporary provider skill-home creation.
- Managed workspace preflight for agent home, instructions, memory, life, and
  skills directories.
- Explicit local CLI credential bridging for legacy or non-default runtime
  modes that do not run the child process with operator `HOME`.
- Desktop packaging and update flows that copy app resources across platforms.
- Environment inputs including `HOME`, `USERPROFILE`, `RUDDER_HOME`,
  `RUDDER_OPERATOR_HOME`, provider-specific home variables,
  `RUDDER_BROWSER_ENABLED`, and `PATH`/`Path`.
- Managed external MCP binding assembly and every proxied discovery or tool
  dispatch.
- Desktop system-permissions settings surface, including local permission
  status display and `Open settings` actions.
- Desktop bridge requests for `desktop:get-system-permissions` and
  `desktop:open-system-permission-settings`.

## Product Logic Flow

1. Before invoking a local runtime, Rudder resolves the effective workspace cwd
   and verifies that required managed workspace directories exist, are
   directories, and are writable.

2. Rudder resolves two distinct homes: the operator home used as the default
   child `HOME`/`USERPROFILE` for local trusted adapters, and the
   adapter-managed runtime state used only for adapter-owned config, selected
   skills, narrow provider-native auth/session materialization, isolated Git
   policy files, sessions, and temporary files. `RUDDER_OPERATOR_HOME` records
   the operator boundary when exposed to the child process.

3. Rudder prepares the child environment with platform-correct home variables.
   For local trusted adapters, `HOME` and `USERPROFILE` default to the
   operator home. Provider-specific home variables may point at
   adapter-managed runtime state. On all platforms, `PATH`/`Path` lookup must
   preserve command resolution. For supported Browser-capable local adapters,
   Rudder sets or removes `RUDDER_BROWSER_ENABLED` from trusted run context
   after user environment merging; agent or user config cannot override it.

4. Rudder resolves selected runtime skills to stable installed source
   directories. A normal invocation may validate a missing legacy installation,
   but it must not destructively rebuild, rewrite, or redownload an already
   installed organization skill. Chat list/detail loading resolves skill
   metadata only and does not perform filesystem or network materialization.

5. Rudder exposes those installed sources using an adapter-supported mechanism:
   native provider config, symlink, directory junction, copied directory,
   prompt-injected skill text, or another explicit strategy. Materialization is
   a runtime implementation detail, but the product result is that selected
   skills are available to the provider or clearly reported as unavailable. The
   adapter mechanism must not broaden the selected set with provider-native,
   operator-home, project, global, or stale managed skills.

6. Before provider execution, Rudder prunes, disables, isolates, or ignores
   stale Rudder-managed and provider-native skills that are not in the current
   selected set.

7. When materialization depends on filesystem indirection, Rudder must choose a
   platform-safe method. POSIX symlinks are acceptable on macOS/Linux. Windows
   directory symlinks must not be the only path for ordinary users because they
   may require Developer Mode or elevation; junction or copy fallback is the
   expected durable strategy for directory skill materialization.

8. Rudder must not copy, symlink, or recreate broad operator-home credential
   and tooling entries into adapter-managed runtime state by default. Entries
   such as `.git-credentials`, `.npmrc`, `.npm`, `.ssh`, `.config/gh`,
   `.docker`, `.kube`, and `.vscode` remain in the operator home and are
   available because the child process already uses operator `HOME`. Explicit
   credential bridges or command-specific shims are reserved for legacy or
   non-default modes. Adapter setup must prune legacy generic credential bridge
   symlinks or empty placeholders from adapter-managed runtime state when it
   prepares that state.

9. Narrow provider-native auth/session materialization remains allowed when an
   adapter needs provider-specific state outside child `HOME`, such as
   Claude/Anthropic auth directories, Gemini auth files, OpenCode cache/session
   state, or Pi profile files. This must stay adapter-specific and must not
   become a broad local CLI/tooling bridge.

10. If a platform limitation is recoverable, Rudder records the substitution or
   skip in logs, command notes, adapter metadata, or skill sync evidence. The
   run may continue when the selected skill/credential behavior still matches
   the product contract.

11. If the limitation prevents required runtime startup, workspace access,
   credential access, or skill availability, Rudder fails before or during
   adapter invocation with a clear error code/message that tells the operator
   what permission, path, login, or configuration needs repair.

12. Provider OAuth access tokens, refresh tokens, client secrets, PKCE
    verifiers, and temporary dynamic-client metadata stay in encrypted
    organization secrets. They are never written into prompts, tool arguments,
    adapter config, command lines, child environment variables, or audit
    outcomes. GitHub authorization requires the configured
    `GITHUB_MCP_CLIENT_ID` and `GITHUB_MCP_CLIENT_SECRET`, uses the registered
    `/api/mcp/oauth/callback`, and is exchanged server-side. Read-only GitHub
    authorization is pinned to the least-privilege `read:org`, `read:user`,
    `user:email`, `read:packages`, and `read:project` scope set rather than
    inheriting provider metadata; no GitHub PAT mutation path exists.

    Reauthorization is a two-phase replacement. Rudder retains the prior usable
    grant while the new OAuth session is pending and atomically swaps credentials
    only after successful callback and tool validation. Cancellation, provider
    denial, malformed or stale callback, timeout, or discovery failure must not
    revoke the prior grant; explicit Disconnect is the immediate-stop action.

13. Runtime adapters receive a provider-neutral, run-scoped external MCP proxy
    binding containing only binding id, proxy server name, server-derived tool
    policy, policy revision, required behavior, startup timeout, and tool
    timeout. The
    fixed Rudder proxy URL and run-owned authorization are derived outside the
    binding array. The runtime identity authorizes only the selected
    organization, agent, run, connection, binding, and enabled tools; it does
    not become the provider OAuth identity.

    Rudder persists the run-start policy snapshot. Both `tools/list` and
    `tools/call` enforce the intersection of that snapshot, the current binding,
    and current provider policy. Reductions take effect for subsequent calls in
    the active run; increases wait until a new run. Permission update and run
    dispatch use one revision/locking order so a race cannot widen a snapshot.

    For an official provider, Rudder first resolves a usable Agent-owned
    connection for the exact runtime Agent, then an Organization connection.
    The chosen connection id determines the only grant and encrypted credential
    that dispatch may use. An Agent-owned connection with a disabled binding is
    an explicit deny and does not authorize fallback. Revoked or disconnected
    Agent connections no longer shadow an available Organization connection.
    Named Custom MCP connections do not shadow across scopes.

14. Arbitrary custom STDIO execution is permitted only in `local_trusted`.
    Authenticated deployments require instance-administrator allowlists for
    commands, executable paths, working directories, and environment variable
    names. Sensitive environment values remain server-side encrypted; allowed
    safe values and environment references must not broaden inherited host
    environment access.

15. Custom Streamable HTTP permits public HTTPS targets by default. HTTP,
    loopback, private-network, redirect, and OAuth metadata targets require
    deployment-administrator allowlists. Resolution and redirect handling must
    resist DNS rebinding, and authorization, cookie, proxy authorization, API
    key, host, and other unsafe headers cannot be smuggled through non-secret
    config. Safe config may retain non-sensitive static headers and
    header-name-to-environment-name mappings, but secret header, environment,
    and Bearer values enter only through mutation-only encrypted input. Manual
    Authorization header, Bearer environment, and direct Bearer sources are
    mutually exclusive.

16. Every discovery and dispatch revalidates the current deployment boundary.
    Required connections fail the run with safe actionable evidence when
    unavailable; optional connections may be omitted or reported without
    exposing credentials or target-internal response data.

17. Rudder Desktop exposes host permission status for Full Disk Access,
    Accessibility, Automation, and Notifications on the system permissions
    settings surface. The Desktop shell reports Full Disk Access,
    Accessibility, and Automation status; the renderer reads Notifications
    status from the platform notification API. The OS remains the source of
    truth, and the UI must not imply that Rudder can grant a permission. On
    macOS, the Full Disk Access, Accessibility, and Automation actions send
    symbolic permission ids through a dedicated Desktop bridge. The main
    process maps only those known ids to fixed macOS System Settings targets
    before opening them. The generic external-link bridge remains restricted
    to its existing safe web/mail protocols, and macOS-only permission actions
    are hidden on non-macOS Desktop platforms.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| POSIX skill directory indirection | Runtime materializes a selected skill on macOS/Linux | Symlink or native provider config may expose the skill | Product code must not assume the materialized path is a physical copy | Skill sync metadata, adapter command notes, provider-visible skill home |
| Windows selected directory skill | Runtime materializes a directory skill on Windows | Use a Windows-safe mechanism such as junction or copy fallback when native provider config is not available | Ordinary run must not fail only because `fs.symlink` needs elevated Windows privileges | Runtime logs, skill sync result, known gap until all adapter paths implement fallback |
| Windows symlink privilege unavailable | `fs.symlink` returns `EPERM` for a recoverable directory materialization | Fallback strategy should preserve selected skill availability or report the skill as unavailable with actionable error text | Error must not be exposed as an unexplained provider failure or require admin as the only product path | Adapter error code/message and command notes |
| Stale previously selected skill | A prior run materialized a skill that is now disabled or absent from the selected set | Provider execution starts with that skill removed, disabled, isolated, or ignored | Previously enabled skills must not remain provider-visible because they were left in a managed skill home | Execute-level adapter tests, skill sync metadata, loaded-skill metadata |
| Managed workspace missing or unwritable | Agent home/instructions/memory/life/skills path cannot be created or write-probed | Workspace preflight fails with a repair-needed error before provider execution | Provider must not start with a broken managed workspace and produce opaque downstream errors | `workspace_permission_repair_needed`, managed workspace preflight tests |
| Local trusted runtime child home | Adapter invokes Codex, Claude, Cursor, Gemini, OpenCode, or Pi locally | `HOME` and `USERPROFILE` default to the operator home, with `RUDDER_OPERATOR_HOME` matching that value | Adapter must not use adapter-managed runtime state as child `HOME` by default | Execute-level adapter env tests and command metadata |
| Adapter-managed runtime state isolation | Adapter needs provider config, selected skills, narrow provider-native auth/session state, isolated Git policy, sessions, or temp files | Use explicit provider variables or adapter-owned paths such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `OPENCODE_CONFIG`, OpenCode XDG state, `PI_CODING_AGENT_*`, or managed prompt sidecars | Adapter-managed state must not require copying broad operator-home dotfiles into managed state | Adapter tests for provider variables and managed skill/config dirs |
| Operator credential or tooling entry exists | `.npmrc`, `.npm`, `.ssh`, `.config/gh`, `.git-credentials`, `.vscode`, or similar exists in operator home | Leave it in operator home; local commands see it through child `HOME`; prune legacy generic bridge symlinks from adapter-managed runtime state | Default runtime setup must not copy, symlink, or recreate broad operator-home entries in adapter-managed runtime state | Negative execute tests for adapter-managed runtime state |
| Explicit non-default credential bridge | A legacy or non-default mode cannot use operator `HOME` as child home | Bridge only selected entries or use command shims; preserve managed-state boundaries and logs | Bridge must not become the default for local trusted adapters | Credential bridge utility tests and adapter-specific opt-in evidence |
| Windows home environment | Runtime sets child process home on Windows | `HOME`, `USERPROFILE`, and provider-specific home variables match the selected managed/operator-home semantics | Child process must not read credentials from a different home because only one variable was updated | Adapter env construction tests and command metadata |
| Desktop resource packaging | Packaged app copies resources on Windows | Packaging may dereference symlinks into real files/directories | Runtime skill injection must not assume packaging fallback also protects run-time temp dirs | Desktop packaging code and separate runtime adapter tests |
| Built-in Browser enabled for supported local adapter | Trusted run context enables Browser | Managed MCP/native config receives only the capability flag and runtime-owned tool identity | Adapter must not receive Browser profile paths, cookies, Broker credentials, or an agent-overridable enable flag | Adapter execute and run-context tests |
| Browser disabled or runtime unsupported | Live setting is off, runtime is remote, or no secure managed tool path exists | Remove the managed Browser flag/tools or report capability unavailable | Inherited env or user MCP config must not expose stale Browser control | Negative adapter and MCP manifest tests |
| Managed provider OAuth grant | Connection is active for the organization and agent | Runtime gets a run-scoped proxy identity; Rudder injects provider credentials server-side per call | OAuth tokens or secret ids must not enter adapter config, prompts, arguments, logs, or model-visible errors | Proxy authorization and secret-redaction tests |
| GitHub OAuth authorization | GitHub connection targets the fixed account-scoped MCP endpoint and server configuration provides the OAuth App client plus registered callback | Rudder creates a one-time PKCE session with an access-mode-specific scope set, redirects to GitHub, consumes the callback once, validates the grant, and persists connected state | UI must not accept a PAT; read-only must not inherit broad provider scopes; cancellation, provider failure, malformed/replayed callback, or duplicate start must not report success or activate a new grant | GitHub OAuth provider, scope-policy, route, validator, UI, and E2E tests |
| Agent and Organization grants exist for one official provider | Agent connection is non-revoked and belongs to the runtime Agent | Resolve the Agent connection and inject only its connection-bound credential | Organization credentials and another Agent's credentials must not be read or used as fallback | Scope-priority, owner-boundary, and credential-isolation tests |
| Agent connection binding is `No access` | Agent connection remains non-revoked | Expose no provider tools and retain explicit disabled state | Runtime must not silently fall back to Organization | Binding source-resolution tests |
| Agent connection is revoked or disconnected | Organization connection and binding remain usable | Resolve the Organization connection on the next runtime projection | Revoked Agent credentials must never be used | Revocation fallback tests |
| Reauthorization is cancelled, expires, or fails | Existing usable grant remains active and the replacement session records failure | Pending replacement must not revoke the current grant or interrupt every bound Agent | OAuth replacement race and stale-callback tests |
| Operator explicitly disconnects provider | Current grant is revoked and subsequent proxy calls stop | Disconnect must not be treated as a recoverable reauthorization attempt | Disconnect and proxy rejection tests |
| Agent access is reduced during an active run | Later external MCP list/call checks apply the reduction immediately | The run-start snapshot must not preserve revoked write access | Run policy snapshot and direct-call rejection tests |
| Agent access is increased during an active run | Increase is deferred until the next run snapshot | A long-lived run must not gain new authority mid-run | Run policy snapshot tests |
| Custom STDIO in `local_trusted` | Operator config passes validation | Rudder may launch the configured command with bounded args, cwd, environment, timeouts, output, and cleanup | Child process must not inherit unselected secret environment or outlive required cleanup | Process allowlist, isolation, timeout, and cleanup tests |
| Custom STDIO in authenticated deployment | Command/path/env is not instance-admin allowlisted | Discovery and dispatch are rejected with a policy error | Organization managers must not bypass deployment-admin process policy | Authenticated deployment negative tests |
| Public HTTPS Streamable HTTP target | URL and resolved addresses remain public and headers are safe | Discovery/dispatch may proceed through the managed client | Redirects or DNS changes must not pivot into private/loopback targets | SSRF, redirect, and DNS rebinding tests |
| Private, loopback, HTTP, redirect, or OAuth metadata target | Deployment-admin allowlist is absent | Target is rejected before credential use | Credentials must not be sent while evaluating or reporting the blocked target | Network policy and credential non-disclosure tests |
| Desktop macOS permission action | Operator selects Full Disk Access, Accessibility, or Automation in Desktop settings on macOS | Dedicated bridge maps the known permission id to the matching fixed System Settings pane and opens it | Renderer-supplied arbitrary protocols must not reach the generic external-link path or be treated as a successful permission grant | Desktop permission, preload, navigation-guard, UI, and packaged smoke tests |
| Desktop non-macOS permission action | Operator views the system permissions page outside macOS | Show current supported/unsupported status without macOS-specific permission buttons | UI must not offer `x-apple.systempreferences:` actions on platforms that cannot use them | UI platform-visibility test |
| Invalid Desktop permission target | Renderer or stale UI sends an unknown permission id, or the dedicated bridge is used outside macOS | Reject the request with a safe error and do not open an external target | Unknown ids must not be interpolated into an OS URL or bypass the current-frame and platform checks | Main-process validation path, system-permission mapping tests, and packaged smoke coverage; direct negative IPC coverage remains a known gap |

## Actor-Visible Input

The runtime agent does not need to know the low-level filesystem strategy.
Actor-visible input is the resulting provider environment:

- selected skills are available through the adapter's skill mechanism, prompt
  context, or provider-visible skill directory
- discovered-only, disabled, stale, provider-default, and operator-home skills
  are absent from the loaded skill set unless Rudder selected them for the
  current invocation
- provider-native built-ins that cannot be disabled by the provider remain
  classified as provider-native behavior, not Rudder-loaded skills; the run
  must expose a Rudder skill boundary so the agent does not report those
  built-ins as enabled Agent Skills
- `HOME` and `USERPROFILE` default to the operator home for local trusted
  adapters; provider home variables reflect separate adapter-managed runtime
  state isolation
- Rudder API env vars and local auth credentials are available only through
  operator `HOME`, explicit env, or an adapter-supported adapter-managed
  runtime state path
- cwd and workspace paths point at the verified execution workspace, fallback
  workspace, or agent home chosen for the run
- when Browser is enabled for a supported local run, managed config exposes the
  conditional Browser skill/tools without exposing profile storage, cookies,
  Keychain material, or Desktop Broker credentials
- Desktop system-permission status is reported from the local shell; the UI
  distinguishes authorized, needs-access, and unsupported states without
  claiming to change the OS grant itself
- On macOS Desktop, a permission action identifies one of the fixed Full Disk
  Access, Accessibility, or Automation panes; on non-macOS Desktop, those
  macOS-specific actions are not presented

If a required permission cannot be repaired or substituted, the actor should
not receive a normal work prompt. The run should fail with configuration or
permission evidence instead of asking the model to diagnose host filesystem
state.

## Operator-Visible Output

Operators and reviewers should be able to see:

- managed workspace preflight failures with the path and repair instruction
- adapter auth-required, command-not-found, permission-denied, or
  materialization-failed errors when a local runtime cannot start correctly
- logs or command notes for adapter-managed runtime state preparation,
  workspace fallback, explicit credential bridges or command shims when a
  non-default mode uses them, and skill materialization warnings
- run result/transcript metadata that separates provider failure from Rudder
  runtime setup failure
- Desktop permission status responses and action failures are available to the
  settings surface for the current local shell; the OS remains the authority
  for the actual grant and no permission grant is persisted as Rudder-owned
  runtime state
- Preload, main-process, UI, navigation-guard, and packaged smoke evidence
  proves that known macOS permission ids open the intended pane without
  allowing arbitrary protocols

User-facing guidance may recommend enabling Windows Developer Mode as a manual
workaround, but the durable product contract is platform-safe fallback for
recoverable directory materialization.

## Persisted Evidence

Evidence can include:

- heartbeat run context snapshot with workspace and runtime-home facts
- adapter invocation metadata with cwd, command, env-derived notes, prompt
  metrics, loaded/realized skill facts, and command notes
- run logs recording workspace preflight, adapter-managed runtime state
  preparation, explicit credential bridge/shim use, or materialization actions
- skill sync/listing results for created, repaired, skipped, failed, desired,
  realized, native, or prompt-injected skills
- managed workspace preflight error code/message when a path is not writable
- test coverage for operator-home defaults, adapter-managed runtime state
  isolation, absence of default broad credential/tooling bridges, legacy
  generic bridge pruning, symlink repair, and adapter-specific local runtime
  execution
- trusted run-context and adapter evidence for conditional Browser capability
  projection; Browser profile contents and Broker credentials are deliberately
  absent from persisted runtime evidence

## Canonical Scenarios

1. Claude local loads bundled skills on Windows:
   - Trigger: agent run selects Claude local with a bundled runtime skill.
   - Expected state/action: Rudder materializes the selected skill into the
     provider-visible temporary skill home using a Windows-safe strategy.
   - Visible output: run starts normally, or fails with an actionable
     materialization error naming the skill/path.
   - Evidence: adapter logs/metadata show the materialized skill result.

2. Codex local uses operator `HOME` plus managed `CODEX_HOME`:
   - Trigger: Codex local run starts with a managed `CODEX_HOME` and selected
     workspace cwd.
   - Expected state/action: Rudder keeps child `HOME` on the operator home and
     isolates provider-owned Codex state in `CODEX_HOME`.
   - Visible output: agent receives Rudder instructions and workspace context,
     not an unbounded copy of the operator home.
   - Evidence: command notes and tests show operator `HOME`, managed
     `CODEX_HOME`, selected skills, and cwd selection.

3. Claude local uses operator `HOME` plus managed Claude config:
   - Trigger: Claude local run starts with selected Rudder skills.
   - Expected state/action: Rudder sets child `HOME`/`USERPROFILE` to the
     operator home, points `CLAUDE_CONFIG_DIR` at adapter-managed runtime
     state, and passes selected skills through Claude's adapter mechanism.
   - Visible output: agent sees Rudder-selected skills and can run local CLIs
     against the operator's normal home.
   - Evidence: execute tests show operator `HOME`, managed `CLAUDE_CONFIG_DIR`,
     and no default `.npmrc`, `.ssh`, `.config/gh`, or `.vscode` bridge.

4. Managed workspace permission failure:
   - Trigger: `AGENT_HOME/skills` or another required managed directory is a
     file, missing without create permission, or not writable.
   - Expected state/action: preflight fails before provider execution.
   - Visible output: operator sees a repair-needed permission/configuration
     message.
   - Evidence: workspace preflight test and run error metadata.

5. Browser capability cannot be forged:
   - Trigger: agent config or inherited user environment sets
     `RUDDER_BROWSER_ENABLED` while the instance capability is disabled.
   - Expected state/action: Rudder removes or overwrites the value after merge
     and does not expose Browser tools; live calls remain rejected.
   - Visible output: no Browser tool surface or a stable disabled error.
   - Evidence: run-context, adapter, and MCP manifest negative tests.

6. macOS operator repairs a missing permission:
   - Trigger: Desktop reports Full Disk Access, Accessibility, or Automation as
     needing access and the operator selects `Open settings`.
   - Expected state/action: the dedicated Desktop bridge resolves the selected
     permission id to its fixed macOS System Settings pane and opens that pane.
   - Visible output: the settings surface remains available without the
     generic “URL protocol cannot be opened from Rudder” error.
   - Evidence: UI, preload, main-process mapping, and packaged Desktop smoke
     coverage.

7. Non-macOS operator views system permissions:
   - Trigger: Desktop renders the same settings surface on Windows or Linux.
   - Expected state/action: Rudder reports the platform-supported status and
     hides macOS-specific permission actions.
   - Visible output: operators are not offered unusable `x-apple` settings
     links.
   - Evidence: platform-visibility UI test and system-permission status tests.

## Invariants / Non-Goals

- Platform-specific filesystem operations must be hidden behind runtime
  materialization helpers or adapter-owned setup, not scattered as unchecked
  assumptions.
- Windows users must not be required to run Rudder as administrator for
  recoverable directory materialization such as selected skills.
- Adapter-managed runtime state and operator home are separate product concepts
  even when a provider-specific variable points at managed state.
- Default local trusted adapters must not copy, symlink, or expose arbitrary
  operator-home contents into adapter-managed runtime state as a convenience
  shortcut. Any explicit credential bridge must be selected, logged, and
  redacted.
- Operator `HOME` does not authorize provider-native, project, global, stale,
  or unselected skills to become Rudder-loaded runtime skills.
- This contract does not promise equal provider capability across all
  adapters. Adapter capability parity remains owned by
  `AGENT.RUNTIME.ADAPTERS.001`.
- This contract does not require every optional skill source to be usable on
  every platform; unavailable sources must be represented honestly.
- The OS remains the source of truth for Desktop permission grants; Rudder
  does not promise to grant Full Disk Access, Accessibility, Automation, or
  Notifications itself.
- Desktop permission settings actions must use fixed, platform-checked targets;
  generic external navigation is not a permission-routing escape hatch.
- Browser website identity may be shared across organizations by
  `AGENT.BROWSER.001`, but its profile data and Broker credential must never be
  copied into operator home, adapter-managed runtime state, prompts, or model
  tool arguments.
- Provider OAuth identity, the authorizing Rudder user, and run-scoped proxy
  identity are separate authorization boundaries.
- OAuth replacement credentials do not become active until callback validation
  and atomic swap complete; an in-progress replacement is not authorization to
  destroy a usable grant.
- External MCP run policy is monotonic within a run: live reductions may remove
  authority, but live increases cannot add authority beyond the run-start
  snapshot.
- External MCP credentials remain server-side and are never materialized in
  runtime homes, generated adapter source, prompts, tool arguments, or
  redacted dispatch outcomes.
- External MCP credentials are connection-scoped. Organization, Agent A, and
  Agent B grants for the same provider cannot be substituted or queried across
  their owner boundaries.
- Safe custom STDIO/HTTP configuration is not authorization to access arbitrary
  processes, environment values, headers, redirects, or network ranges.

## Drift Boundaries

Requires updating this contract:

- changing how local runtimes choose operator `HOME`, adapter-managed runtime state, or
  provider-specific home variables
- adding or removing a runtime skill materialization strategy
- changing Windows fallback behavior for symlinks, junctions, copies, or
  temp-home creation
- broadening or narrowing default operator-home behavior, credential bridge
  entries, shim commands, or allowed host-home access
- changing permission/preflight error semantics for managed workspaces
- changing Desktop system-permission status semantics, platform visibility, or
  the fixed macOS settings targets
- changing the Desktop bridge or external-navigation policy used to open
  operating-system permission panes
- changing who can set the managed Browser capability flag or exposing Browser
  profile/Broker state to a runtime process
- changing managed external MCP OAuth/token materialization, run-scoped proxy
  identity, STDIO allowlists, environment selection, HTTP/redirect policy, or
  network target validation

Does not require updating this contract:

- internal refactors that preserve the same platform permission semantics
- internal Desktop IPC or UI refactors that preserve the same permission ids,
  fixed targets, platform checks, and operator-visible outcomes
- adding tests for an existing materialization strategy
- changing log wording without changing operator-visible repair meaning
- provider-specific command flag changes covered by the adapter capability
  contract

## Traceability

Related plans:

- `doc/plans/2026-06-21-product-logic-registry.md`
- `doc/plans/2026-06-26-local-runtime-operator-home-default.md`
- `doc/plans/2026-07-12-built-in-browser.md`
- `doc/plans/2026-07-23-managed-mcp-oauth-integrations.md`
- `doc/plans/2026-07-25-managed-mcp-access-and-interactions.md`
- `doc/plans/2026-07-27-managed-mcp-connection-scopes.md`

Related code:

- `packages/agent-runtime-utils/src/server-utils.cli.ts`
- `packages/agent-runtime-utils/src/rudder-mcp.ts`
- `packages/shared/src/types/mcp.ts`
- `packages/shared/src/validators/mcp.ts`
- `packages/agent-runtimes/claude-local/src/server/execute.ts`
- `packages/agent-runtimes/codex-local/src/server/codex-home.ts`
- `packages/agent-runtimes/codex-local/src/server/execute.ts`
- `packages/agent-runtimes/cursor-local/src/server/execute.ts`
- `packages/agent-runtimes/gemini-local/src/server/execute.ts`
- `packages/agent-runtimes/opencode-local/src/server/execute.ts`
- `packages/agent-runtimes/pi-local/src/server/execute.ts`
- `server/src/services/managed-workspace-preflight.ts`
- `server/src/services/agent-run-context.ts`
- `desktop/src/main.ts`
- `desktop/src/navigation-guard.ts`
- `desktop/src/preload.ts`
- `desktop/src/system-permissions.ts`
- `ui/src/lib/desktop-shell.ts`
- `ui/src/pages/InstanceNotificationsSettings.tsx`
- `desktop/scripts/after-pack.mjs`

Related tests:

- `packages/agent-runtime-utils/src/server-utils.test.ts`
- `server/src/__tests__/codex-local-execute.test.ts`
- `server/src/__tests__/claude-local-execute.test.ts`
- `server/src/__tests__/cursor-local-execute.test.ts`
- `server/src/__tests__/gemini-local-execute.test.ts`
- `server/src/__tests__/opencode-local-execute.test.ts`
- `server/src/__tests__/pi-local-execute.test.ts`
- `server/src/__tests__/managed-workspace-preflight.test.ts`
- `server/src/__tests__/agent-run-context.test.ts`
- `server/src/__tests__/managed-mcp-bindings-service.test.ts`
- `server/src/__tests__/managed-mcp-connections-service.test.ts`
- `desktop/src/navigation-guard.test.ts`
- `desktop/src/preload.browser.test.ts`
- `desktop/src/system-permissions.test.ts`
- `ui/src/pages/InstanceNotificationsSettings.test.tsx`
- `desktop/scripts/smoke.mjs`

Known gaps:

- Direct negative IPC tests for an unknown system-permission id, an unsupported
  platform, or a non-current renderer sender are not yet present; the main
  process validation path is covered by implementation and the valid action is
  exercised by packaged smoke.
- Some runtime paths still call `fs.symlink` directly. The product contract
  records the desired cross-platform behavior; follow-up implementation should
  consolidate skill and credential materialization behind a platform-aware
  helper with Windows junction/copy fallback.
- Product evidence for skill materialization is not yet normalized across all
  adapters. Some adapters expose created/repaired/skipped/failed results, while
  others only expose logs or command notes.
