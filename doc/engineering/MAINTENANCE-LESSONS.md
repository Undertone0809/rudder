---
title: Maintenance and Verification Lessons
status: active
---

# Maintenance and Verification Lessons

Use this record before maintenance work and merge review. Each lesson links a
failure to a regression check and a review rule. A checkbox is not evidence.
Keep new incidents here rather than creating competing rule documents.

## 2026-10-28: Canary opt-out markers suppressed product releases

Main Test runs `40607366853` and `40624024900` succeeded, but their Release
preflight jobs were skipped because merged product PR messages included
`[skip release]`. The latest published canary remained `0.7.24-canary.49`.

Reserve the explicit `[skip canary]` opt-out for active stable-release repairs
and generated post-stable version handoffs. Legacy `[skip release]` text no
longer suppresses automatic canaries. Keep the generator, runbook and release
skill synchronized with the workflow token.

The release workflow contract executes the actual preflight expression against
legacy product merge messages, explicit maintenance opt-outs, unsuccessful CI,
non-main/non-push and foreign-repository events, plus manual stable dispatch.
An automatic attempt and a completed publication are separate observations:
the previous eligible run `40155135246` failed its Windows candidate gate.
Retain every candidate and public-install gate when restoring the trigger.

The first repair PR run `40633528594` also exposed three diff-local Node review
records inherited from the preceding Messenger merge. No runtime source changed
in the repair, so the trusted base checker correctly rejected those stale
records. Retire only the already-landed `reviewed_node_changes` entries, as the
existing CLI lifecycle regression requires; preserve source inventories,
transport admissions and checker enforcement.

## 2026-10-28: Keep qualification and publication on supported runner images

The restored main Test `40642026483` automatically started Release
`40648135955`, including its deliberate legacy-marker regression fixture.
Preflight selected `0.7.24-canary.50`; npm, Linux, Windows and macOS Intel
candidates passed. The remaining Apple Silicon candidate stayed queued on
`macos-14` for more than 90 minutes.

[GitHub's retirement notice](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/)
sets November 2, 2026 as the removal date, with earlier brownouts and possible
capacity reductions. The queue alone does not prove its cause, but an image
scheduled for removal cannot support a durable release path. Move the canonical
Test and Release ARM jobs to the supported `macos-15` label together, retain
`macos-15-intel` for x64, and preserve the migration, package and public-install
gates. Contract coverage must reject retiring labels on both paths.

An obsolete candidate may be cancelled before publication after checking npm,
the remote tag and GitHub Release state. A replacement workflow/source needs
its own immutable qualification and candidate; passing artifacts from the old
workflow must not be relabeled as a candidate for the new source.

## 2026-10-13 audit scope

Inspected public main `93faca8b2352cad0331db54794b6895630ad2ecc`: contributor
rules, CI qualification/architecture wiring, test orchestration, forbidden-token
checking, and recent/open PR descriptions. The source files used in the local
regression run were reconstructed from connected GitHub reads and verified
against their Git blob IDs before editing. This was a scoped audit, not a full
repository, dependency, binary, credential-history or malware scan.

The defects below establish unsafe behavior, not malicious authorship. No claim
of deliberate implant or repository-wide absence of malware is made. The
forbidden-token checker is a tracked-file privacy guard, not a replacement for
secret scanning. Its existing optional empty-token skip and lockfile exclusion
remain explicit coverage limits.

## M001: JSON quoting is not shell escaping

**Evidence:** `scripts/check-forbidden-tokens.mjs` interpolated `JSON.stringify`
into `execSync`. Tokens originate in username environment variables and the
local forbidden-token file. In an isolated Git fixture, command-substitution
text created a marker file through the old shell path. No external target,
credential, network request or live user data was used.

**Correction:** invoke Git with `execFileSync`, an argument array and no shell.
Use fixed-string matching and an explicit `-e` argument. Print only JSON-escaped,
NUL-delimited matching filenames, not matching lines or raw subprocess errors.

**Regression:** `scripts/maintenance-guards.test-node.mjs` covers command
substitution, backticks, quotes, whitespace, regex metacharacters, option-like
patterns, case-insensitive matching and non-disclosure of matching contents.

**Reject:** a change treating JSON serialization as shell escaping, interpolating
untrusted data into an executable command string, or printing secrets to prove
that a secret scanner found them. For another caller, trace its actual input
and trust boundary before declaring exploitability; a string search alone is
not an audit. See the Node child-process and Git grep documentation below.

## M002: A broken check is not a clean result

**Evidence:** the same scanner caught every Git failure and treated it as no
matches. A real directory outside Git returned success on the old implementation.
The old test used an untyped error as a no-match fixture, encoding the mistake.

**Correction:** only exit status 1 with no signal or system error is no-match.
Launch failure, invalid repository, timeout, output overflow and termination
block publishing. Keep stderr and the token out of the failure log.

**Reject:** broad `catch {}` around a required verification command, `|| true`,
unchecked null exit codes, or success after missing prerequisites. Correct the
fixture to model the documented error, not the implementation's accidental bug.

## M003: Zero tests cannot qualify a change

**Evidence:** `scripts/run-vitest-projects.mjs` unconditionally enabled
`--passWithNoTests`; empty server-file discovery also returned success without
launching a test. The runner now explicitly disables no-tests success, rejects
an empty project selection, and records an empty server discovery as a failure
while preserving later-project diagnostics.

**Regression:** the dependency-free guard suite is run explicitly with
`node --test` by `pnpm test:maintenance-guards`, which is part of `pnpm test:run`.
This prevents the Node suite from depending on Vitest discovery. Tests cover
empty selection/discovery, the spawned argument contract and failure aggregation.
These tests do not prove that an all-skipped Vitest suite is detected; that is a
separate remaining gap requiring actual test-report accounting.

**Reject:** counting no-tests, skipped, ignored, cancelled, setup-only, pending
or not-run results as passes. Record passed/failed/skipped counts and the actual
runner. A discovered filename is not proof that its assertions executed. Do not
use a permissive flag or remove a test merely to restore green CI.

## M004: Runtime source repairs must refresh their authority evidence

**Evidence:** PR #356 at `07ddced13403726c1cb0be55773c930eb8f7029a`
passed its focused Desktop checks, but CI run `39893339993` stopped in the
qualification planner because the generated authority inventory still recorded
the old `desktop/src/update-check.ts` hash. The planner's inventory suite passed
33 tests; the planner failed and downstream qualification jobs were skipped.
Regenerating exposed the next
required gate: the changed source also needed a reviewed compatibility-boundary
record.

**Correction:** regenerate the inventory and bind the scoped existing Electron
release-discovery repair to its exact base/head hashes and independent review.
Keep the unchanged structural surfaces and unknown entries visible. This record
does not claim Rust ownership of the updater or completion of backend migration.

**Regression:** run `node scripts/rust-backend-authority-inventory.mjs check`,
then the trusted comparison-base checker with `compare --compare-ref <base>`.
The stale inventory and missing-record cases must fail before repair; both
checks must pass after repair. The inventory suite and exact-candidate CI remain
required; local updater or inventory tests do not qualify skipped jobs.

**Reject:** handoff after merely opening a PR, treating pending/skipped CI as a
pass, or widening an allowlist to avoid the source-bound review requirement.

**Comparison-source recovery:** run `40089641446` passed the regenerated
inventory check, but its PR event still named comparison base `e6eb1d033` while
the tested merge's first parent was current main `12724f401`. The trusted
ratchet consequently also evaluated already-merged database migration changes
whose diff-local records had been retired. Refreshing the PR's unchanged
`main` target updated its base metadata. Trigger a fresh PR event after that
refresh; rerunning the old event preserves the stale comparison input. Keep
the trusted checker and its findings intact.

## M005: A merged fix is not an installed update

**Evidence:** the Hermes configuration fix in PR #359 was merged after the
`0.7.24-canary.49` artifact was published. That installed artifact still exposed
disabled Hermes options even though source acceptance had passed.

**Correction:** resolve the named installed bundle and runtime, then bind repair
evidence to its UI and Rust binary hashes. Preserve the existing profile and
database. Expose the existing owned-runtime restart action in Settings > About
so recovery does not depend on an accessible tray or force-quitting old runs.

**Regression:** `desktop/scripts/smoke.mjs --scenario=runtime-restart-settings`
clicks the real About control in an isolated packaged copy, observes a replaced
runtime descriptor, and checks that Electron and saved organization data survive.
Component tests cover duplicate clicks, update-in-progress blocking and retry
after failure. This isolated fixture does not replace acceptance of the named
installation, its account session or real provider profiles.

**Reject:** reporting a branch, merged PR, healthy unrelated server or staged
artifact as an updated installation. Record the installed path, version, asset
identity and terminal user workflow separately from release publication.

## M006: Verify the installed CLI launcher chain

**Evidence:** the local Hermes command used a small shell launcher which clears
`PYTHONPATH` and `PYTHONHOME`, then executes its venv Python and console script.
The pinned ACP adapter only recognized the inner console script, so readiness
incorrectly reported that the installed bootstrap was unavailable.

**Correction:** Rust recognizes that exact launcher grammar without invoking a
shell, validates the pinned inner installation, and requires both interpreter
paths to resolve to the same file. It fingerprints both launchers and rechecks
the expected installation revision immediately before the owned process starts.
Python still runs with isolated mode and an explicit environment. This is a
trusted local installation check, not an immutable-filesystem execution claim.

**Regression:** Hermes ACP tests cover direct and wrapped entries, malformed
commands, interpreter mismatch, source/launcher revision changes, and missing
launch revisions. The named installed-launcher check is read-only; actual
provider credentials and model responses still require installed-app acceptance.
The separate ignored empty-profile session-persistence probe failed locally;
do not report the inclusive suite as green or use it as real-profile evidence.

## Historical lessons to preserve

The following are source PR records, not newly reproduced runtime results:

- [PR #297](https://github.com/Undertone0809/rudder/pull/297) records synthetic
  process IDs reaching real OS cleanup. Use owned child handles and verify
  identity; never send real signals to fabricated or stale PIDs. Intercept mock
  IDs at every platform boundary and retain real-child cleanup tests.
- [PR #302](https://github.com/Undertone0809/rudder/pull/302) records 25 Activity
  tests skipped when the PostgreSQL provider was unavailable. Required fixture
  readiness is a gate, not an optional success branch. Name the actual database,
  binary and ingress used; do not substitute a mock for a promised real journey.
- [PR #275](https://github.com/Undertone0809/rudder/pull/275) records a Node test
  suite reported as zero Vitest tests and a manifest CLI option that was ignored.
  Test the real CLI entry and verify argument parsing with positive and negative
  subprocess cases, not only an imported helper.
- [PR #303](https://github.com/Undertone0809/rudder/pull/303) and
  [PR #304](https://github.com/Undertone0809/rudder/pull/304) record isolation and
  privacy corrections during Rust read migration. Organization scoping alone
  does not prove visibility: test private ownership, malformed/foreign related
  rows, revoked credentials, pagination and failure paths through public ingress.

Do not use these descriptions as proof that an open PR or a newer head is
currently qualified. Read current diffs, exact-head checks and unresolved gates.
Do not close, merge or cherry-pick an old draft solely because related work landed.

## Maintainability is not a line-count contest

The inspected `scripts/architecture-audit.mjs` only scans selected TypeScript
production roots; it does not scan native Rust, `identity/`, or nested
`packages/agent-runtimes/*/src/`. A green result is therefore not whole-backend
architecture acceptance. Its pagination keyword heuristic is advisory, not
proof of bounded queries. These coverage gaps are not fixed by this patch.

Before extending the ratchet, inventory actual files and existing debt, add
scope tests, and assign ownership and expiry to exceptions. Never widen a
threshold, inflate the baseline, remove an assertion or add exclusions to
conceal a regression. Do not shift logic into an ignored directory to pass.

Cleanup should remove a demonstrated duplicate responsibility or unsafe path.
Prefer one coherent responsibility per module and small reversible changes.
Before deleting an old Node authority after a Rust migration, verify every real
caller, public route, failure mode and packaging path; retained compatibility
is not automatically dead code. Do not combine cleanup with speculative product
rewrites, dependency churn, or another draft's unqualified work.

## Merge rejection rules

Block merge when any applicable gate is unresolved: security finding, unsafe
execution or secret logging, broken organization/private ownership boundaries,
missing negative tests, unverified destructive cleanup, stale-source evidence,
new architectural debt hidden by exclusions, or an unqualified required CI job.
A focused pass does not waive a full required check. Existing baseline failures
need explicit attribution; they cannot be silently reclassified as success.

For every repaired incident retain: source identity, observed failure, minimal
reproduction, causal correction, red-to-green test, remaining limits, and the
rule that prevents recurrence. Bind reviewer/verifier results to the same
candidate. Self-review is not independent acceptance. Follow AGENTS section 9.1
when that risk gate applies; nothing here authorizes bypassing it.

Before a merge claim, include:

```text
Candidate / base / tested content identity:
Command and actual runner:
Environment and owned fixture identity:
Passed / failed / skipped / cancelled counts:
Negative case that failed before the fix:
Exact-head CI and independent review status:
Not run, unresolved risks, and reason:
Rollback boundary:
```

## Validation recorded for this repair

On Linux with Node 22.16.0 and local Git, the same proposed 22-case Node suite
reported 2 passed / 20 failed against the verified original files, then
22 passed / 0 failed / 0 skipped against the corrected files. The tests include
real Git fixtures as well as explicit process-boundary fakes; they are not a
full Vitest, application or platform acceptance run.

The authoring container cannot resolve GitHub for cloning and lacks pnpm,
Cargo and workspace dependencies. Full lint, workspace typecheck, Vitest,
build, packaged smoke, macOS/Windows execution and independent reviewer/verifier
acceptance were not performed here. They must not be inferred from this record.
Keep the change unmerged until applicable exact-head CI/review gates are met.
No production data, deployment, release or branch protection was changed.

## Reference semantics

- [Node child processes](https://nodejs.org/api/child_process.html): executable
  plus arguments versus shell interpretation; subprocess error handling.
- [Git grep](https://git-scm.com/docs/git-grep): literal matching, explicit
  patterns and filename-only NUL-delimited output.
- [Vitest v3 configuration](https://v3.vitest.dev/config/#passwithnotests):
  no-test success is an explicit option, not verification evidence.
