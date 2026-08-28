# Rust Migration G0 Baseline Freeze

Status: review candidate

Issue: R6Z-129

Parent: R6Z-120

## Decision

G0 freezes the accepted A1-A4 evidence package for a behavior-neutral Rust
migration foundation. It does not transfer runtime authority, change Product
Logic, create a second public listener, change database migration ownership, or
authorize a release.

The G0 source base is `f159583282d4dd5935848a92df3eb58787fdd1e5`
(tree `0bcd165e9f81521963268a3a77ca1ec35a521088`). It was a clean `origin/main`
worktree before the G0 documentation package was applied; it is not itself the
freeze package. The package adds the two accepted inventory artifacts that had
not yet landed on `main`, this consolidation document, and the reviewable
current-source delta overlay.

Package fingerprint: `4c7f4d0e3079a4af3d081962026d0b5a5dd9325ec4098470d8720b4bc72affa2`

The fingerprint is SHA-256 over the four added paths in lexical order, each
encoded as `path`, a NUL byte, normalized file bytes, and a second NUL byte.
Normalization removes only the `Package fingerprint:` line from this document.
The exact candidate commit remains an external Git identity recorded in the
review handoff because a commit cannot contain its own SHA.

## Accepted Inputs

| Wave | Issue | Artifact | Accepted identity |
| --- | --- | --- | --- |
| A1 | R6Z-125 | `doc/plans/2026-08-20-rust-route-transaction-writer-inventory.yml` | source `3b470a7874129050d9a4c8d3132ee9f5fe99579d`; SHA-256 `2fdf4f20d33f777fa7011ed72fc7f9f0467b7d164d53ba68574e9b98b78cb185`; structured stage reviewer approve and Issue completion |
| A2 | R6Z-126 | `doc/plans/2026-08-20-rust-cli-mcp-contract-inventory.yml` | delivery commit `1c177839362bb4a858b151c467c32a9d7cef8b78`; SHA-256 `8cbe6bfd6f4d78746d02d890880862884270b234a7304c745a3e3b76f7086c49` |
| A3 | R6Z-127 | `doc/plans/2026-08-20-rust-performance-baseline.yml` | delivery commit `c945ff93c2288429e13396194aa6c7515b547cbe`; SHA-256 `81c92776ceab8430cf2b06c8e5e4951972315a167d7a2903503425e6b3b45976`; reviewer accept and independent verifier PASS |
| A4 | R6Z-128 | `doc/plans/2026-08-20-rust-electron-release-inventory.yml` | source `a63048f2b5388ae77ccf486fd72ee8f26e8624de`; SHA-256 `7b2c183903b8536efd14bb79a6cccc732a257546a8c5c09b790676a6a5b8a529`; independent review approve |

Current-source drift is frozen separately in
`doc/plans/2026-08-28-rust-migration-g0-current-source-delta.yml`; it preserves
the accepted A-wave artifact hashes instead of rewriting their provenance.

## Current-Source Reconciliation

The A1 and A4 artifacts preserve their independently reviewed source identity.
Because `main` advanced after those reviews, G0 also records a bounded source
delta rather than rewriting accepted evidence without a fresh review.

At the G0 candidate:

- route scan: 59 non-test route source files; using the accepted A1 public-route
  semantics, direct public `router.*` declarations advanced from 496 to 498
  across the same 43 files, and current public bindings total 506. The separate
  private analytics collectors contain 6 declarations across 2 files. Both
  added public route identities are frozen as stable overlay rows;
- transaction scan: 187 production `.transaction(` call sites across 50 files;
- migration scan: 161 SQL files and 159 journal entries, with the two legacy
  allowlist entries already described by A1;
- CLI/MCP scan: 117 total CLI capabilities, 106 agent-v1 capabilities, 11
  compatibility-only capabilities, 106 canonical MCP tools (81 core and 25
  Browser), core hash
  `db0fd5ef1f23df4e5605fdca726624cf39c5f515629269c616cf1ef1c786ce24`,
  and unchanged Browser hash
  `640c060df9ef9ae3c649d973d123fdcfc0d1456217cbe1ec48dbba337de75923`;
- authority overlay: 4 public route delta units, 5 current writer delta units,
  6 process/helper delta units, and 1 release policy delta unit are classified
  with exact sources, write boundaries, failure/recovery behavior, evidence
  status, candidate Rust authority, and retirement gates;
- release scan: the accepted A4 package contains 12 ownership rows and 18
  bounded entrypoints; the delta adds 1 explicit mirror-policy unit, gates 2
  mirror jobs, and adds 2 checksum-only jobs;
- benchmark scan: A3 retains 2 scale profiles, 5 measured paths, 7 paired
  comparison blocks, 6 required commands, and 2 supplementary commands; G0
  promotes 0 current-candidate Rust comparisons;
- public listener authority remains the Node HTTP listener plus its live-event
  WebSocket upgrade; the optional analytics collector and dynamic loopback
  workspace listeners remain bounded non-public authorities described by A1;
- the source delta since the accepted A1 candidate touches the known route,
  run, chat, goal, issue, organization, workspace-backup, and migration units.
  The two added public routes, two plugin Agent-read authorization changes,
  Goal typed-reference middleware, conservative network-suspension classifier,
  bounded retry/backoff policy and recovery controller, durable Run-to-Goal
  binding across every writer,
  needs-follow-up Issue transition, Feishu failed-reply persistence, and
  shell-free npm helper are explicit overlay rows. No new route module,
  transaction-owning source file, public listener root, or migration runner
  root is left unclassified by the current scans;
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
| `git status --short --branch` | PASS; clean source base with exactly the four G0 documentation additions before commit |
| `pnpm product-logic:check` | PASS; 96 contracts valid |
| `pnpm architecture:audit:test` | PASS; 18 tests |
| `pnpm mcp-contract:check` | PASS; generated descriptors match the canonical contract |
| `pnpm --filter @rudderhq/server typecheck` | PASS |
| `pnpm --filter @rudderhq/cli typecheck` | PASS |
| strict `js-yaml@4.2.0` parse of all five YAML inventories | PASS; A1 contains 2 documents and A2-A4 plus the delta overlay contain 1 each |
| accepted artifact SHA-256 verification | PASS; all four hashes match the accepted identities above |
| current route/transaction/migration count reconciliation | PASS; A1-comparable public route identity is 498 direct declarations / 43 files and 506 bindings, plus 6 private collector declarations / 2 files; 187 transaction calls / 50 files; 161 SQL files / 159 journal entries |
| current CLI/MCP reconciliation | PASS; 117 total / 106 agent-v1 / 11 compatibility-only CLI capabilities, 106 MCP tools, core hash `db0fd5ef...`, Browser hash `640c060d...` |
| route/writer/process/release delta overlay | PASS; 4 route, 5 writer, 6 process/helper, and 1 release policy authority units have stable rows and no unclassified current authority addition remains at the source base |
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
- `origin/main` already contains the separately delivered B2 native foundation:
  candidate `3343eda1330a40217d3e451b3710ca373f76183e`, integration
  `81b0f6583cea3d01f2d7b1792bfe44c0512e5532`. The original G0-before-B2
  ordering was not met and cannot be restored retroactively. The amended G0
  contract treats that exact loopback-only foundation as the sole historical
  exception and establishes a forward-only baseline before B1 and every later
  authority expansion. G0 neither reviews nor expands B2 authority.
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
7. hand the accepted contract crate/module to B4 and any later B2 extension
   without transferring listener, query, migration, or release authority.

## Dependency Change

On G0 acceptance, R6Z-130 (B1) and the remaining B3 work are unblocked. B4
still requires both B1 and B2. Read-only vertical slices remain gated by B1,
B2, and B4 as declared by R6Z-120.
