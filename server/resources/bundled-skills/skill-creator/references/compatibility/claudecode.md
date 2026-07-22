# Claude Code Compatibility

Use this guide when the current host is Claude Code, or when evaluating a skill's trigger behavior with the Claude Code CLI.

## Capabilities

| Capability | Support | Notes |
|------------|---------|-------|
| Draft or edit skills | Yes | Normal filesystem edits work. |
| Run execution evals | Yes | Use realistic prompts and preserve run artifacts. |
| Parallel baseline runs | Yes | Run with-skill and baseline runs in the same turn when subagents are available. |
| Description tuning | Yes | Prefer the Claude backend for trigger measurement. |
| Packaging | Yes | Use `scripts/package_skill.py` when packaging is requested. |

## Trigger Evaluation

Use `scripts/run_eval.py --backend claude` or `scripts/run_loop --backend claude` when available. Claude Code can observe real skill routing behavior through `claude -p`, so this is the highest-fidelity backend for description tuning.

Treat these measurements as stronger evidence than judged proxy routing. Still include near-miss prompts and held-out prompts so the description does not overfit obvious positive cases.

## Baselines

For new skills, compare against a no-skill baseline. For existing skills, snapshot the old skill before editing and use that snapshot as the baseline.

Launch with-skill and baseline runs together when possible so duration and model conditions are comparable. Save outputs, grading, and timing data in the same workspace structure described in `SKILL.md`.

## Host Metadata

Claude Code does not require `agents/openai.yaml`. Do not create that file solely for Claude Code. If the same skill will also be distributed to Codex/OpenAI, also read `codex.md` and add the Codex/OpenAI metadata there.
