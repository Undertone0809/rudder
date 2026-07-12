---
title: Agent Work Loop
status: active
coverage: seed
edit_policy: user_confirmed_only
---

# Agent Work Loop

This is a composed workflow view. It is not an owning source of behavior.

Entry paths:

- Issue-first work uses structured state, assignment, checkout, review, or
  comment wake.
- Chat-first work can execute and complete conversationally or add/link issue
  structure by operator choice; see `CHAT.LIFECYCLE.001`,
  `MESSENGER.ATTENTION.001`, and
  `RUN.CHAT.AGENT.001`.
- IM integrations such as Feishu enter through Messenger/chat binding and may
  create issue/run work; see `IM.FEISHU.001`.
- Automations enter through trigger/run/output routing and then either create
  tracked issues or per-run chats; see `AUTOMATION.*`.

Path:

1. Goal/project reason and context: `ORG.GOAL.001`,
   `ORG.PROJECT.001`.
2. Issue state, hierarchy, comment evidence, and local mutation:
   `ISSUE.STATE.001`, `ISSUE.HIERARCHY.001`, `ISSUE.COMMENTS.001`,
   `ISSUE.WORKFLOW.001`.
3. Assignment, checkout, reviewer, and attention routing:
   `ROUTING.ASSIGNMENT.001`, `ROUTING.CHECKOUT.001`,
   `ROUTING.REVIEWER.001`, `ROUTING.ATTENTION.001`,
   `ROUTING.COMMENT.WAKE.001`.
4. Wakeup admission, timer preflight, and issue execution serialization:
   `RUN.WAKEUP.001`, `RUN.PREFLIGHT.001`, `RUN.ADMISSION.001`.
5. Agent identity, inbox, skills, adapter, instruction/context loading:
   `AGENT.IDENTITY.CONFIG.001`, `AGENT.INBOX.001`,
   `AGENT.SKILLS.001`, `AGENT.RUNTIME.ADAPTERS.001`,
   `AGENT.INSTRUCTIONS.001`.
6. Project resources and workspace context:
   `CONTEXT.RESOURCES.001`, `WORKSPACE.PROJECT.001`,
   `WORKSPACE.RUN.001`.
7. Unified Agent Run execution, managed workspace preflight, and result
   persistence: `RUN.AGENT.UNIFICATION.001`,
   `RUN.WORKSPACE.PREFLIGHT.001`, `RUN.EXECUTION.001`,
   `RUN.RESULT.001`.
8. Review, close-out, feedback, and learning:
   `REVIEW.DECISION.001`, `REVIEW.CLOSEOUT.001`,
   `LEARNING.PROMOTION.001`.
9. Spend, activity, and intelligence readback:
   `CONTROL.BUDGETS.001`, `CONTROL.ACTIVITY.001`,
   `CONTROL.RUN.INTELLIGENCE.001`.
