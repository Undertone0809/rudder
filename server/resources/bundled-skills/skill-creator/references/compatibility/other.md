# Other Host Compatibility

Use this guide for generic shell agents, chat-only hosts, headless worker hosts, or any environment that is not clearly Claude Code or Codex/OpenAI.

## Capabilities

| Capability | Support | Notes |
|------------|---------|-------|
| Draft or edit skills | Yes | Requires normal filesystem access. |
| Run execution evals | Depends | Requires a usable agent CLI or manual serial runs. |
| Parallel baseline runs | Depends | Skip baselines when subagents are unavailable. |
| Description tuning | Depends | Requires a shell-accessible backend such as `claude` or `codex`. |
| Packaging | Yes | `scripts/package_skill.py` works with Python and filesystem access. |

## Chat-Only Hosts

When there are no subagents, run test prompts serially yourself. Read the skill, follow it on each test prompt, save any generated files, and ask for human feedback inline.

Skip quantitative baseline benchmarking when there is no independent baseline runner. Qualitative review is more honest than pretending a self-run comparison is independent.

## Headless Worker Hosts

When a browser cannot open, generate a static review artifact:

```bash
python <skill-creator-path>/eval-viewer/generate_review.py \
  <workspace>/iteration-N \
  --skill-name "my-skill" \
  --benchmark <workspace>/iteration-N/benchmark.json \
  --static <workspace>/iteration-N/review.html
```

Make sure each run directory has an `outputs/` subdirectory before launching the viewer. If a lightweight benchmark only produced grading and timing files, create a small `outputs/summary.md` so the viewer has something to render.

## Metadata

Do not create `agents/openai.yaml` by default for generic or chat-only hosts. Create it only when the skill will also be distributed to Codex/OpenAI, then follow `codex.md`.

## Description Optimization

Run description optimization only when the current environment exposes a compatible shell backend. If no backend exists, write realistic trigger and near-miss prompts for later testing, then continue with manual qualitative evaluation.
