---
name: rudder-workspace-hygiene-maintainer
description: "Use to audit or clean Rudder worktrees, generated artifacts, logs, caches, and repo-owned processes without deleting active work, user data, or unrelated machine state. Returns AUDIT, CLEANED, or BLOCKED."
---

# Rudder Workspace Hygiene Maintainer

Make workspace cost visible and reclaim only space that is both proven safe and
explicitly authorized.

## Exclusive Outcome

- `AUDIT`: read-only inventory and classified cleanup candidates.
- `CLEANED`: exact authorized targets removed, with reclaimed space and
  post-cleanup health reported.
- `BLOCKED`: safe classification or required cleanup authority is missing.

An audit is always allowed. Cleanup is allowed only for exact targets covered
by the user's request.

## Protected By Default

Never delete or rewrite the main checkout; dirty, unmerged, locked, or active
worktrees; source or user-created data; `~/.rudder` instances and databases;
global caches; unrelated project state; or logs still being written before
identifying and handling their producer.

Do not use broad unresolved globs, inferred environment variables, or recursive
deletion against a workspace root.

## Audit

Run the bundled read-only helper first:

```bash
.agents/skills/maintainer/rudder-workspace-hygiene-maintainer/scripts/audit-workspace.sh
```

Add `--sizes` only when a slower serial disk scan is worthwhile.

Gross directory size is not reclaimable space. For every candidate, classify:
registered worktree and branch; main/current/locked state; dirty/unmerged state;
active repo-owned process; merge ancestry or other recoverability proof;
generated versus user data; and exact expected reclaim.

Process reports must be scoped to registered Rudder worktree roots or an exact
Rudder-owned signature. Report only redacted PID, PPID, elapsed time, RSS,
executable, and owner; never dump full argv that may contain tokens.

## Cleanup

1. Resolve exact absolute targets.
2. Confirm each target is within the user's authorized scope.
3. Stop or fix active producers before rotating/removing their output.
4. Prefer repository-aware or recoverable operations.
5. Remove only classified generated artifacts or proven-safe worktrees.
6. Re-run the audit and a lightweight health check.
7. Report target, reason, bytes reclaimed, and recoverability.

For worktrees, “old” or “large” is insufficient. Protect any worktree that is
dirty, unmerged, active, locked, current, or not proven recoverable from a
remote/merged commit.

## Report Format

```text
RESULT: AUDIT | CLEANED | BLOCKED
Scope:
Protected:
Candidates:
Actions:
Reclaimed:
Post-check:
```
