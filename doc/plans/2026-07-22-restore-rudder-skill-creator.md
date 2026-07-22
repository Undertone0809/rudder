---
title: Restore the bundled Rudder skill creator
date: 2026-07-22
kind: implementation
status: completed
area: skills
entities:
  - skill_creator
  - bundled_skills
  - organization_skills
  - runtime_skill_materialization
issue:
related_plans:
  - 2026-04-16-agent-private-skill-creation.md
  - 2026-06-14-rudder-operating-skill-reframe.md
supersedes: []
related_code:
  - server/resources/bundled-skills/skill-creator/SKILL.md
  - server/src/services/knowledge-portability/organization-skills.ts
  - tests/e2e/organization-agent-skills.spec.ts
  - doc/product/domains/agents/skills-and-inbox.md
commit_refs: []
updated_at: 2026-07-22
---

# Restore The Bundled Rudder Skill Creator

## Summary

Restore `skill-creator` from the tracked package at upstream commit
`9b513b7f606a1fac6e4266046c6696d0c45aace7`. The Rudder repository received
only a nine-line placeholder when the bundled skill was introduced on
2026-05-14, so the evaluation, review, packaging, and compatibility resources
were never available to runtime agents.

Keep the upstream package self-contained and make only narrow Rudder changes:
route private skills to `AGENT_HOME/skills`, route shared skills through the
organization Skill Library, keep runtime enablement explicit, and store eval
artifacts outside read-only bundled or provider-managed directories.

## Product Logic Delta

Affected contract: `AGENT.SKILLS.001`.

- Define `skill-creator` as the intent-triggered, self-contained built-in
  workflow for skill creation, improvement, evaluation, and packaging.
- Preserve the distinction between installing a private skill and importing an
  organization skill.
- Do not treat provider-native or global discovery paths as Rudder runtime
  enablement.

## Implementation

1. Copy the tracked upstream package, excluding caches and generated artifacts.
2. Add a Rudder compatibility reference and link it from the main workflow.
3. Add service/E2E checks for nested bundled resources and runtime
   materialization.
4. Compare the restored package with the original placeholder on three
   ownership and evaluation scenarios, then generate a static review viewer.
5. Run product, repository, E2E, and packaged Desktop verification before
   commit and push.

## Verification Evidence

- Restored 23 tracked upstream files from
  `9b513b7f606a1fac6e4266046c6696d0c45aace7`; all common files except the
  intentionally adapted `SKILL.md` and `CHANGELOG.md` remain byte-identical.
  `references/rudder.md` is the only added package file. The final package has
  24 files, no cache/generated artifacts, and preserves upstream Python
  executable modes.
- `scripts/quick_validate.py`, isolated Python compilation, packaging, archive
  inventory checks, relative-resource checks, and package-mode checks passed.
- The focused organization skill reference test passed 9/9 before the later
  full-suite run left the shared machine under PostgreSQL process contention.
- The three focused Playwright paths passed together: bundled Library file tree
  and reads, Codex nested runtime materialization, and agent-private
  creation/enablement.
- Black-box API and filesystem verification found all 24 files in the Library
  and managed Codex home, including `references/rudder.md`, packaging scripts,
  and viewer files. The private skill was installed, additively enabled, and
  loaded on the following heartbeat.
- `pnpm product-logic:check`, `pnpm -r typecheck`, and `pnpm build` passed.
- `pnpm lint` is blocked by pre-existing import-order findings in
  `ui/src/pages/AgentDetail.run-rail.test.tsx` and
  `ui/src/pages/Chat.workspace-helpers.test.tsx`.
- `pnpm test:run` completed 4,706 passing tests but was not green: concurrent
  embedded PostgreSQL initialization failures and unrelated UI timing/content
  failures remained on the shared machine. The task-specific unit and E2E
  paths were verified separately.
- `pnpm desktop:verify` reached and passed bundled organization skill checks,
  then failed in the existing Chat smoke path because `initialMessage` was
  absent. A separate `pnpm desktop:dist` produced the macOS app and passed all
  server-package checks except the unrelated Browser MCP handshake. Direct
  inspection of that packaged app confirmed the complete 24-file
  `skill-creator` package and executable script modes.
- Adversarial review found two contaminated baselines, missing viewer metadata,
  and one viewer-runtime coverage gap. All three were corrected before final
  aggregation. The retained evaluation is restored 10/10 versus clean old
  2/10, with an analyzer pass and static review viewer under
  `doc/plans/artifacts/2026-07-22-skill-creator-restore-eval/`.
