---
title: Risk-based verification and contributor routing
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
  - doc/engineering/LOCAL-DEVELOPMENT.md
  - doc/engineering/ARCHITECTURE-GUARDRAILS.md
  - doc/engineering/PERFORMANCE.md
commit_refs: []
updated_at: 2026-08-17
---

# Risk-Based Verification And Contributor Routing

## Summary

Replace the default full-repository local build requirement with four evidence
strategies: `FULL_GATE`, `SPECIALIZED`, `SCOPED`, and `NO_BUILD`. Keep broad CI
and release gates intact while making local iteration proportional to the
changed surface and reserving independent black-box acceptance for concrete
terminal behavior.

Make `AGENTS.md` the only authoritative contributor workflow. Retain
`doc/engineering/DEVELOPING.md` as a compatibility link for historical
references, not as a second policy or development entrypoint.

## Problem

The current contributor policy requires full lint, recursive typecheck, all
tests, and a repository build before every hand-off. It also requires distinct
reviewer and verifier agents for nearly every non-trivial task. That combines
iteration checks, domain-specific acceptance, and final integration evidence
into one expensive default even when the change has a bounded or non-executable
surface.

## Scope

- Update `AGENTS.md` with the authoritative classification and escalation rules.
- Route local setup, architecture checks, and performance constraints to
  focused engineering guides.
- Move plan metadata ownership to `doc/plans/_template.md` and
  `doc/plans/_taxonomy.md`.
- Keep `doc/engineering/DEVELOPING.md` only as a compatibility route map.
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
4. Remove duplicate workflow policy from `DEVELOPING.md` and route each
   engineering topic directly from `AGENTS.md` and `doc/README.md`.

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
- Active contributor routes point to `AGENTS.md` or a focused engineering
  guide; `DEVELOPING.md` contains no independent policy.
- Release exact-source and broad CI requirements remain unchanged.

## Validation

- Run `git diff --check` for the scoped documentation files.
- Search the resulting policy for contradictory universal full-build or
  verifier requirements.
- Confirm active contributor routes point to `AGENTS.md` or focused guides,
  with `DEVELOPING.md` used only for compatibility.
- Run `pnpm docs:integrity` and `pnpm docs:alignment`.
- Confirm every named command exists in `package.json` or its owning current
  engineering guide.
- Replay representative recent task shapes against the decision order.
- Do not run typecheck, tests, or build; this is a `NO_BUILD` contributor-doc
  change with no executable or product behavior impact.

## Open Issues

- Revisit machine-readable pull request enforcement only after 1-2 weeks of
  observing misclassification, escalation frequency, and CI failures.
