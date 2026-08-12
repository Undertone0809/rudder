---
title: Unified Requests And Issue Block Audit
date: 2026-08-11
kind: proposal
status: completed
area: api
entities:
  - request_workflow
  - issue_block_audit
  - messenger_attention
  - issue_reviewer
issue:
related_plans:
  - 2026-04-28-chat-plan-mode-request-user-input.md
  - 2026-05-02-issue-add-reviewer-proposal.md
  - 2026-04-24-passive-issue-closeout-watchdog.md
  - 2026-04-10-messenger-unification.md
supersedes: []
related_code:
  - packages/db/src/schema/approvals.ts
  - packages/db/src/schema/issue_approvals.ts
  - packages/shared/src/constants.ts
  - packages/shared/src/types/approval.ts
  - packages/shared/src/types/messenger.ts
  - packages/shared/src/validators/approval.ts
  - packages/shared/src/validators/issue.ts
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - packages/agent-runtime-utils/src/rudder-mcp-contract.ts
  - server/src/routes/approvals.ts
  - server/src/routes/issues.mutations.ts
  - server/src/services/messenger.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
  - server/src/services/runtime-kernel/heartbeat.sessions.ts
  - ui/src/components/ApprovalCard.tsx
  - ui/src/components/AssistanceRequestPanel.tsx
  - ui/src/pages/Inbox.tsx
  - ui/src/pages/Messenger.tsx
commit_refs: []
updated_at: 2026-08-11
---

# Unified Requests And Issue Block Audit

## Proposal Delta: Issue-Inline Request Handling

An Assistance Request linked to an Issue is one durable object with two equal
operator entry points: the Requests thread and the Issue detail. The Issue
surface must not reduce the Request to a redirect. While the Request is open,
the operator can answer it, mark the external action complete, report that they
cannot help, or cancel it directly on the Issue. Both entry points call the same
Request API and render the same persisted state.

While the Request is open, its decision card replaces the Issue comment
composer at the bottom of Activity. This keeps the operator's current decision
at the natural response point without adding another persistent panel above the
Issue content. After resolution, cancellation, or supersession, the normal
comment composer returns. The terminal Request remains available in Activity
and Requests as durable evidence; there is no separate Issue-local copy.

Request messages show the requesting Agent's own avatar and a source link to
the Issue or Chat where the Request originated. V1 Assistance Requests are
Issue-backed, while the card contract accepts a generic source label and href
so Chat-backed Requests can use the same presentation later.

### Special message card language

Requests and Failed Runs use one reusable special-message card instead of
independent object-card treatments. The card follows a stable three-part
anatomy inspired by Feishu's lightweight interactive cards:

1. A tinted semantic header containing the title and compact status context.
2. A neutral, readable body containing the description and source context.
3. A separated footer containing the current action or peer action set.

The supported semantic variants are `info` (blue, attention or action needed),
`success` (green, completed), and `error` (red, failed or unable to continue).
Color reinforces meaning but never carries status alone. UI Lab documents all
three variants, long-content behavior, and action-footer states.

An open Assistance Request may retain its input-oriented title. A terminal
card must replace that title with the observed outcome, such as `Response
received`, `Action completed`, or `Request cancelled`; it must never continue
to say that input is needed. Block Audit attempt counts remain durable runtime
evidence but are not rendered in the operator card.

Issue Activity uses a virtualized timeline for long histories. Deep links,
viewport resizing, and screenshot capture must retain enough rows above the
viewport to avoid a blank leading region. The timeline keeps an explicit
upward render runway while preserving the target comment and fixed composer.

### Compact state inventory

| State | Current decision | Visible controls | Deferred controls | Continuity |
| --- | --- | --- | --- | --- |
| Open | Provide the requested input or action outcome | Request card in the Activity composer slot; response field; Send answer; Mark action complete; Cannot help; Cancel request | Normal comment composer and later workflow controls | Unsent text is stored locally by Request ID across refresh; terminal state comes from the Request record |
| Submitting | Wait for the selected Request mutation | Disabled peer actions and stable panel dimensions | Further submissions | Success updates both entry points; failure preserves input and exposes an error toast |
| Resolved | Continue normal Issue discussion; inspect Request history when needed | Normal comment composer; terminal record in Activity and Requests | All Request mutation controls | Refresh and reopen preserve the server-backed terminal state |
| Cancelled or superseded | Continue normal Issue discussion; inspect why the Request ended | Normal comment composer; terminal record in Activity and Requests | All Request mutation controls | A later Request is a new durable object; the old record is not reopened |

The panel presents one decision at a time. `Send answer` requires a response;
the other typed outcomes may use concise defaults when the operator provides no
text. The secondary Requests link remains available for surrounding history,
but is not required to complete the Request.

## Overview

Unify Rudder's operator-facing request semantics and make `blocked` an
evidence-backed Issue conclusion instead of an Agent's first-error escape
hatch.

The product-level hierarchy is:

```text
Attention (derived operator projection)
└── Request (durable interaction)
    ├── Approval (authorize a governed action)
    └── Assistance (provide input or complete a human/external action)
```

Issue status remains separate from Request state. An Assistance Request can be
open while an Issue is still `in_progress`; `blocked` is reached only after the
same blocker survives the bounded audit and no meaningful Agent progress is
possible without user input or an external-state change.

This proposal adapts the Codex Goal continuation rule to Rudder's existing
Issue execution loop:

- the first blocked claim records evidence and keeps the Issue active;
- the original Run plus the two existing passive follow-up continuations form
  the three eligible audit opportunities;
- only the third consecutive matching blocked claim may persist `blocked`;
- resolving the Request resumes the same assignee and starts a fresh audit.

The Agent-facing contract remains intentionally small: state the blocker and
the exact human input or action required. Rudder derives actor, Run, Issue,
lineage, attempt number, deduplication identity, and evidence references.

## What Is The Problem?

### Current state

- `issue.block` directly changes an Issue to `blocked` when an Agent supplies a
  comment.
- Runtime instructions present `blocked` as a peer close-out signal beside
  progress, done, handoff, and review.
- Moving an Issue to `blocked` can immediately wake its reviewer.
- Approvals are a governed-action boundary with approve/reject semantics and
  action-application side effects.
- Messenger exposes a synthetic Approvals thread, while other operator needs
  appear through separate issue, run, budget, and review projections.
- Passive Issue close-out already provides bounded continuation attempts when
  an Agent Run finishes without a durable close-out signal.

### Problem

The first tool, environment, or workflow failure can become a durable
responsibility transfer. The control plane makes `blocked` cheap and visible,
while no equally explicit contract requires a materially different recovery
attempt first.

Treating the remedy as a Block Approval would create a second semantic error:
the operator is normally not authorizing a governed mutation. The Agent is
asking the operator to answer a question, perform an external action, or change
external state. Approving such a request would imply authority that the
response does not grant.

### Impact

- recoverable failures become human backlog;
- operators receive repeated or low-signal blocked notifications;
- approval metrics mix authorization with assistance;
- reviewer routing can duplicate the human attention already requested;
- blocked counts cannot distinguish validated impasses from early exits;
- Agent capability changes cannot be benchmarked against a stable lifecycle
  invariant.

## Product Decisions

### Request is the umbrella object

The UI, Messenger thread, Inbox aggregation, activity copy, and read API use
`Request` terminology. Approval remains a subtype with its existing governed
action semantics.

V1 request subtypes:

| Subtype | Meaning | Operator resolution |
| --- | --- | --- |
| `approval` | authorize or reject a governed action | approve, reject, request revision |
| `assistance` | provide input or complete a human/external action | answer/complete, cannot help |

Review stays on the existing reviewer routing and structured review-decision
contract. V1 does not create a generic Review Request subtype.

### Shared lifecycle, subtype-specific resolution

The shared lifecycle is:

```text
open -> resolved
     -> cancelled
     -> superseded
```

Resolution remains typed:

- Approval: `approved`, `rejected`, or `revision_requested`;
- Assistance: `answered`, `action_completed`, or `cannot_help`.

This avoids presenting approve/reject controls for a task that is not an
authorization decision. Assistance resolution never grants permission for a
later governed action.

### Compatibility shape

V1 keeps the physical `approvals` table and existing `/approvals` endpoints as
an Approval compatibility layer. It adds a normalized Request API and Request
projection used by Messenger/Inbox. Assistance requests use the common
persistence envelope with an explicit request kind and subtype-specific
resolution handler.

The compatibility layer must reject Assistance records at approve/reject
endpoints. The Request service must never call the existing generic Approval
application path for Assistance.

### Block Audit

`blocked` is permitted for an assignee Agent only when all conditions are true:

1. The same normalized blocker fingerprint appears in three consecutive
   eligible Issue execution attempts.
2. The original Agent Run counts as attempt one; passive follow-up Runs count
   as attempts two and three.
3. Each attempt ends with an explicit blocked claim for the same root Issue.
4. The Agent cannot make meaningful progress without user input or an
   external-state change.
5. The claim identifies an exact human input or action.

An eligible attempt is a terminal Issue execution Run owned by the current
assignee and organization. Tool calls, comments, repeated MCP calls inside one
Run, reviewer Runs, and unrelated assignment Runs are not attempts.

The consecutive counter resets when:

- the normalized blocker fingerprint changes;
- the Issue records material progress;
- the Assistance Request is resolved, cancelled, or superseded;
- the Issue is reassigned;
- relevant external state changes;
- a later Run completes or moves the Issue forward instead of claiming the
  same block.

The following governed stops remain outside ordinary Block Audit counting:

- an existing pending or denied Approval;
- a permission or authentication boundary represented by its owning policy;
- a budget hard stop;
- user cancellation;
- runtime safety stop;
- an explicit board/manual status transition.

They must not create a nested Block Approval or duplicate Assistance Request.

### First and second blocked claims

On claims one and two:

- keep the Issue `in_progress`;
- create or reuse one open Assistance Request;
- persist the audit attempt and causal Run reference;
- return an Agent-visible result explaining that the block is not yet
  established and bounded recovery must continue;
- allow the existing passive close-out continuation to provide the next audit
  opportunity;
- do not wake the reviewer merely because an audit is pending.

The UI derives `waiting_on_human` from the open Assistance Request and displays
`In progress · Waiting on you`.

### Third blocked claim

On the third consecutive matching claim:

- atomically persist `blocked`;
- retain exactly one open Assistance Request;
- link the Request to all three audit attempts and the root Issue;
- release the execution lease and suppress further passive follow-up;
- route operator attention once;
- preserve existing reviewer routing only for reviewer-owned review decisions,
  not as a duplicate assignee-block notification.

The UI displays `Blocked · Waiting on you`.

### Assistance resolution

When the operator answers or confirms the external action:

- resolve the Request with typed resolution and operator evidence;
- clear the derived waiting facet before wakeup;
- move a linked `blocked` Issue to `in_progress` when it still has an assignee,
  otherwise `todo`;
- reset the Block Audit lineage;
- wake the same assignee exactly once with the response and causal Request;
- never wake a stale previous assignee after reassignment.

`cannot_help` closes the Request and leaves an already blocked Issue blocked.
For an Issue that has not reached the third audit claim, `cannot_help` does not
silently force `blocked`; the bounded audit or an explicit board action still
owns that transition.

### Deduplication and races

- At most one open Assistance Request may exist for an Issue and blocker
  lineage.
- Repeating the same request returns the existing object and does not create a
  second badge, notification, or wakeup.
- Issue completion, cancellation, reassignment, manual blocking, or a new
  blocker lineage supersedes stale open Requests atomically.
- Resolve/cancel/supersede/manual-status races are idempotent. A stale Request
  cannot apply after its Issue lineage changes.
- Request resolution clears the pending facet before enqueueing the wake.
- Request expiry never auto-approves, auto-blocks, or silently reactivates an
  Issue. V1 marks stale attention and emits one escalation signal only.

## What Will Be Changed?

1. Add shared Request types, constants, validators, and API paths while keeping
   Approval aliases compatible.
2. Extend request persistence with request kind, typed resolution, dedupe key,
   Issue/run/agent lineage, and timestamps needed for idempotency.
3. Add Issue Block Audit attempt persistence with organization, Issue, Agent,
   Run, root Run, canonical fingerprint, eligibility, ordinal, and evidence.
4. Intercept assignee-Agent `status: blocked` mutations and apply the audit
   policy before Issue status changes.
5. Add Request create/list/detail/resolve/cancel APIs with organization and
   actor enforcement.
6. Expose an Agent capability for Assistance Request creation with only reason
   and exact human action/input.
7. Update runtime prompt and bundled Rudder references so Agents recover before
   blocking and use Requests for human-only dependencies.
8. Rename the Messenger synthetic Approvals destination to Requests and render
   Approval and Assistance cards with subtype-correct controls.
9. Add Issue waiting facets and Request evidence to Issue detail and activity.
10. Extend Run Intelligence and eval packets with Block Audit/Request events.
11. Preserve old `/messenger/approvals` and `/approvals` routes as compatibility
    aliases where their Approval-only behavior remains valid.

## Success Criteria For Change

- The first and second matching Agent blocked claims do not persist `blocked`.
- The third consecutive eligible matching claim persists `blocked` exactly
  once.
- A changed blocker or material progress resets the audit.
- One open Assistance Request is visible across Issue detail, Requests, Inbox,
  and Messenger without duplicate attention.
- Approval cards still approve/reject governed actions and existing callers
  remain compatible.
- Assistance cards never show approve/reject controls.
- Assistance resolution resumes the same current assignee exactly once and
  starts a fresh Block Audit.
- `cannot_help` never becomes an early automatic block escape hatch.
- Approval, permission, budget, cancellation, and safety boundaries do not
  produce nested Requests.
- Reviewer decisions remain structured and reviewer routing is not duplicated.
- Organization and actor boundaries are enforced for every Request mutation.
- Request and audit events are observable in activity, Run Intelligence, and
  benchmark artifacts.

## Out Of Scope

- Replacing reviewer routing with a Request subtype.
- Multiple simultaneous Assistance Requests for one Issue.
- Automatic Request approval or block on timeout.
- Natural-language semantic classification using a remote model.
- A general external ticketing or support-request system.
- Migrating or renaming the physical `approvals` table in V1.
- Changing budget, permission, cancellation, or safety stop ownership.
- Editing the guarded Product Logic Registry without explicit authorization.

## Non-Functional Requirements

- **Atomicity:** request, audit, Issue state, activity, and wakeup intent must
  not expose partially applied transitions.
- **Idempotency:** retries and duplicate Agent calls must converge on one
  Request, one status effect, and at most one resume wake.
- **Organization isolation:** all reads and writes include organization scope;
  linked Issue, Run, Agent, requester, and resolver must belong to it.
- **Authority:** only human board actors with the owning permission can resolve
  Approvals. Assistance responses do not grant mutation authority.
- **Privacy:** secrets and credentials are never stored in Request payload or
  activity. Existing redaction applies to all operator-visible projections.
- **Bounded work:** three eligible attempts are the default hard ceiling for
  one blocker lineage; passive follow-up remains bounded and timer work is
  suppressed after durable `blocked`.
- **Observability:** ordered events preserve attempt number, fingerprint,
  Request identity, status before/after, and causal Run lineage.
- **Usability:** top-level cards state one decision and expose only controls
  relevant to that decision.

## User Experience Walkthrough

### Recoverable failure

1. The assignee Agent encounters a browser failure.
2. It tries a materially different path and verifies the result.
3. If it succeeds, the Issue proceeds normally and no Request is created.
4. If it claims blocked, Rudder records audit attempt one, creates one
   Assistance Request, and keeps the Issue `in_progress`.
5. The existing bounded continuation wakes the Agent with the same Issue and
   Request evidence.
6. If the Agent finds a working path, the Request is superseded and the audit
   resets.
7. If the identical blocker survives three eligible attempts, Rudder marks the
   Issue `blocked` and keeps the same Request waiting for the operator.

### Human-only dependency

1. The Agent proves that a user-only action is required and submits the reason
   plus exact action.
2. Requests shows `Agent needs your help`; the Issue displays
   `In progress · Waiting on you` before the Block Audit threshold.
3. The operator completes the action and selects `I've done this`, or answers
   the requested input.
4. Rudder resolves the Request, clears waiting state, and wakes the same Agent
   once with the response.
5. The Agent verifies the external change and continues.

### Governed action

1. The Agent proposes a high-impact action.
2. Requests shows an Approval card with Approve, Reject, and Request changes.
3. Approval applies only its owning governed action.
4. It does not count as a Block Audit attempt or create an Assistance Request.

### Unable to help

1. The operator opens the Assistance Request.
2. The operator selects `Can't help` and supplies a short reason.
3. The Request closes with `cannot_help`.
4. An already blocked Issue remains blocked. A pre-threshold Issue does not
   become blocked solely because the operator cannot help.

## UI State Inventory

| State | Primary decision | Visible controls | Deferred controls | Safety context | Back/close behavior |
| --- | --- | --- | --- | --- | --- |
| Requests list | choose a Request | filters, row open | resolution actions | subtype, requester, age, Issue | preserves filter and scroll |
| Approval detail open | authorize the named action | Approve, Reject, Request changes | later action-specific fields | exact governed effect | Close returns to list; draft note retained |
| Assistance detail open | provide the requested help | answer or I've done this, Can't help | raw audit evidence | Issue, Agent, requested action | Close keeps Request open and draft retained |
| Assistance resolving | confirm one response | Submit, Cancel | unrelated Issue controls | response destination and resume effect | Cancel returns to open Request |
| Waiting pre-threshold | understand who acts next | Open Request | Blocked actions | attempt n/3 and next continuation | Issue remains in progress |
| Blocked with Request | unblock or report inability | Open Request | ordinary Run controls | three-attempt evidence | Issue remains blocked until resolved/manual action |
| Resolved | inspect outcome | Open Issue/Run | mutation controls | resolver and resumed Run | read-only history |

## Implementation

### Product Or Technical Architecture Changes

The implementation has four ownership layers:

1. **Request service** owns common persistence, subtype validation, dedupe,
   comments, typed resolution, organization checks, and activity.
2. **Approval adapter** owns existing governed-action application and projects
   Approval records into Request responses.
3. **Block Audit service** owns attempt eligibility, lineage, fingerprint,
   reset, threshold, Issue transition, and Assistance creation/reuse.
4. **Attention projections** own Messenger/Inbox/UI aggregation and never
   infer authorization from a generic Request resolution.

The issue mutation route delegates Agent `blocked` claims to Block Audit. Board
manual blocking retains the explicit direct path. Reviewer decisions retain
their current structured route and are not counted as assignee attempts.

The existing passive follow-up context supplies bounded attempt identity. The
audit service persists its own attempt rows rather than reconstructing the
threshold later from comments or transcript text.

### Data Model

Request envelope additions:

- `request_kind`: `approval | assistance`;
- `request_status`: common open/resolved/cancelled/superseded projection;
- `resolution_kind`: subtype-specific terminal result;
- `dedupe_key`: server-derived stable key;
- `resolved_by_user_id`, `resolved_at`;
- compatibility mapping to existing Approval status fields.

Block Audit attempt:

- organization, Issue, assignee Agent, source Run, root Run;
- normalized blocker fingerprint and redacted summary;
- eligible ordinal and threshold;
- Assistance Request reference;
- status before/after and reset/supersede reason;
- created timestamp.

The exact migration may use additive columns on the existing Approval envelope
for compatibility, but all new code uses Request terminology outside the
Approval adapter.

### Fingerprint

V1 uses a deterministic, server-owned canonical fingerprint assembled from:

- root Issue identity;
- normalized failure/operation class available from Run context;
- normalized blocker reason and requested human action;
- relevant governed-stop classification.

Raw error strings, timestamps, paths, UUIDs, ports, and retry numbers are
normalized before hashing. Fingerprint derivation is unit tested. Agents do
not submit or override the fingerprint.

### Breaking Change

No intended breaking change:

- existing Approval types and endpoints remain;
- existing Approval URLs remain valid;
- existing reviewer flows remain;
- board manual block remains;
- Request APIs are additive;
- Messenger redirects old Approvals links to the unified Requests surface.

### Security

- No new external dependency or remote API is introduced.
- Request endpoints reuse organization access and board/Agent actor identity.
- Agent requester, assignee, Issue, organization, and source Run are derived
  from authenticated execution context.
- Assistance response text is redacted before activity/Run Intelligence
  projection and must not carry credentials or secrets.
- Approval authorization remains stricter than Assistance response authority.

## What Is Your Testing Plan (QA)?

### Goal

Prove subtype-correct Request behavior, bounded Block Audit, exact-once resume,
organization isolation, compatibility, and the visible operator journey.

### Prerequisites

- isolated test organization with one assignee Agent, one reviewer Agent, and a
  board actor;
- deterministic terminal Run fixtures with passive follow-up lineage;
- request and activity cleanup scoped to the fixture organization;
- rendered local UI with Requests route and Issue detail.

### Test Scenarios / Cases

1. First same-fingerprint blocked claim stays `in_progress`, records attempt
   one, and creates one Assistance Request.
2. Second claim reuses the Request and records attempt two.
3. Third claim atomically changes the Issue to `blocked` and records attempt
   three.
4. Multiple calls from one Run do not increment the attempt count.
5. Different fingerprint resets to attempt one.
6. Material Issue progress supersedes the Request and resets the audit.
7. Approval, permission, budget, cancellation, and safety classifications do
   not create nested Assistance Requests.
8. Board manual block remains immediate and auditable.
9. Reviewer blocked decision remains structured and does not enter assignee
   Block Audit.
10. Assistance answer/action completion resolves once, reactivates a blocked
    Issue, and wakes the current same assignee exactly once.
11. Reassignment before resolution prevents waking the stale assignee.
12. `cannot_help` leaves blocked Issue blocked and does not early-block an
    `in_progress` Issue.
13. Concurrent resolve/cancel/manual-status calls converge idempotently.
14. Cross-organization Request access and resolution are rejected.
15. Approval compatibility routes and existing Approval E2E remain green.
16. Requests list displays both subtypes once with subtype-correct controls.
17. Issue detail displays pre-threshold waiting and final blocked waiting.
18. Refresh, reopen, Back, Cancel, and draft response restoration preserve the
    current Request decision state.

### Expected Results

- zero `blocked` transitions before the third eligible matching attempt;
- one Request and one attention item per open blocker lineage;
- zero nested Block Approvals;
- zero Agent self-resolution of an Approval;
- exactly one same-assignee resume after Assistance resolution;
- no stale-request side effects after reassignment or supersession;
- current Approval, reviewer, issue, Messenger, and passive follow-up behavior
  stays compatible outside the named changes.

### Pass / Fail

Pending implementation. Final evidence must include focused service/route
tests, relevant existing regression suites, product logic validation, full
repository validation, rendered screenshots, and the required independent
reviewer/verifier sequence on one frozen candidate.

## Benchmark And Observability

The dynamic eval dashboard should record:

- Block Audit attempt sequence and fingerprint;
- blocked-before-three invariant violations;
- third-attempt block success;
- Assistance Request rate per eligible failure;
- duplicate suppression rate;
- request-to-human and resolution latency;
- resolution-to-resume latency;
- same-assignee exactly-once resume rate;
- final task correctness and success after recovery;
- governed-stop exclusion accuracy;
- Agent cost and latency.

Raw blocked count and raw Request count are not success metrics. A treatment is
better only when final correctness/recovery improves without violating hard
stops or increasing human attention, cost, or latency beyond the accepted
budget.

## Documentation Changes

Implementation-authorized documentation:

- this proposal;
- API/CLI/runtime reference docs outside `doc/product/**` when public behavior
  changes;
- bundled skill references synchronized with runtime instructions.

Deferred guarded Product Logic Registry delta, requiring explicit user
authorization before editing:

- `ISSUE.STATE.001`: add assignee Block Audit, waiting projection, and Request
  resolution transitions;
- `APPROVAL.GOVERNED.ACTIONS.001`: define Approval as a governed-action Request
  subtype and preserve authorization semantics;
- `ROUTING.REVIEWER.001`: prevent duplicate reviewer wake from pending
  assignee Assistance and retain structured reviewer decisions;
- Messenger/attention contract: rename the Approval-only synthetic projection
  to Requests and aggregate Approval plus Assistance;
- Run admission/wakeup contract: suppress post-threshold continuation and
  resume the same assignee exactly once after Request resolution.

Owner: Rudder product/operator. Due date: before release of the feature. Reason
for deferral: `doc/product/**` is guarded and this implementation request did
not explicitly authorize Product Logic Registry edits.

## Open Issues And Risks

- Deterministic V1 fingerprinting must be broad enough to survive harmless
  wording changes without merging materially different blockers.
- Existing passive follow-up behavior must be checked for all runtime adapters;
  no adapter may accidentally create more than three audit opportunities.
- Current Approval persistence naming remains technical debt until a later
  compatibility migration.
- Current reviewer wake behavior on `blocked` requires an explicit source
  distinction to avoid duplicate Request/reviewer attention.
- Request response draft persistence must reuse an established local pattern
  or be explicitly deferred with visible behavior, not silently lost.
- The implementation must remain narrow enough that Requests does not become a
  generic ticket system.
