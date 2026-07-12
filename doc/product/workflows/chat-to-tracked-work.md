---
title: Chat To Tracked Work
status: active
coverage: detailed
edit_policy: user_confirmed_only
---

# Chat To Tracked Work

This is a composed workflow view. It cites owning contracts and must not define
new product rules.

This path is optional. Chat is already a task execution surface; creating or
linking an issue adds structured coordination without promoting the task into a
more legitimate class of work.

Path:

1. Chat conversation/message lifecycle: `CHAT.LIFECYCLE.001`.
2. Optional chat assistant turn: `RUN.CHAT.AGENT.001`,
   `RUN.AGENT.UNIFICATION.001`, `RUN.RESULT.001`.
3. Rich references and issue/chat links remain readable through
   `CHAT.LIFECYCLE.001`, `LIBRARY.FILES.001`, and `ISSUE.COMMENTS.001`
   where applicable.
4. When the operator chooses structured coordination, create, link, or update
   issue work:
   `ISSUE.WORKFLOW.001`, `ISSUE.STATE.001`, `ISSUE.HIERARCHY.001`.
5. Assignment, reviewer, mention, and checkout paths use
   `ROUTING.ASSIGNMENT.001`, `ROUTING.REVIEWER.001`,
   `ROUTING.ATTENTION.001`, and `ROUTING.CHECKOUT.001`.
6. Messenger attention/read state uses `MESSENGER.ATTENTION.001`.
