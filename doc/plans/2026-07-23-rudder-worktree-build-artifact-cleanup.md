---
title: Rudder worktree and build artifact disk cleanup
date: 2026-07-23
kind: implementation
status: in_progress
area: developer_workflow
entities:
  - git_worktree
  - build_artifacts
  - e2e_test_home
related_plans:
  - 2026-03-10-workspace-strategy-and-git-worktrees.md
supersedes: []
related_code:
  - tests/e2e
  - desktop
commit_refs: []
updated_at: 2026-07-23
---

# Rudder Worktree and Build Artifact Disk Cleanup

## Goal

Recover disk space without deleting user data, uncommitted work, unmerged
branches, or the running main development environment.

## Approved Cleanup

- Remove only clean worktrees whose HEAD is contained in the refreshed
  `origin/main`; retain all branches.
- Prune stale worktree registrations whose directories no longer exist.
- Delete inactive Rudder release, build, QA, and verification directories under
  `/private/tmp`.
- Remove reproducible E2E, packaging, dependency-store, and report artifacts.
- In retained worktrees, remove only generated paths confirmed by
  `git check-ignore`.

## Protected State

- Preserve the main worktree and its running dependencies and compiled output.
- Preserve `~/.rudder`, Rudder application support, and global npm/pnpm caches.
- Preserve every dirty worktree, every unmerged remote-backed worktree, every
  local-only commit, and every Git branch.

## Verification

- Recheck cleanliness, merge ancestry, and active processes before deletion.
- Compare protected worktree status snapshots before and after cleanup.
- Confirm the dev health endpoint remains available.
- Confirm no orphan E2E PostgreSQL process remains.
- Measure actual reclaimed space with `df`.
