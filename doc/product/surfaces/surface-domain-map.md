---
title: Surface Domain Map
status: active
coverage: seed
edit_policy: user_confirmed_only
---

# Surface Domain Map

Surface docs are maps, not sources of truth. Every behavioral claim must cite an
owning domain contract.

## Issue Detail

- Issue fields, local status, and issue-visible slots: `ISSUE.SURFACE.001`.
- Issue status rules: `ISSUE.STATE.001`.
- Parent/sub-issue hierarchy and ancestor context:
  `ISSUE.HIERARCHY.001`.
- Issue comments, local timeline evidence, and comment-thread display:
  `ISSUE.COMMENTS.001`.
- Assignment, checkout, reviewer, and attention routing:
  `ROUTING.ASSIGNMENT.001`, `ROUTING.CHECKOUT.001`,
  `ROUTING.REVIEWER.001`, `ROUTING.ATTENTION.001`.
- Comment-triggered assignee/mention/reopen wakes:
  `ROUTING.COMMENT.WAKE.001`.
- Structured reviewer decisions and issue/review follow-up:
  `REVIEW.DECISION.001`, `REVIEW.CLOSEOUT.001`.
- Run evidence, transcript, usage, and results: `RUN.RESULT.001`.
- Issue-backed run admission and follow-up: `RUN.ADMISSION.001`.

## Agent Detail

- Runtime instruction and context loading: `AGENT.INSTRUCTIONS.001`.
- Agent identity/config, runtime adapter, skills, telemetry, and inbox:
  `AGENT.IDENTITY.CONFIG.001`, `AGENT.RUNTIME.ADAPTERS.001`,
  `AGENT.SKILLS.001`, `AGENT.SKILL.TELEMETRY.001`,
  `AGENT.INBOX.001`.
- Heartbeat runs and transcripts: `RUN.AGENT.UNIFICATION.001`,
  `RUN.EXECUTION.001`, `RUN.RESULT.001`.
- Assigned and reviewable issue attention: `ROUTING.ASSIGNMENT.001`,
  `ROUTING.REVIEWER.001`, `ROUTING.ATTENTION.001`.
- Integrations tab for Feishu/IM setup and Feishu source badges on
  chat-origin run details: `IM.FEISHU.001`.

## Issues List

- Issue state and visible issue metadata: `ISSUE.SURFACE.001`.
- Assignment/reviewer display and inline updates: `ROUTING.ASSIGNMENT.001`,
  `ROUTING.REVIEWER.001`.

## Goal Detail And Goals List

- Goal hierarchy, owner, status, dependency protection, and linked work:
  `ORG.GOAL.001`.
- Project and issue references remain governed by `ORG.PROJECT.001` and
  `ISSUE.SURFACE.001`.

## Project Detail

- Project identity, goal links, lead agent, and grouping: `ORG.PROJECT.001`.
- Project resources and Library-backed context: `CONTEXT.RESOURCES.001`,
  `LIBRARY.FILES.001`.
- Project workspaces: `WORKSPACE.PROJECT.001`.
- Issue/project execution evidence: `RUN.AGENT.UNIFICATION.001`,
  `RUN.RESULT.001`.

## Automations

- Definition, trigger, status, owner, and run history:
  `AUTOMATION.DEFINITION.001`, `AUTOMATION.TRIGGER.001`,
  `AUTOMATION.RUN.001`.
- Output mode and linked issue/chat navigation: `AUTOMATION.OUTPUT.001`,
  `ISSUE.WORKFLOW.001`, `CHAT.LIFECYCLE.001`.

## Library And Organization Workspaces

- Library file lifecycle, protected paths, and references:
  `LIBRARY.FILES.001`.
- Organization/project resources: `CONTEXT.RESOURCES.001`.
- Project and execution workspace policy: `WORKSPACE.PROJECT.001`,
  `WORKSPACE.RUN.001`.
- Workspace backup versions, browsing, restore/delete, and download:
  `WORKSPACE.BACKUP.001`.

## Messenger And Chat

- Chat conversation/message lifecycle, attachments, rich references, and
  assistant turns: `CHAT.LIFECYCLE.001`, `RUN.CHAT.AGENT.001`.
- Messenger thread attention, unread/read state, ordering, pin/archive, and
  issue/approval/run attention: `MESSENGER.ATTENTION.001`.
- Messenger custom group membership, grouped-row navigation/read behavior, and
  group pin priority: `MESSENGER.CUSTOM.GROUPS.001`.
- Feishu/IM source badges on Feishu-bound chat rows: `IM.FEISHU.001`.
- Issue comment and issue-thread facts: `ISSUE.COMMENTS.001`,
  `ROUTING.COMMENT.WAKE.001`.

## Run Workspace And Run Intelligence

- Execution workspace lifecycle: `WORKSPACE.RUN.001`.
- Unified Agent Run facts and result/transcript evidence:
  `RUN.AGENT.UNIFICATION.001`, `RUN.RESULT.001`.
- Derived summaries and dashboard-style run intelligence:
  `CONTROL.RUN.INTELLIGENCE.001`.

## Dashboard Costs And Activity

- Cost, budget, and spend trend facts: `CONTROL.BUDGETS.001`.
- Activity/audit timeline facts: `CONTROL.ACTIVITY.001`.
- Dashboard-derived run summaries: `CONTROL.RUN.INTELLIGENCE.001`.
- Dashboard aggregation: `CONTROL.DASHBOARD.001`.

## Calendar And Inbox

- Calendar event source identity and navigation: `CONTROL.CALENDAR.001`.
- Human operator attention aggregation: `CONTROL.INBOX.001`.

## Settings Onboarding Export Import

- Instance/operator/organization settings: `ORG.SETTINGS.001`.
- Fresh organization and invite onboarding: `ORG.ONBOARDING.001`.
- Organization export/import preview and apply: `ORG.PORTABILITY.001`.

## Documents And Work Products

- Editable documents, revisions, legacy issue documents, and output artifacts:
  `DOCUMENT.WORKPRODUCT.001`.

## Plugin Manager And Plugin Pages

- Plugin install/update/uninstall and worker health: `PLUGIN.LIFECYCLE.001`.
- Capability-gated host bridge and namespaced tools: `PLUGIN.CAPABILITY.001`.
- Plugin jobs/webhooks/logs/state: `PLUGIN.JOBS.WEBHOOKS.001`.
