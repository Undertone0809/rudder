---
title: Agent Tool Contract Reliability
date: 2026-07-27
kind: fix-plan
status: completed
area: agent_runtimes
entities:
  - agent_v1_contract
  - rudder_mcp_tools
  - run_transcripts
related_plans:
  - 2026-06-30-agent-v1-mcp-tools.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/rudder-mcp-contract.ts
  - cli/src/agent-v1-capabilities.ts
  - cli/src/agent-v1-mcp-server.ts
  - cli/src/__tests__/agent-v1-mcp-server.test.ts
  - doc/product/domains/agents/control-tools.md
commit_refs: []
updated_at: 2026-07-27
---

# Agent Tool Contract Reliability

## Incident Summary

Production Agent runs from the preceding 48 hours showed repeated tool-call
retries caused by MCP schemas that advertised a broad union of arguments
instead of the exact arguments accepted by each tool. The failures were noisy
and recoverable in many runs, but they consumed turns and made MCP no more
reliable than CLI invocation.

## What Is Broken?

- `issue.search` advertised an optional query even though execution requires
  one, causing empty-search calls when the model intended to list issues.
- `issue.commit` did not distinguish its required `message` argument from
  nearby summary-like fields.
- run-intelligence tools advertised incompatible aliases and output-expansion
  flags such as `runIdPrefix`, `includeOutput`, and `limitBytes` on tools that
  do not accept them.
- numeric bounds such as the `user.activity` limit maximum were absent from the
  schema.
- the generic schema made every core tool appear to accept dozens of unrelated
  fields, weakening model guidance and drift detection.

## Root Cause Hypothesis

The CLI invocation planner is capability-specific, but the MCP schema was
mostly generated from category-wide and global argument unions. Schema,
runtime validation, generated descriptors, and tests therefore shared tool
names but not one exact per-capability input contract.

## What Will Change?

1. Replace the generic core schema with exact per-capability schemas, including
   required fields, enums, size limits, and numeric bounds.
2. Add `issue.list` as the explicit no-query issue discovery tool while keeping
   `issue.search` query-required.
3. Keep runtime-owned identity absent from all model-visible inputs.
4. Generate MCP descriptors and fingerprints from the canonical contract.
5. Add contract and JSON-RPC E2E-style regression coverage for the production
   failure shapes.
6. Record the 48-hour baseline and schedule a same-method production comparison
   three days after delivery.

## Risk And Compatibility Notes

- Exact schemas intentionally reject formerly advertised but unsupported
  arguments. This is a contract correction, not a runtime identity change.
- Existing accepted aliases remain an internal compatibility detail only where
  already supported; canonical schemas expose one preferred spelling.
- `issue.list` is additive and dispatches through the existing CLI/API behavior.
- No database migration or persisted-data rewrite is required.

## Success Criteria

- Every first-party core MCP tool advertises only planner-supported arguments.
- Every planner-required canonical argument is marked required in the schema.
- The known production failure payloads fail schema validation before dispatch.
- Valid replacements produce the expected CLI/direct API invocation.
- Three-day production comparison shows contract-shape error rate below the
  baseline and reports total MCP/CLI error rates with exclusions unchanged.

## Validation Plan

- Run focused MCP server, registry, descriptor, and product logic checks.
- Run the repository lint, recursive typecheck, tests, and build.
- Exercise `tools/list` and representative `tools/call` requests over the real
  JSON-RPC server path.
- Have an adversarial reviewer inspect schema/planner drift and a verifier run
  black-box local checks.

## Open Issues

- Transport/process failures (`chat_adapter_failed`, `process_lost`, and
  `adapter_failed`) are tracked separately because the baseline did not
  attribute them to MCP contract errors.
- Result-size UX and automatic CLI fallback telemetry remain follow-up work
  after the schema reliability phase is measured.

## Completion Evidence

- Exact per-capability schemas, pre-dispatch validation, hidden compatibility
  alias normalization, and the additive `issue.list` tool are implemented.
- Core MCP preflight accepts the canonical schema dialect, including `anyOf`,
  and still rejects non-canonical manifests.
- Focused contract tests, all four local runtime bundle boundaries, process-level
  MCP E2E, lint, recursive typecheck, product-logic validation, contract
  generation validation, and the production build passed.
- The repository-wide test run completed with unrelated resource-contention
  failures; focused tests for every changed boundary passed after serializing
  runtime tests that share process-global fixture state.
