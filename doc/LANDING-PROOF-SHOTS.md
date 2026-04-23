# Landing Proof Shots

This document defines the screenshot system for Rudder's landing page and
README-style marketing surfaces.

The job of these images is not to show that the product exists.
The job is to prove that Rudder completes real agent-work loops inside a clear
control plane.

## What These Shots Need To Prove

Each screenshot should answer one product claim:

- work is happening
- chat can turn requests into durable work
- issues carry the execution loop
- humans remain in control at review time
- agents operate as a team, not as isolated prompts
- autonomy stays budget-visible
- work lives inside an organization structure

If a screenshot does not make one of those claims obvious within a few seconds,
it is not a landing proof shot yet.

## Canonical Demo Story

All screenshots should come from one coherent demo organization.
Do not invent a new company, date range, or tone for each surface.

Use this default demo story:

- Organization: `Rudder`
- Goal: `Ship the desktop-first public beta and supporting launch assets`
- Time window: a believable active week with recent work across product,
  release, docs, and launch
- Tone: all English, operator-facing, compact, confident

### Core Team

- `CEO`
- `Founding Engineer`
- `Design Engineer`
- `Release Engineer`
- `Growth Lead`
- `Support Ops`

### Recurring Issue Themes

Reuse this family of issue titles across screenshots:

- `Ship enterprise pricing comparison page`
- `Fix desktop startup crash on macOS 15`
- `Draft launch brief for public beta`
- `Publish onboarding checklist for new desktop users`
- `Tighten approval copy for release-blocking changes`
- `Reduce run transcript noise in Messenger`

## Global Capture Rules

### Data Quality

- Use one language only. Default to English.
- Avoid screenshots full of zero values.
- Avoid every state being green and perfect. A believable system has active
  work, recent completions, and a small amount of pending review.
- Show concrete outputs whenever possible: preview links, PR numbers, docs
  updates, or release checklist progress.
- Keep IDs and timestamps believable and mutually consistent.
- Do not use placeholder names like `Test Org`, `Demo Agent`, or `Issue 123`.

### Composition

- One screenshot, one thesis.
- Crop tighter than a normal product screenshot. Remove dead space that does
  not help prove the claim.
- Keep the desktop shell or app chrome only when it helps the image read as a
  real operating tool.
- Favor the work surface itself over large empty side areas.
- Every screenshot should survive being reused in a hero, feature block, or
  social crop.

### Product Truthfulness

- Only use surfaces that exist in Rudder today.
- Do not invent fake widgets just for marketing.
- It is acceptable to curate the data, crop, and state for clarity.
- It is not acceptable to imply a workflow the product does not support.

## Recommended Shot Set

Use seven proof shots by default.
If the landing cannot accommodate all seven, keep the first five and treat the
last two as secondary feature shots.

| Shot | Surface | Product claim | Landing use |
| --- | --- | --- | --- |
| `dashboard-control-plane` | Dashboard | The organization is alive and legible | hero or top feature |
| `chat-create-issue` | Messenger chat | Chat turns requests into tracked work | feature block |
| `issue-execution-loop` | Issue detail / issue thread | One issue closes end to end | feature block |
| `approval-review` | Approval review block | Humans stay in control | feature block |
| `heartbeats-team-ops` | Heartbeats | Agents operate as a team | feature block |
| `costs-budget-control` | Costs | Autonomy stays budget-visible | supporting proof |
| `org-structure` | Org chart | Work belongs to an organization | supporting proof |

## Detailed Shot Briefs

### 1. Dashboard Control Plane

- Claim:
  Rudder lets the operator understand what the organization is doing right now.
- Surface:
  Dashboard
- Primary crop:
  Top summary region plus the first row of recent activity / metric cards.
- Must show:
  - active agents
  - non-zero spend
  - open work
  - pending approvals
  - a short list of recent meaningful outcomes
- Recommended data:
  - `12 Agents Enabled`
  - `4 Running now`
  - `7 Open tasks`
  - `2 Pending approvals`
  - `$428.60 Week spend`
  - recent outcomes such as:
    - `PR #184 merged for desktop startup crash fix`
    - `Pricing page preview deployed`
    - `Public beta launch brief shared`
- Avoid:
  - all-zero metric cards
  - duplicate activity cards that say effectively the same thing
  - blank charts with no recent movement
- Landing caption:
  `See who is working, what changed, what it cost, and where review is needed.`

### 2. Chat Create Issue

- Claim:
  Chat is an intake surface that can convert a request into a durable issue.
- Surface:
  Messenger chat thread
- Primary crop:
  The assistant exchange plus the issue-draft review block and the resulting
  created-issue confirmation.
- Must show:
  - a user request grounded in real work
  - assistant clarification or synthesis
  - a review block for issue creation
  - a visible decision action that converts the proposal into durable work
  - created issue confirmation with the new issue ID
- Recommended user request:
  `Create an issue to ship the enterprise pricing comparison page before Friday. It needs competitor callouts, two customer proof points, and a draft CTA.`
- Recommended issue draft:
  - title: `Ship enterprise pricing comparison page`
  - assignee: `Growth Lead`
  - priority: `High`
  - labels: `launch`, `website`
  - summary bullets:
    - compare Rudder against two alternatives
    - include customer proof section
    - draft CTA for desktop beta
- Recommended confirmation:
  `Created issue RUD-184 and assigned it to Growth Lead.`
- Avoid:
  - a chat screenshot that only shows loose brainstorming
  - a block that looks like generic message text instead of a reviewable object
  - empty left-thread lists that make the product feel inactive
- Landing caption:
  `Turn a request into tracked work without losing the conversation that created it.`

### 3. Issue Execution Loop

- Claim:
  Rudder keeps execution attached to the issue until the work is done.
- Surface:
  Issue detail or issue-style thread inside Messenger
- Primary crop:
  Header plus the most useful progress updates and output references.
- Must show:
  - issue title
  - status
  - assignee
  - one or two agent updates
  - at least one output artifact
  - resolution or near-resolution state
- Recommended issue:
  `RUD-184 Ship enterprise pricing comparison page`
- Recommended visible progress:
  - status: `In review` or `Done`
  - assignee: `Growth Lead`
  - linked output:
    - `Preview deployed: pricing-v4`
    - `PR #184 opened`
    - `docs/pricing-comparison.md updated`
  - update snippets:
    - `Added competitor matrix and customer proof section.`
    - `Waiting on final approval for public-facing copy.`
- Avoid:
  - a long transcript with no visible artifacts
  - an issue that looks idle or underdefined
  - copy that duplicates the dashboard instead of showing execution detail
- Landing caption:
  `Execution stays attached to the issue, with updates, artifacts, and decision history in one place.`

### 4. Approval Review

- Claim:
  Rudder keeps a human in control when work needs a decision.
- Surface:
  Approval review block, ideally inside Messenger or an approval detail surface
- Primary crop:
  Proposal summary, risk note, linked issue or output, and visible decision
  actions.
- Must show:
  - approval title
  - why approval is needed
  - linked work object
  - approve / request revision actions
  - compact supporting rationale
- Recommended approval:
  `Approve publish of enterprise pricing page`
- Recommended support text:
  - reason: `Public-facing pricing and claim language changed.`
  - linked issue: `RUD-184`
  - risk note: `Customer quotes and competitor claims need operator review before publish.`
- Avoid:
  - approvals rendered as tiny badges with no decision context
  - generic `approve / reject` UI without the object being reviewed
  - large empty helper copy
- Landing caption:
  `Autonomy moves fast, but public-facing or risky changes still stop for review.`

### 5. Heartbeats Team Ops

- Claim:
  Rudder runs a team of agents with visible schedules and recent outcomes.
- Surface:
  Organization `Heartbeats`
- Primary crop:
  Agent rows with scheduler state, last run, and latest result.
- Must show:
  - multiple agent roles
  - mixed states such as scheduled, running, and configured inactive
  - last-run recency
  - latest run outcome summary
- Recommended rows:
  - `CEO` - scheduled every `6h` - last run `18m ago`
  - `Founding Engineer` - scheduled every `30m` - latest result `Fixed desktop startup crash`
  - `Design Engineer` - scheduled every `2h` - latest result `Revised pricing page hierarchy`
  - `Release Engineer` - scheduled every `4h` - latest result `Packaged beta build and smoke checks`
  - `Growth Lead` - configured inactive - latest result `Drafted beta launch brief`
- Avoid:
  - a list of identical idle rows
  - no visible evidence of what recent runs accomplished
  - overcropping so the table stops reading as team operations
- Landing caption:
  `Run specialists on a schedule and keep their latest work visible at the organization level.`

### 6. Costs Budget Control

- Claim:
  Rudder makes autonomous work cost-legible instead of invisible.
- Surface:
  Costs page or a dense dashboard cost block
- Primary crop:
  Spend summary plus one provider, agent, or incident breakdown that proves
  governance.
- Must show:
  - non-zero spend
  - period framing
  - at least one budget or provider breakdown
  - one sign of control, such as a threshold or policy state
- Recommended data:
  - month spend around `$1,842`
  - provider split across `Claude`, `Codex`, and `Gemini`
  - one note such as `Weekly Claude budget at 82%`
  - optional incident or policy row showing review threshold behavior
- Avoid:
  - isolated big-number spend with no breakdown
  - tiny unreadable chart-only crops
  - costs that feel disconnected from the team and work shown elsewhere
- Landing caption:
  `Track provider spend, see where the burn is coming from, and keep policy in view.`

### 7. Org Structure

- Claim:
  Work is organized through roles and reporting lines, not one giant prompt.
- Surface:
  Org chart
- Primary crop:
  CEO plus one or two clear reporting branches.
- Must show:
  - top-level goal context
  - at least two reporting branches
  - role specialization that matches the work elsewhere in the story
- Recommended structure:
  - `CEO`
  - reports:
    - `Founding Engineer`
    - `Growth Lead`
  - under `Founding Engineer`:
    - `Design Engineer`
    - `Release Engineer`
  - under `Growth Lead`:
    - `Support Ops`
- Avoid:
  - a huge unreadable graph
  - too many decorative node treatments
  - roles that do not match the screenshots on the rest of the landing
- Landing caption:
  `Define the team structure once, then let goals, work, and approvals follow it.`

## Cross-Shot Consistency Rules

Every shot in the set should share these details:

- organization name remains `Rudder`
- issue IDs stay stable when the same work appears twice
- the same roles recur across dashboard, issues, approvals, and heartbeats
- timestamps move plausibly from one screen to another
- public-beta and desktop-launch work remain the narrative backbone

If the screenshots cannot all come from one believable week of work, the set
will read as stitched together.

## Production Order

Capture in this order:

1. `dashboard-control-plane`
2. `chat-create-issue`
3. `issue-execution-loop`
4. `approval-review`
5. `heartbeats-team-ops`
6. `costs-budget-control`
7. `org-structure`

This order forces the highest-value proof shots to be designed first.

## Final Review Checklist

- Can each image be summarized in one sentence without saying "and" twice?
- Does each image show real product value, not only visual polish?
- Are the metrics and issue IDs coherent across the set?
- Is the chat screenshot clearly about creating tracked work?
- Are at least three screenshots visibly tied to concrete outputs or approvals?
- Would a new visitor understand that Rudder is a control plane, not a generic chat app?
