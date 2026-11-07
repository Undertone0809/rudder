# Rust backend migration — machine handoff (2026-11-07)

This is a WIP preservation and continuation handoff, not a completed migration or release. The user explicitly requested pushing all progress and opening a PR without waiting for CI, followed by removal of related local worktrees. No merge, deployment or new acceptance is performed in this handoff.

## Start on a new computer

```sh
git clone https://github.com/Undertone0809/rudder.git
cd rudder
git fetch origin '+refs/heads/codex/rust-handoff-20261107/*:refs/remotes/origin/codex/rust-handoff-20261107/*'
git switch -c resume-rust origin/codex/rust-automation-execution-20261028
pnpm install --frozen-lockfile
```

Read `AGENTS.md`, `doc/engineering/BACKEND_ARCHITECTURE.md` and the snapshot manifest beside this document. Fetching the snapshot namespace recovers all 46 former workspace tips, including unfinished code. Each manifest row binds its original branch/HEAD, remote snapshot ref/SHA/tree, staged checkpoint (when any), added source files, and original status. Recreate any one with `git worktree add ../resume-topic origin/<snapshot_ref>`. Snapshot refs preserve separate alternatives; do not merge all historical snapshots indiscriminately.

## Active implementation PRs

| PR | Scope | Base | Frozen source at handoff |
|---|---|---|---|
| [#398](https://github.com/Undertone0809/rudder/pull/398) | Agent execution, runtime tools, cancellation and Steer | main | 64800e00ffda3affaaa0e04ee79e8a9a6787548b |
| [#399](https://github.com/Undertone0809/rudder/pull/399) | Asset uploads, logo and GET/HEAD content | main | 919c7f7c98c21d61d198b454ca11026fec99f523 |
| [#400](https://github.com/Undertone0809/rudder/pull/400) | Approval lifecycle and domain effects | #398 branch | 6e2621f34b61bed0c553caaaebc932b209983f9b |
| [#401](https://github.com/Undertone0809/rudder/pull/401) | Cargo cache in two qualification workflows | main | 428cf2cd6bc9ac863c0509dd7989f0d53947fd69 |
| [#402](https://github.com/Undertone0809/rudder/pull/402) | Automation execution and assistance Request writes | #398 branch | 421f5f84e46be7c8d2f7ce8cb16df54aaedb0b45 |

These implementation PRs and their branches remain intact. When #398 lands, retarget #400/#402 and reconcile `reviewed_node_changes` against the new comparison base. Keep persistent transport admissions, remove consumed diff-local records, and run the trusted authority checker. Source being pushed is distinct from being merged, published, or active in an installed app.

## Newly preserved unfinished work

The snapshot namespace also contains uncommitted Native Chat finalizer code (135 original status entries, including 33 newly discovered source files), two analytics variants, the Request test-module ordering fix, Pi native protocol changes, and older Rust branding/outbox/main-reconciliation work. Historical workspace deletions are also retained. Staged content has its own parent checkpoint before the final working-tree checkpoint where applicable. Deleted Desktop icons are preserved as observed WIP, not endorsed as intended product changes. Untracked dependency symlinks and Python bytecode were intentionally excluded. Use the manifest for exact source identities rather than relying on this narrative.

## Historical evidence and known gaps

The adjacent `historical-evidence/` reports were produced on 2026-10-28 and retain their original candidate bindings and local paths. They are portable reference records, not a fresh verification of all current snapshots. In particular:

- #398's frozen repair received independent stage/final review and 12 public HTTP selectors plus Goal Stop/retry acceptance. Its native tree matched the tested checkpoint. Exact-current-source required CI remains a merge gate.
- An external recovery fixture initially used SQL_ASCII; initialize disposable PostgreSQL with UTF8 and read back `SHOW server_encoding`. The same frozen Run workflow passed with all 13 HEAD expectations preserved after fixing that fixture.
- Automation execution/Goal tests create their own journal-186 database; management and Request tests used a separate external journal-188 fixture. Setting an external URL does not make a self-owned fixture use that database. Preserve this distinction in reports.
- #400's three compiler/clippy repairs passed an all-target check, but that alone is not workflow/PAV evidence.
- #399's test configuration was corrected to authenticated ingress with implicit local identity disabled, and its module order was fixed. Its final real workflow and independent PAV still need qualification.
- #402's combined candidate needs its Automation workflow and three Request workflows rebound, affected units, CI and final review. CI explicitly calls the Automation and two Request-write ignored tests; the Request-read case already exists in the preceding step.

Do not infer completion from Rust LOC, old route percentages, green health checks, or a listener forwarding to Node. Remaining migration areas include residual auth/lifecycle paths, skills, analytics/admin, instance settings, run intelligence, App Builder/access/invites, managed MCP administration/OAuth, CLI/MCP and final default/no-Node installed acceptance. Refresh that list from current main and implementation before assigning new work.

## Continuation strategy and authority

Work through existing PRs before duplicating their domains. Keep independent implementation/CI branches parallel, reuse Rust domain modules and current storage/queue primitives, and focus on real failures. The user requested approval before adding complexity for speculative rare races. Preserve API/session/data/migration compatibility and single-writer ownership. Required review/PAV/CI still gate merging; this archival PR does not waive them. CI was not awaited and no CI pass is claimed by this handoff.

## Local-only preservation

Before deleting worktrees, ignored databases, profiles and non-rebuildable verification data are moved outside them to `/Users/zeeland/.codex/rudder-rust-handoff/2026-11-07/private-data/`. They are intentionally not uploaded to this public GitHub repository. Existing `~/.rudder`, the primary checkout, unrelated worktrees and external evidence directories are retained. This Git handoff transfers code and written evidence, not credentials or a production database. The local snapshot/push/cleanup receipts are retained in the same handoff directory.
