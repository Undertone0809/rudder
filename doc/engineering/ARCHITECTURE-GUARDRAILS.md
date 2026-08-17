# Architecture Guardrails

Use this guide when a change affects module boundaries, public facades,
oversized production files, critical ordering, compatibility logic, or runtime
prompt assembly. Verification class selection remains in `AGENTS.md`.

## Reasoning Comments

Add concise reasoning comments when a business-critical path is policy-driven,
ordering-sensitive, or intentionally backward-compatible.

- Place the comment near the key branch or assembly logic.
- Explain why the order or tradeoff exists, not what each statement does.
- Link a plan or product contract when the decision originates there.

Recommended shape:

```ts
/**
 * Short description of the behavior and ordering.
 *
 * Reasoning:
 * - Why this branch or order is intentional.
 * - Which compatibility or product tradeoff it preserves.
 *
 * Traceability:
 * - doc/plans/YYYY-MM-DD-topic.md
 */
```

For runtime prompt assembly:

- document the order of bootstrap, handoff, runtime notes, and heartbeat input;
- include a concrete assembled-prompt example near ordering-sensitive code;
- explain why assignment/mention wake sources receive their specific context;
- preserve context continuity for recovery runs instead of rebuilding a lossy
  wakeup;
- inject mode- or state-specific sections only when active;
- keep the always-loaded prompt limited to invariants;
- prefer base prompt plus conditional sections over dormant `when X` branches;
- allow discovery metadata to say `use when`, but keep runtime prompts focused
  on the active mode and state;
- keep organization resources queryable and inject project-attached resources
  by default rather than the entire organization catalog.

## Architecture Ratchet

CI runs architecture checks in a separate Ubuntu job without installing
workspace dependencies. It fetches full Git history, runs zero-dependency
fixtures, validates the oversized-debt inventory, checks declared domain
cycles and facade bypasses, and rejects production files that newly cross or
grow beyond the line-count ceiling.

Comparison refs depend on the event:

- pull requests compare with the pull request base SHA;
- pushes to `main` compare with the event `before` SHA;
- manual runs compare with `HEAD^` when a parent exists;
- initial pushes without a parent comparison report an explicit skip.

Do not compare a `main` push with `origin/main`; after checkout that ref may
equal `HEAD`, making the ratchet vacuous. Reproduce the gate with a concrete
clean base:

```sh
pnpm architecture:audit:test
pnpm architecture:boundaries
node scripts/architecture-audit.mjs \
  --baseline scripts/architecture-audit-baseline.json \
  --compare-ref <base-commit> \
  --fail-on-regression
```

`pnpm architecture:audit:check` is the convenience command for branches whose
clean target is `origin/main`. Use the explicit command for stacked branches or
another target.

## Oversized-Debt Inventory

Every production file over the ceiling needs `owner`, `rationale`, `target`,
and `expiry` metadata. Missing, duplicate, stale, or expired entries fail the
check. An exception allowance cannot grow above the same path's clean-baseline
allowance, so editing inventory cannot hide new debt.

A newly discovered historical oversized path uses the `maxLines + 1` sentinel.
The clean comparison ref, rather than old inventory line counts, determines
whether unchanged historical debt blocks CI.

`scripts/architecture-boundaries.json` intentionally uses
`scope: declared-only`. Declared Collaboration, Execution, and Rudder modules
have enforced cycle and public-facade rules. `observed` paths are migration
inventory only; a green check does not claim the whole repository has no
bypasses. Add a domain to enforced scope only after public entrypoints are
stable, and include a fixture when checker behavior changes.
