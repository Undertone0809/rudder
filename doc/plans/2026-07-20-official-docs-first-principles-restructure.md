---
title: Restructure the bilingual official documentation around first principles
date: 2026-07-20
kind: implementation
status: in_progress
area: planning
entities:
  - official_docs
  - bilingual_docs
  - documentation_sources
  - rudder_docs
issue:
related_plans:
  - 2026-07-16-recent-product-logic-official-docs-sync.md
  - 2026-07-18-rudder-docs-skill-proposal.md
supersedes: []
related_code:
  - docs
  - scripts/docs-content-map.yml
  - scripts/docs-content-map.mjs
  - server/resources/bundled-skills/rudder-docs/references/source-map.md
  - server/resources/bundled-skills/rudder-docs/evals
  - .github/workflows/docs-staging.yml
  - .github/workflows/docs-production.yml
commit_refs:
  - "docs: establish first-principles documentation foundation"
  - "docs: rewrite concepts and how-to guides"
  - "docs: complete first-principles documentation migration"
updated_at: 2026-07-20
---

# Restructure the bilingual official documentation around first principles

## Summary

Rewrite the English and Chinese public documentation so that a new reader can
understand Rudder before being asked to operate it, while an agent can still
locate exact, authoritative facts quickly.

What, Why, and How are questions every page must answer, not generic headings
that every page must repeat. Home pages begin with a real situation and result,
then explain what Rudder is, why it helps, and the first action. Concept pages
introduce the idea through one consistent case, explain when it is useful, and
end with operating boundaries. How-to pages begin with the intended result and
prerequisites, then give case-backed steps, success signals, and recovery.
Reference pages stay direct and normative.

English and Chinese share a fact brief and contract ownership map. Each locale
is written in its own natural voice instead of being translated sentence by
sentence.

## Problem

The current public documentation often presents product vocabulary before the
reader has a concrete problem to solve. Chinese pages also retain too many
ordinary English nouns, which makes the text read like translated interface
copy. Repeated definitions, legacy control-plane positioning, incomplete
`llms.txt` coverage, and hand-maintained redirects make both human reading and
agent retrieval less reliable.

## Scope

In scope:

- preserve the five existing navigation groups and the current Concepts order;
- rewrite all canonical English and Chinese pages using page-type-specific
  narrative rules;
- add a four-to-six-step learning path and manual next/previous links to both
  Overview pages;
- define Issue consistently as a durable task record with explicit status and
  lifecycle;
- retire current public-facing "control plane" positioning while keeping
  historical, protocol, compatibility, and internal uses;
- add bilingual approvals, budgets, cost, and activity Reference pages;
- redirect old Control Plane, Chat, and Messenger routes in one permanent hop;
- add a private content map for pages, contracts, examples, aliases, and
  bilingual pairing;
- generate `docs/llms.txt` and redirect artifacts from the content map;
- add deterministic integrity checks and warning-only alignment reminders;
- update the bundled `rudder-docs` source map and retrieval-authority evals
  without widening skill activation;
- localize About, Contact, footer, and navbar content;
- validate the rendered site in English and Chinese on desktop and mobile.

Out of scope:

- semantic edits under `doc/product/**`;
- deleting the internal governance-and-visibility domain or bundled
  `operating-practices.md`;
- changing product behavior, runtime behavior, or skill trigger scope;
- rewriting historical facts in Release Notes;
- manual production deployment;
- claiming the first-reader gate has passed before ten eligible participants
  have completed the study.

## Content decisions

### Page structures

- Home: real situation and result, product definition, reason to use it, first
  action.
- Concept: definition, one continuing case, when it helps, operating boundary.
- How-to: completed state, prerequisites, case-backed steps, success signal,
  recovery.
- Reference: definition, states, constraints, boundaries, example.

Each page may use one main example and one high-risk edge case. Normative facts
must also exist outside examples.

### Issue terminology

English definition:

> An issue is a durable task record with an explicit status and lifecycle. Use
> one when work needs a named owner, dependencies, or a review path; comments,
> agent runs, artifacts, and review decisions can stay with the same record.

Chinese definition:

> Issue（任务单）是带有明确状态和生命周期的任务记录。需要指定负责人、跟踪依赖或安排评审时使用；评论、Agent 运行、产物和评审结论可以留在同一条记录中。

Public pages must not call an Issue a "structured task" or "结构化任务".
Chinese retains English names only when a reader must recognize them in the UI.
Ordinary terms use natural Chinese, including 负责人、评审人、运行记录、运行环境、
对话记录、产物 and 审批.

### Public control-plane retirement

Remove Control Plane as a current product concept, navigation item, home-page
positioning, About description, SEO phrase, and ordinary public prose. Keep the
term only in historical Release Notes, the guarded Product Logic Registry,
protocol identifiers, compatibility notes, old URLs, and the bundled internal
practice reference.

Add these canonical pages:

- `/reference/approvals-budgets-activity`
- `/zh/reference/approvals-budgets-activity`

Both pages expose these stable anchors:

- `approvals`
- `budgets-and-cost`
- `activity`
- `run-intelligence`
- `dashboard-calendar-and-inbox`

At the top, a legacy topic map sends readers to the new locations for approval,
budget, activity, run evidence, Dashboard, Calendar, and human attention.

Permanent one-hop redirects:

- `/concepts/control-plane` to `/reference/approvals-budgets-activity`
- `/zh/concepts/control-plane` to
  `/zh/reference/approvals-budgets-activity`
- `/concepts/chat` and `/concepts/messenger` to
  `/concepts/chat-messenger`
- `/zh/concepts/chat` and `/zh/concepts/messenger` to
  `/zh/concepts/chat-messenger`

### Public fact ownership

- `APPROVAL.GOVERNED.ACTIONS.001`, `BUDGET.ENFORCEMENT.001`, and
  `ACTIVITY.AUDIT.001`: approvals, budgets, and activity Reference.
- `RUN.INTELLIGENCE.001` and `RUN.RESULT.001`: Agents and Agent Runs.
- `DASHBOARD.SUMMARY.001`: Overview.
- `CALENDAR.SOURCE.001`: Calendar.
- `INBOX.ATTENTION.001` and `MESSENGER.ATTENTION.001`: Chat and Messenger.
- `AGENT.CONTROL.TOOLS.001`: agent runtime configuration guide.
- `REVIEW.DECISION.001` and `REVIEW.CLOSEOUT.001`: review concept page.
- `DESKTOP.STARTUP.RECOVERY.001`: Installation.
- `SERVER.LIFECYCLE.001`: internal only.

Review explains what a reviewer inspects. Agents and Agent Runs own run summary,
raw evidence, runtime, and cost relationships. Dashboard belongs to Overview,
Calendar to Calendar, and human attention to Chat and Messenger.

## Maintenance system

Add `scripts/docs-content-map.yml` as the private public-docs manifest. It
contains stable page IDs, page type, user job, status, locale files, canonical
URLs, explicit anchors, composition, source documents, `llms.txt` inclusion,
pairing exceptions, contract ownership, aliases, and example IDs.

The same manifest registers examples as `real_rudder_case`,
`anonymized_real_case`, or `illustrative_case`. A real case records its starting
request, surface choice, human and agent responsibilities, intervention points,
artifacts, outcome, and traceable evidence. The first verified real cases are
the Rudder 0.5.0 release and the Steer fix. Performance tests, contract audits,
and operations examples stay illustrative unless their evidence and permission
records are complete.

Generate the following from the manifest, `docs.json`, and MDX frontmatter:

- a complete canonical `docs/llms.txt` for all Concept, How-to, Reference, and
  Project pages;
- Mintlify redirects;
- Vercel redirects used by both documentation deployment workflows.

`docs:integrity` fails on deterministic errors involving files, URLs, locale
pairs, contract IDs, primary ownership, canonical metadata, hreflang, anchors,
navigation, redirects, sitemap, or `llms.txt`.

`docs:alignment` reports possible English, Chinese, contract, or supporting-page
drift and always exits successfully. Reviewers classify each reminder as fixed,
intentional, or false positive.

Update the bundled `rudder-docs` source map and retrieval-authority fixtures.
Keep its main router and activation boundary unchanged.

## Delivery sequence

### Batch 1: rules and high-traffic pilot

1. Add this plan, the public-doc writing guide, bilingual glossary, UI label
   allowlist, content map, example registry, generators, and checks.
2. Record the current canonical URL, anchor, navigation, redirect, and locale
   baseline.
3. Rewrite both Home, Overview, Installation, First Organization, Issues, and
   Chat and Messenger page pairs.
4. Add the recommended learning path and manual page sequence to Overview.
5. Add a first-reader test protocol and results template for five Chinese and
   five English first-time readers.
6. Validate, review, commit, and push only batch files.

### Batch 2: Concepts and How-to

1. Rewrite all remaining bilingual Concept and How-to page pairs.
2. Clarify Agent, Run, runtime, cost, output, and raw evidence relationships.
3. Distinguish Review from Approval.
4. Remove roadmap copy, internal implementation detail, and duplicated state
   descriptions; link to authoritative Reference pages.
5. Review each English and Chinese pair as one unit.
6. Validate, review, commit, and push only batch files.

### Batch 3: Reference, Project, and retirement cleanup

1. Rewrite all Reference pages and add the approvals, budgets, and activity
   pair.
2. Add Chinese About and Contact pages and locale-specific footer and navbar
   content.
3. Preserve historical Release Notes terms while standardizing current entry
   copy and future-writing guidance.
4. Delete duplicate Control Plane, Chat, and Messenger bodies atomically after
   redirects, links, SEO, sitemap, and `llms.txt` are correct.
5. Update `rudder-docs` source routing and retrieval-authority evals.
6. Complete human, agent retrieval, desktop, and mobile checks.
7. Validate, review, commit, and push only batch files.

## Success criteria

- Every canonical public page has one locale partner unless the manifest records
  an intentional exception.
- The five navigation groups remain intact and Concepts keeps its current order
  except for removal of the retired Control Plane entry.
- Every required contract has one public primary owner or a documented
  `internal_only` reason.
- All canonical pages appear in generated `llms.txt`; redirect aliases do not.
- Every legacy route resolves through one 301 or 308 response to the correct
  language and final page.
- Canonical, hreflang, stable anchors, navigation, sitemap, redirects, and
  generated metadata agree.
- Chinese prose contains no undefined ordinary English terms outside the
  allowlist for UI labels, history, legacy URLs, and compatibility indexes.
- Retrieval fixtures identify source class and required contracts exactly,
  reach at least 90 percent primary URL accuracy, resolve legacy control-plane
  queries through the compatibility entry, and never use an illustrative case
  as sole normative authority.
- First-reader research reaches the approved comprehension and findability
  thresholds before the rewrite is treated as fully rolled out.

## Validation

For every batch:

```sh
pnpm docs:metadata:generate
pnpm docs:integrity
pnpm docs:alignment
pnpm docs:validate
```

Also run the documentation structure tests, static export, and rendered browser
checks for English and Chinese. Verify representative desktop and mobile pages
and retain screenshots outside the repository.

Before final handoff:

```sh
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm product-logic:check
```

After static export, request every canonical URL and require HTTP 200. Request
each alias without following redirects and require one 301 or 308 response with
the exact Location. The final page must expose the correct canonical, hreflang,
and compatibility anchors.

## Open issues and rollout gates

All three repository implementation batches are complete and validated. The
plan remains `in_progress` because rollout still depends on the external
first-reader study and an explicitly authorized production publication.

- The first-reader study requires ten eligible external participants. The
  repository can include the protocol and results template, but implementation
  must not claim that this gate passed without completed observations.
- Manual production publishing is not authorized by this plan.
- `doc/product/**` remains unchanged. Any later Product Logic Registry update
  requires separate explicit authorization.
