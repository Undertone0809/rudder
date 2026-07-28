# Performance Evidence Model

## Evidence Levels

1. **Terminal evidence**: the named user-visible workflow in the required
   browser/Desktop/runtime, under the selected workload.
2. **System evidence**: API/service/query/payload/process data that explains the
   terminal result.
3. **Supporting evidence**: code inspection, unit tests, profiler hypotheses,
   stale installed builds, or synthetic microbenchmarks.

Do not promote supporting evidence to terminal proof.

## Minimum Cohort Record

Record:

- source SHA and dirty state;
- server/Desktop version, instance ID, local environment, descriptor/API URL;
- build/bundle identity and timestamp;
- scenario manifest/hash, organization ID, volume, timestamp anchor;
- warmups, measured iterations, viewport/platform;
- request count, payload bytes, latency distribution;
- DOM/mounted rows, frame/long-task data for visible UI;
- exact memory metric and collection source;
- correctness sentinels and failures.

## Scaling Questions

For every suspected hotspot, ask:

- Does cost grow with total rows, visible rows, active rows, or update rate?
- Is the expensive representation loaded in a list/polling path?
- Are repeated consumers sharing data or multiplying requests/subscriptions?
- Does background work continue after the relevant surface closes or reaches a
  terminal state?
- Is client rendering bounded by the viewport?
- Does one high-frequency entity invalidate unrelated entities?
- Are response row limits paired with an aggregate byte budget?

## Comparison Rules

Before/after is valid only when source and workload differences are named and
controlled. Prefer multiple warmups and iterations. Keep raw JSON alongside the
summary. Include unchanged or worse metrics; do not select only wins.

If the production target runs a different source:

- use it for data shape and historical symptom evidence;
- reproduce on current source in an isolated environment;
- do not claim the old target proves the current change.

## Correctness Is Part Of Performance

Include high-risk sentinels such as:

- neighboring organization records never appear;
- pagination returns the complete ordered set without unbounded requests;
- deep links mount offscreen targets;
- background streaming becomes exact when reopened;
- live-to-terminal runs retain final evidence and stop polling;
- reconnect gaps are reconciled;
- final Markdown/transcript text matches persisted output;
- virtualized drag, focus, unread, and accessibility behavior remains usable.
