# Skill Benchmark: skill-creator

**Model**: gpt-5.6-codex
**Date**: 2026-07-22
**Evals**: 1, 2, 3 (1 clean run each per configuration)

## Summary

| Metric | Restored Skill | Old Skill | Delta |
|---|---:|---:|---:|
| Pass Rate | 100% | 19% | +0.81 |
| Time | 90.7s | 121.7s | -31.0s |
| Tokens | 129,807 | 51,087 | +78720 |

## Notes

- The restored skill passed all 10 assertions; the clean isolated nine-line baseline passed 2 of 10.
- Both contaminated baseline attempts were discarded and rerun in isolated workdirs containing only the nine-line SKILL.md.
- The restored package uniquely supplied additive private enablement, organization import ownership, durable Rudder eval workspaces, and the bundled static review workflow.
- Each configuration has one run per scenario, so the comparison is directional rather than a variance estimate.
