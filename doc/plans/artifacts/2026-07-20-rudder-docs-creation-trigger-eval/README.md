# Rudder Docs Creation Trigger Evaluation

This directory records the trigger evaluation for merging Rudder Agent creation
and Plugin authoring guidance into the canonical `rudder-docs` skill.

## Result

- Evaluation set: 20 bilingual queries, split evenly between positive and
  negative cases.
- Trial count: three runs per query.
- Split: 60% train and 40% held out.
- Train decisions: 36/36 correct.
- Held-out decisions: 24/24 correct.
- Precision, recall, and accuracy: 100%.
- Greeting check: `hi` activated the skill in 0/3 trials.

The first evaluation iteration passed all cases, so the optimizer did not alter
the reviewed description.

## Files

- `results.json`: machine-readable trigger results.
- `trigger-report.html`: generated static trigger report.
- `review.html`: reviewer-friendly copy of the generated static report.
- `host-verification.md`: real-host and workflow verification evidence.
