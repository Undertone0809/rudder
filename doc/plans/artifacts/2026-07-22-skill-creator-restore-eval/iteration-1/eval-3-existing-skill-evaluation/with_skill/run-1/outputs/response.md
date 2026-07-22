Use the following procedure for a two-prompt, paired `old_skill` versus `with_skill` evaluation inside Rudder Codex.

## 1. Resolve ownership and workspace

Preserve the existing skill’s directory name and `name` frontmatter value. Because it is multi-file, treat the entire directory—including `SKILL.md`, `agents/`, `scripts/`, `references/`, `assets/`, and `evals/`—as the unit being revised.

When project context exists, place the durable evaluation workspace at:

```text
$RUDDER_PROJECT_LIBRARY_ROOT/skill-evals/<slug>-workspace/
```

Use this fallback only when no project context exists:

```text
$RUDDER_ORG_WORKSPACE_ROOT/artifacts/YYYY-MM-DD/skill-evals/<slug>-workspace/
```

Do not place the workspace or results in:

- Rudder’s read-only bundled-skill directory.
- A provider-managed runtime mount.
- `~/.agents/skills`.
- `~/.codex/skills` or another provider-native skill directory.
- `/tmp` or another ephemeral directory.
- The installed skill directory itself.

Those locations are either read-only, ephemeral, or not Rudder’s source of truth.

## 2. Freeze the baseline before editing

Set:

```text
SKILL_PATH=<installed complete skill directory>
WORKSPACE=$RUDDER_PROJECT_LIBRARY_ROOT/skill-evals/<slug>-workspace
ITERATION=$WORKSPACE/iteration-1
```

Before changing anything, copy the complete package to:

```text
$WORKSPACE/skill-snapshot/
```

That immutable snapshot is the `old_skill` baseline. Copy the complete package to a writable revision directory such as:

```text
$WORKSPACE/candidate-skill/
```

Make the improvements only in `candidate-skill/`. Do not compare against a reconstructed or partial baseline.

Review the current skill, its referenced resources, and representative workflows. Improve causes rather than examples: clarify ambiguous instructions, remove unproductive steps, explain why important actions matter, and consolidate repeated work into bundled scripts or templates. Keep `SKILL.md` lean through progressive disclosure.

For Codex compatibility, retain concise `name` and `description` frontmatter and update `agents/openai.yaml` if product metadata, dependencies, default prompt, or invocation policy changed.

## 3. Define exactly two prompts

Create two realistic prompts that exercise different failure modes:

1. `core-workflow`: the skill’s common end-to-end task, with realistic inputs and a concrete deliverable.
2. `edge-recovery`: a less common but supported case involving ambiguity, malformed input, a missing optional dependency, or another documented fallback.

Use the same prompt, input files, model, permissions, and output requirements for both configurations. The only independent variable is the skill version.

Write `$WORKSPACE/candidate-skill/evals/evals.json`:

```json
{
  "skill_name": "<unchanged-skill-name>",
  "evals": [
    {
      "id": 1,
      "prompt": "<realistic core end-to-end user request>",
      "expected_output": "<specific deliverable and correctness criteria>",
      "files": ["evals/files/<core-input>"],
      "expectations": [
        "The required deliverable exists and is non-empty.",
        "The deliverable contains the expected values derived from the supplied input.",
        "The deliverable satisfies the required structure or format.",
        "The transcript shows the required validation step completed successfully."
      ]
    },
    {
      "id": 2,
      "prompt": "<realistic edge-case request requiring the supported fallback>",
      "expected_output": "<correct result plus appropriate handling of the edge condition>",
      "files": ["evals/files/<edge-input>"],
      "expectations": [
        "The run completes without silently discarding the problematic input.",
        "The documented fallback is used when its triggering condition occurs.",
        "The final deliverable remains correct after fallback handling.",
        "Any unresolved limitation is disclosed accurately rather than hidden or invented."
      ]
    }
  ]
}
```

Replace generic assertions with domain-specific, mechanically verifiable statements before running. For example, test exact cell formulas, schema keys, record counts, required sections, or parsed values—not merely the presence of a filename or keyword.

## 4. Create the paired run layout and metadata

Use descriptive directories:

```text
iteration-1/
├── core-workflow/
│   ├── eval_metadata.json
│   ├── with_skill/
│   │   └── outputs/
│   └── old_skill/
│       └── outputs/
└── edge-recovery/
    ├── eval_metadata.json
    ├── with_skill/
    │   └── outputs/
    └── old_skill/
        └── outputs/
```

Each `eval_metadata.json` contains the exact prompt and assertions used for both sides:

```json
{
  "eval_id": 1,
  "eval_name": "core-workflow",
  "prompt": "<exact prompt>",
  "assertions": [
    "<domain-specific assertion 1>",
    "<domain-specific assertion 2>",
    "<domain-specific assertion 3>",
    "<domain-specific assertion 4>"
  ]
}
```

Create an equivalent file with `eval_id: 2` and `eval_name: "edge-recovery"`.

## 5. Launch all four executor runs together

In one scheduling turn, launch:

- `core-workflow` with `candidate-skill`.
- `core-workflow` with `skill-snapshot`.
- `edge-recovery` with `candidate-skill`.
- `edge-recovery` with `skill-snapshot`.

Each executor instruction must identify:

```text
Skill path: <candidate-skill or skill-snapshot>
Task: <exact eval prompt>
Input files: <exact paths>
Save outputs to: <corresponding outputs directory>
Outputs to save: <explicit deliverables, transcript, metrics, and user notes>
```

This prevents time-dependent conditions or host drift from systematically favoring one version. Do not run all candidate cases first and baselines later.

## 6. Capture timing immediately

As each executor completes, immediately save its task-notification values to that run’s `timing.json`; they cannot be recovered later:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.332
}
```

Also retain executor timestamps when available. Store execution metrics in `outputs/metrics.json`, including tool-call counts, steps, files created, errors, output size, and transcript size.

## 7. Grade both versions identically

Grade every run against the assertions in its eval metadata. Prefer deterministic scripts for checks such as JSON schema validity, spreadsheet formulas, filenames, record counts, or exact extracted values. Inspect both the transcript and the actual output files.

Save `grading.json` beside each `outputs/` directory. The viewer requires these exact assertion fields:

```json
{
  "expectations": [
    {
      "text": "<original assertion>",
      "passed": true,
      "evidence": "<specific output or transcript evidence>"
    }
  ],
  "summary": {
    "passed": 4,
    "failed": 0,
    "total": 4,
    "pass_rate": 1.0
  }
}
```

A pass requires substantive evidence, not superficial compliance. An unverifiable assertion fails. Record false or unverifiable output claims and flag assertions that would also pass for an incorrect result.

## 8. Aggregate the benchmark

Run:

```bash
python -m scripts.aggregate_benchmark \
  "$WORKSPACE/iteration-1" \
  --skill-name "<unchanged-skill-name>"
```

This produces:

```text
iteration-1/benchmark.json
iteration-1/benchmark.md
```

Keep `with_skill` before the baseline in presentations. The run directories remain named `old_skill` to preserve baseline provenance. If the aggregator/viewer schema emits the baseline configuration as `without_skill`, retain that exact schema value—the underlying source is still the frozen old-skill snapshot. Do not invent a different configuration field that the viewer cannot parse.

The benchmark must report, for each configuration:

- Assertion pass rate: mean ± standard deviation.
- Duration: mean ± standard deviation.
- Token usage: mean ± standard deviation.
- Per-eval results and deltas.
- Tool calls and errors when available.

With only one run per prompt/configuration, standard deviation across the two prompts measures cross-prompt spread, not repeatability. State this limitation explicitly; multiple repetitions would be required to estimate stochastic run-to-run variance.

## 9. Perform the analyst review

Read the per-run grades, timings, metrics, and benchmark. Add grounded observations to `benchmark.json` and `benchmark.md`, covering:

- Assertions that pass or fail in both versions and therefore do not discriminate.
- Assertions improved or regressed by the revision.
- Whether one prompt accounts for most of the gain.
- High-variance or anomalous results.
- Candidate regressions hidden by the aggregate pass rate.
- Time or token costs relative to quality improvement.
- Transcript evidence connecting changed skill instructions or resources to changed behavior.

Do not call the revision better solely because its aggregate score is higher. Treat it as better only if:

1. Its total assertion pass rate is higher.
2. Neither prompt has a material correctness regression.
3. The improvement occurs on at least one meaningful, discriminating assertion.
4. Any additional time or token cost is acceptable for the measured gain.
5. Human review does not identify a qualitative regression missed by assertions.

Otherwise classify the result as a tie, regression, or inconclusive. Two prompts are suitable for a focused gate, not a broad generalization claim.

## 10. Generate the static human-review viewer

Every run must contain an `outputs/` directory. If a run has only grades and timing, add a minimal `outputs/summary.md` so it appears in the viewer.

In a headless Rudder Codex run, generate a standalone viewer rather than starting a browser server:

```bash
python <skill-creator-path>/eval-viewer/generate_review.py \
  "$WORKSPACE/iteration-1" \
  --skill-name "<unchanged-skill-name>" \
  --benchmark "$WORKSPACE/iteration-1/benchmark.json" \
  --static "$WORKSPACE/iteration-1/review.html"
```

Do not write custom review HTML. Return the exact Rudder-visible Library link to `review.html`, or its exact workspace path if a Library reference command is unavailable.

The viewer lets the reviewer inspect both versions’ rendered outputs, prompts, formal grades, and benchmark metrics. The reviewer records qualitative feedback and uses “Submit All Reviews” to download `feedback.json`; copy that file into the iteration workspace before the next revision.

## 11. Record the decision

Create or update `$WORKSPACE/history.json`, identifying the frozen original as `v0`, the candidate as `v1`, pass rates, and one of `won`, `lost`, or `tie`.

Promote the candidate only when the quantitative gate and human review both pass. Before calling it ready:

- Parse `SKILL.md` frontmatter.
- Confirm the original `name` remains unchanged.
- Parse `agents/openai.yaml` if present.
- Run `scripts/quick_validate.py` against the complete candidate package.
- Verify every referenced script, asset, and reference file is included.

Installation and enablement remain separate Rudder operations. A valid package is not automatically enabled, and enablement affects future runs rather than the current run. Do not install, import, enable, or overwrite the original skill as part of this evaluation unless separately authorized.