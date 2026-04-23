console.error(
  [
    "[rudder] `pnpm evals:smoke` still points at the removed promptfoo prototype.",
    "[rudder] Phase-1 eval ownership is now Rudder-run benchmark cases plus Langfuse analysis.",
    "[rudder] Use the benchmark plan in `doc/plans/2026-04-07-rudder-benchmark-v0.1.md` as the canonical direction.",
  ].join("\n"),
);

process.exitCode = 1;
