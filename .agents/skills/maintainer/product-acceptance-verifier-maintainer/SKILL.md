---
name: product-acceptance-verifier-maintainer
description: "Use after implementation when Rudder needs independent black-box acceptance of a concrete terminal UI, Desktop, CLI, runtime, integration, or release outcome. Returns exactly PASS, FAIL, or QUESTION. Do not use for code review, root-cause diagnosis, or ordinary unit/integration/focused test execution without a public terminal surface."
---

# Product Acceptance Verifier Maintainer

Separate passing implementation checks from an observed product outcome.

## Exclusive Outcome

End with exactly one verdict:

- `PASS`: the requested terminal behavior was observed in the required
  environment, including the highest-risk adjacent state.
- `FAIL`: the terminal behavior was observed and contradicted the acceptance
  criteria.
- `QUESTION`: required authority, environment, data, or observable evidence is
  missing, so a truthful verdict is not possible.

Do not edit source, repair the implementation, reinterpret failing acceptance
as success, or return a fourth outcome.

## First-Principles Boundary

Use this skill only when all of these are true:

1. There is a concrete terminal behavior to accept.
2. Independent observation is materially stronger than the author's tests.
3. The environment or state matters to the claim.

Do not use it for code review, ordinary test execution, root-cause diagnosis,
or generic “looks good” confirmation.

## Procedure

1. Rewrite the request as observable acceptance criteria.
   Freeze them before execution. Rebaseline only from the user, an owning
   product contract, or a recorded product decision—not from an author reacting
   to failed evidence.
2. Resolve the required target before mutating anything: environment,
   organization/account, runtime instance, data, build/version, and visible
   surface.
3. Classify evidence as terminal, supporting, or missing.
4. Reproduce through the same public surface a user would use.
5. Exercise the highest-risk adjacent state: permissions, organization
   boundary, persistence, volume/date ordering, restart, async completion, or
   failure recovery, as applicable.
6. Preserve concrete evidence: commands, runtime identity, inputs, observed
   output, and screenshots for visible UI.
7. Return one exclusive verdict and the shortest evidence chain that proves it.

## Real-Environment Rule

A disposable Rudder instance with real API, PostgreSQL, runtime, and terminal
UI can prove a generic “real local” claim. Mocks, test doubles, code inspection,
and lower-level tests cannot substitute for terminal observation.

Unit, integration, service, and focused E2E tests are supporting evidence only
unless they drive the same public terminal surface and environment named by the
acceptance criteria. If no qualifying terminal surface can be observed, return
`QUESTION`; never turn a green lower-level suite into `PASS`.

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
Target:
Acceptance criteria:
Observed:
Adjacent risk checked:
Supporting evidence:
Missing or blocked:
```

Use [`evals/evals.json`](evals/evals.json) for routing, proof, authority, and
criterion-freeze regressions.
