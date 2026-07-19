# Real-host and Workflow Verification

Date: 2026-07-20

## Codex greeting self-gating

Ran Codex with an isolated `CODEX_HOME` containing only the candidate
`rudder-docs` skill. The request was `hi`.

Observed JSONL events:

- one agent response: `Hi! What would you like to work on?`
- no command, file-read, or other tool event

This verifies that default discovery did not turn a greeting into a
documentation lookup.

## Codex Agent creation routing

Asked the same isolated host for the current Rudder Agent creation workflow in
read-only mode. Codex first read `rudder-docs/SKILL.md`, then read
`references/agent-creation.md`. It verified the installed CLI and current
source contracts, including permission checks, the canonical `rudder agent
hire` fallback, direct creation, and `pending_approval`. It performed no
mutation.

The governed mutation branches were exercised separately by
`cli/src/__tests__/agent-cli-e2e.test.ts`: the suite passed its default
permission direct-create path, approval-required path, and explicit-deny path.

## Codex Plugin authoring routing

Asked the isolated host for the external Rudder Plugin package workflow in
read-only mode. Codex first read `rudder-docs/SKILL.md`, then read
`references/plugin-authoring.md`, the current authoring guide, runtime
contract, SDK README, and scaffold source. It performed no mutation.

The creation path was exercised only under
`/tmp/rudder-plugin-scaffold-verify.cFpr3r`. The generated external package
completed:

- `pnpm typecheck`
- `pnpm test` (one SDK harness test passed)
- `pnpm build`

No bundled-example host wiring was added.

## OpenCode prompt-injected greeting

Injected the complete candidate `rudder-docs` skill into a pure OpenCode run
using `opencode/deepseek-v4-flash-free`, then sent `hi` as the current request.

Observed JSONL events:

- one text response: `Hi. What can I help you with?`
- no tool or file-read event

This verifies the skill's body-level gating when the full skill text is
already present in the host prompt.
