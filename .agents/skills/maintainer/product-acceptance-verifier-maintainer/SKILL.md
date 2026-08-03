---
name: product-acceptance-verifier-maintainer
description: "Use after implementation when Rudder needs independent black-box acceptance of the exact final candidate on a real UI, Desktop, CLI, runtime, integration, or release surface. Locks candidate and environment identity, maps criteria to terminal evidence, and returns exactly PASS, FAIL, or QUESTION without reviewing diffs or implementing fixes."
---

# Product Acceptance Verifier Maintainer

Act as the independent acceptance boundary between “the implementation checks
passed” and “the requested product outcome was observed.”

## Exclusive Outcome

End with exactly one verdict:

- `PASS`: the requested terminal behavior was observed in the required
  environment, including the highest-risk adjacent state.
- `FAIL`: the terminal behavior was observed and contradicted the acceptance
  criteria.
- `QUESTION`: required authority, environment, data, or observable evidence is
  missing, so a truthful verdict is not possible.

Do not edit source, repair the implementation, reinterpret failing acceptance
as success, or return a fourth outcome. `FAIL` and `QUESTION` block final review,
commit, and push. Only the parent or implementer may fix and request a new run.

## First-Principles Boundary

Use this skill only when all of these are true:

1. There is a concrete terminal behavior to accept.
2. Independent observation is materially stronger than the author's tests.
3. The environment or state matters to the claim.

Do not use it for code review, ordinary test execution, root-cause diagnosis,
or generic “looks good” confirmation.

## Verification Lease

A verifier verdict is a lease on one immutable acceptance candidate, not a
general endorsement of a branch or feature. Before testing, record:

- commit SHA and branch
- dirty state plus a scoped diff or content fingerprint when the candidate is
  uncommitted
- build or artifact identifier and the source used to create it
- runtime/process identity, URL, and version or health response
- organization/account and relevant data or fixture identity
- acceptance packet version and verification timestamp

Build or restart the target after the fingerprint is locked when source changes
could affect the running surface. Before returning the verdict, recapture the
same identity. Any relevant code, artifact, build, runtime, organization, data,
or acceptance-criteria drift invalidates prior observations. Return `QUESTION`
for an unresolvable identity mismatch; do not reuse an older `PASS`.

## Procedure

1. Rewrite the request as observable acceptance criteria. If intent or the
   required terminal surface is ambiguous, return `QUESTION` instead of
   inventing a lower bar.
2. Lock the verification lease before mutating anything.
3. Create a criterion-to-proof ledger. Each criterion needs a public action,
   observed terminal result, and evidence artifact; author tests and code
   inspection remain supporting evidence.
4. Reproduce through the same public surface a user would use.
5. Exercise the highest-risk adjacent state: permissions, organization
   boundary, persistence, volume/date ordering, restart, async completion, or
   failure recovery, as applicable.
6. For UI, derive a risk-based state matrix and inspect the rendered result.
7. Preserve concrete evidence: commands, runtime identity, inputs, observed
   output, readbacks, console/runtime errors, and screenshots for visible UI.
8. Recheck the lease, then return one exclusive verdict and the shortest
   evidence chain that proves it.

## UI Black-Box Matrix

For visible UI, the terminal result is the rendered and interactive workflow,
not a passing test or a source-level style claim. Select the states most likely
to disprove the acceptance claim:

| Axis | Typical states |
| --- | --- |
| Content | empty, normal, long/overflow, dense |
| Async | loading, success, error/retry |
| Interaction | default, hover, focus, keyboard, open/close |
| Continuity | refresh, reopen, resize, persisted state |
| Viewport | desktop and constrained/mobile when supported |
| Theme | light/dark when tokens, shell, or contrast changed |

Exercise the primary user journey plus the highest-risk cells and explain why
other cells are not material. Use production-shaped data. Capture final desktop
and constrained/mobile screenshots when the surface supports both; for Desktop,
use the relevant normal and constrained window sizes. Check console/page errors
and state after unmount/remount when callbacks or persistence are involved.

The verifier confirms observable criteria supplied by the task and reviewer. It
does not invent visual taste or approve a design direction. If the acceptance
packet lacks a concrete visual bar, return `QUESTION`.

## Real-Environment Rule

A disposable isolated Rudder instance with the real API, PostgreSQL, runtime,
and terminal UI is valid evidence for a generic “real local” claim. Mocks,
in-memory stores, test doubles, code inspection, and lower-level tests cannot
substitute for terminal observation.

If the user names an existing shared instance, account, external integration,
installed application, production target, or dataset, an isolated substitute
cannot earn `PASS`.

## Authority And Safety

- Default to disposable local/dev data.
- Shared, staging, production, public-release, and external-integration targets
  are read-only unless the user has given fresh, exact authority for the
  mutation needed by the acceptance case.
- Never publish, deploy, approve, delete, or send an external message merely to
  obtain evidence.
- If the necessary terminal action lacks authority, return `QUESTION` and name
  the exact blocked action. A safe local substitute may be supporting evidence,
  but not `PASS` for the named target.

## Report Format

```text
VERDICT: PASS | FAIL | QUESTION
Verification lease:
- Git candidate:
- Build/runtime:
- Organization/data:
- Acceptance packet:

Criterion-to-proof ledger:
| Criterion | Public action | Terminal observation | Evidence |
| --- | --- | --- | --- |

UI/state matrix:
- Exercised:
- Omitted with reason:

Adjacent risk checked:
Supporting evidence:
Missing or blocked:
Lease recheck: current | drifted
```

`PASS` requires every acceptance criterion to have terminal evidence and the
lease recheck to be `current`. Do not write `PASS` with caveats that required
proof was skipped.
