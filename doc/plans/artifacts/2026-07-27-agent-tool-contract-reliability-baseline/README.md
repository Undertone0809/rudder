# Agent Tool Contract Reliability Baseline

This artifact freezes the production baseline used to evaluate the exact MCP
tool-contract change three days after delivery.

## Window And Population

- Window: 2026-07-25 22:14 through 2026-07-27 22:14 Asia/Shanghai
- Runs: 102
- Outcomes: 85 succeeded, 12 failed, 4 cancelled, 1 running
- Runtime mix: 99 R6z runs; 94 Codex Local and 8 Claude Local runs
- Transcript entries reviewed: 54,534
- Tool calls reviewed: 2,920

The diagnostic run `e5913c44-00f0-4118-b27b-3c3da31f2` is excluded from
operational tool-rate comparisons. It intentionally stress-tested MCP with 205
calls and 90 expected errors.

## Adjusted Baseline

| Surface | Runs using surface | Calls | Errors | Error rate |
| --- | ---: | ---: | ---: | ---: |
| MCP | 62 | 483 | 41 | 8.49% |
| CLI | 22 | 81 | 8 | 9.88% |

Nineteen runs used both surfaces. Twenty-seven runs had at least one MCP error,
and 22 of those runs still completed successfully. Terminal run failures were
7 `chat_adapter_failed`, 3 `process_lost`, and 2 `adapter_failed`; the reviewed
evidence did not attribute those terminal failures to MCP contract errors.

## Contract-Shape Error Set

The follow-up must count these signatures independently from domain guardrails,
transport failures, browser timing/staleness, user cancellation, and deliberate
negative probes:

- `issue.search` called without a non-empty `query` (2 observed calls)
- `issue.commit` called with `summary` instead of required `message` (2 observed
  calls)
- `runs.get` called with `runIdPrefix`, `includeTranscript`, `includeOutput`, or
  `maxChars`
- `runs.list` called with `includeOutput`
- `runs.transcript` called with `runIdPrefix` or `limitBytes`
- `runs.by-skill` called with `includeOutputs` or `includeTranscript`
- `user.activity` called with `limit` above the server maximum of 100

The run-tool and user-activity signatures were observed in the reviewed
transcripts, but their individual counts were not preserved separately from
the 41 adjusted MCP errors. The three-day eval must therefore report both:

1. exact counts for every signature in its new window; and
2. whether each signature recurs at all, using zero recurrence as the primary
   regression target.

## Repeat Method

1. Query the production run-intelligence API for the latest 48-hour window.
2. Retrieve bounded run summaries first, then error-focused transcript slices.
3. Use raw logs only when the normalized transcript omits the tool arguments or
   error result needed for classification.
4. Exclude clearly labeled diagnostic/stress runs from operational rates, and
   report every exclusion with its run id and reason.
5. Classify MCP and CLI calls using the same error rules as this baseline.
6. Compare adjusted MCP/CLI totals, contract-shape recurrence, runs affected,
   successful runs with recoverable errors, terminal failure causes, and
   response-too-large errors.

The machine-readable values are in `baseline.json`.
