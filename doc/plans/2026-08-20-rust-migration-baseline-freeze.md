# Rust Migration G0 Baseline Freeze

Status: accepted baseline candidate

Issue: R6Z-129

Parent: R6Z-120

## Decision

G0 freezes the accepted A1-A4 evidence package for a behavior-neutral Rust
migration foundation. It does not transfer runtime authority, change Product
Logic, create a second public listener, change database migration ownership, or
authorize a release.

The freeze candidate is `3a29c690e6ba0b21b35e273d869e1a73f8ccc526`
(tree `8dfe316dd45210f0be7449e561c683a8e4e85194`). The candidate starts from a
clean `origin/main` worktree. The only G0 changes are the two accepted inventory
artifacts that had not yet landed on `main` and this consolidation document.

## Accepted Inputs

| Wave | Issue | Artifact | Accepted identity |
| --- | --- | --- | --- |
| A1 | R6Z-125 | `doc/plans/2026-08-20-rust-route-transaction-writer-inventory.yml` | source `3b470a7874129050d9a4c8d3132ee9f5fe99579d`; SHA-256 `2fdf4f20d33f777fa7011ed72fc7f9f0467b7d164d53ba68574e9b98b78cb185`; structured stage reviewer approve and Issue completion |
| A2 | R6Z-126 | `doc/plans/2026-08-20-rust-cli-mcp-contract-inventory.yml` | delivery commit `1c177839362bb4a858b151c467c32a9d7cef8b78`; SHA-256 `8cbe6bfd6f4d78746d02d890880862884270b234a7304c745a3e3b76f7086c49` |
| A3 | R6Z-127 | `doc/plans/2026-08-20-rust-performance-baseline.yml` | delivery commit `c945ff93c2288429e13396194aa6c7515b547cbe`; SHA-256 `81c92776ceab8430cf2b06c8e5e4951972315a167d7a2903503425e6b3b45976`; reviewer accept and independent verifier PASS |
| A4 | R6Z-128 | `doc/plans/2026-08-20-rust-electron-release-inventory.yml` | source `a63048f2b5388ae77ccf486fd72ee8f26e8624de`; SHA-256 `7b2c183903b8536efd14bb79a6cccc732a257546a8c5c09b790676a6a5b8a529`; independent review approve |

## Current-Source Reconciliation

The A1 and A4 artifacts preserve their independently reviewed source identity.
Because `main` advanced after those reviews, G0 also records a bounded source
delta rather than rewriting accepted evidence without a fresh review.

At the G0 candidate:

- route scan: 59 non-test route source files, 45 files with router method
  declarations, 504 declarations, and 507 path variants after the three
  documented execution-workspace aliases;
- transaction scan: 187 production `.transaction(` call sites across 50 files;
- migration scan: 161 SQL files and 159 journal entries, with the two legacy
  allowlist entries already described by A1;
- public listener authority remains the Node HTTP listener plus its live-event
  WebSocket upgrade; the optional analytics collector and dynamic loopback
  workspace listeners remain bounded non-public authorities described by A1;
- the source delta since the accepted A1 candidate touches the known route,
  run, chat, goal, issue, organization, workspace-backup, and migration units.
  No new route module, transaction-owning source file, public listener root, or
  migration runner root is left unclassified by the current scans;
- the source delta since A4 touches Desktop identity/update/recovery, release
  compatibility, and smoke coverage within the authority units already mapped
  by A4. B3 owns compatibility and release-set implementation changes.

This reconciliation is sufficient for the behavior-neutral B1 contract and
code-generation foundation. Any later mutation slice must rebind the affected
authority rows to its own exact candidate before implementation review.

## Contract And Authority Freeze

- HTTP/API behavior remains owned by the current TypeScript routes and tests.
- CLI capability identity remains owned by `cli/src/agent-v1-registry.ts` and
  `cli/src/agent-v1-capabilities.ts` until a B1 versioned source is accepted.
- MCP behavior remains owned by
  `packages/agent-runtime-utils/src/rudder-mcp-contract.ts`, its generated
  descriptors, the CLI MCP dispatcher, and parity checks.
- PostgreSQL runtime query and migration authority remain with Drizzle and the
  existing migration runtime. SQLx receives no migration authority at G0.
- Electron remains the Desktop shell. Installer entry scripts may remain
  bounded JavaScript, shell, or PowerShell entrypoints but may not own the
  persistent Server, first-party CLI/MCP, database, queue, or product state.
- Production double-write, a second public listener, and permanent Node
  fallback remain prohibited.

Contract IDs frozen for downstream evidence:

- `DATABASE.MIGRATION.COMPATIBILITY.001`
- `AGENT.CONTROL.TOOLS.001`
- `AGENT.RUNTIME.ADAPTERS.001`
- `RUN.AGENT.UNIFICATION.001`
- `RUN.EXECUTION.001`
- `RUN.RESULT.001`
- `CLIENT.AUTH.RELEASE.ISOLATION.001`
- `DESKTOP.STARTUP.RECOVERY.001`

## Validation

| Check | Result |
| --- | --- |
| `git status --short --branch` | PASS; clean `origin/main` base with exactly the three G0 documentation additions before commit |
| `pnpm product-logic:check` | PASS; 96 contracts valid |
| `pnpm architecture:audit:test` | PASS; 18 tests |
| `pnpm mcp-contract:check` | PASS; generated descriptors match the canonical contract |
| `pnpm --filter @rudderhq/server typecheck` | PASS |
| `pnpm --filter @rudderhq/cli typecheck` | PASS |
| strict `js-yaml@4.2.0` parse of all four YAML inventories | PASS; A1 contains 2 documents and A2-A4 contain 1 each |
| accepted artifact SHA-256 verification | PASS; all four hashes match the accepted identities above |
| current route/transaction/migration count reconciliation | PASS; 504 declarations / 45 declaration files, 187 transaction calls / 50 files, 161 SQL files / 159 journal entries |
| A3 accepted workload packet | PASS at its frozen candidate; workflow tests 4/4, smoke 2 warmups + 7 measured iterations, thread-heavy 3 warmups + 20 measured iterations; not rerun or promoted as a current-candidate Rust comparison |

## Evidence Gaps And No-Go Boundaries

- A3 is a Node baseline and comparison protocol. It is not a Rust performance
  claim; seven paired Node/Rust blocks remain required at later performance
  gates.
- Authenticated CLI/MCP workflow, full packaged Desktop workflow, p99, peak
  process-tree RSS, memory-time, CPU, serialization, cold-start, throughput,
  cancellation, and timeout claims remain unpromoted where A3 records them as
  unavailable.
- A4's explicit release-CI packaged recovery/update matrix and release-set
  compatibility work remain B3 responsibilities.
- `origin/main` already contains the separately delivered B2 native foundation.
  This retroactive G0 reconciliation neither reviews nor expands B2 authority;
  it restores the declared gate before B1 and later slices proceed.
- G0 does not close R6Z-124. That later live-inventory refresh remains separate
  evidence and cannot silently replace the accepted R6Z-125 artifact without
  its own review and verifier packet.

## B1 Handoff

B1 may proceed after this exact G0 candidate is accepted. It must:

1. select one versioned source of truth for API, CLI, and MCP descriptors;
2. keep TypeScript behavior authoritative while generated Rust/TypeScript
   artifacts are compared;
3. generate deterministically and record the source version plus artifact hash;
4. normalize only explicitly enumerated non-semantic fields;
5. add differential fixtures for success, authorization, validation, bounded
   output, cancellation, and runtime-context errors;
6. pass `cargo check --manifest-path native/Cargo.toml`,
   `pnpm mcp-contract:check`, CLI typecheck, and Product Logic validation;
7. hand the accepted contract crate/module to B2 and B4 without transferring
   listener, query, migration, or release authority.

## Dependency Change

On G0 acceptance, R6Z-130 (B1) and the remaining B3 work are unblocked. B4
still requires both B1 and B2. Read-only vertical slices remain gated by B1,
B2, and B4 as declared by R6Z-120.
