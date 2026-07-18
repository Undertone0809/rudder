# Rudder Docs Trigger Evaluation

This artifact records the `skill-creator` description-routing evaluation for
the bundled `rudder-docs` skill.

- Backend: Codex judged-routing proxy
- Eval set: 20 bilingual queries, balanced 10 positive / 10 negative
- Split: 12 train / 8 held out
- Repetitions: 3 per query
- Allowed improvement iterations: 2
- Actual iterations: 1; the loop stopped early because both splits passed
- Train result: 36 / 36 routing decisions correct
- Held-out result: 24 / 24 routing decisions correct
- `hi`: 0 / 3 triggers
- Description change: none

This result evaluates whether the description makes the intended routing
decision clear. It is not evidence that a native host loaded or read the skill.
Native and prompt-injected host checks are reported separately.

Files:

- `results.json`: machine-readable loop output
- `trigger-report.html`: description-optimization report
- `review.html`: static `eval-viewer` review surface
- `host-verification.md`: real Rudder Codex, prompt-injected OpenCode,
  OpenClaw discovery, and official-source verification, with availability and
  use reported separately
