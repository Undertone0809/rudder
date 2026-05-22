# Evaluation Suite

Use this reference whenever `conversation-to-skill` decides a skill should be
evaluated rather than merely drafted.

This is the full evaluation suite.
Do not reduce it to "run one prompt and eyeball it" unless the host truly
cannot support more.

This skill bundles the required evaluation support files locally:

- `agents/grader.md`
- `agents/comparator.md`
- `agents/analyzer.md`
- `eval-viewer/generate_review.py`
- `assets/eval_review.html`
- `scripts/*.py`
- `references/compatibility.md`
- `references/schemas.md`

Prefer these local copies over reaching into another skill directory.

## When To Use This

Use the full suite when at least one of these is true:

- the user asks to test, benchmark, compare, or improve a skill
- the skill has objectively checkable outputs
- the first draft is clearly weak and needs iteration
- description quality or trigger accuracy matters

You may skip the full suite when the user explicitly wants a draft only, or when
the skill output is so subjective that formal grading would be fake precision.

## Layout

Choose the skill location first, then set up evaluation paths around it.

- Global skill: `~/.agents/skills/<skill-name>`
- Project-based skill: `<project-path>/.agents/skills/<skill-name>`
- Eval workspace: sibling directory named `<skill-name>-workspace/`

Within the workspace, organize by iteration:

```text
<skill-name>-workspace/
├── skill-snapshot/              # optional baseline snapshot for existing skill
├── iteration-1/
│   ├── eval-0-<name>/
│   ├── eval-1-<name>/
│   └── benchmark.json
└── iteration-2/
```

Within each eval directory, keep run outputs separated:

```text
eval-0-descriptive-name/
├── eval_metadata.json
├── with_skill/
│   ├── outputs/
│   ├── grading.json
│   └── timing.json
└── without_skill/              # or old_skill/
    ├── outputs/
    ├── grading.json
    └── timing.json
```

Do not create every directory upfront.
Create only what the current iteration needs.

## Before Running Anything

### 1. Write realistic test prompts

Create 2-3 realistic prompts that a real user would plausibly type.
Share them with the user when that feedback would help.

Save them to `evals/evals.json`:

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

Do not write assertions yet.
You will draft them while the runs are in progress.

### 2. Decide the baseline

Use the right comparator:

- New skill: `without_skill`
- Existing skill being improved: snapshot the old version first, then compare against `old_skill`

If improving an existing skill, snapshot before editing:

```bash
cp -r <skill-path> <workspace>/skill-snapshot/
```

### 3. Create eval metadata

Each eval directory should contain an `eval_metadata.json`:

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

Use descriptive eval names.
Avoid generic names like `eval-0` when a better label exists.

## Running The Suite

This sequence is continuous.
Do not stop after spawning runs or after creating the benchmark.

### Step 1. Spawn all runs in the same turn

For each test case, start both variants at once:

- one run with the skill
- one baseline run without the skill, or against the old snapshot

Do not launch all with-skill runs first and defer baselines.
Parallel launch keeps the comparison cleaner and faster.

Use prompts shaped like:

```text
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user actually cares about>
```

Baseline run:

```text
Execute this task:
- Skill path: none                # or old snapshot path
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/<baseline>/outputs/
- Outputs to save: <same deliverables as with-skill>
```

### Step 2. Draft assertions while runs are executing

Do not wait idly.
While runs are in progress:

- draft assertions for each eval
- update `eval_metadata.json`
- update `evals/evals.json`
- explain to the user what each assertion checks if that context matters

Good assertions are:

- objective
- descriptive
- easy to understand in the benchmark viewer

Bad assertions are vague or subjective.
If quality depends on human judgment, keep that part qualitative.

### Step 3. Capture timing as runs finish

When each run completes, capture the timing data immediately:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

Save it to `timing.json` in the run directory.
Do not delay this step if the host exposes timing only in completion
notifications.

### Step 4. Grade each run

Evaluate each assertion against the outputs and save `grading.json`.

The expectations array must use these exact fields:

- `text`
- `passed`
- `evidence`

Example:

```json
{
  "expectations": [
    {
      "text": "Output includes a trigger-oriented description",
      "passed": true,
      "evidence": "Frontmatter description mentions both capability and trigger contexts."
    }
  ]
}
```

If an assertion can be checked programmatically, prefer a script over manual
inspection.

### Step 5. Aggregate into a benchmark

Once all runs are graded, aggregate the iteration into benchmark artifacts.

Run the local aggregation script from the skill root:

```bash
python scripts/aggregate_benchmark.py <workspace>/iteration-N --skill-name <name>
```

Expected outputs:

- `benchmark.json`
- `benchmark.md`

Put each `with_skill` result before its baseline counterpart in summaries so the
comparison is easy to scan.

### Step 6. Do an analyst pass

Read the benchmark and look for patterns that averages hide:

- assertions that always pass regardless of the skill
- flaky or high-variance evals
- speed or token regressions that are not buying quality
- cases where the skill only improves one narrow prompt

If a metric is non-discriminating, change the eval design rather than pretending
it is useful.

### Step 7. Generate the review viewer

Do not stop at `benchmark.json`.
Always generate a reviewable artifact for the human.

Generate the review viewer with the local bundled script:

```bash
nohup python eval-viewer/generate_review.py \
  <workspace>/iteration-N \
  --skill-name "<name>" \
  --benchmark <workspace>/iteration-N/benchmark.json \
  > /dev/null 2>&1 &
VIEWER_PID=$!
```

For iteration 2+, also pass:

```bash
--previous-workspace <workspace>/iteration-<N-1>
```

If a synthetic benchmark created no real outputs yet, add a minimal file such as
`outputs/summary.md` so the viewer has something to render.

### Step 8. Hand the viewer to the user in the same turn

Do not make the user ask for the results viewer later.
Tell them where it is immediately.

If a server-backed viewer is available, say it is open and explain the two main
tabs:

- `Outputs`: prompt, output artifacts, grades, and feedback box
- `Benchmark`: pass rate, time, token usage, and analyst observations

### Step 9. Read feedback and iterate

When the user finishes review, read `feedback.json`:

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."}
  ],
  "status": "complete"
}
```

Empty feedback usually means the user found that case acceptable.
Focus changes on cases with specific complaints.

If you started a viewer server, stop it afterwards:

```bash
kill $VIEWER_PID 2>/dev/null
```

## Improvement Loop

Use the feedback to improve the skill, not to overfit it.

Priorities:

1. generalize from repeated failures instead of patching one exact prompt
2. remove instructions that create busywork without quality gains
3. explain why important behavior matters
4. package repeated deterministic work into scripts when multiple runs rediscover it

After revising the skill:

1. rerun all evals into `iteration-<N+1>/`
2. keep the same baseline logic unless there is a clear reason to change it
3. regenerate the viewer with `--previous-workspace`
4. collect user feedback again
5. repeat until quality is acceptable or progress stalls

Stop when:

- the user is happy
- feedback is empty across the board
- the skill is no longer improving meaningfully

## Blind Comparison

If the user specifically wants a more rigorous A/B comparison between two skill
versions, run a blind comparison:

- give two outputs to an independent grader without saying which is which
- have it judge quality
- analyze why the winner won

This is optional.
Use it when normal human review is not enough.

## Host-Specific Adaptation

### Chat-only host

If the host has no subagents:

- run test cases one by one
- skip baseline if independent comparison is impossible
- present outputs directly in chat or save them for the user to inspect
- focus on qualitative feedback
- skip benchmarking if it would be fake rigor

### Headless worker host

If the host has no browser or display:

- still run the full evaluation workflow
- generate a static HTML review artifact instead of opening a live viewer
- provide the exact output path to the user
- expect feedback to arrive as a downloaded `feedback.json`

For headless review generation, prefer:

```bash
python eval-viewer/generate_review.py \
  <workspace>/iteration-N \
  --skill-name "<name>" \
  --benchmark <workspace>/iteration-N/benchmark.json \
  --static <workspace>/iteration-N/review.html
```

## Packaging

If the user wants a distributable skill package and the appropriate tooling is
available, package it after the skill is stable.

If the user wants packaging, use the local bundled script:

```bash
python scripts/package_skill.py <path/to/skill-folder>
```

## Final Rule

If you chose evaluation, follow through.
Do not stop after writing prompts.
Do not stop after generating benchmarks.
Do not stop after revising the skill once.

The full suite is:

- draft or revise the skill
- run test cases
- grade and benchmark them
- generate a human-review artifact
- collect feedback
- improve the skill
- rerun and compare again
