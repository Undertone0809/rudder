---
name: delivery-lifecycle-maintainer
description: "Coordinate complex Rudder delivery when concurrent integration, runtime/data identity, or release gates require a machine-readable evidence packet. Follow AGENTS.md for authorization and review depth. Ordinary docs, skills, localized fixes, and simple Git handoffs do not need this lifecycle."
---

# Delivery Lifecycle Maintainer

Own the root delivery state for one bounded Rudder task. The purpose is to
make the final handoff truthful when implementation, acceptance, integration,
or concurrent work changes the candidate. This is a thin coordinator and
evidence ledger, not another implementation, review, verification, release, or
general Git skill.

## Scope and boundaries

Use this skill when a high-risk task under `AGENTS.md` section 9.1 needs a shared
ledger to keep source, runtime, acceptance, and integration evidence consistent:

```text
intent -> implementation -> review -> black-box acceptance -> integration -> delivered ref
```

It is especially useful for concurrent shared `main` integration, multiple branches,
long-running agents, candidate replacement, budget/deadline changes, or a
handoff that needs exact source and receipt identity.

Crossing two routine stages or encountering unrelated dirty paths alone is not
a trigger. Keep ordinary tasks in a concise change/check/Git handoff. Once a full
packet is warranted, its required identities and validation remain mandatory.

- Preserve the user's raw request, later corrections, non-goals, and explicit
  authorization. Never replace the request with a convenient summary.
- Route implementation to the implementer, product judgment to
  `agent-work-reviewer-maintainer`, black-box terminal observation to
  `product-acceptance-verifier-maintainer`, and public release/publish work to
  `release-maintainer`. Record their receipts; do not impersonate them.
- Do not decide Git conflict meaning, rewrite history, publish, or delete
  external state. When an explicitly authorized local integration is needed,
  record the Git operator's evidence and enforce the identity gates below.
- Do not create a worktree as ceremony. Start from the named checkout/main;
  isolate only after a real conflict, concurrent-write risk, destructive
  operation, or independent build/runtime requirement is observed.
- Reuse the user's existing authorization. A specialist handoff or new workflow
  stage is not another permission boundary. Recoverable failures and stale
  receipts require repair, not an automatic final blocked response.

## Delivery packet

Create one packet from `assets/delivery-packet.template.json` beside the task
evidence. Keep it machine-readable and append corrections, drift events, and
receipts rather than rewriting history. Validate it with:

```bash
python .agents/skills/maintainer/delivery-lifecycle-maintainer/scripts/validate_delivery_packet.py path/to/delivery-packet.json
```

The packet must identify:

- `delivery_id`, one current `owner`, and a legal `status`;
- `intent.raw_request`, ordered `corrections`, non-goals, and authorization;
- the candidate source ref/SHA, branch, dirty/diff fingerprint, changed-path
  scope, build/artifact identity, runtime/process identity, organization/data
  identity, workload/fixture identity, budget/deadline lease, and acceptance
  packet version;
- reviewer, verifier, and final-review receipts, each tied to the exact
  candidate fingerprint, runtime/data identity, and acceptance packet version;
- integration target, base SHA, remote ref and observed remote SHA, patch-tree
  identity, expected-old ref for CAS, and resulting delivered ref/tree;
- preserved unrelated dirty paths plus index/worktree fingerprints; and
- a terminal `delivered_ref` receipt with timestamp, ref, SHA, tree, and proof.

Use stable hashes or explicit `unknown`/`not_applicable` values in ordinary
identity fields. SHA-typed fields are stricter: write a verified 40-character
lowercase SHA, or keep the template's `replace-with-...-sha` placeholder and
block the transition. Never copy an abbreviated or ellipsized ref such as
`8e7c...` into a SHA-typed field; preserve it only as an observation. Run the
validator before presenting the packet. Do not put secrets, cookies, API keys,
or full session contents in the packet.

## Lifecycle

### 1. Normalize intent and ownership

Copy the raw user request verbatim into `intent.raw_request`. Record every
later correction in order, including what it supersedes. Record non-goals and
the exact authority boundary (implementation, local integration, release, or
publication). Assign one root owner and link predecessor/replacement roots;
child agents are evidence contributors, not extra owners.

### 2. Freeze the acceptance candidate

Before review or verification, capture the candidate identity as a tuple:

```text
source ref + commit SHA + scoped dirty/diff fingerprint + changed paths
build/artifact source + runtime/process + organization/data + workload/fixture
acceptance-packet version + budget/deadline lease
```

Write the acceptance packet's state inventory and criteria. For UI, include
the decision sequence, visible/deferred controls, safety-critical context,
focal action or peer choice set, and Back/Cancel/Close/Reopen/draft semantics.
For integration, include the intended target and base before asking for a
review or verifier run.

### 3. Gate independent receipts

Ask the reviewer for the stage or final verdict, and ask the verifier for
`PASS`, `FAIL`, or `QUESTION` on the same frozen tuple. A final handoff also
needs reviewer `accept`. Keep author-claimed checks separate from independent
receipts. Missing, conditional, stale, or mismatched evidence blocks the next
transition; it never becomes a soft warning.

### 4. Detect drift and invalidate

Re-capture the tuple immediately before integration and handoff. Invalidate
affected receipts when any relevant source SHA, dirty/diff fingerprint,
changed path, build/artifact, runtime/process, organization/data,
acceptance-packet criterion, workload, budget, deadline, target, base, or
remote ref changes. Append a drift event explaining the before/after identity
and mark the old receipts `invalidated`; do not reuse an old `PASS` or
`accept`.

Record the new identities. Rebuild/restart and rerun verification only for
affected behavior, then obtain final review for the current candidate. For
content-equivalent metadata/ref changes, document equivalence and rebind the
receipt with the issuing agent; do not copy mismatched identities into a packet
or replay unrelated product journeys. Recheck exact-source CI for releases.

### 5. Integrate main-first, then recheck

For an explicitly authorized local integration:

1. Inspect current target `main`, remote ref/SHA, branch tips, and the dirty
   path/index baseline. Record all six (or however many) candidate branch refs
   rather than collapsing them into “the branches”.
2. Attempt the smallest direct main-first operation. If it is conflict-free
   and no concurrent-write/destructive risk exists, keep the named checkout.
3. On a real conflict or risk trigger, create a detached isolated worktree and
   perform the merge/rebase there. Validate the exact candidate tree, tests,
   and receipts before touching the shared ref.
4. Use compare-and-swap semantics against the recorded expected-old target
   SHA. If the target or remote moved, stop, record non-fast-forward/drift,
   refreeze against the new base, and reverify. Never silently merge onto a
   newer target.
5. Never run `git read-tree` against the shared checkout's live index. A ref
   update does not require an index update. If a disposable index view is
   needed for comparison, set `GIT_INDEX_FILE` to an explicit temporary path,
   initialize and inspect only that alternate index, then discard it. Record
   `index_update_mode` as `none` or `alternate_index`; any live-index mutation
   blocks delivery. Verify that unrelated dirty paths and the original index
   fingerprint remain preserved; an inconclusive digest is not proof.

This skill records integration identity and gates the transition. It does not
resolve conflicts by taste, choose release channels, or push/publish without
the corresponding authority and specialist skill.

### 6. Close with a terminal receipt

Mark `delivered` only when the exact current candidate has current reviewer
`accept`, verifier `PASS`, final review `accept`, a successful authorized
integration/ref update, and preservation evidence. The terminal receipt must
name the delivered ref/SHA/tree, target/base/remote observations, packet
version, and verification time. Otherwise return `blocked` or `invalidated`
with the precise missing transition and next owner.

## State and fail-closed rules

Legal states are `draft`, `in_progress`, `review_ready`,
`acceptance_pending`, `integration_pending`, `delivered`, `blocked`, and
`invalidated`. A packet cannot be `delivered` when:

- any receipt is missing, invalidated, expired, or tied to another identity;
- a candidate, budget/deadline lease, acceptance criterion, runtime/data
  identity, target/base, or remote ref moved after the last receipt;
- the integration CAS did not compare against the recorded expected-old SHA;
- unrelated dirty paths or the index were overwritten or not independently
  checked; or
- the delivered ref/SHA/tree receipt is absent.

When a transition is blocked, repair it within scope and continue independent
work. Return a blocked handoff only when a specific external decision or resource
prevents useful progress. Preserve the packet and evidence; do not claim readiness.

## Handoff format

Always emit or save the complete JSON delivery packet, including for
`blocked` and `invalidated` outcomes, and run the validator before handoff.
Unknown required identities remain valid template placeholders and blockers;
they are not a reason to omit the packet. The human-readable summary below is
required in addition to the JSON packet, never as its replacement.

```text
RESULT: DELIVERED | BLOCKED | INVALIDATED
Delivery packet: <path and version>
Intent/corrections: <raw request preserved; latest correction>
Candidate: <source SHA, dirty/diff, build/runtime/data identity>
Receipts: <reviewer / verifier / final review and freshness>
Integration: <target, base, remote, patch tree, CAS result>
Preservation: <dirty paths and index evidence>
Delivered ref: <ref, SHA, tree, timestamp or not applicable>
Next owner/blocker: <one concrete transition>
```
