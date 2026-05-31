---
name: rudder-ui-polish-maintainer
description: >
  Execute screenshot-driven Rudder UI polish and narrow visible interaction
  fixes. Use when the user points at a Rudder screen or screenshot and asks to
  adjust density, alignment, badges, labels, cards, menus, hover affordances,
  empty states, redundant pages, onboarding steps, or other narrow
  small-to-medium UI behavior, especially with Chinese prompts like "这里有点丑",
  "对齐一下", "去掉这个页面", "改成这个 UI", "先说说/优化一下", or
  "弄个截图给我看".
  Also use for narrow UI fixes even when the user mentions an advisor/reviewer
  skill, unless they explicitly ask for reviewer agents, repeated review rounds,
  or an acceptance gate.
  Prefer build-advisor for pure advice with no implementation request, and
  advisor-review-loop-maintainer for high-stakes proposal plus reviewer gates.
---

# Rudder UI Polish Maintainer

Use this skill to turn concrete Rudder UI feedback into a scoped, implemented,
validated, and committed change.

The goal is not a full redesign. The goal is to preserve Rudder's dense,
operator-focused interface while fixing the specific visual or interaction
problem the user noticed.

## Use When

Use this skill for Rudder UI tasks such as:

- screenshot-driven visual polish
- alignment, line-height, spacing, density, overflow, or hover fixes
- adding a small status badge, label, icon, menu, or affordance
- simplifying settings sections or redundant explanatory copy
- removing a page or route that no longer belongs in the product
- changing an empty state, onboarding step, tutorial jump, or small workflow
  surface
- producing a quick screenshot of the current UI after a local change
- explaining why a visible surface looks wrong when the user asks "为什么"
  and the likely answer is current CSS/layout/data layering rather than an
  approved implementation request

Use `build-advisor` first when the user explicitly asks "你懂我要怎么改吗",
"先说说", or otherwise wants the product/design direction before edits.
After the direction is accepted, continue here for implementation.

Use `advisor-review-loop-maintainer` instead when the user asks for reviewer
agents, two rounds, proposal review, or an acceptance gate before handoff.

When the user invokes `advisor-review-loop-maintainer` for a small visible fix
but only asks to "修一下", "优化一下", "去掉这个 button", "颜色不对", or similar,
treat this skill as the implementation contract after a short advisor check.
Say explicitly in the handoff that the work used a lightweight route rather
than a full two-reviewer loop.

## Do Not Use When

Do not use this skill for:

- broad architecture refactors or large feature builds
- pure code review with no UI change
- data diagnosis where the core question is "why is this page empty"; use
  `rudder-data-path-diagnostician-maintainer`
- screenshot/demo data creation; use `mock-data-maintainer` and then
  `landing-proof-shots-maintainer` when needed
- release, CI, Desktop packaging, or browser automation infrastructure issues
- UI Lab, component inventory, component fixture coverage, or design-system
  catalog work where the main deliverable is coverage and classification rather
  than a narrow rendered-state polish fix; route through
  `development-lifecycle-router-maintainer` first

## Default Workflow

### 1. Resolve intent and mode

Classify the prompt before editing:

- `advice-only`: user asks to discuss, judge, or generate options.
- `explain-only`: user asks why a visual state looks the way it does, without
  asking to change it yet.
- `implement`: user asks to fix, optimize, remove, add, or "改一下".
- `screenshot`: user wants the current rendered UI captured.
- `review-gated`: user invokes reviewers or says the result must pass review.
- `component-lab`: user asks to build, expand, or audit UI Lab/component
  inventory; route out to the lifecycle/component-lab workflow first.

In `advice-only`, produce the smallest useful UI direction and stop. In
`explain-only`, trace the rendered reason from screenshot to component/CSS/data
source and stop with the likely fix direction, not a patch. In `implement`,
make the code change. If the user gives screenshots plus vague language, infer
the concrete pain from the image and surrounding product state.

In `component-lab`, do not start a narrow polish pass. The owning workflow must
first define component coverage, context-required labeling, route behavior,
tests, and browser proof. Return to this skill only for a concrete visual fix
inside an already-scoped component-lab task.

### 2. Build a small evidence packet

Gather only the context needed for this UI surface:

- current route, component, and API client involved
- relevant nearby tests
- `doc/DESIGN.md` for visible UI defaults when the change is layout-sensitive
- existing components, tokens, icons, and status labels before inventing new UI
- screenshot or browser state when the user provided or requested visual proof

Check `git status --short --branch` before editing. Preserve unrelated dirty
worktree changes.

### 3. Make the smallest coherent UI change

Prefer local product consistency over a generic design pattern:

- reuse existing Rudder components and status vocabulary
- keep operational screens compact, scannable, and calm
- remove redundant copy instead of explaining the UI inside the UI
- avoid wrapping cards inside cards
- avoid decorative treatment that competes with work content
- keep controls discoverable but not oversized
- preserve keyboard, selection, copy, and accessibility behavior when editing
  input or composer surfaces

When adding visible state such as issue status, use real existing data from the
surface's context snapshot or API response. Do not hard-code status text just
to make the UI look right.

### 4. Keep contracts aligned

If the UI change needs data that is not already present, trace the contract:

- shared type or validator
- server route or service response
- UI API client and component props
- tests and E2E expectations

Do not silently introduce an organization-scoping, permission, or persistence
change while doing a visual polish task. If that is needed, call it out and
scope it as feature work.

### 5. Validate behavior and visual result

Run the narrowest meaningful automated checks first:

- component or page test for the touched surface
- E2E test when the user-visible workflow changed
- typecheck/build when shared contracts changed

For visible UI changes, verify the rendered result with a browser, Desktop
shell, screenshot, or equivalent visual inspection. Prefer the available
browser automation path for local routes. If browser verification is blocked,
state the exact blocker and do not describe the layout as visually proven.

When the defect is alignment, line height, avatar/text/time centering, column
width, or row rhythm, a screenshot alone is often too weak. Use realistic data
for the actual object being aligned, such as a real agent avatar instead of a
placeholder icon, a long activity label, and the timestamp or action controls
that appear in production. Then add at least one measurable proof when
practical:

- DOM bounding boxes for the avatar, primary text, secondary text, timestamp,
  and row container
- centerline or top/bottom delta showing the items share the intended row axis
- screenshot with the real fixture state, saved outside the repo

If Browser or the test harness cannot collect geometry, say that the alignment
proof is visual-only. Do not claim a row-alignment fix is fully proven from a
unit test that renders placeholder data instead of the production-shaped row.

For follow-up corrections from the user, such as "这颜色不对", "没修好", or
"这里还是不对", inspect the rendered state again before editing further. Treat
the user's screenshot as evidence that the previous proof was incomplete, not
as a reason to keep patching blindly.

Store temporary screenshots outside the repo, for example under `/tmp`.

### 6. Commit only this task

After validation, stage only files changed for this task. Do not include
unrelated dirty worktree changes. Use a Conventional Commit message such as:

- `fix: align automation settings rows`
- `feat: show issue status in messenger cards`
- `chore: remove redundant organizations settings page`

Push the current branch when the repository rules and current branch state
allow it.

## Output Expectations

For implementation tasks, hand off with:

- what changed, in product terms
- key files touched
- validation run and any blocked checks
- screenshot path or rendered proof when the change is visual
- commit hash and push status when committed

For advice-only tasks, hand off with:

- the product diagnosis
- the recommended UI direction
- any explicit non-goals
- the implementation shape if the user approves edits

## Common Failure Modes

- Over-solving a small screenshot complaint with a broad redesign.
- Routing every small screenshot complaint through a full advisor/reviewer loop
  when a lightweight UI-polish pass is enough.
- Treating a visual issue as pure CSS when the real problem is wrong data,
  wrong route, or redundant object modeling.
- Claiming visual verification after browser automation timed out.
- Claiming an alignment fix from placeholder fixtures when the real surface uses
  agent avatars, long labels, timestamps, badges, or row actions.
- Shipping a nice-looking state badge that reads stale or mock data.
- Mixing unrelated dirty files into the commit.
- Using `advisor-review-loop-maintainer` for every small UI tweak, slowing down
  work that only needed a focused polish pass.
- Treating UI Lab or component-inventory work as a small cosmetic issue and
  stopping after screenshots or style tweaks without coverage and fixture proof.
