# Evaluation Method

Skill Optimizer should be evaluated at three levels:

1. Trigger eval: should the optimizer skill activate for realistic optimization requests and avoid unrelated tasks?
2. Patch-quality eval: does it produce an evidence-based, safe, reviewable, useful improvement to a target skill?
3. Downstream-task eval: after the target skill is patched, does the target skill perform better on its own tasks?

A SkillsBench-style local eval can compare:

- `without_skill`: a naive assistant improvement
- `previous_skill`: the last optimizer version
- `candidate_skill`: the optimized version

Each task should include a target skill, a transcript or failure observation, expected durable changes, and a deterministic verifier.

Do not treat synthetic verifier scores as official model pass rates. Use them to catch regressions and blind spots before running full agent-harness evals.
