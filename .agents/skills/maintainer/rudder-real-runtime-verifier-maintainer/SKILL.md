---
name: rudder-real-runtime-verifier-maintainer
description: "Use only to verify Rudder agent-runtime behavior in real local runs: Codex/Claude/OpenCode/Pi provider matrices, typed Rudder MCP/native tool availability, transcript proof, internal tool errors, or model-visible rudder CLI/Bash/curl fallback. Do not use for general UI/Desktop acceptance, release verification, dev startup/recovery, workspace or log cleanup, or single-run root-cause diagnosis."
---

# Rudder Real Runtime Verifier Maintainer

Verify whether a named agent runtime actually completes Rudder work through
typed Rudder-managed tools in a real local run. This is read-only verification
and diagnosis by default; do not edit source, configuration, git state, or
product contracts unless the user separately requests a fix.

## Route Boundary

- Use `product-acceptance-verifier-maintainer` for ordinary UI, Desktop, CLI,
  integration, or release-surface acceptance.
- Use `debug-run-transcript-maintainer` to reconstruct one failed run; return
  here only when a post-fix real rerun must prove runtime behavior.
- Use `rudder-desktop-dev-recovery-maintainer` for Desktop or dev-shell startup,
  instance, profile, update, or launch recovery.
- Use `rudder-workspace-hygiene-maintainer` for worktree, cache, disk, or log
  audits and cleanup.
- Use `release-maintainer` for npm, GitHub Release, Desktop asset, tag, dist-tag,
  or public docs release state.

## Evidence Workflow

1. Resolve the real local Rudder instance and verify `/api/health`.
2. Name the requested runtime matrix; never treat one provider as proof for
   another.
3. Run the smallest real probe that answers the question.
4. Inspect structured transcript or raw log evidence for the expected typed
   Rudder calls.
5. Reject model-visible fallback to Bash, curl, or `rudder` CLI for Rudder work.
6. Read back the terminal product effect and separate provider/model blockers
   from Rudder adapter or tool failures.
7. Report mutations, skipped coverage, and exact run/issue/org evidence.

Read only the references needed:

- [`references/probe-workflow.md`](references/probe-workflow.md) for setup,
  disposable data, the probe ladder, and full-manifest coverage.
- [`references/transcript-evidence.md`](references/transcript-evidence.md) for
  transcript proof and fallback detection.
- Runtime-specific parsing: [`codex.md`](references/codex.md),
  [`claude.md`](references/claude.md), [`opencode.md`](references/opencode.md),
  or [`pi.md`](references/pi.md).
- [`references/reporting.md`](references/reporting.md) for verdicts and the
  mutation ledger.

## Pass Gate

A runtime passes only when a real run exists, expected typed tools are visible
in transcript evidence, internal tool results are successful, no model-visible
CLI fallback occurred, and the terminal effect was read back. A successful
final answer alone is not proof. If the user asks for all tools, list unexecuted
tools as uncovered instead of saying “all green.”

Use [`evals/evals.json`](evals/evals.json) for positive runtime cases and
near-neighbor route-confusion regressions.
