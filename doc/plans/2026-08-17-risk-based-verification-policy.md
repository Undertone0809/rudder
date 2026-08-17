---
title: Risk-based verification policy
date: 2026-08-17
kind: implementation
status: completed
area: developer_workflow
entities:
  - verification_policy
  - contributor_workflow
issue:
related_plans: []
supersedes: []
related_code:
  - AGENTS.md
  - doc/engineering/DEVELOPING.md
commit_refs: []
updated_at: 2026-08-17
---

# Risk-Based Verification Policy

## Summary

Replace the default full-repository local build requirement with four evidence
strategies: `FULL_GATE`, `SPECIALIZED`, `SCOPED`, and `NO_BUILD`. Keep broad CI
and release gates intact while making local iteration proportional to the
changed surface and reserving independent black-box acceptance for concrete
terminal behavior.

## Problem

The current contributor policy requires full lint, recursive typecheck, all
tests, and a repository build before every hand-off. It also requires distinct
reviewer and verifier agents for nearly every non-trivial task. That combines
iteration checks, domain-specific acceptance, and final integration evidence
into one expensive default even when the change has a bounded or non-executable
surface.

## Scope

- Update `AGENTS.md` with the authoritative classification and escalation rules.
- Add detailed commands, examples, and reporting guidance to
  `doc/engineering/DEVELOPING.md`.
- Preserve current CI, release, Desktop, E2E, and Product Logic gates where
  their owning surfaces are affected.
- Do not modify the pull request template, add CI enforcement, or edit
  `doc/product/**`.

## Implementation Plan

1. Define one primary verification class per final diff, with `FULL_GATE`
   taking precedence and specialized gates added when relevant.
2. Separate fast iteration checks from frozen-candidate acceptance and broad
   CI/release integration evidence.
3. Limit independent verifier use to concrete terminal behavior where the
   environment or state materially affects the claim.
4. Document class-specific commands, escalation triggers, examples, and the
   required hand-off evidence.

## Design Notes

- `SPECIALIZED` is a different evidence shape, not merely a linear intensity
  step between scoped and full verification.
- A visible UI change needs rendered evidence even when it does not need a
  repository build.
- A full gate runs once after the candidate is frozen, not after every edit.
- Candidate or acceptance-packet drift invalidates evidence tied to the old
  candidate.

## Success Criteria

- Contributors can assign one unambiguous primary class to representative
  documentation, package, UI, Desktop, and cross-contract changes.
- The policy states when specialized checks supplement a full gate.
- No rule still requires a full repository build or black-box verifier for all
  non-trivial tasks.
- Release exact-source and broad CI requirements remain unchanged.

## Validation

- Run `git diff --check` for the scoped documentation files.
- Search the resulting policy for contradictory universal full-build or
  verifier requirements.
- Confirm every named command exists in `package.json` or its owning current
  engineering guide.
- Replay representative recent task shapes against the decision order.
- Do not run typecheck, tests, or build; this is a `NO_BUILD` contributor-doc
  change with no executable or product behavior impact.

## Open Issues

- Revisit machine-readable pull request enforcement only after 1-2 weeks of
  observing misclassification, escalation frequency, and CI failures.
