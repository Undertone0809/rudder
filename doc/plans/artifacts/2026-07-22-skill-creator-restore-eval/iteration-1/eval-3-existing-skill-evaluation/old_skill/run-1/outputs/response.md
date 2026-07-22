## Evaluation objective

Evaluate whether a revised multi-file skill produces materially better task outcomes than the current version without increasing failures, unsafe behavior, or unreasonable latency.

Use exactly two task prompts and compare:

- `old_skill`: an immutable snapshot of the complete current skill directory.
- `with_skill`: an immutable snapshot of the complete revised skill directory.

A “skill” snapshot includes `SKILL.md` plus every referenced script, template, asset, example, and reference file. Comparing only the two `SKILL.md` files is invalid.

## Workspace placement

When project context exists, place the evaluation workspace inside that project:

```text
<project-root>/.codex/evals/<skill-name>/<evaluation-id>/
```

Example:

```text
rudder-oss/.codex/evals/skill-creator/2026-07-22-restore/
```

This keeps prompts, fixtures, source revisions, and results tied to the commit and project they evaluate. Add the workspace to `.gitignore` unless the evaluation artifacts are intentionally being checked in.

Do not use:

- `/tmp` or another system temporary directory.
- `~/.codex/skills`, `~/.agents/skills`, or any global installed-skill directory.
- The live source-skill directory as the evaluation workspace.
- A directory inside either candidate snapshot.
- A shared workspace that another Codex run can mutate.
- An unrelated repository merely because it is writable.

If no project context exists, use an explicitly created, isolated evaluation directory—not a global installation directory—and record its absolute path in the metadata.

## Workspace layout

```text
.codex/evals/skill-creator/2026-07-22-restore/
├── manifest.json
├── prompts/
│   ├── 01-improve-existing-skill.md
│   └── 02-prove-revision.md
├── fixtures/
│   └── input-skill/
├── candidates/
│   ├── old_skill/
│   └── with_skill/
├── runs/
│   ├── prompt-01/
│   │   ├── old_skill/
│   │   └── with_skill/
│   └── prompt-02/
│       ├── old_skill/
│       └── with_skill/
├── grading/
│   ├── rubric.json
│   ├── assertions.json
│   ├── blind-assignments.json
│   └── grades.jsonl
├── benchmark/
│   └── summary.json
├── analyst/
│   └── review.md
└── viewer/
    └── index.html
```

Copy both candidate directories before running anything, make them read-only, and record a recursive SHA-256 inventory. The revised candidate must not modify or import files from `old_skill`.

## The two prompts

Both prompts operate on fresh copies of the same fixture. They must describe outcomes, not mention the expected implementation or identify the candidate.

### Prompt 1: improve an existing multi-file skill

```text
Improve the supplied multi-file skill. Preserve its intended behavior and
public interface while making its instructions clearer, its supporting files
internally consistent, and its workflow executable by another Codex agent.

Inspect every relevant file, make the necessary revisions, and return:
1. the completed changes;
2. a concise rationale;
3. validation evidence;
4. any remaining limitations.

Do not replace the skill with a single-file simplification, omit referenced
resources, or claim validation that was not performed.
```

This tests the normal authoring workflow: discovery, cross-file consistency, implementation, and verification.

### Prompt 2: prove the revision is better

```text
Given the original and revised forms of the supplied multi-file skill, produce
a decision-complete evaluation package showing whether the revision should be
adopted.

The package must define reproducible comparison cases, deterministic
assertions, a blind grading rubric, timing and cost measurements, benchmark
aggregation, analyst review, and a static human-review viewer. Identify
regressions and state a ship/no-ship decision.

Do not rely on subjective prose alone, do not hide failed cases, and do not
run or publish anything outside the provided workspace.
```

This tests whether the skill can turn “better” into reproducible evidence rather than self-assessment.

## Run matrix and controls

Run the four cells:

| Prompt | Candidate |
|---|---|
| 01 | `old_skill` |
| 01 | `with_skill` |
| 02 | `old_skill` |
| 02 | `with_skill` |

Use a fresh checkout or fixture copy for every cell. Hold constant:

- Codex model and reasoning effort.
- System and project instructions.
- Tool permissions and network policy.
- Starting files and environment variables.
- Working-directory shape.
- Token and wall-clock limits.
- Temperature or sampling configuration, if configurable.
- Rudder/Codex version and evaluator version.

Use candidate-neutral output identifiers during grading, such as `A17` and `B42`. Randomize their mapping separately for each prompt and keep the key out of the grader context.

For a quick decision, run each cell once. For a benchmark intended to justify adoption, predeclare three repetitions per cell with fixed run seeds where supported. Never add repetitions only after seeing an unfavorable result.

## Manifest metadata

`manifest.json` must record:

```json
{
  "evaluation_id": "2026-07-22-skill-creator-restore",
  "project_root": "<absolute-project-root>",
  "project_commit": "<git-sha>",
  "fixture_hash": "<sha256>",
  "candidates": {
    "old_skill": {
      "path": "candidates/old_skill",
      "tree_hash": "<sha256>"
    },
    "with_skill": {
      "path": "candidates/with_skill",
      "tree_hash": "<sha256>"
    }
  },
  "prompts": [
    {"id": "01", "path": "prompts/01-improve-existing-skill.md", "sha256": "..."},
    {"id": "02", "path": "prompts/02-prove-revision.md", "sha256": "..."}
  ],
  "runtime": {
    "codex_version": "...",
    "rudder_version": "...",
    "model": "...",
    "reasoning_effort": "...",
    "permissions": "...",
    "network": "disabled",
    "timeout_seconds": 900,
    "repetitions": 3
  },
  "grader": {
    "model": "...",
    "rubric_version": "1",
    "blind": true
  },
  "created_at": "<ISO-8601>",
  "timezone": "UTC"
}
```

Also retain the exact user prompt, resolved system/project instructions, tool-call transcript, stdout/stderr, exit status, produced files, and final response for every run.

## Deterministic assertions

Run assertions before model grading. Assertions inspect both the response and produced workspace.

Required assertions:

1. Run completed within the declared timeout.
2. Exit status and tool failures are recorded.
3. No writes occurred outside the cell workspace.
4. All expected deliverables exist and are non-empty.
5. Every file referenced by the resulting `SKILL.md` exists.
6. No absolute paths point into the evaluator’s machine or `old_skill`.
7. The revised skill remains multi-file where supporting files are required.
8. Supporting files and `SKILL.md` agree on names, paths, commands, and schemas.
9. Validation claims are backed by captured command output.
10. The evaluation package contains metadata, assertions, timing, grading, aggregation, analyst review, and viewer specifications.
11. The viewer is static and opens without a backend or network access.
12. No candidate identity leaks into blind grading material.

Classify assertions as:

- `critical`: failure makes the run ineligible to win.
- `quality`: failure reduces the score but does not invalidate the run.
- `informational`: reported without affecting eligibility.

Path escape, missing required deliverables, fabricated validation, and unresolved referenced files are critical failures.

## Timing and resource capture

Measure each run from immediately before Codex invocation until process termination using a monotonic clock. Record:

- Wall-clock duration.
- Time to first response event, if available.
- Time spent in tool execution.
- Number of tool calls and failed tool calls.
- Input, cached-input, output, and reasoning tokens when available.
- Estimated cost using the price table captured in the manifest.
- Timeout or cancellation status.

Do not infer missing timing or token fields. Store them as `null` with an explanatory reason.

## Blind grading

Use the same rubric for all four cells. The grader receives only the prompt, fixture description, anonymized output, produced-file inventory, assertion results, and validation evidence.

Score each dimension from 0–4:

| Dimension | Weight |
|---|---:|
| Task correctness and completeness | 30% |
| Cross-file coherence and executability | 20% |
| Evidence and validation quality | 15% |
| Evaluation rigor and reproducibility | 15% |
| Safety and scope discipline | 10% |
| Clarity and decision usefulness | 10% |

Anchors:

- `0`: absent, unusable, or fundamentally wrong.
- `1`: major gaps; substantial rework required.
- `2`: partially correct; important omissions remain.
- `3`: complete and usable with minor issues.
- `4`: exceptionally complete, precise, and independently reproducible.

Require the grader to provide dimension scores, cited evidence, observed regressions, confidence, and a forced preference: anonymous candidate 1, anonymous candidate 2, or tie.

If possible, use two independent graders. Resolve a total-score disagreement greater than 10 points, a disagreement about any critical failure, or opposing winner selections through a third blind adjudication.

## Benchmark aggregation

For each cell, aggregate repetitions using:

- Assertion pass rate.
- Critical-failure rate.
- Median weighted grade.
- Interquartile range of weighted grade.
- Median wall time.
- Median token use and cost.
- Grader win/tie/loss count.

For each prompt calculate:

```text
quality_delta = median(with_skill grade) - median(old_skill grade)
latency_delta = median(with_skill time) / median(old_skill time) - 1
cost_delta    = median(with_skill cost) / median(old_skill cost) - 1
```

The overall quality score is the equally weighted mean of the two prompt-level median grades. Do not pool all repetitions in a way that lets one prompt dominate.

Adopt `with_skill` only if all predeclared gates pass:

- No new critical assertion failures.
- Overall quality improves by at least 5 points on a 100-point scale.
- Neither prompt regresses by more than 3 points.
- `with_skill` wins more blind comparisons than it loses.
- Median latency increases by no more than 25%, unless the analyst documents a material quality benefit.
- Median cost increases by no more than 20%, under the same exception rule.
- No high-severity analyst concern remains unresolved.

Otherwise the decision is `revise` or `reject`, not “inconclusive but ship.”

## Analyst review

After automated grading, reveal candidate identities to one analyst. The analyst reviews:

- All assertion failures and grader evidence.
- The actual diffs across every skill file.
- Whether the revision merely teaches to the two prompts.
- Whether behavior outside the tested cases was accidentally narrowed.
- Unsupported claims, hidden dependencies, brittle paths, or unsafe commands.
- Latency and cost tradeoffs.
- Grader disagreements and suspiciously generic feedback.
- At least one output from every matrix cell.

The analyst writes `analyst/review.md` with:

1. Evaluation scope and limitations.
2. Evidence supporting improvement.
3. Regressions and unresolved risks.
4. Explanation of any overridden automated result.
5. Final decision: `adopt`, `revise`, or `reject`.
6. Exact follow-up changes required when the decision is not `adopt`.

The analyst may override the benchmark only with cited run evidence; preference alone is insufficient.

## Static human-review viewer

Generate one self-contained `viewer/index.html`. It must work by opening it directly with a `file://` URL and must not require a server, package installation, CDN, or network request. Embed escaped result data in the document rather than calling `fetch()` on local JSON.

The viewer should provide:

- Evaluation metadata and candidate hashes.
- Ship gate status and final decision.
- Prompt-by-prompt old-versus-revised comparison.
- Assertion pass/fail table with critical failures prominent.
- Grade breakdown and grader evidence.
- Timing, token, and cost comparisons.
- Win/tie/loss and aggregate benchmark charts using HTML/CSS or inline SVG.
- Side-by-side final responses.
- Produced-file tree and text diffs.
- Tool failures and validation logs.
- Analyst review and limitations.
- Filters for prompt, repetition, candidate, assertion severity, and grader.
- Clear labeling of missing data instead of treating it as zero.

Escape all embedded content to prevent generated output from executing HTML or JavaScript. Cap or collapse large logs while preserving links to the raw local artifacts.

## Final evidence package

The evaluation is decision-complete when another reviewer can:

1. Verify the exact candidates, prompts, environment, and fixture from hashes.
2. Reproduce every run from recorded commands and metadata.
3. Inspect deterministic assertion results.
4. Audit blind grades and candidate randomization.
5. Recalculate benchmark aggregates.
6. Read the identity-revealed analyst judgment.
7. Open the static viewer locally.
8. Reach the same adoption decision without relying on undocumented context.

This procedure defines the evaluation only. It does not authorize running the four cells, modifying the live skill, installing the revision, or publishing results.