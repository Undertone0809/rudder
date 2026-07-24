---
title: Maintainer Skill Minimal Reset
date: 2026-07-24
kind: implementation
status: completed
area: skills
entities:
  - maintainer_skills
  - product_acceptance
  - desktop_recovery
  - workspace_hygiene
issue:
related_plans: []
supersedes: []
related_code:
  - .agents/skills/maintainer/product-acceptance-verifier-maintainer
  - .agents/skills/maintainer/rudder-desktop-dev-recovery-maintainer
  - .agents/skills/maintainer/rudder-workspace-hygiene-maintainer
  - .agents/skills/maintainer/mock-data-maintainer
  - .agents/skills/maintainer/release-maintainer
commit_refs: []
updated_at: 2026-07-24
---

# Maintainer Skill Minimal Reset

## Summary

Reduce the maintainer-skill strategy to a small set of distinct operational
outcomes. Strong reasoning models should handle ordinary planning, coding, and
debugging without procedural wrappers. A repository skill earns its place only
when it preserves fragile Rudder-specific knowledge, enforces a safety or
authority boundary, provides a deterministic helper, or owns a terminal result
that another skill does not.

## First-Principles Test

Keep or add a maintainer skill only if it answers all four questions:

1. What exclusive terminal outcome does it own?
2. What repo-specific knowledge would otherwise be repeatedly rediscovered?
3. What costly or unsafe failure does its boundary prevent?
4. Why is a short repository document or ordinary model reasoning insufficient?

Skills that merely restate generic engineering practice, duplicate another
skill's outcome, or cannot be distinguished by a maintainer from their name and
description should be merged, converted to reference material, or removed.

## Changes

- Restore `product-acceptance-verifier-maintainer` as an independent black-box
  gate with the exclusive outcomes `PASS`, `FAIL`, and `QUESTION`.
- Restore `rudder-desktop-dev-recovery-maintainer` as the owner of one verified
  development or packaged Desktop recovery, with strict runtime identity.
- Add `rudder-workspace-hygiene-maintainer` for read-only resource audits and
  exact, authorized cleanup.
- Keep release behavior in `release-maintainer`, including separate stable
  publication and production-docs authorization.
- Keep landing screenshot capture as a deterministic helper inside
  `mock-data-maintainer`, not a separate skill.

## Non-Goals

- No wholesale redesign of all current skills in this change.
- No semantic edits to `doc/product/**`.
- No automatic deletion of worktrees, caches, logs, or user data.
- No release or production deployment.

## Verification

- Validate each maintainer skill package and eval name.
- Syntax-check and run the hygiene audit in read-only mode.
- Run release workflow contract tests and repository typecheck.
- Conduct independent skill review and black-box routing checks.
