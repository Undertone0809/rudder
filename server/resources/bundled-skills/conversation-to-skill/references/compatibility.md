# Host Compatibility

This skill is designed to work across multiple agent hosts. The workflow stays
the same, but some mechanics change.

## Capability Matrix

| Host | Draft skill | Run evals | Parallel baseline | Description tuning | Packaging |
|------|-------------|-----------|-------------------|--------------------|-----------|
| Codex | Yes | Yes, judged via `codex exec` | Usually yes | Yes | Yes |
| Claude Code | Yes | Yes, observed via `claude -p` | Yes | Yes | Yes |
| Claude.ai | Yes | Manual/serial | No | Usually no | Yes |
| Generic shell agent | Yes | Yes if a CLI exists | Depends | Depends | Yes |

## Important Differences

- **Claude Code**
  - `scripts/run_eval.py --backend claude` measures real observed triggering.
  - This is the highest-fidelity description benchmark.

- **Codex**
  - `scripts/run_eval.py --backend codex` measures judged routing, not native
    skill invocation. It is still useful for testing whether the description
    makes the intended use cases obvious.
  - Treat Codex trigger numbers as a proxy, not ground truth.

- **Claude.ai or chat-only hosts**
  - Skip automated trigger benchmarks unless you have a shell + CLI bridge.
  - Do serial manual evals and focus on qualitative output review.

## Recommended Defaults

- If you are improving instructions, tool choices, examples, or bundled scripts:
  qualitative evals matter most.
- If you are improving trigger phrasing:
  prefer `--backend claude` when available, otherwise `--backend codex`.
