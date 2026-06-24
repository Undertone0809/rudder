---
title: Runtime Platform Permissions
domain: agents
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - AGENT.RUNTIME.PERMISSIONS.001
related_code:
  - packages/agent-runtime-utils/src/server-utils.cli.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/cursor-local/src/server/execute.ts
  - packages/agent-runtimes/gemini-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - server/src/services/managed-workspace-preflight.ts
  - desktop/scripts/after-pack.mjs
related_tests:
  - packages/agent-runtime-utils/src/server-utils.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - server/src/__tests__/claude-local-execute.test.ts
  - server/src/__tests__/cursor-local-execute.test.ts
  - server/src/__tests__/gemini-local-execute.test.ts
  - server/src/__tests__/opencode-local-execute.test.ts
  - server/src/__tests__/pi-local-execute.test.ts
  - server/src/__tests__/managed-workspace-preflight.test.ts
related_plans:
  - doc/plans/2026-06-21-product-logic-registry.md
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
with the same product semantics: isolated managed home, access to required
Rudder context, selected skills, and usable local CLI credentials when the
adapter intentionally bridges them. They should not need to know whether a
provider adapter uses symlinks, junctions, copied directories, temporary homes,
or shell shims unless a repair action is required.

## Why / Design Reasoning

Rudder local runtimes cross two boundaries at the same time:

- the product boundary between the agent's managed workspace and the human
  operator's host machine
- the platform boundary between POSIX filesystems and Windows filesystem
  permissions

The current design favors managed runtime homes and explicit credential bridges
over running every adapter directly in the operator home. That protects
repeatability, avoids leaking unrelated user files into the agent's default
home, and lets Rudder attach run evidence to a known workspace. The tradeoff is
that files, credentials, skills, sockets, config directories, and temporary
runtime material must be materialized in a platform-aware way.

The key platform rule is that Windows directory symlink creation can require
Developer Mode or elevated privileges. Rudder must not make ordinary Windows
users run the product as administrator just to load skills or share read-only
credential entries. When a runtime needs directory indirection on Windows, the
preferred behavior is a platform-safe substitute such as a directory junction
or copied directory. If a substitute is impossible or unsafe, the run should
produce a clear permission/configuration error before provider execution.

## Actors / Objects / State

- Operator: the human whose machine, local CLIs, provider credentials, and
  filesystem permissions host the local runtime.
- Runtime agent: the adapter-invoked process running as the selected Rudder
  agent.
- Managed home: Rudder-created runtime home for an adapter, such as managed
  Codex, Claude, Cursor, Gemini, OpenCode, or Pi state.
- Operator home: the host user's real home, exposed as `RUDDER_OPERATOR_HOME`
  when a local runtime intentionally needs access to host credentials.
- Skill source directory: bundled, organization, global/user, or agent-home
  skill directory selected for a run.
- Materialized skill directory: the provider-visible skill location created by
  symlink, junction, copy, native config, prompt injection, or another
  adapter-specific mechanism.
- Credential bridge: a managed-home entry, shell shim, git config, or env var
  that lets a local CLI use the operator's authenticated state without treating
  the entire operator home as the runtime home.
- Platform capability: filesystem and process capability that differs by OS,
  including symlink privileges, path syntax, case behavior, home variables,
  executable lookup, process termination, and installer/package copying.

## Entry Points / Inputs

- Local adapter execution for Claude, Codex, Cursor, Gemini, OpenCode, and Pi.
- Adapter environment tests and model/listing probes.
- Runtime skill sync, skill listing, or temporary provider skill-home creation.
- Managed workspace preflight for agent home, instructions, memory, life, and
  skills directories.
- Local CLI credential bridging for provider CLIs, git, `gh`, and other
  selected host commands.
- Desktop packaging and update flows that copy app resources across platforms.
- Environment inputs including `HOME`, `USERPROFILE`, `RUDDER_HOME`,
  `RUDDER_OPERATOR_HOME`, provider-specific home variables, and `PATH`/`Path`.

## Product Logic Flow

1. Before invoking a local runtime, Rudder resolves the effective workspace cwd
   and verifies that required managed workspace directories exist, are
   directories, and are writable.

2. Rudder resolves two distinct homes: the managed runtime home used by the
   adapter process, and the operator home used only for explicitly supported
   credential bridging. `RUDDER_OPERATOR_HOME` records that boundary when
   exposed to the child process.

3. Rudder prepares the child environment with platform-correct home variables.
   On Windows, `USERPROFILE` must be set consistently with the chosen home
   semantics; on all platforms, `HOME` isolation and `PATH`/`Path` lookup must
   preserve command resolution.

4. Rudder materializes runtime skills using an adapter-supported mechanism:
   native provider config, symlink, directory junction, copied directory,
   prompt-injected skill text, or another explicit strategy. Materialization is
   a runtime implementation detail, but the product result is that selected
   skills are available to the provider or clearly reported as unavailable. The
   adapter mechanism must not broaden the selected set with provider-native,
   operator-home, project, global, or stale managed skills.

5. Before provider execution, Rudder prunes, disables, isolates, or ignores
   stale Rudder-managed and provider-native skills that are not in the current
   selected set.

6. When materialization depends on filesystem indirection, Rudder must choose a
   platform-safe method. POSIX symlinks are acceptable on macOS/Linux. Windows
   directory symlinks must not be the only path for ordinary users because they
   may require Developer Mode or elevation; junction or copy fallback is the
   expected durable strategy for directory skill materialization.

7. Rudder bridges credential entries into the managed home only for selected
   local CLI surfaces. Existing non-empty managed-home credential directories
   are not overwritten. Empty placeholders may be repaired. If managed-home
   credentials still fail, command-specific shims may run the selected command
   with the operator home.

8. If a platform limitation is recoverable, Rudder records the substitution or
   skip in logs, command notes, adapter metadata, or skill sync evidence. The
   run may continue when the selected skill/credential behavior still matches
   the product contract.

9. If the limitation prevents required runtime startup, workspace access,
   credential access, or skill availability, Rudder fails before or during
   adapter invocation with a clear error code/message that tells the operator
   what permission, path, login, or configuration needs repair.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| POSIX skill directory indirection | Runtime materializes a selected skill on macOS/Linux | Symlink or native provider config may expose the skill | Product code must not assume the materialized path is a physical copy | Skill sync metadata, adapter command notes, provider-visible skill home |
| Windows selected directory skill | Runtime materializes a directory skill on Windows | Use a Windows-safe mechanism such as junction or copy fallback when native provider config is not available | Ordinary run must not fail only because `fs.symlink` needs elevated Windows privileges | Runtime logs, skill sync result, known gap until all adapter paths implement fallback |
| Windows symlink privilege unavailable | `fs.symlink` returns `EPERM` for a recoverable directory materialization | Fallback strategy should preserve selected skill availability or report the skill as unavailable with actionable error text | Error must not be exposed as an unexplained provider failure or require admin as the only product path | Adapter error code/message and command notes |
| Stale previously selected skill | A prior run materialized a skill that is now disabled or absent from the selected set | Provider execution starts with that skill removed, disabled, isolated, or ignored | Previously enabled skills must not remain provider-visible because they were left in a managed skill home | Execute-level adapter tests, skill sync metadata, loaded-skill metadata |
| Managed workspace missing or unwritable | Agent home/instructions/memory/life/skills path cannot be created or write-probed | Workspace preflight fails with a repair-needed error before provider execution | Provider must not start with a broken managed workspace and produce opaque downstream errors | `workspace_permission_repair_needed`, managed workspace preflight tests |
| Credential entry exists in operator home | A selected local CLI credential directory/file exists outside managed home | Bridge only selected entries or use command shims; preserve managed-home isolation | Entire operator home must not become the runtime home unless the adapter explicitly owns that behavior | Credential bridge logs, shim command notes, server-utils tests |
| Existing non-empty managed credential dir | Target managed-home credential path already contains user/runtime data | Skip replacement and preserve the existing directory | Rudder must not delete or overwrite non-empty credential state to create a symlink | Credential sync result and tests |
| Windows home environment | Runtime sets child process home on Windows | `HOME`, `USERPROFILE`, and provider-specific home variables match the selected managed/operator-home semantics | Child process must not read credentials from a different home because only one variable was updated | Adapter env construction tests and command metadata |
| Desktop resource packaging | Packaged app copies resources on Windows | Packaging may dereference symlinks into real files/directories | Runtime skill injection must not assume packaging fallback also protects run-time temp dirs | Desktop packaging code and separate runtime adapter tests |

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
- `HOME`, `USERPROFILE`, provider home variables, and `RUDDER_OPERATOR_HOME`
  reflect the intended managed-home and operator-home boundary
- Rudder API env vars and local auth credentials are present only when the
  adapter supports them
- cwd and workspace paths point at the verified execution workspace, fallback
  workspace, or agent home chosen for the run

If a required permission cannot be repaired or substituted, the actor should
not receive a normal work prompt. The run should fail with configuration or
permission evidence instead of asking the model to diagnose host filesystem
state.

## Operator-Visible Output

Operators and reviewers should be able to see:

- managed workspace preflight failures with the path and repair instruction
- adapter auth-required, command-not-found, permission-denied, or
  materialization-failed errors when a local runtime cannot start correctly
- logs or command notes for credential bridging, command shim preparation,
  workspace fallback, and skill materialization warnings
- run result/transcript metadata that separates provider failure from Rudder
  runtime setup failure

User-facing guidance may recommend enabling Windows Developer Mode as a manual
workaround, but the durable product contract is platform-safe fallback for
recoverable directory materialization.

## Persisted Evidence

Evidence can include:

- heartbeat run context snapshot with workspace and runtime-home facts
- adapter invocation metadata with cwd, command, env-derived notes, prompt
  metrics, loaded/realized skill facts, and command notes
- run logs recording workspace preflight, credential bridge, shim, or
  materialization actions
- skill sync/listing results for created, repaired, skipped, failed, desired,
  realized, native, or prompt-injected skills
- managed workspace preflight error code/message when a path is not writable
- test coverage for home isolation, credential bridging, symlink repair, and
  adapter-specific local runtime execution

## Canonical Scenarios

1. Claude local loads bundled skills on Windows:
   - Trigger: agent run selects Claude local with a bundled runtime skill.
   - Expected state/action: Rudder materializes the selected skill into the
     provider-visible temporary skill home using a Windows-safe strategy.
   - Visible output: run starts normally, or fails with an actionable
     materialization error naming the skill/path.
   - Evidence: adapter logs/metadata show the materialized skill result.

2. Codex local uses a worktree-isolated home:
   - Trigger: Codex local run starts with a managed `CODEX_HOME` and selected
     workspace cwd.
   - Expected state/action: Rudder isolates runtime state while preserving
     explicit auth/config bridges needed for Codex to run.
   - Visible output: agent receives Rudder instructions and workspace context,
     not an unbounded copy of the operator home.
   - Evidence: command notes and tests show managed home, shared auth/config,
     and cwd selection.

3. Local CLI credential bridge falls back to shim:
   - Trigger: a provider or helper CLI cannot authenticate from the managed
     home after selected credential entries are bridged.
   - Expected state/action: Rudder prepares command-specific shim execution
     with the operator home when the command is allowed.
   - Visible output: logs name the prepared shim command, not secret material.
   - Evidence: credential shim tests and redacted run logs.

4. Managed workspace permission failure:
   - Trigger: `AGENT_HOME/skills` or another required managed directory is a
     file, missing without create permission, or not writable.
   - Expected state/action: preflight fails before provider execution.
   - Visible output: operator sees a repair-needed permission/configuration
     message.
   - Evidence: workspace preflight test and run error metadata.

## Invariants / Non-Goals

- Platform-specific filesystem operations must be hidden behind runtime
  materialization helpers or adapter-owned setup, not scattered as unchecked
  assumptions.
- Windows users must not be required to run Rudder as administrator for
  recoverable directory materialization such as selected skills.
- Managed runtime home and operator home are separate product concepts even
  when a specific adapter temporarily exposes both.
- Credential bridges must be selected, logged, and redacted. Rudder must not
  copy or expose arbitrary operator-home contents as a convenience shortcut.
- This contract does not promise equal provider capability across all
  adapters. Adapter capability parity remains owned by
  `AGENT.RUNTIME.ADAPTERS.001`.
- This contract does not require every optional skill source to be usable on
  every platform; unavailable sources must be represented honestly.

## Drift Boundaries

Requires updating this contract:

- changing how local runtimes choose managed home, operator home, or
  provider-specific home variables
- adding or removing a runtime skill materialization strategy
- changing Windows fallback behavior for symlinks, junctions, copies, or
  temp-home creation
- broadening or narrowing credential bridge entries, shim commands, or
  allowed host-home access
- changing permission/preflight error semantics for managed workspaces

Does not require updating this contract:

- internal refactors that preserve the same platform permission semantics
- adding tests for an existing materialization strategy
- changing log wording without changing operator-visible repair meaning
- provider-specific command flag changes covered by the adapter capability
  contract

## Traceability

Related plans:

- `doc/plans/2026-06-21-product-logic-registry.md`

Related code:

- `packages/agent-runtime-utils/src/server-utils.cli.ts`
- `packages/agent-runtimes/claude-local/src/server/execute.ts`
- `packages/agent-runtimes/codex-local/src/server/codex-home.ts`
- `packages/agent-runtimes/codex-local/src/server/execute.ts`
- `packages/agent-runtimes/cursor-local/src/server/execute.ts`
- `packages/agent-runtimes/gemini-local/src/server/execute.ts`
- `packages/agent-runtimes/opencode-local/src/server/execute.ts`
- `packages/agent-runtimes/pi-local/src/server/execute.ts`
- `server/src/services/managed-workspace-preflight.ts`
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

Known gaps:

- Some runtime paths still call `fs.symlink` directly. The product contract
  records the desired cross-platform behavior; follow-up implementation should
  consolidate skill and credential materialization behind a platform-aware
  helper with Windows junction/copy fallback.
- Product evidence for skill materialization is not yet normalized across all
  adapters. Some adapters expose created/repaired/skipped/failed results, while
  others only expose logs or command notes.
