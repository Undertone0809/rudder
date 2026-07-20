---
title: Automation To Output
status: active
coverage: detailed
edit_policy: user_confirmed_only
---

# Automation To Output

This is a composed workflow view. It cites owning contracts and must not define
new product rules.

Path:

1. Automation definition and owner/context: `AUTOMATION.DEFINITION.001`.
2. Trigger eligibility and dispatch source:
   `AUTOMATION.TRIGGER.001`.
3. Automation run record, concurrency, idempotency, and terminal state:
   `AUTOMATION.RUN.001`.
4. Output path selection: `AUTOMATION.OUTPUT.001`.
5. Tracked issue output enters `ISSUE.WORKFLOW.001`,
   `ROUTING.ASSIGNMENT.001`, `RUN.WAKEUP.001`, and
   `RUN.ADMISSION.001`.
6. Chat output enters `CHAT.LIFECYCLE.001`, `RUN.CHAT.AGENT.001`,
   `RUN.AGENT.UNIFICATION.001`, and `RUN.RESULT.001`.
7. Spend, activity, and intelligence readbacks use `BUDGET.ENFORCEMENT.001`,
   `ACTIVITY.AUDIT.001`, and `RUN.INTELLIGENCE.001`.
