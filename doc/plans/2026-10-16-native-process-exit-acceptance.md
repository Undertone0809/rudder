---
title: Native process child exit transport acceptance
date: 2026-10-16
kind: implementation
status: in_progress
area: api
entities: [backend_authority, rust_migration]
issue:
related_plans: [2026-10-16-rudder-rust-backend-retirement.md]
supersedes: []
related_code: [packages/agent-runtime-utils/src/native-process-runner.ts]
commit_refs: []
updated_at: 2026-10-16
---

# Scope and candidate

Restore the existing RunProcessResult contract for a real provider's nonzero
exit after Rust process-host acceptance. Rust remains the process lifecycle
owner and retains its durable failed/child_exit receipt. This is a bounded
transport correction, not native provider migration or Node retirement.

Base: ae74493a38f9688980d9ff46d49fff1a32896eab.
Runner SHA-256: cf886f5e03f4bcccbf4142176ff76af46ed5ab8061aabb1b5a96ad02076584ae.
Test SHA-256: 03dd654700470c204e808ee85f7afa17eb924352617027e96e9b27b71ffd12ab.
Existing Rust host SHA-256: cb24138f43109eb120a4b4a964546de6417f94208bfafc07df113aa6886432fa.

# Independent acceptance

After stage review acceptance, freeze the source and copy the host to an
immutable temporary evidence directory. Exercise the exported process runner
through its default native auto mode, not a mock-only substitute:

- A real child writes stdout/stderr and exits 7. Caller receives code 7 and
  correct output; the Rust receipt still records failed/child_exit.
- A successful child requires one valid zero-exit frame. A requested Stop may
  retain its nonzero/signal result only with matching stopped confirmation and
  valid exit evidence; missing/malformed success evidence rejects.
  A supported signaled child retains
  its signal result where the platform supports that process behavior.
- An accepted real host with injected malformed protocol evidence rejects;
  process ancestry/spawn evidence proves no fallback Node subprocess retry.
- Missing, duplicate, malformed, unspawned, zero-exit failure and unsupported
  signal evidence cannot turn a host failure into a valid process result.
- Provider retry/error classification tests operate in default native mode.

Record source, host, environment, commands, process/receipt evidence and hashes
before and after. Return PASS, FAIL or QUESTION for this exact candidate. Use
only disposable files and processes. Do not alter implementation or rebuild the
host during acceptance. Author results (51 runner tests, 113 provider tests,
affected-package typecheck) are supporting evidence only.

# Retirement boundary

The JavaScript layer may transport Rust process events into the existing caller
result contract; it must not decide execution ownership, retry after acceptance,
or weaken protocol/cleanup failures. Retire this compatibility layer when native
provider adapters replace the JavaScript process transport.
