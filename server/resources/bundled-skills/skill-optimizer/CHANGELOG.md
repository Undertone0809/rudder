# Changelog

## v4.3 framing evidence hardening

- Added sequencing guidance for requests that ask to optimize a skill after another live task: complete and verify the primary task first, then optimize from evidence.
- Added explicit treatment of strong user corrections as high-signal evidence, especially framing corrections and wrong-abstraction-level failures.
- Added framing checks for user outcome vs UI surface, scenario spine vs fixture rows, source of truth vs derivative signal, and product intent vs local convenience.
- Relaxed the final response contract for larger workflows so the primary task result can be reported before concise skill changes.

## v4.2 open-source package

- Added package mode and open-source project structure guidance.
- Added explicit adapter file lookup under `references/adapters/`.
- Added packaging expectations for README, examples, evals, changelog, and distributable skill zip.
- Preserved the generic analysis framework: core optimizer plus modular domain adapters.

## v4.1 adapter hardening

- Added explicit domain adapter use rule: source of truth, required inputs, review owner, authority gates, privacy, output template, validation cases, and must-not behaviors.
- Added benchmark reporting split for trigger accuracy, patch-quality coverage, and downstream transfer.
- Added warning that synthetic verifier scores are regression signals, not official leaderboard results.

## v4.0 generic

- Reframed Skill Optimizer from a software-focused hardening checklist into a domain-general analysis framework.
- Added universal optimization lens covering purpose, triggers, inputs, workflow, tools, outputs, quality, safety, failure, and maintainability.
- Moved domain-specific checks into modular adapter patterns.
- Added trigger optimization guidance and benchmark mode.
- Preserved strict patch safety around high-impact actions.
