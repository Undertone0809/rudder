---
title: Local runtime operator home default
date: 2026-06-26
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - local_runtime_home
  - runtime_skills
  - credential_bridges
issue:
related_plans:
  - 2026-06-24-agent-run-scene-runtime-contract.md
  - 2026-04-14-codex-managed-skill-surface-isolation.md
  - 2026-04-14-codex-managed-skill-materialization.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.cli.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/claude-local/src/server/test.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/cursor-local/src/server/execute.ts
  - packages/agent-runtimes/gemini-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - doc/product/domains/agents/runtime-platform-permissions.md
  - doc/product/domains/agents/skills-and-inbox.md
commit_refs: []
updated_at: 2026-06-26
---

# Local Runtime Operator Home Default

## Decision

Local trusted runtime adapters should default the child process `HOME` and
`USERPROFILE` to the operator's real home directory. Rudder-managed runtime
directories remain valid for adapter-owned runtime state: selected runtime
skills, sanitized provider config, narrow provider-native auth/session
materialization, isolated Git policy files, sessions, temporary files, and
adapter metadata.

This separates three concepts:

- operator home: the real user home used by local CLIs, dotfiles, package
  managers, editor state, and host credentials
- adapter-managed runtime state: Rudder-owned provider config,
  skill/session state, narrow provider-native auth materialization, isolated
  Git policy, and temporary files, addressed through variables such as
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `OPENCODE_CONFIG`,
  and `PI_CODING_AGENT_*`
- agent workspace: the managed cwd, instructions, memory, and skills roots
  exposed through `AGENT_HOME` and `RUDDER_*` context

Rudder must not copy, symlink, or recreate broad operator-home credential and
tooling entries such as `.git-credentials`, `.npmrc`, `.npm`, `.ssh`,
`.config/gh`, `.docker`, `.kube`, or `.vscode` into a managed runtime home by
default. Runtime agents should use the operator's existing local environment
when they run local commands.

## Scope

This implementation will:

1. Keep Codex's existing split of operator `HOME` plus provider-owned
   `CODEX_HOME`.
2. Move Claude local execution and environment probes to operator `HOME` while
   preserving managed `CLAUDE_CONFIG_DIR`, selected Rudder skill materialization,
   sanitized settings, and runtime temp files.
3. Move Cursor local execution to operator `HOME` while keeping selected Rudder
   skills in a managed adapter skill directory and prompt-injected skill text.
4. Move Gemini local execution to operator `HOME` while keeping
   `GEMINI_CLI_HOME` on adapter-managed runtime state for selected skill and
   provider config isolation.
5. Move OpenCode local execution to operator `HOME` while keeping selected
   Rudder skills and sanitized provider config in adapter-managed runtime
   state.
6. Move Pi local execution to operator `HOME` while keeping
   `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` in Rudder-managed
   adapter state.
7. Stop invoking default local CLI credential-home bridges and command shims
   from these adapters when operator `HOME` is already the child home.
8. Update runtime permission product logic to make operator-home default the
   current contract and preserve provider-specific state isolation.

## Non-Goals

- Do not remove provider-specific managed homes or selected skill
  materialization.
- Do not broaden the set of Rudder-loaded skills with operator-home,
  provider-native, project, global, or stale managed skills.
- Operator `HOME` allows local shell commands to see the operator's dotfiles;
  it does not authorize provider-native, project, global, stale, or unselected
  skills to become Rudder-loaded runtime skills.
- Do not delete the shared credential-bridge utilities in this slice; they may
  remain available for explicit legacy or future non-default modes.
- Do not change remote/gateway runtime semantics.

## Provider Matrix

| Runtime | Child home default | Provider-owned state kept managed |
| --- | --- | --- |
| Codex local | operator `HOME` / `USERPROFILE` | `CODEX_HOME`, managed Codex config copy, selected skill paths |
| Claude local | operator `HOME` / `USERPROFILE` | `CLAUDE_CONFIG_DIR`, `RUDDER_CLAUDE_HOME`, sanitized settings, selected skill paths, runtime tmp |
| Cursor local | operator `HOME` / `USERPROFILE` | managed Cursor skill directory and prompt-injected skill text |
| Gemini local | operator `HOME` / `USERPROFILE` | `GEMINI_CLI_HOME`, managed Gemini skills/config |
| OpenCode local | operator `HOME` / `USERPROFILE` | `OPENCODE_CONFIG`, OpenCode XDG state, sanitized OpenCode config, and managed skill prompt sidecar |
| Pi local | operator `HOME` / `USERPROFILE` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, selected skills |

## Acceptance Criteria

- Every local trusted runtime in scope sets child `HOME` to the operator home
  by default.
- Runtime env metadata still exposes `RUDDER_OPERATOR_HOME`.
- Adapter-managed runtime state variables remain present where needed.
- Adapter execution no longer creates default local CLI credential bridges or
  command shims when the child already runs with operator `HOME`.
- Tests prove that adapter-managed runtime state does not receive broad copied
  or symlinked operator credential/tooling entries by default, and prunes
  legacy generic bridge symlinks left by older runs.
- Product logic documents the current operator-home default and the separate
  adapter-managed runtime state isolation boundary.

## Verification Plan

- Update adapter execute/probe tests for Claude, Cursor, Gemini, OpenCode, and
  Pi to assert operator `HOME`, provider-specific managed state variables, and
  absence of default credential bridge side effects.
- Run the targeted runtime tests for the changed adapters.
- Run package typecheck for changed runtime packages and server tests.
- Run `pnpm product-logic:check` after product contract updates.
- Run the route-required verifier gate with a runtime provider matrix review.
- Run spawned reviewer gates after verifier `PASS`.

## Review And Handoff Gates

Lifecycle route:

```text
runtime_contract -> implementation -> writer checks -> verifier acceptance -> spawned review -> commit/push
```

Reviewer lenses:

- functional trust: provider matrix, tests, product contract sync, git safety
- adversarial: hidden credential-copy behavior, skill boundary regressions,
  provider-specific home leakage
- heuristic/product-systems: whether the contract remains understandable and
  durable for future adapters
