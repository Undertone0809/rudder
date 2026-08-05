---
title: Goal Workspace and Alignment Journey PRD
date: 2026-08-05
kind: proposal
status: proposed
area: ui
entities:
  - goals
  - goal_workspace
  - goal_alignment
  - goal_activity
issue:
related_plans:
  - 2026-08-04-goal-system-refactor.md
supersedes: []
related_code:
  - packages/db/src/schema/goals.ts
  - packages/shared/src/validators/goal.ts
  - ui/src/components/NewGoalDialog.tsx
  - ui/src/pages/Goals.tsx
  - ui/src/pages/GoalDetail.tsx
  - server/src/routes/goals.ts
  - server/src/services/goals.ts
  - server/src/services/chat-assistant.ts
  - tests/e2e/goal-detail-lifecycle.spec.ts
commit_refs: []
updated_at: 2026-08-05
---

# Goal Workspace and Alignment Journey PRD

## Overview

Rudder should make a Goal feel familiar to anyone who can create and follow an
Issue, while preserving the different job a Goal performs.

An Issue is a bounded unit of execution. A Goal is a durable desired change in
the external world that may become clearer as Agents investigate, act, and
collect evidence. Goal UI should therefore reuse the Issue interaction grammar
without copying the Issue state machine.

This proposal adopts the Option C direction:

- direct, Issue-like Goal creation is the default entry
- conversation-first creation remains an optional path for unclear intent
- creation opens an evolving Goal Workspace, not a Contract configuration page
- the Agent maintains the structured Goal Contract, Plan, Activity, and
  evaluation state behind the user-facing experience
- the user observes progress, gives feedback, decides consequential changes,
  and accepts or rejects the final result

The existing Goal Contract backend remains valuable. This PRD changes the
authoring, orchestration, and presentation layers instead of replacing the
contract or evidence model.

Affected Product Logic contracts if this proposal is approved for
implementation:

- `ORG.GOAL.001`
- `CHAT.LIFECYCLE.001` when Messenger-to-Goal creation is included
- `MESSENGER.ATTENTION.001` when Goal decisions enter Messenger attention

This document is a proposal. It does not update the guarded Product Logic
Registry.

## Decision Summary

The proposed product decision is:

1. Goal and Issue share the same product shell and interaction grammar.
2. Goal creation is a compact form with a plain-language preview and one
   primary action: `Create and start`.
3. The user-facing Goal model is limited to the Goal, progress, feedback,
   decisions, and result.
4. The Agent compiles and maintains the internal Contract, Plan, criteria,
   continuation, Activity, evidence references, and evaluation policy.
5. Goal progress is an evidence-backed statement about external change, not an
   Issue count, Run count, manually entered percentage, or editable status.
6. Goals can evolve. Clarifications and bounded strategy changes are recorded
   automatically; consequential changes require a plain-language before/after
   proposal and user approval.
7. The Goal board groups work by who or what acts next. Its columns are derived
   attention facets, not draggable lifecycle states.
8. Completion is an Agent-submitted result proposal with evidence, risks, and
   verifier status. The user accepts the result or explains the remaining gap.
9. Starting a Goal is distinct from saving a Draft. `Create and start` is only
   available after the compiler has produced a complete activation packet that
   satisfies `ORG.GOAL.001`; otherwise the user can save and align the Draft.
10. The first implementation slice is direct creation plus the primary Goal
    Workspace against the existing backend. Messenger creation, change
    proposals, and result proposals remain designed here but are not required
    for that first internal slice.

## What Is The Problem?

### Current state

The current implementation exposes the internal Goal model directly in the
primary journey:

- New Goal creates a Draft from title and context.
- Goal Detail then asks the user to configure objective mode, Agent Owner,
  criteria, evaluator kinds, evidence requirements, autonomy, human authority,
  deadlines, continuation, and an initial Plan.
- Active Goals ask the user to revise the Plan, manually add Activity, enter
  evidence references, assign criterion results, and trigger evaluation.

The backend behavior is coherent for governance and verification. The UI asks
the wrong actor to operate it.

### User impact

The user is forced to behave like a workflow engine operator before an Agent
can begin useful work. This creates several failures:

- users must understand concepts that are implementation details
- users who do not yet understand their own goal cannot start safely
- progress becomes manual reporting instead of observed external change
- the Agent is treated as an executor of configured fields rather than the
  owner of structuring and advancing the Goal
- Messenger and Goals become separate mental models instead of two entry points
  into one durable outcome
- completion becomes a form-filling exercise instead of evidence-backed human
  acceptance

### Core contradiction

A Goal must be structured enough to govern autonomous work, but the user should
not have to understand or populate that structure.

The product should resolve this contradiction through an Agent-owned compiler
and orchestration layer, not by simplifying labels on the existing Contract
form.

## First-Principles Product Model

### What a Goal is

A Goal preserves what change the human and Agent are trying to make true across
multiple Runs, Issues, conversations, waiting periods, and strategy revisions.

It is not:

- a large Issue
- a manually operated workflow
- a container whose progress equals the number of completed child tasks
- a persistent chat transcript
- a status that can be marked complete without evidence

### Human responsibility

The human should:

- express intent and context
- judge tradeoffs
- grant or constrain consequential authority
- resolve important ambiguity
- accept the final result or identify the gap

### Agent responsibility

The Agent should:

- turn natural-language intent into a structured Goal Contract
- identify only the missing information that would materially change direction
- propose and revise the Plan
- advance work through bounded Runs, Issues, and conversations
- collect and connect evidence
- synthesize progress updates
- propose consequential Goal changes
- submit the result for acceptance

### Product principle

> A Goal is an outcome commitment aligned with the user, continuously advanced
> by an Agent, and ultimately accepted by the user.

Conversation can author and align the Goal. The Goal Contract is the compiled
artifact used for governance and verification.

## User-Facing Model

The standard journey should not require additional Goal vocabulary beyond what
the user needs to act.

| User sees | User question answered | System maintains |
| --- | --- | --- |
| Goal | What are we trying to change? | outcome statement and objective mode |
| Current progress | What has actually changed? | Activity, evidence, and evaluation inputs |
| Agent is doing | What is happening now? | current Plan and active work links |
| Next step | What happens next? | continuation and wake condition |
| Needs your attention | Why am I needed? | human authority and approval policy |
| Current agreement | What are the important boundaries? | criteria, autonomy envelope, deadlines |
| Result proposal | Is the Goal really done? | terminal evaluation and Proof |

The low-level Contract remains available under an `Advanced` or diagnostic
surface for developers and operators who need it. It is not part of normal Goal
creation or progress review.

## Product Scope

### In scope

- Issue-like direct Goal creation
- an attention-oriented Goal board
- an evolving Goal Workspace
- Agent-generated plain-language Goal understanding
- automatic evidence-backed progress updates
- user feedback in the Goal context
- explicit approval for consequential Goal changes
- Agent-submitted completion proposals and user acceptance
- advanced disclosure of the compiled Contract
- responsive desktop and mobile behavior

### Designed now, delivered after the first internal slice

- optional Messenger-to-Goal creation
- persisted consequential Goal change proposals
- Agent-submitted result proposals and user acceptance
- routing Goal attention into Messenger

### Out of scope

- replacing the existing Goal Contract data model
- a new arbitrary evaluator language
- user-created Goal hierarchy or a sub-goal scheduler
- making Goals draggable workflow cards
- treating every conversation or Issue as a Goal
- building a Jira replacement
- automatically granting new external authority from ambiguous text
- silently changing the Goal outcome, success conditions, or human boundaries
- redesigning the entire Messenger or Issue product

## Goal And Issue UI Relationship

Goal and Issue should look related because they are both durable work objects.
They should not behave identically.

| Shared UI grammar | Issue semantics | Goal semantics |
| --- | --- | --- |
| compact create dialog | defines a bounded task | defines a desired external change |
| title, context, owner, target date | ownership of execution | accountability for an outcome |
| list or board card | explicit lifecycle status | derived next-actor facet |
| detail header and properties | current task state | current Goal agreement |
| activity and comments | task discussion and events | evidence, alignment, and feedback |
| related Runs and artifacts | execution record | supporting work and proof |
| review action | accept task output | accept evidence-backed Goal result |

The Goal Workspace should extend the existing Rudder workspace shell instead of
creating a separate chat-only application or a tutorial column.

The shared shell contract is explicit:

| Component or action | Shared behavior | Issue-only behavior | Goal-only behavior |
| --- | --- | --- | --- |
| create trigger | same placement, shortcut, compact dialog, validation, cancel, and error recovery | create a bounded task | compile a desired outcome into a Draft or active Goal |
| identity header | title, owner, target time, links, overflow menu | editable Issue status and priority | current Goal understanding and quiet revision indicator |
| card | title, owner, target time, compact summary, attention indicator | explicit status badge and workflow state | latest evidence-backed progress and derived attention facet |
| board grouping | filter, search, open detail, keyboard navigation | status columns may support workflow transitions | next-actor facets are read-only and never draggable |
| timeline | chronological events, comments, artifacts, Runs, retry and pagination | task lifecycle and review events | Checkpoints, evidence, feedback, proposals, and acceptance events |
| composer | durable user input, attachments, submit/error state | task comment or instruction | Goal feedback or supplemental fact; never implicit approval |
| attention block | question, impact, evidence, actor, clear actions | task review or blocker response | reply, choose, approve, or accept with distinct audit meaning |
| review action | self-contained proposal and decision | accept or request changes on task output | accept Goal result or identify the remaining outcome gap |
| properties | compact secondary metadata and progressive disclosure | status, priority, labels, assignee | current agreement, Owner, target time, and next action |
| mobile | same content priority, actions, focus order, and detail route | status-sorted Issue list | attention-sorted Goal list; no horizontal derived-state board |

Goal-specific badges are limited to the derived facets `Agent advancing`,
`Needs your attention`, `Waiting for external result`, and `Ready for
acceptance`, plus persisted paused or terminal result labels in filtered views.
Issue status, priority, sprint, and workflow-transition controls must not appear
on a Goal. Goal facets must not expose drag handles, drop targets, editable
status menus, or optimistic state movement. Opening a card, filtering, searching,
giving feedback, and acting on an attention block use the same interaction
patterns as Issues.

## User Experience Walkthrough

### 1. Enter Goals

The user opens `Goals` and sees an operational board or list. The default board
answers who or what acts next:

- `Agent advancing`
- `Needs your attention`
- `Waiting for external result`
- `Ready for acceptance`

Paused and completed Goals live in filters or archive views. Cards are not
draggable between these columns because the facet is derived from real Goal
state, active work, waiting conditions, approvals, and acceptance.

Each Goal card shows:

- Goal title
- latest evidence-backed progress statement
- accountable Agent
- next action or waiting condition
- target date when relevant
- attention reason when the user must act

### 2. Create a Goal directly

The user selects `New Goal`. The compact create surface follows the Issue
creation pattern and asks for:

- Goal: the desired change, in the user's words
- Context: optional background or why it matters now
- Assignee: the same Agent picker used by Issue creation; Rudder may preselect
  a capable suggestion and the user may assign or change it
- Target time: optional

As the user writes, Rudder shows a compact plain-language preview:

- current understanding of the desired result
- how success will be judged
- selected accountable Agent
- the key authority or scope boundary
- the first bounded action the Agent will take
- target time when one is material

The primary action is `Create and start`.

This one action is the explicit confirmation for initial activation, but it is
enabled only when the compiler has produced a complete candidate activation
packet. The packet must contain a complete Contract, exactly one capable
same-organization Agent Owner, an initial Plan, and continuation coverage, and
must pass the existing activation validation. On confirmation, the system
submits one durable Goal Start Request containing an organization-scoped
idempotency key and immutable packet hash. The server validates the complete
packet before mutation, then creates or reuses the Draft and commits activation,
Owner assignment, initial Plan, continuation, activation Activity, and the
completed Start Request atomically. The user never sees a second Contract
activation form.

The server returns `active` only after that transaction succeeds. The same key
and packet hash replay returns the original Goal and effects; the same key with
a different packet hash returns conflict. A validation failure creates no new
Goal or activation side effect, while a separately saved Draft remains Draft.
If the process or response fails during start, the transaction either rolls
back completely or commits with the durable request; retry after restart cannot
duplicate the Goal, Owner assignment, Plan, continuation, or Activity. Changing
the preview creates a new packet and requires a new request key.

When material information is missing or no suitable Owner exists, the primary
action becomes `Save draft`; `Create and start` remains disabled. Saving opens
the Draft Workspace in `Needs your attention` with one concrete alignment
question and a new compiler preview after the user answers. An unactivated
Draft cannot start Runs, create execution Issues or automations, perform
external actions, or conduct "restricted discovery" under the Goal. This is a
hard distinction: safe discovery is the first action of an activated Goal, not
a permission to execute from an incomplete Draft.

### 3. Create a Goal from Messenger (later slice)

The user may express an outcome in Messenger or ask to turn a conversation into
a Goal.

The Agent asks only questions whose answers would materially change:

- the desired external result
- the target person or system
- a consequential boundary
- the success judgment
- the deadline when timing changes the strategy

When enough is known, the Agent inserts a self-contained Goal proposal in the
conversation. It contains the same compact understanding and first action as
direct creation. Its actions are:

- `Create and start`
- `Continue adjusting`

The proposal is the primary review block. The freeform composer must not compete
with it while a start decision is pending.

This path reuses the same compiler and activation packet; it does not introduce
different activation semantics. It is intentionally deferred until direct
creation and the Workspace have passed acceptance against the existing backend.

### 4. Open the Goal Workspace

After creation, the Goal opens in a workspace that uses the same structural
grammar as Issue Detail. Information appears in this order:

1. Current Goal
2. Current progress
3. Needs your attention, when present
4. Agent is doing
5. Next step
6. Embedded progress and feedback timeline
7. Current agreement and related work

The first screen should answer:

- what outcome are we pursuing now?
- what has actually changed?
- what is the Agent doing?
- what happens next?
- is the user needed?

The current Goal is explicitly an evolving understanding. The Workspace may
show a quiet version history or `Updated from evidence and feedback` label, but
it should not ask the user to manage Contract revisions.

The standard Goal Workspace uses a compact embedded feedback timeline and
composer, not a full Messenger conversation. Slice 1 includes this durable
feedback loop alongside existing Activity and evidence history. Related
Messenger conversations may open through links. A primary conversation
relation may be added later, but it is not a dependency for direct creation or
Workspace continuity.

### 5. Observe progress

The Agent synthesizes progress from real work:

- Runs
- Issues
- artifacts and outputs
- decisions and approvals
- external metrics
- evidence references
- waiting conditions

A progress update must state:

- what changed in the external world
- what evidence supports the statement
- what remains uncertain or unmet
- what the Agent is doing next

The UI must not use an arbitrary progress percentage. It must not translate
completed Issues or Runs into Goal progress without evidence that the Goal's
external result moved.

Users do not manually add normal Activity or set criterion states. Manual input
is feedback or a supplemental fact. The Agent and system turn work events into
the append-only Activity and evidence model.

### 6. Give feedback

The Goal Workspace has one continuous feedback composer. The user may:

- add a fact
- correct the Agent's understanding
- change priority
- name a new concern
- explain why the current result is insufficient

Feedback enters the Goal's durable context. The Agent responds and updates the
current understanding, Plan, or next action as appropriate.

Feedback is not automatically an approval. A consequential change caused by
feedback still follows the Goal change rules below.

Submitting feedback must preserve the original text, user identity, time,
attachments, and idempotency key; make it visible in the timeline immediately;
and route the Goal back to its Owner Agent for a response. The Agent's response
and any resulting clarification, Plan revision, or pending change proposal stay
in the same timeline. Feedback must not directly mutate the Contract, criteria,
authority, evaluation input, or result state.

Until the governed change flow in Slice 3 is available, consequential feedback
is recorded and called out as requiring alignment, but the current Contract
remains unchanged. The internal feature-flagged journey must not silently apply
that request or misrepresent it as approved.

### 7. Evolve the Goal

Goals evolve because users and Agents learn from real work. The system handles
changes by impact:

| Change type | Example | Required behavior |
| --- | --- | --- |
| clarification | correct a name or add known context | append Activity and update the displayed understanding without a Contract revision |
| bounded strategy change | test a different channel within the same outcome and authority | create a Plan revision and append Activity with the reason and source |
| consequential Goal change | change target audience, success judgment, material deadline, or authority | persist a before/after Goal Change Proposal and require approval before applying it |
| Goal replacement | pursue a different external outcome | create a linked new Goal and preserve the prior Goal and its history |

A consequential change proposal contains:

- what the current Goal says
- what the Agent recommends changing
- why the evidence supports the change
- expected impact on time, scope, or risk
- actions to approve, keep the current Goal, or discuss

The Agent must not silently infer consequential constraints or approval.

A persisted `Goal Change Proposal` is the internal governed artifact for every
consequential change. It contains:

- proposal ID, Goal ID, organization ID, and expected base Contract revision
- immutable before snapshot and machine-applicable after patch
- plain-language before/after summary, rationale, evidence links, and impact
- proposing actor, creation time, status, approval ID, and idempotency key

Proposal statuses are `pending`, `approved`, `rejected`, `superseded`, or
`applied`. Creating or retrying the same proposal with its idempotency key must
not duplicate it. Approval records the human decision but does not bypass the
revision check. The apply command succeeds only when:

1. the linked approval is accepted and organization-scoped
2. the current Contract revision equals the expected base revision
3. the after patch passes the same Contract and authority validation as
   activation

The command writes the next Contract revision and Activity atomically, then
marks the proposal `applied`. If the base revision no longer matches, the
proposal becomes `superseded`; the Agent must regenerate a proposal against the
current Contract instead of rebasing or applying it silently. Rejecting or
keeping the current Goal records the decision and leaves the Contract unchanged.

### 8. Handle attention

The product must distinguish four types of user interaction:

| Interaction | User job | UI action |
| --- | --- | --- |
| reply | provide missing information | answer in context |
| choose | select among meaningful options | select one option |
| approve | authorize a consequential change or action | approve or keep current state |
| accept | judge the final result | accept result or identify the gap |

Each attention block contains the question, why it matters, impact, evidence,
and actions in one self-contained surface.

### 9. Wait without losing continuity

When progress depends on an external event, the Goal moves to `Waiting for
external result`. The Workspace shows:

- what it is waiting for
- why work cannot continue yet
- when or under what condition Rudder will check again
- what evidence is expected

A Run may end while the Goal remains active. Waiting must not look like failure
or completion.

Internally, waiting is the active Goal's canonical continuation with
`kind: wait`, a human-readable `summary`, and an explicit `wakeCondition`.
`Waiting for external result` is derived only when there is no unresolved
higher-priority user attention and no eligible Agent action. When the condition
becomes true, the system appends source-linked Activity and advances to a new
Plan or continuation; it does not mutate the board facet directly.

### 10. Complete and accept the Goal

When the Agent believes the terminal result is supported, it submits a result
proposal containing:

- the outcome it claims became true
- evidence for each important success judgment
- unresolved gaps or risks
- verifier status where required
- the recommended terminal result

The user chooses:

- `Accept result`
- `Result is not sufficient`

Before the proposal becomes `Ready for acceptance`, the server preflights an
evaluator-compatible candidate payload without mutating Goal lifecycle or
writing Proof. The candidate maps every Contract criterion to `met`, `unmet`,
`breached`, or `unknown`; reports missing declared `evidenceRequirements` and
their resulting `unknown` criteria; includes the referenced evidence; and
includes `resultValue` for `maximize`, `decision` for `decide`, and any
criterion-specific human decision needed to make a `human` criterion
non-unknown. Narrative progress or an Agent assertion alone can never create
Proof.

Readiness is determined by running the unchanged canonical reducer. A proposal
enters `Ready for acceptance` only when that reducer returns a terminal outcome.
This includes supported `target:not_achieved` and `maintain:breached` outcomes
even when another criterion remains `unknown`; those unknowns stay visible in
the proposal. `maximize` and `decide` outcomes that reduce to `inconclusive`
remain active with explicit gaps. No Goal closes automatically: an authorized
user must accept the proposed result as the final record first.

The decision behavior is:

| User or system result | Persisted behavior | Evaluator behavior |
| --- | --- | --- |
| reducer returns `inconclusive` | append an Agent-action Activity and show exact evidence, value, decision, and unknown-criterion gaps | do not create a ready proposal or invoke canonical evaluation |
| reducer returns a terminal result | persist a `ready` Result Proposal with immutable candidate payload, visible failed or unknown criteria, and base Contract revision | do not invoke canonical evaluation until user acceptance |
| `Accept result` | require an authorized human board actor, record organization-scoped acceptance of the proposed final record, then consume the proposal idempotently | invoke canonical evaluation once with evidence, criteria, `resultValue`, `decision`, acceptance reference, and separately confirmed human-criterion inputs as applicable |
| `Result is not sufficient` | require feedback, mark proposal `rejected`, append Activity, and create or revise continuation | do not terminally evaluate; Goal returns to Agent action |
| evaluator returns `inconclusive` | preserve evaluation inputs and explicit gaps; keep the Goal active | allowed only where the current objective mode's canonical evaluation permits it |
| evaluator returns a terminal positive or negative result | persist canonical evaluation and terminal lifecycle atomically | Proof is the canonical evaluation result, never the proposal narrative |

Acceptance records that the user accepts this outcome as the final Goal record;
it does not force a positive outcome or automatically mark a `human` criterion
as met. A criterion-specific human decision is included only when the proposal
shows that judgment separately and the user explicitly confirms it. The user
may therefore accept a supported negative result without turning failed or
unknown criteria into success. If the canonical evaluation disagrees with the
proposal because the Contract or evidence changed, the transaction fails closed
and the Agent must regenerate the proposal against the current Contract
revision. Rejecting preserves the rejected proposal, feedback, and rationale.
The Owner Agent may submit a proposal but may not accept its own result through
an Agent API key.

The user never enters evidence URIs, evaluator states, or a result payload in
the standard completion path.

## Functional Requirements

### Creation and alignment

- `GW-001`: Goals must support compact direct creation from the Goals surface.
- `GW-002`: Direct creation must show only Goal, context, the same assignable
  Agent picker used by Issue creation, and optional target time as editable
  inputs. Rudder may preselect a capable suggestion.
- `GW-003`: The create surface must show the current plain-language
  understanding and first action before `Create and start`.
- `GW-004`: `Create and start` must compile and explicitly confirm the initial
  canonical Goal Contract without exposing its internal fields.
- `GW-005`: `Create and start` must require a complete Contract, capable
  same-organization Owner, initial Plan, continuation, and successful canonical
  activation validation.
- `GW-005A`: Goal start must persist an organization-scoped request key and
  immutable activation-packet hash. Same-key/same-hash replay must return the
  original Goal; same-key/different-hash replay must return conflict.
- `GW-005B`: Draft creation or reuse, activation, Owner assignment, initial
  Plan, continuation, activation Activity, and Start Request completion must
  commit atomically so process failure cannot leave partial or duplicate effects.
- `GW-006`: Missing material information must allow `Save draft`, produce one
  concrete attention question, and prohibit Runs, execution Issues,
  automations, external actions, and Goal-scoped discovery until activation.
- `GW-006A`: A later Messenger entry may create the same Goal through the same
  compiler and inline review block; it must not create a second Goal model.

### Board and workspace

- `GW-007`: Goal board grouping must be derived from next-actor and waiting
  state, not directly edited or dragged by the user.
- `GW-008`: Goal Workspace must lead with current Goal, current progress, Agent
  action, next step, and user attention.
- `GW-009`: Contract, raw evaluator, evidence-reference, continuation, and
  Activity command controls must be absent from the standard path.
- `GW-010`: Low-level Goal state must remain inspectable through progressive
  disclosure for debugging and governance.
- `GW-011`: Workspace layout must use the existing Rudder workspace shell and
  Issue interaction grammar.
- `GW-011A`: Goal facets must be read-only derived state and must never expose
  Issue status controls, drag handles, drop targets, or workflow transitions.

### Progress and feedback

- `GW-012`: Standard progress updates must be generated from Runs, Issues,
  artifacts, decisions, evidence, and waiting conditions.
- `GW-013`: Progress must describe observed external change and uncertainty;
  Issue count, Run count, or arbitrary percentage alone is insufficient.
- `GW-014`: User feedback must remain attached to the Goal and be available to
  future Goal work.
- `GW-014A`: Feedback submission must be organization-scoped and idempotent,
  preserve the human actor and original content, route follow-up to the Owner
  Agent, and never count as approval or directly mutate the Contract.
- `GW-015`: Agent Plan and current understanding updates must record why they
  changed and which evidence or feedback caused the change.

### Change control and completion

- `GW-016`: Consequential Goal changes must use a before/after proposal and
  explicit user approval.
- `GW-016A`: Applying a Goal Change Proposal must validate accepted approval,
  expected base Contract revision, organization boundary, Contract validity,
  and idempotency in one governed command.
- `GW-017`: Clarification, choice, approval, and final acceptance must have
  distinct actions and audit meaning.
- `GW-018`: Goal replacement must preserve the prior Goal and link the new
  Goal; it must not silently rewrite history.
- `GW-019`: Completion must be proposed by the Agent with evidence and risks.
- `GW-020`: User rejection of a result must preserve feedback and resume Agent
  action.
- `GW-021`: Every terminal Goal result, positive or negative, must receive
  organization-scoped user acceptance before canonical evaluation may close the
  Goal and produce durable Proof.
- `GW-021A`: Result Proposal preflight must expose criterion-level evidence
  gaps without writing Proof or closing the Goal.
- `GW-021B`: Rejecting a Result Proposal must not invoke terminal evaluation;
  accepting must invoke canonical evaluation idempotently against the immutable
  candidate payload and matching Contract revision without treating acceptance
  itself as proof that a human criterion was met.
- `GW-021C`: Canonical evaluation must reject any terminal close attempt that
  lacks a matching accepted Result Proposal and organization-scoped human
  acceptance reference; an Agent cannot accept its own Goal result.

### Responsive and accessible behavior

- `GW-022`: The primary journey must work at desktop and constrained mobile
  widths without exposing a second configuration workflow.
- `GW-023`: Mobile Goal Detail must show the current Goal and progress before a
  long timeline or conversation.
- `GW-024`: Approval and result review blocks must keep the proposal, impact,
  and actions together and remain operable by keyboard.
- `GW-025`: Mobile Goals must use one attention-sorted list rather than
  horizontal derived-state columns; the page body must not overflow and every
  attention state must remain reachable.

## Product And Technical Architecture

### Goal Authoring Controller

Introduce an orchestration boundary that accepts plain-language intent and
produces the canonical activation command.

Inputs:

- user Goal and context
- suggested or selected Agent
- optional target time
- organization policy and Agent capabilities
- relevant Messenger context when creation starts in conversation

Outputs:

- a versioned candidate activation packet containing outcome statement and
  objective mode, criteria and evaluator mapping, evidence requirements,
  autonomy envelope and human authorities, initial Plan and continuation, and
  exactly one capable same-organization Owner
- a plain-language review containing desired outcome, success judgment,
  selected Owner, key boundary, first action, and material target time
- validation status and, when invalid, one highest-impact alignment question

The candidate packet is immutable between preview and confirmation. `Create and
start` submits the exact packet hash plus a durable organization-scoped request
key to the Goal Start command. A changed user input, organization policy, Agent
capability, or preview invalidates the packet and requires recompilation and a
new request key. Activation must fail closed if the selected Agent is no longer
available, capable, or in the same organization.

The Goal Start Request persists request key, organization ID, packet hash,
optional existing Draft ID, resulting Goal ID, status, and timestamps. Its
unique organization/key constraint is the retry boundary. The Start command
validates before mutation and executes Draft creation or reuse, canonical
activation, Owner assignment, initial Plan, continuation, activation Activity,
and request completion in one database transaction. A committed request is the
readback after a lost response or process restart; an uncommitted transaction
leaves no partial activation to recover.

Inference follows a field-level policy:

| Structure | Compiler policy |
| --- | --- |
| initial Plan and continuation | may infer from confirmed intent and show the first action in preview |
| evaluator mapping | may compile from the confirmed success judgment; must not invent a materially different success judgment |
| evidence requirements | may preserve or strengthen organization policy; must not weaken required proof silently |
| autonomy envelope | may choose the least-authority bounded action; must not expand external or irreversible authority |
| human authorities | may preserve stricter organization defaults; must not remove a required human decision |
| objective mode | may recommend a mode but the plain-language outcome and success judgment must be visibly confirmed |
| outcome, target person or system, material success threshold, consequential deadline | require visible confirmation; ambiguity blocks activation |
| Owner | may preselect from capability data; the user assigns or changes it through the same picker as Issue creation, and activation requires one capable same-organization Agent |

The controller may inspect organization policy and same-organization Agent
capability metadata to compile the packet. It may not call external systems,
start a Run, create execution work, or use cross-organization data while the
Goal remains Draft.

### Progress Synthesizer

Introduce a read model or service that composes:

- latest Goal Activity
- linked Runs and their terminal state
- linked Issues and artifacts
- evidence and evaluation state
- active approvals and decisions
- continuation or waiting condition

It returns the user-facing current progress, Agent action, next step, attention
reason, and supporting references. It does not create Proof from narrative
alone.

The read model uses these source-of-truth rules:

| User-facing field | Canonical sources | Derivation rule |
| --- | --- | --- |
| current Goal | latest applied Contract revision plus non-contract clarification Activity | Contract wins on outcome, criteria, authority, and material deadline |
| current progress | evidence-linked Goal Activity, artifact/evidence records, and accepted decisions | state external change and uncertainty; never infer movement from Run or Issue status alone |
| Agent is doing | current Plan revision plus eligible active linked Run or Issue | show the bounded action, not raw runtime state |
| next step | canonical continuation plus pending eligible work or explicit wait condition | continuation wins when sources conflict |
| needs your attention | unresolved question, choice, approval, or ready Result Proposal | oldest consequential blocking item first; acceptance outranks optional feedback |
| history | append-only Activity joined to source Runs, Issues, artifacts, evidence, proposals, and approvals | preserve source IDs and chronological audit order |

Runs and Issues are context sources, not Goal advancement by themselves. A Run
or Issue may change `Agent is doing` or `history`, but only evidence-linked
Activity can change the positive `current progress` claim.

### Goal Change Proposal service

The change service persists the expected base revision, immutable before
snapshot, validated after patch, rationale, evidence, approval relation,
idempotency key, and proposal status described in the journey. It exposes a
single apply command that atomically checks accepted approval and current base
revision, writes the Contract revision and Activity, and marks the proposal
applied. Existing Plan revision remains the mutation path for bounded strategy
changes; clarification remains append-only Activity.

### Result Proposal service

The result service assembles an immutable candidate matching
`evaluateGoalSchema`: `evidenceRefs`, one status per criterion, optional
`resultValue`, optional `decision`, and evaluator-compatible `resultPayload`.
It calls the same pure evaluation reduction as a non-mutating preflight and
returns criterion-level evidence gaps. A candidate becomes `ready` for required
user acceptance exactly when that reducer returns a terminal outcome. Failed
and unknown criteria remain visible; they do not block a terminal negative
`target` or `maintain` result that the existing reducer permits. `maximize` and
`decide` candidates that reduce to `inconclusive` remain active. No objective
mode auto-closes.

Accept consumes the exact candidate once, records acceptance of the final
record, rechecks the Contract revision, and calls the canonical evaluate
command with the acceptance reference. The acceptance record includes proposal
ID, Goal ID, organization ID, human actor, accepted time, and base Contract
revision. It adds criterion-specific human input only when separately
confirmed. Evaluate validates that the reference belongs to the same Goal and
organization, is accepted by an authorized human actor, matches the current
Contract revision, and has not already been consumed. Reject records feedback
and continuation without calling evaluate. The service must preserve all
attempts and must not translate result acceptance, proposal prose, Run success,
Issue completion, or reviewer confidence directly into criterion satisfaction
or Proof.

### Goal feedback context and later conversation relation

Slice 1 includes an embedded Goal feedback timeline plus existing Activity,
evidence, and linked work. A later slice may add one primary durable
conversation relation if user research shows that the feedback timeline is
insufficient. If added, directly created Goals may create a conversation
context and Messenger-created Goals may reuse the originating conversation when
organization and visibility boundaries match. This relation must remain
optional in the read model; the user must not have to switch between Messenger
and Goal configuration to preserve alignment.

The Slice 1 feedback command is an append-only, organization-scoped mutation.
It persists Goal ID, actor type and ID, original body and attachments, creation
time, and idempotency key; links the resulting timeline event to its source; and
routes a follow-up to the current Owner Agent through existing continuation or
wake behavior. If existing Goal Activity cannot preserve the human actor and
original feedback without overloading Agent-submitted evidence, add the
smallest dedicated Goal Feedback record rather than discarding provenance.

An accepted feedback command may update attention and trigger Agent work, but
it cannot directly revise Contract, Plan, criteria, authority, evaluation, or
Proof. Those changes still use their canonical commands and governed boundaries.

### Compatibility with current commands

The existing commands remain the canonical mutation boundary:

- activate Goal
- revise Plan
- append Activity
- assign Owner
- set Focus
- evaluate Goal

The new controller calls these commands. The standard UI stops exposing them as
manual forms.

Goal Start is an additive orchestration command, not a competing lifecycle
command. It places Draft creation or reuse and the existing canonical activation
effects inside the durable Start Request transaction described above. The
low-level activate command may remain available for governed diagnostics, but
the standard `Create and start` path cannot assemble those side effects through
separate client calls.

Consequential Contract changes and pre-evaluation review require additive
proposal commands because the current command set has no persisted stale-safe
proposal boundary. These commands orchestrate existing Contract revision,
approval, Activity, continuation, and evaluate behavior; they do not introduce
a second lifecycle or evaluator.

The existing evaluate command remains the canonical evaluator but gains one
terminal authority invariant: it may close a Goal only when called with a valid
accepted Result Proposal reference. Direct Agent evaluation without that human
acceptance may preflight or remain inconclusive, but it cannot produce a
terminal lifecycle transition. This is a required `ORG.GOAL.001` contract delta,
not a UI-only hiding rule.

### Data impact

The MVP should avoid a Goal schema rewrite. Implementation should first test
whether the existing records can support:

- a primary Goal conversation link
- source attribution for generated progress updates
- material-change proposal and approval linkage
- result proposal state before terminal evaluation

The first internal slice requires durable feedback provenance but no full
conversation or proposal schema. It should reuse Goal Activity only if the
human actor, original input, attachments, source, and idempotency survive
without pretending that feedback is Agent-submitted evidence; otherwise it adds
the minimal Goal Feedback relation described above. The Workspace read model
must not duplicate canonical Goal state.

Slice 1 also requires a minimal Goal Start Request record because current Draft
creation and activation commands do not share a durable idempotency boundary.
The record carries the organization-scoped request key, immutable packet hash,
optional Draft ID, resulting Goal ID, status, and timestamps. It is not a second
Goal lifecycle; it exists only to make the composite start command atomic and
restart-safe.

Later slices may add Goal Change Proposal and Result Proposal tables because
their immutable payload, base revision, idempotency, and status cannot be
reconstructed reliably from narrative Activity. Add persisted fields or
relations only where current Activity, approval, conversation, and evaluation
records cannot preserve the required audit trail.

### Breaking change

No external API or storage breaking change is proposed for the first slice.
Existing low-level Goal commands remain available. The visible default journey
changes substantially and should be feature-flagged until migration and E2E
coverage prove compatibility.

## State And Derivation

The persisted lifecycle remains owned by the Goal Contract. The board derives a
user-facing facet:

| Derived facet | Minimum condition |
| --- | --- |
| Agent advancing | active Goal with Agent-owned next action and no blocking attention |
| Needs your attention | unresolved reply, choice, approval, or result decision owned by the user |
| Waiting for external result | active Goal with explicit wait condition and no actor action currently eligible |
| Ready for acceptance | complete result proposal awaiting user judgment |

Paused, closed, and terminal result states remain filters or archive views.
Derived facets must be stable across refresh and must not be persisted as a
second competing lifecycle.

Draft Goals never appear as `Agent advancing` or `Waiting for external result`.
They appear in a Draft filter and may show `Needs your attention` only as a
read-model label for the missing activation answer. For active Goals, facet
precedence is `Ready for acceptance`, `Needs your attention`, `Waiting for
external result`, then `Agent advancing`. The derivation must return its source
record IDs and reason so the UI never guesses from text or stale client state.

## Edge Cases

### The user is unsure what they want

Save a Draft and ask one question only when its answer changes the result,
authority, target, success judgment, or strategy materially. Do not execute
discovery under the Goal until the answer yields a complete activation packet.

### No suitable Agent is available

Save a Draft, explain that an accountable Agent is required, and ask the user
to choose or create one. Do not activate or silently assign an incapable or
cross-organization Owner.

### The Agent cannot make progress

Show the blocker, evidence, attempted actions, and the smallest user decision
that can unblock work. Do not degrade to a generic stalled status.

### The target time passes

The Agent proposes a revised deadline, reduced scope, or result assessment.
Changing the deadline requires approval when it changes the commitment.

### Evidence disproves the strategy

Negative evidence is progress when it changes what should happen next. The
Agent records it and proposes a strategy or Goal change without claiming the
desired outcome was achieved.

### Success is inconclusive

The result proposal states what is known, what is missing, and whether to wait,
run another action, change the Goal, or accept an inconclusive result where the
objective mode permits it.

### Feedback conflicts with the current Goal

The Agent identifies the conflict. If the feedback changes the commitment, it
creates a before/after approval instead of silently changing the Goal.

### Refresh, reopen, and restart

Current progress, pending attention, conversation context, Plan, Activity,
evidence, and result proposal must survive API and UI restart without changing
ownership or meaning.

## Success Criteria For Change

### User outcomes

- A user can create and start a Goal without seeing or editing an internal
  Contract field.
- A user can understand the Goal, current progress, current Agent action, and
  next step from the first Goal Workspace screen.
- A user can correct direction through feedback without operating Plan or
  Activity commands.
- A user sees an explicit diff before any consequential Goal change.
- A user can accept or reject an evidence-backed result without entering
  evaluator or evidence-reference fields.

### Product metrics

- median time from opening New Goal to `Create and start`
- percentage of Goals that reach a first Agent action without Advanced UI
- percentage of active Goals with an evidence-backed progress update in the
  last seven days
- median time a Goal remains in `Needs your attention`
- percentage of result proposals accepted, rejected with feedback, or returned
  for more evidence
- weekly owner-accepted Goal Advancement events

### Guardrails

- zero required internal Contract fields in the standard journey
- zero consequential Goal changes without explicit approval
- zero positive progress claims based only on Issue or Run completion counts
- zero terminal results without evaluator-valid evidence and required human
  authority
- zero terminal Goal lifecycle transitions without explicit user acceptance of
  the proposed final record
- no cross-organization Owner, evidence, conversation, or approval links

## Rollout Plan

### Slice 1: Internal direct-create and Workspace vertical slice

This is the only authorized first implementation scope:

- put the experience behind an internal feature flag
- add direct compact creation and a deterministic Goal Authoring Controller
- require visible Owner selection and a complete validated activation packet
  before enabling `Create and start`
- add the durable Goal Start Request and atomic composite start command
- support `Save draft` plus one alignment question without executing work
- reorganize Goal Detail in the existing Issue workspace shell around current
  Goal, existing evidence-linked Activity, Agent action, next step, attention,
  and history
- add the embedded feedback timeline and composer with durable human
  provenance, idempotent submission, and Owner Agent follow-up
- render existing Contract, Plan, continuation, Activity, evidence, and Proof
  through the new read model without changing evaluator semantics
- keep low-level activation and command controls available only in developer or
  debug mode during migration

This slice does not add derived board facets, the mobile attention-sorted list,
Messenger creation, a primary conversation relation, automatic progress claims
from new sources, Goal Change Proposal persistence, Result Proposal persistence,
or public rollout. Consequential feedback remains recorded but unapplied until
the governed change flow exists. Its acceptance target is a clear and safe
vertical path over the existing backend, not the whole future journey.

### Slice 2: Evidence-backed progress and board

- Add the Progress Synthesizer with source attribution and precedence rules.
- Add derived attention facets on desktop and the attention-sorted mobile list.
- Prove that Run and Issue completion alone cannot advance Goal progress.

### Slice 3: Governed Goal evolution

- Add persisted Goal Change Proposals, linked approvals, stale revision checks,
  idempotent apply, and replacement links.
- Keep clarification on Activity and bounded strategy changes on Plan revisions.
- Verify unchanged Contract state before approval and on rejected or stale
  proposals.

### Slice 4: Result proposal and acceptance

- Add evaluator-compatible preflight and persisted Result Proposals.
- Replace the standard manual Evaluate form with accept and
  reject-with-feedback actions.
- Prove that narrative alone cannot create Proof and that accept invokes the
  canonical evaluator once against the matching revision.

### Slice 5: Optional conversation entry and attention routing

- Add Messenger-to-Goal creation using the same compiler and activation packet.
- Add a primary conversation link only if user testing shows that linked
  conversations plus embedded feedback are insufficient.
- Route consequential Goal attention into Messenger without duplicating state.

### Slice 6: Public migration

- Do not expose the new Goal journey publicly until Slices 1-4 pass their E2E,
  exact-candidate verifier, and reviewer gates together.
- Remove the legacy Contract activation, manual Activity, and manual Evaluate
  forms from the normal Goal journey only after migration compatibility passes.
- Retain developer/debug access where needed.
- Propose and, only after explicit approval, synchronize the final behavior into
  `doc/product/**`.

## What Is Your Testing Plan (QA)?

### Goal

Prove that a real user can create, follow, redirect, and accept a Goal without
understanding the internal Contract, while the existing governance and evidence
invariants remain intact.

### Prerequisites

- isolated real local Rudder instance
- embedded PostgreSQL
- one organization
- at least two Agents with different capabilities
- real API and UI, not mocked stores
- seeded Runs, Issues, artifacts, waiting conditions, approvals, and evidence
- desktop and constrained mobile browser viewports

### Core scenarios

Slice 1 release gate:

1. Create a clear Goal directly from an immutable preview and begin the first
   bounded action with a capable same-organization Owner.
2. Save an unclear Goal as Draft, receive one material clarification question,
   and verify no Run, Issue, automation, external action, or discovery starts.
3. Attempt activation with missing Contract, Owner, Plan, continuation,
   cross-organization Owner, incapable Owner, and stale preview; verify each
   fails without partial effects.
4. Retry `Create and start` with the same request key and packet hash before and
   after API restart; verify the original Goal is returned with one Owner
   assignment, one Plan, one continuation, and one activation Activity.
5. Reuse a request key with a different packet hash; verify conflict and no
   mutation. Inject failure and a lost response between Draft creation and
   activation side effects; verify rollback or committed-request readback with
   no partial or duplicate effects after retry.
6. Refresh and restart after activation; verify Owner, Plan, current Goal,
   existing evidence-linked Activity, progress, and next action persist.
7. Submit ordinary feedback; verify original content, human actor, attachments,
   and one idempotent timeline entry persist across refresh and restart, the
   Owner Agent receives follow-up, and the feedback does not become approval or
   directly mutate Contract, Plan, evaluation, or Proof.
8. Submit consequential feedback before Slice 3; verify it remains visible and
   unapplied, with the current Contract unchanged.
9. Verify the normal Workspace contains no low-level activation, Plan mutation,
   Activity submission, or Evaluate controls, while developer/debug mode still
   exposes governed diagnostics.
10. Verify desktop and constrained-mobile Goal Detail, keyboard focus, long
   content, dense read-only history, loading, error, retry, and empty states.

Later-slice gates:

11. Verify desktop derived facets and the attention-sorted mobile Goal list;
   verify Goal cards cannot be dragged or assigned Issue status.
12. Generate progress from a successful Run with valid evidence, then complete
   several Issues without moving the external outcome and verify Goal progress
   does not falsely advance.
13. Record negative evidence; verify the Agent changes strategy without claiming
   success. Add ordinary feedback and verify it does not become approval.
14. Submit a consequential target-audience or success-threshold change; verify
    persisted before/after approval, unchanged state before approval, stale
    proposal supersession, and idempotent application.
15. Enter a waiting condition, end the Run, restart, and resume after the
    condition becomes true.
16. Submit a result proposal that reduces to `inconclusive` and verify no ready
    proposal or Proof. Then preflight a terminal negative `target` or `maintain`
    result with visible unknown criteria, reject it with feedback, continue
    work, and submit and accept a later result exactly once. Verify an objective
    metric result still waits for acceptance, and accepting a supported negative
    result does not mark failed or unknown human criteria as met. Attempt
    terminal evaluation from the Owner Agent without an accepted proposal
    reference and verify rejection without lifecycle change.
17. Attempt cross-organization Goal, Owner, proposal, evidence, conversation,
    approval, and result-acceptance references; verify rejection.
18. Create a Goal from Messenger and verify it uses the same preview,
    activation packet, Draft fallback, and Goal identity as direct creation.

### Expected results

- The standard journey contains no editable objective mode, evaluator,
  evidence URI, autonomy envelope, human-authority, continuation, criterion
  status, or result-payload field.
- All internal activation and evaluation invariants remain enforced.
- User-visible progress always names evidence and uncertainty.
- Approval and acceptance actions survive refresh without duplication.
- Every objective mode remains active until an authorized human accepts the
  exact terminal Result Proposal, and Agent API keys cannot self-accept.
- The same exact candidate passes real browser E2E and independent product
  acceptance verification.

### Pass / fail

- Current status: not run; this is a proposal.
- Implementation cannot be handed off while any required E2E case is missing,
  the verifier returns `FAIL` or `QUESTION`, or the reviewer does not accept the
  exact verified candidate.

## Non-Functional Requirements

### Usability

- One primary action per surface.
- No persistent tutorial or system-explanation column.
- Human-readable summary first; internal data under progressive disclosure.
- Long Goal titles, evidence, and decision text must wrap without overlap.

### Accessibility

- Keyboard-operable creation, feedback, approval, and acceptance.
- Focus returns to the initiating action or updated review block.
- Review blocks expose status and decision actions semantically.
- Derived board facets do not rely on color alone.

### Performance and scale

- Goal board must load cards without fetching complete Activity and evidence
  history for every Goal.
- Goal Workspace should query current summary first and paginate or incrementally
  load long history.
- Polling and mutations must preserve board filters, scroll position, and
  selected Goal.

### Security and governance

- All Goal, Owner, conversation, evidence, approval, result, and acceptance
  operations stay organization-scoped.
- The compiler cannot expand external authority beyond organization policy or
  Agent capability.
- Generated structure remains inspectable and auditable even when hidden from
  the primary UI.
- Idempotency protects activation, progress ingestion, approval, and result
  acceptance.

### Observability

- Record source links from user-visible progress to Activity, Runs, artifacts,
  approvals, and evidence.
- Record why the current understanding or Plan changed.
- Distinguish generated proposals, user confirmations, Agent actions, and
  system-derived facets in audit data.
- Distinguish acceptance of the final Goal record from criterion-specific human
  judgments so audit consumers cannot interpret acceptance as success.

## Documentation Changes If Approved

After the product direction and implementation plan are approved:

- propose a concrete `ORG.GOAL.001` delta for the authoring, progress,
  evolution, and acceptance journeys
- update `surface-domain-map.md` for Goal board and Goal Workspace
- update collaboration contracts if Messenger creates or routes Goal attention
- update `doc/engineering/DESIGN.md` only if a new reusable Goal review-block
  pattern is introduced
- update public user documentation after the shipped behavior is verified

No guarded `doc/product/**` file should change until the user explicitly
approves that contract delta.

## Locked Proposed Decisions

These decisions remove ambiguity from the implementation proposal. They remain
open to explicit product revision during PRD discussion, but an implementation
must not choose differently on its own.

1. `Create and start` is the single explicit activation confirmation after an
   immutable plain-language preview. There is no second Contract form.
2. Activation requires a complete canonical packet and exactly one visibly
   selected, capable, same-organization Agent Owner.
3. Ambiguous intent or missing Owner yields `Save draft` and one alignment
   question. Draft Goals execute nothing, including bounded discovery.
4. Slice 1 includes the embedded Goal feedback timeline and composer with
   durable human provenance and Owner Agent follow-up; it does not embed a full
   Messenger conversation.
5. Slice 2 introduces derived attention columns on desktop and one
   attention-sorted Goal list on mobile, not horizontal mobile columns.
6. Low-level Contract and mutation controls are available only in developer or
   debug mode during migration. Standard users do not receive an `Advanced`
   escape hatch that recreates the operator workflow.
7. Goal cards share Issue visual grammar but never Issue status transitions,
   drag-and-drop, or editable derived facets.
8. The first implementation slice is the internal feature-flagged direct-create
   and primary Workspace vertical slice defined above.
9. Only a change that materially alters the outcome commitment, success
   judgment, authority, target, or consequential deadline requires Approval;
   routine scheduling and bounded strategy adjustments do not.
10. Every terminal Goal result requires explicit user acceptance. Acceptance
    settles the final record but does not force a positive outcome or mark a
    human criterion as met without a separate explicit judgment.

## Explicitly Deferred Decisions

- Whether every Goal should eventually have one primary Messenger conversation.
  User research after the embedded feedback timeline should determine whether
  that additional object improves continuity or adds another concept.
- Whether Messenger should offer proactive `Turn this into a Goal` suggestions.
  The later Messenger slice first supports explicit user intent only.
- Whether expert operators need a supported non-debug Contract inspection
  surface. Migration experience and governance audits should determine this;
  low-level editing remains out of the standard journey.
- Whether desktop users prefer a board or attention-sorted list as their default.
  Both use the same read model; the first desktop implementation may retain the
  board while measuring scan and action completion.

## Convergence Recommendation

Proceed with one product direction rather than maintaining three separate Goal
experiences:

- use Option C as the Goal Workspace model
- use Option A's compact Issue-like direct creation as the default entry
- use Option B's conversation-first alignment as an optional entry when intent
  is unclear

The implementation should first make the Goal understandable and operable from
the user's perspective. The existing Contract model should become the governed
compiled layer beneath that experience.
