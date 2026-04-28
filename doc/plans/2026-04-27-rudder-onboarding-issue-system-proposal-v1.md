# Proposal: Rudder Onboarding Issue System v1

**Date:** 2026-04-27  
**Status:** Draft for product/design review  
**Scope:** User-facing onboarding issue content, onboarding project structure, first agent-work loop guidance  
**Primary goal:** Move new users from setup into one real Rudder work loop as quickly as possible.

---

## 1. Executive Summary

This proposal recommends replacing Rudder's current single-seed onboarding issue with a structured onboarding issue system inspired by Multica's issue-based onboarding pattern, but adapted to Rudder's own product model.

The new onboarding should create:

1. One pinned welcome issue that explains the Rudder work loop.
2. One `Getting Started` project containing concrete onboarding issues.
3. Five high-priority guide issues in `Todo` that walk the user through the first real work loop.
4. Four optional guide issues in `Backlog` that progressively introduce reusable workflows, goals, files, and multi-agent roles.

The core onboarding loop should be:

```text
real request -> runnable issue -> agent execution -> human review -> reusable context
```

This changes onboarding from "define the organization first" to "move one real piece of work into Rudder first." It respects the reality that users often discover their goals, workflows, and team structure gradually, as they start moving actual work into the product.

The recommended default experience is:

- Do not require a goal on day zero.
- Do not seed a synthetic demo task such as hiring a founding engineer.
- Do not auto-run agents on guide issues.
- Do create a concrete `Getting Started` project.
- Do teach the user the minimum mechanics required to complete one real agent-work loop.

---

## 2. Context

Rudder is positioned as the operating layer for agent teams. Its product model is not "one prompt goes in, one answer comes out." It is a durable work system where humans and agents coordinate through goals, tasks, knowledge, workflows, approvals, and feedback.

Rudder's product direction also emphasizes that:

- Work should belong to an organization, not a loose thread.
- Durable execution should stay attached to issues, approvals, and outputs.
- Chat should help clarify and route work.
- Tasks should eventually trace back to a goal.
- The current north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.

The key interpretation for onboarding is that goal traceability is the target state, not necessarily the first input. New users may not know the right goal, org structure, or workflow yet. They often know only a current task, a vague direction, or a process they want to migrate.

The onboarding system should therefore help them bring in one real piece of work and then progressively enrich it with structure.

---

## 3. Reference Pattern: What to Learn From Multica

The Multica screenshots show a strong onboarding grammar:

1. A pinned welcome issue introduces the workspace and collaboration model.
2. A `Getting Started` project contains numbered onboarding issues.
3. High-priority issues sit in `Todo`; lower-priority enrichment issues sit in `Backlog`.
4. Each issue teaches one specific behavior.
5. The issue body is concrete and action-oriented, usually following the pattern: explanation, steps, gotcha, success signal.

Rudder should adopt this grammar, but not copy the exact content.

Multica's onboarding teaches users how to operate a single-agent workspace. Rudder needs to teach users how to move real work through a durable agent-work loop. That means Rudder's onboarding issues should focus less on feature exploration and more on work migration:

```text
capture real work -> structure it as an issue -> trigger an agent -> review output -> preserve reusable context
```

---

## 4. Problem Statement

The current onboarding direction has four product problems.

### 4.1 Goal-first onboarding is too abstract for many users

Asking users to define the organization goal upfront assumes they already understand what structure they want. In practice, users often figure this out only after they try moving one real task or workflow into Rudder.

### 4.2 Synthetic onboarding tasks feel fake

A default task like "hire your first engineer" can demonstrate a product path, but it assumes a company-like organization, a hiring workflow, and a permission model the user may not care about. It risks turning onboarding into a demo rather than a workflow migration experience.

### 4.3 A single starter issue is too vague

One generic starter issue does not teach the user the actual sequence of Rudder actions: where requests go, when to use chat, when to create an issue, how to trigger an agent, how to review output, and when to save reusable context.

### 4.4 Auto-running a welcome issue can create a fragile first impression

The Multica reference shows a welcome issue where the agent run failed. That is useful as a caution. Rudder should not make the first impression depend on a successful agent runtime. The welcome guidance should be product-authored and stable; the first agent run should happen later on a real issue.

---

## 5. Goals

This proposal aims to achieve the following outcomes:

1. Help the user start with a real task, request, project, or workflow, even if it is vague.
2. Teach the minimum mechanics required to run one agent-work loop.
3. Convert chat or raw intent into a durable issue.
4. Make the first agent run happen on real user work, not a synthetic demo.
5. Introduce human review as a required part of the loop.
6. Introduce reusable context after the user has seen why context matters.
7. Defer goal creation until the user has at least one real work object to connect to it.
8. Keep deeper setup, such as files, workflows, and second agents, as progressive enrichment.

---

## 6. Non-goals

This proposal does not aim to:

1. Replace the entire onboarding wizard.
2. Require users to complete organization modeling before using Rudder.
3. Require a goal before the first issue can exist.
4. Require all users to connect a repository or external file source.
5. Require all users to create multiple agents.
6. Teach every Rudder feature during onboarding.
7. Hide agent failures. Failures should be visible and reviewable, but they should not block the onboarding explanation itself.

---

## 7. Proposed User Experience

After the user creates an organization and first agent, Rudder should create two layers of onboarding artifacts.

### 7.1 Pinned welcome issue

A pinned issue introduces the collaboration model and points the user to the `Getting Started` project. It should be stable product guidance, not an auto-run agent task.

### 7.2 Getting Started project

A project named `Getting Started` contains concrete onboarding issues. Internally, it can still use an `onboarding` origin or slug.

The project should visually resemble a normal Rudder project board. This matters because onboarding should happen inside the same work surface users will rely on later.

### 7.3 Critical path and enrichment path

The first five issues are the critical path. They should be placed in `Todo`.

The remaining four issues are progressive enrichment. They should be placed in `Backlog`.

This creates a clear path without overwhelming the user.

---

## 8. Recommended Initial Board State

### Pinned

| Title | Status | Purpose |
| --- | --- | --- |
| `Welcome to Rudder - let's run your first work loop` | Done | Explain the mental model and point to Getting Started. |

### Getting Started / Todo

| Step | Issue | Priority | Purpose |
| --- | --- | --- | --- |
| 1 | `Tell Rudder one real thing you are working on` | High | Capture real user work as the onboarding input. |
| 2 | `Turn that request into your first runnable issue` | High | Convert raw intent into a durable issue. |
| 3 | `Trigger your agent on the issue` | High | Teach the execution trigger mechanic. |
| 4 | `Review the result and leave feedback` | High | Complete the human-agent feedback loop. |
| 5 | `Save shared context your agent should reuse` | High | Start compounding knowledge from the first run. |

### Getting Started / Backlog

| Step | Issue | Priority | Purpose |
| --- | --- | --- | --- |
| 6 | `Capture one reusable workflow from the first run` | Medium | Turn one successful pattern into a reusable workflow. |
| 7 | `Link this work to a goal` | Medium | Add goal traceability after real work exists. |
| 8 | `Attach files, repo, or workspace references` | Low | Connect real materials when the work needs them. |
| 9 | `Add a second agent with a different role` | Low | Introduce multi-agent structure only after a role is clear. |

---

# 9. Detailed Issue Specifications

## Issue 0: Welcome to Rudder - Let's Run Your First Work Loop

### Metadata

| Field | Value |
| --- | --- |
| Title | `Welcome to Rudder - let's run your first work loop` |
| Status | `Done` |
| Priority | `High` |
| Project | None |
| Assignee | None |
| Pinned | Yes |
| Agent-triggered | No |
| Guide issue | Yes |

### Issue body

```md
Welcome to Rudder.

Rudder is where humans and agents move real work through a clear loop:

request -> issue -> agent run -> review -> reusable context

You do not need to configure the whole organization on day one. Start by moving one real piece of work into Rudder.

Here is the fastest path:

1. Open the Getting Started project.
2. Start with "Tell Rudder one real thing you are working on."
3. Turn that request into a runnable issue.
4. Assign the issue to your first agent and set it to Todo.
5. Review the result and save any context you do not want to repeat next time.

Chat is useful for clarifying work.
Issues are where durable execution happens.

When you are ready, open the first Getting Started issue.
```

### Reasoning

The welcome issue establishes Rudder's mental model without requiring the user to make an abstract setup decision. It explains the full loop in one sentence and then points the user to the project where the actual onboarding work happens.

The issue should not be assigned to the agent by default. If the first agent run fails on a synthetic welcome task, the user may lose confidence before trying Rudder on real work. Product-authored welcome guidance is more reliable.

This issue also introduces the difference between chat and issues. Chat is for clarification and routing. Issues are where durable work happens.

### Completion criteria

This issue is created as already done. The user does not need to complete it.

---

## Issue 1: Tell Rudder One Real Thing You Are Working On

### Metadata

| Field | Value |
| --- | --- |
| Title | `1. Tell Rudder one real thing you are working on` |
| Status | `Todo` |
| Priority | `High` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No |
| Guide issue | Yes |

### Issue body

```md
Every useful Rudder workflow starts with real work.

Do not invent a demo task. Pick one thing you are already thinking about, building, managing, debugging, researching, or trying to organize.

It can be vague. Rudder can help clarify it.

Try it now:

1. Open Chat.
2. Write 2-5 sentences about one real thing you are working on.
3. Include whatever you know:
   - What are you trying to move forward?
   - What outcome would be useful?
   - What context should the agent know?
   - What is currently unclear or blocked?
4. Ask Rudder to turn it into a short working brief.
5. Paste the working brief back into this issue as a comment.

Suggested prompt:

"I want to move this work into Rudder. Please summarize it as a short working brief and identify the first runnable issue."

Working brief template:

- Current work:
- Desired outcome:
- Useful context:
- Known constraints:
- First possible task:
- Missing information:

You'll know it worked when:

- This issue has a short working brief in the comments.
- The brief describes real work, not a sample task.
- There is at least one candidate task that could become an issue.
```

### Reasoning

This is the true onboarding entry point. It asks for real work, not a complete organization model.

The user may not know their goal yet. They may not know whether the work should become a project, a goal, a workflow, or a one-off issue. That is acceptable. The goal of this step is simply to capture enough real context to produce the first durable work object.

This issue also teaches the role of chat. Chat is used to clarify ambiguous intent and produce a working brief. The durable output is then moved back into an issue.

### Completion criteria

This issue is complete when:

1. A working brief exists as a comment or attached note.
2. The brief is based on real user work.
3. The brief identifies at least one candidate task that can become an issue.

---

## Issue 2: Turn That Request Into Your First Runnable Issue

### Metadata

| Field | Value |
| --- | --- |
| Title | `2. Turn that request into your first runnable issue` |
| Status | `Todo` |
| Priority | `High` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No |
| Guide issue | Yes |

### Issue body

```md
Now turn the working brief into a real Rudder issue.

A runnable issue is small enough for an agent to move forward and specific enough for a human to review.

Try it now:

1. Use the working brief from issue 1.
2. Create a new issue.
3. Give it a concrete title.
4. Add a short description with:
   - Desired outcome
   - Scope
   - Acceptance criteria
   - Useful context
   - Known constraints
   - What not to do
5. Keep the issue small. The first issue should be something an agent can make progress on without owning your entire project.
6. Do not worry about linking a goal yet. You can link the work to a goal later.

Suggested issue template:

Title:
[Verb] [specific object] so that [outcome]

Description:

Context:
...

Task:
...

Acceptance criteria:
- ...
- ...

Constraints:
- ...

Do not:
- ...

You'll know it worked when:

- A new real issue exists in Rudder.
- The issue is based on the working brief from issue 1.
- The issue has clear acceptance criteria.
- The issue is small enough for a first agent run.
```

### Reasoning

This issue converts raw intent into durable work.

Rudder should not let onboarding remain in chat. The product value comes from taking ambiguous human intent and turning it into a work object that can be assigned, executed, reviewed, and referenced later.

This issue also teaches a key behavior: the first real issue does not need perfect structure. It only needs enough specificity for an agent to make progress and for a human to review the result.

Goal linking is explicitly deferred. This keeps the first issue low-friction while preserving the ability to add goal traceability later.

### Completion criteria

This issue is complete when:

1. A new real issue exists.
2. The issue is not a sample task.
3. The issue includes desired outcome, scope, acceptance criteria, and constraints.
4. The issue is small enough for one agent run.

---

## Issue 3: Trigger Your Agent on the Issue

### Metadata

| Field | Value |
| --- | --- |
| Title | `3. Trigger your agent on the issue` |
| Status | `Todo` |
| Priority | `High` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No |
| Guide issue | Yes |

### Issue body

```md
Agents in Rudder start work from issues.

To trigger your agent, open the real issue you created in step 2.

Try it now:

1. Open your first runnable issue.
2. In the right-side Properties panel, set Assignee to your first agent.
3. Set Status to Todo.
4. Scroll to Activity.
5. Watch for the agent run to start.

Important:

- Backlog means the issue is parked.
- Todo means the issue is ready to be picked up.
- Assigning the issue to an agent tells Rudder who should work on it.
- Activity is where you can see whether the run started, progressed, failed, or produced output.

You'll know it worked when:

- The issue is assigned to your agent.
- The issue status is Todo or has moved into In Progress.
- Activity shows an agent run, status change, comment, output, or failure event.

If the agent run fails:

- Do not start over.
- Leave the failure visible in Activity.
- Add a short comment describing what you expected.
- Continue to the next issue after recording the failure.
```

### Reasoning

This issue teaches the most important mechanical action in Rudder: how work starts.

Multica's strongest onboarding issue is the one that explains the trigger mechanic. Rudder should provide the same level of specificity: where to click, what property matters, what status matters, where to observe the result, and what to do if it fails.

The guide issue itself should not be assigned to the agent. It should instruct the user to trigger the real issue created in step 2. This prevents a fake guide issue from becoming the user's first agent run.

### Completion criteria

This issue is complete when:

1. The user's real issue is assigned to the first agent.
2. The issue is moved to `Todo` or `In Progress`.
3. The Activity feed shows a visible run, output, or failure state.

---

## Issue 4: Review the Result and Leave Feedback

### Metadata

| Field | Value |
| --- | --- |
| Title | `4. Review the result and leave feedback` |
| Status | `Todo` |
| Priority | `High` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No |
| Guide issue | Yes |

### Issue body

```md
Agent work is only useful if the result can be reviewed.

Open the issue your agent worked on and inspect the latest Activity.

Try it now:

1. Read the agent's comment, output, plan, failure, or proposed next step.
2. Decide what should happen next.
3. Leave one clear review comment.

Use one of these comment patterns:

If the result is useful:

"Looks good. Please mark this done and summarize the final result."

If the result needs revision:

"Please revise this. The missing part is: ..."

If the task is blocked:

"This is blocked because: ... The next useful step is: ..."

If the work should continue:

"Create a follow-up issue for: ..."

If the agent failed:

"The run failed. Expected outcome was: ... Please retry with this additional context: ..."

You'll know it worked when:

- The agent result has been reviewed by a human.
- The issue has a clear next state: Done, In Review, blocked, retry needed, or follow-up needed.
- There is a human comment that the agent or future reviewer can use.
```

### Reasoning

This issue completes the feedback loop.

Without review, onboarding only proves that an agent can start. It does not prove that Rudder can support collaboration. Human review is where the user starts to feel control over agent work rather than watching automation run in the background.

This step also makes failures productive. A failed run can still be part of a successful onboarding loop if it creates a visible activity record and the user knows how to respond.

### Completion criteria

This issue is complete when:

1. The user has reviewed the agent result or failure.
2. The user has left a review comment.
3. The worked issue has a clear next state.

---

## Issue 5: Save Shared Context Your Agent Should Reuse

### Metadata

| Field | Value |
| --- | --- |
| Title | `5. Save shared context your agent should reuse` |
| Status | `Todo` |
| Priority | `High` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No |
| Guide issue | Yes |

### Issue body

```md
The best reason to move work into Rudder is that context can compound.

After your first agent run, save one piece of context you do not want to explain again.

Choose one:

- What this organization or project is trying to do
- What "done" means for this kind of task
- A recurring constraint
- A preferred format for outputs
- A repo, folder, file, or document the agent should know about
- A term or abbreviation you use often
- A review rule the agent should follow before taking action

Try it now:

1. Pick one piece of reusable context from your first task.
2. Add it to the appropriate shared context surface.
3. If there is no dedicated context surface yet, add it as a clearly labeled comment or document on the relevant issue.
4. Link or mention it from the issue your agent worked on.

Suggested format:

Context name:
...

When to use this:
...

Details:
...

Example:
...

You'll know it worked when:

- One reusable context item exists.
- It is attached to the organization, project, issue, or knowledge surface.
- A future issue can reference it instead of making you explain it again.
```

### Reasoning

This issue moves onboarding from "the agent ran once" to "Rudder is becoming an operating layer."

Many products can run an agent once. Rudder's stronger value is that context, workflows, approvals, feedback, and memory stay attached to durable work. This issue introduces that value immediately after the first run, when the user has fresh context worth saving.

This also supports gradual migration. Instead of asking the user to fill a large workspace context form upfront, Rudder asks for one reusable piece of context after real work reveals what context matters.

### Completion criteria

This issue is complete when:

1. One reusable context item exists.
2. It is connected to the organization, project, issue, or knowledge surface.
3. The worked issue links back to it or mentions it.

---

## Issue 6: Capture One Reusable Workflow From the First Run

### Metadata

| Field | Value |
| --- | --- |
| Title | `6. Capture one reusable workflow from the first run` |
| Status | `Backlog` |
| Priority | `Medium` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No by default |
| Guide issue | Yes |

### Issue body

```md
Some work should not stay as one-off instructions.

Look at your first agent run and ask: would you want Rudder to do something like this again?

If yes, capture the repeatable workflow.

Try it now:

1. Pick one repeated pattern from your first task.
2. Write the workflow as a short checklist.
3. Include the trigger, inputs, steps, output, and review rule.
4. Link the workflow back to the issue where it came from.

Workflow template:

Workflow name:
...

Use this when:
...

Inputs needed:
- ...

Steps:
1. ...
2. ...
3. ...

Expected output:
...

Human review needed when:
...

Do not do:
- ...

You'll know it worked when:

- A reusable workflow or checklist exists.
- It is based on real work that already happened.
- It has enough structure to be reused in a future issue.
```

### Reasoning

This issue introduces workflow capture after the user has seen real execution.

It should not be part of the first critical path because users cannot know which workflows are worth capturing before they run anything. Placing it in `Backlog` keeps onboarding lightweight while still showing Rudder's longer-term value.

This is also the correct precursor to recurring automation. First capture the workflow; then decide whether it deserves automation.

### Completion criteria

This issue is complete when:

1. A workflow, checklist, or reusable process note exists.
2. It is based on an actual completed or attempted agent run.
3. It is linked back to the original issue.

---

## Issue 7: Link This Work to a Goal

### Metadata

| Field | Value |
| --- | --- |
| Title | `7. Link this work to a goal` |
| Status | `Backlog` |
| Priority | `Medium` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No by default |
| Guide issue | Yes |

### Issue body

```md
Rudder work should eventually answer: why does this task exist?

Now that you have moved one real task through Rudder, name the larger direction it supports.

You do not need a perfect company mission. Start with a practical goal.

Try it now:

1. Look at the first issue your agent worked on.
2. Ask what larger outcome this work supports.
3. Create or select a goal.
4. Link the goal to the issue or project.
5. If the goal is still uncertain, create a draft goal and refine it later.

Goal examples:

- Ship the first usable version of [product]
- Reduce manual support work for [workflow]
- Build a repeatable research process for [topic]
- Improve engineering velocity on [repo/project]
- Turn founder tasks into agent-operable workflows

Suggested goal format:

Goal:
...

Why it matters:
...

Current work connected to this goal:
- ...

How we know progress is happening:
- ...

You'll know it worked when:

- At least one issue or project is linked to a goal.
- The goal explains why the work matters.
- The goal can be refined later without blocking current execution.
```

### Reasoning

This issue deliberately delays goal creation until after at least one real work object exists.

Rudder's long-term product model expects durable work to trace back to goals. However, requiring a goal as the first onboarding input can be too abstract for users who are still exploring how Rudder fits into their workflow.

The better path is retroactive goal linking: run one real task, then ask what larger direction it serves.

This reconciles two product needs: low-friction onboarding and eventual goal traceability.

### Completion criteria

This issue is complete when:

1. A goal exists or a draft goal exists.
2. At least one issue or project is linked to that goal.
3. The link explains why the work matters.

---

## Issue 8: Attach Files, Repo, or Workspace References

### Metadata

| Field | Value |
| --- | --- |
| Title | `8. Attach files, repo, or workspace references` |
| Status | `Backlog` |
| Priority | `Low` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No by default |
| Guide issue | Yes |

### Issue body

```md
Agents do better work when they can see the materials the work depends on.

Attach one useful reference to the work you have already moved into Rudder.

This can be:

- A Git repository
- A local folder
- A design document
- A product spec
- A customer note
- A spreadsheet
- A research document
- A prior issue
- A project page
- A relevant URL

Try it now:

1. Pick the first issue your agent worked on.
2. Identify the most useful reference for that work.
3. Attach, link, or mention the reference.
4. Add one sentence explaining when the agent should use it.

Suggested format:

Reference:
...

What it is:
...

When the agent should use it:
...

What the agent should not assume:
...

You'll know it worked when:

- One real reference is attached or linked.
- The reference is connected to an actual issue, not just stored somewhere.
- The agent has enough instruction to know why the reference matters.
```

### Reasoning

Multica includes a specific `Connect a Git repo` issue. Rudder should generalize this because Rudder is not only for coding work.

Some users will need a repo. Others will need documents, specs, customer notes, spreadsheets, or workspace links. The onboarding issue should teach the broader behavior: attach the materials that real work depends on.

This issue belongs in `Backlog` because external references may not be necessary for the first run. Forcing this setup too early can add friction.

### Completion criteria

This issue is complete when:

1. One real reference is attached or linked.
2. The reference is connected to an actual work object.
3. The user has described when the agent should use it.

---

## Issue 9: Add a Second Agent With a Different Role

### Metadata

| Field | Value |
| --- | --- |
| Title | `9. Add a second agent with a different role` |
| Status | `Backlog` |
| Priority | `Low` |
| Project | `Getting Started` |
| Assignee | Current human operator, or unassigned if human assignment is not supported |
| Agent-triggered | No by default |
| Guide issue | Yes |

### Issue body

```md
Rudder is designed for agent teams, not just one assistant.

Only add a second agent when you can name a different role it should play.

Good reasons to add a second agent:

- One agent should research while another implements.
- One agent should review work before a human sees it.
- One agent should manage a recurring workflow.
- One agent should specialize in a repo, domain, customer, or function.
- One agent should act as a manager or coordinator.

Do not add a second agent just to test the button.

Try it now:

1. Review the first issue your agent worked on.
2. Ask whether a different role would have helped.
3. If yes, define the role before creating the agent.
4. Create the agent only if the role is clear.

Role template:

Agent name:
...

Role:
...

This agent is responsible for:
- ...

This agent should not:
- ...

Good first issue for this agent:
...

Reports to:
...

You'll know it worked when:

- A second agent exists, or a role draft exists.
- The role is meaningfully different from the first agent.
- There is at least one clear type of issue this agent should own.
```

### Reasoning

Rudder's product model includes explicit roles, reporting lines, and agent teams. But multi-agent structure should emerge from real workflow needs, not from onboarding theater.

This issue teaches that agents should have differentiated responsibilities and boundaries. It is intentionally placed late because the first onboarding goal is not to build an org chart. The first goal is to complete one real work loop.

### Completion criteria

This issue is complete when:

1. A second agent exists, or a clear role draft exists.
2. The role is meaningfully different from the first agent.
3. The role has a clear first issue type it should own.

---

# 10. Product Behavior Requirements

## 10.1 Guide issues should not auto-trigger agents

The onboarding issues are guide issues. They teach the user what to do. The actual first agent run should happen on the user's real issue created in step 2.

This avoids a fragile first impression where a synthetic guide issue fails and the user has not yet experienced Rudder on real work.

## 10.2 Goal linkage should be nullable during onboarding

The first real issue should be allowed to exist without a `goalId`.

Recommended behavior:

- `issue.goalId` can be null during onboarding.
- `project.goalIds` can be empty during onboarding.
- When the user later creates or selects a goal, Rudder should support retroactive linking from issues and projects.

## 10.3 Wizard-provided task should prefill the flow

If the onboarding wizard asks:

```text
What's one small real task you want to move into Rudder first?
```

and the user provides an answer, Rudder should use that answer to personalize the first two issues.

Recommended behavior:

- Issue 1 includes the user's raw request.
- Issue 1 asks the user to turn it into a working brief.
- Issue 2 suggests a draft runnable issue based on that request.
- The user can edit before triggering the agent.

If the user skips the input, the default issue content should still work.

## 10.4 Completion should be based on durable artifacts

Onboarding progress should not be based only on opening pages.

Recommended completion events:

| Step | Completion event |
| --- | --- |
| Issue 1 | Working brief exists. |
| Issue 2 | First real issue exists. |
| Issue 3 | First real issue is assigned to agent and moved to `Todo` or `In Progress`. |
| Issue 4 | Human review comment exists. |
| Issue 5 | Reusable context item, note, comment, or document exists. |
| Issue 7 | At least one issue or project is linked to a goal. |

---

# 11. Data and Implementation Notes

Recommended seed behavior:

1. Create organization.
2. Create first agent.
3. Create pinned welcome issue.
4. Create `Getting Started` project.
5. Create onboarding guide issues 1-9.
6. Place issues 1-5 in `Todo`.
7. Place issues 6-9 in `Backlog`.
8. Mark all guide issues with onboarding metadata.

Recommended metadata:

```ts
{
  origin: "onboarding",
  onboardingStep: number,
  guideIssue: true,
  autoTriggerAgent: false
}
```

Recommended safety behavior:

- Do not assign guide issues to agents by default.
- Do not auto-run the welcome issue.
- Do not create a goal unless the user explicitly provides one or completes the goal-linking step.
- Do not create a second agent automatically.
- Do not connect external files, repos, or runtime resources automatically.

---

# 12. Metrics

The onboarding change should be evaluated by whether it produces real work, not whether users merely complete setup.

Primary metric:

- First real agent-work loop completed during onboarding.

Supporting metrics:

| Metric | Why it matters |
| --- | --- |
| New organizations with first real issue created | Measures conversion from setup to durable work. |
| New organizations with first agent assigned to a real issue | Measures whether users understand the trigger path. |
| First agent runs that receive a human review comment | Measures whether the feedback loop is established. |
| New organizations with reusable context created | Measures whether Rudder starts compounding knowledge. |
| New organizations that later link work to a goal | Measures progressive goal adoption. |
| Time from organization creation to first agent run | Measures onboarding speed. |
| Time from organization creation to first reviewed result | Measures end-to-end loop completion speed. |

---

# 13. E2E Test Plan

Because this proposal changes a user-visible workflow, it should add or update automated E2E coverage.

Minimum E2E assertions:

1. New organization creates a pinned welcome issue.
2. New organization creates a `Getting Started` project.
3. Issues 1-5 appear in `Todo`.
4. Issues 6-9 appear in `Backlog`.
5. Guide issues are not assigned to agents by default.
6. Guide issues do not auto-trigger agent runs.
7. User can create a real issue from onboarding.
8. User can assign the real issue to the first agent.
9. User can move the real issue to `Todo`.
10. Activity shows an agent run, visible output, or visible failure state.
11. User can leave a review comment.
12. User can create or attach reusable context.
13. User can link the work to a goal after the first issue exists.

---

# 14. Rollout Plan

## Phase 1: Seed content only

- Add pinned welcome issue.
- Add `Getting Started` project.
- Add nine guide issues with static content.
- Do not add complex completion automation yet.

## Phase 2: Wizard personalization

- Capture one optional user-provided real task during onboarding.
- Prefill issues 1 and 2 using that task.
- Keep default content if the user skips the input.

## Phase 3: Artifact-based completion

- Track completion based on durable objects.
- Detect working brief, real issue, agent run, review comment, reusable context, and goal link.

## Phase 4: Progressive generation

- Consider generating enrichment issues only after the critical path is complete.
- Keep the initial v1 simpler by seeding all nine issues and separating them through `Todo` and `Backlog`.

---

# 15. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Too many onboarding issues feel overwhelming | Put only the first five in `Todo`; place enrichment issues in `Backlog`. |
| Users treat guide issues as real work | Mark guide issues clearly and avoid agent assignment by default. |
| Users skip chat and create a bad first issue | Issue 2 provides a strict runnable issue template. |
| First agent run fails | Issue 3 and 4 explicitly explain failure handling and review comments. |
| Goal is delayed too long | Issue 7 introduces goal linking after real work exists. |
| Coding users want repo setup early | Issue 8 supports repo setup, but does not force it on non-coding users. |
| Multi-agent positioning is under-exposed | Issue 9 introduces second-agent structure after a differentiated role is clear. |

---

# 16. Alternatives Considered

## Alternative 1: Keep one starter issue only

Rejected.

One starter issue is simple, but too abstract. It does not teach the user the sequence required to use Rudder: request, issue, assignment, execution, review, and context capture.

## Alternative 2: Require organization goal before first issue

Rejected for onboarding.

Goal traceability is important, but forcing it upfront creates friction for exploratory users. It is better to let real work reveal the first goal and then link retroactively.

## Alternative 3: Copy Multica's exact issue set

Rejected.

Multica's structure is useful, but its content is optimized for a different product. Rudder needs onboarding issues that teach durable agent-work loops, goals, knowledge, workflows, feedback, and roles.

## Alternative 4: Use only chat onboarding

Rejected.

Chat is useful for clarification, but Rudder's product value depends on durable work objects. Onboarding should move the user from chat into issues as quickly as possible.

---

# 17. Recommendation

Adopt the proposed onboarding issue system for Rudder v1.

The final onboarding design should include:

- One pinned welcome issue.
- One `Getting Started` project.
- Five high-priority critical-path guide issues in `Todo`.
- Four optional progressive-enrichment guide issues in `Backlog`.
- No required goal at day zero.
- No synthetic demo task.
- No default agent run on guide issues.
- First agent run happens on a real user-created issue.
- Goal linking happens after at least one real work object exists.

This design gives Rudder a concrete, issue-native onboarding path while respecting the fact that users gradually discover their goals, workflows, and organization structure through actual work.

---

# Appendix A: Source Notes

This proposal uses the following project context:

1. `README.md`: Rudder is described as an orchestration and control platform for agent work and the operating layer for agent teams. It gives humans and agents shared structure for goals, tasks, knowledge, workflows, approvals, and feedback. It also states that the current north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.
2. `README.md`: Rudder's design idea states that durable execution should stay attached to issues, approvals, and outputs, while chat should clarify and route work.
3. `README.md`: Rudder's typical flow includes creating an organization, defining a goal, configuring agents, creating issues, letting agents pick up work, and reviewing outputs.
4. `AGENTS.md`: The repository guidance treats the product description as canonical onboarding/product copy context and requires E2E coverage for shipped user-visible workflow changes.

