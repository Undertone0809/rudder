---
title: Product Logic Taxonomy
status: active
coverage: seed
edit_policy: user_confirmed_only
---

# Product Logic Taxonomy

## Domain Ownership

Product facts must have exactly one owning domain. Other files may cite the
owning contract ID but must not restate the behavior as a separate fact.

Seed domains:

- `issues`: issue aggregate, issue state, issue-local flows, issue-visible
  slots.
- `execution`: heartbeat runs, runtime invocation, run admission, transcript,
  result, usage, session, and issue execution lock release.
- `work-routing`: assignment, reviewer routing, checkout, attention, and wakeup
  eligibility.
- `agents`: agent identity, capabilities, runtime config, skills, instructions,
  and runtime-context loading.
- `collaboration`: chat, Messenger, comments, issue threads, unread, and
  conversation semantics.
- `review-feedback-learning`: review decisions, feedback capture, issue/review
  follow-up, and learning promotion.
- `library-and-context`: resources, project Library, file references, and
  context eligibility.
- `automations`: triggers, schedules, output modes, and automation run records.
- `control-plane`: approvals, budgets, activity log, metrics, observability,
  and dashboard-derived signals.
- `organizations-and-goals`: organization identity, goals, projects, and org
  lifecycle.
- `plugins`: installed plugins, plugin workers, capabilities, jobs, webhooks,
  UI slots, logs, and plugin-owned state.

## Tie-Breakers

- Issue state belongs to `issues`; who should act next belongs to
  `work-routing`.
- A reviewer assignment belongs to `work-routing`; the review decision and
  feedback outcome belong to `review-feedback-learning`.
- A heartbeat run belongs to `execution`; issue-visible run evidence is an
  integration from `issues` to `execution`.
- Comment/thread semantics belong to `collaboration`; issue-visible comment
  slots belong to `issues`.
- Activity log semantics belong to `control-plane`; issue-visible timeline
  placement belongs to `issues`.
- Dashboard metrics belong to `control-plane`; metric source behavior belongs
  to the owning domain that emits the underlying state.
- UI page maps belong to `surfaces/`; button/state behavior belongs to the
  owning domain contract.

## Contract IDs

Use stable uppercase IDs:

```text
ISSUE.STATE.001
RUN.WAKEUP.001
ROUTING.REVIEWER.001
AGENT.INSTRUCTIONS.001
```

Prefixes should match the owning domain, not the page where the behavior is
visible.
