# Description Optimization

Use this reference when the skill itself is already decent but its frontmatter
description may under-trigger or over-trigger.

The description is the primary routing surface.
Treat optimization as a real evaluation problem, not copy editing.

## When To Use This

Use description optimization when:

- the user asks to improve triggering
- the skill reads well but is not being invoked reliably
- the skill is firing on near-miss prompts
- you have already finished at least a solid draft of the skill

Do not optimize the description first if the skill body is still weak.
Fix the capability before tuning the routing surface.

## Step 1. Generate trigger eval queries

Create roughly 20 realistic queries split between:

- `should_trigger: true`
- `should_trigger: false`

Save them as JSON:

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

The queries should feel like real user inputs, not toy examples.
Include concrete details such as file names, work context, URLs, messy wording,
typos, abbreviations, or ambiguous phrasing.

Bad negative cases are obviously irrelevant.
Good negative cases are near-misses that share vocabulary but should route
somewhere else.

## Step 2. Review the query set with the user

Before running the loop, let the user review the query set.
Use the local bundled HTML review asset in `assets/eval_review.html` to present
and edit the eval set.

The template workflow is:

1. load the HTML template
2. inject eval data, skill name, and current description
3. write a temp HTML file
4. open it for the user
5. read the exported eval set from Downloads

This step matters because poor trigger queries produce poor descriptions.

## Step 3. Run the optimization loop

Run the local bundled optimization loop from the skill root:

```bash
python scripts/run_loop.py \
  --eval-set <path-to-trigger-eval.json> \
  --skill-path <path-to-skill> \
  --backend auto \
  --max-iterations 5 \
  --verbose
```

If the backend supports model selection, use the current host model when that
keeps the results closer to the user's real experience.

While the loop runs:

- report progress to the user
- watch train and held-out test behavior
- avoid selecting descriptions based only on training performance

## Step 4. Apply the result carefully

Take the best description from the loop, update frontmatter, then show the user:

- before
- after
- relevant scores or win rate

Do not silently swap descriptions with no explanation.

## Query Design Rules

For positive cases:

- vary phrasing from formal to casual
- include cases where the user does not explicitly name the skill
- include edge cases where this skill should win over a competing one

For negative cases:

- use adjacent domains and semantic overlaps
- include ambiguous prompts a naive keyword match would misroute
- avoid "obviously unrelated" filler

## Host Notes

On hosts that do not expose a shell-accessible backend for trigger evaluation,
skip the automated loop and do a manual description review instead.

On Codex-like judged backends, treat the results as a routing proxy rather than
a perfect measurement of native host behavior.
