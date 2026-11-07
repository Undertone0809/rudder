# Relocated Desktop Identity Dependency Repair

## Candidate and scope

- Original frozen source: `ceb08be24dcbf71ae110e55b9907deca54d91a0f`.
- Repair checkpoint: `ed1fed27700df2ea84fa2855fc55f39538a7ab51`.
- Rebased onto Main `e73976f0fa0662b1605838e92232b2b27cdc0faa`:
  `007b8d0ecc02e95586b8e17d75dcf19c98dd99b3`.
- Evidence checkpoint `d989f72d3` adds documentation only to that source.
- No push, merge, stable release, or production operation was performed.

## Observed failure and correction

The standard packaged account gate timed out when launching its copied app.
The separate public automatic update reached a staged candidate and helper
handoff, but journal `138e52a9-7f2c-477d-afc5-fa4b3fe89f62` ended at
`recovery_required / dual_failure`.

A direct launch of the preserved disposable LKG stalled in an Electron
`NSAlert runModal`. The parent attached a debugger to its own diagnostic process
and observed missing `@rudderhq/identity-core` imports from
`identity-local-session.js` and `identity-offline-grant.js`. The packaged app
contained only `@rudderhq/shared`; repository-resident launches could accidentally
resolve the missing dependency from a checkout ancestor.

The repair stages compiled `identity-core/dist` and its normalized manifest,
declares the dependency in the app manifest, and verifies that the Electron
entry resolves to compiled JavaScript inside the real packaged app directory.
The regression checks reject ancestor-checkout resolution and escaping symlinks.
Identity remains first-party Node authority at this transitional point; this
packaging repair does not count as Rust Identity service migration.

## Checks and independent stage review

- Four focused packaging/manifest tests passed. Import lint checked all four
  changed scripts and passed.
- Arendt independently reran the four tests and returned stage `accept` for
  `ed1fed27700df2ea84fa2855fc55f39538a7ab51`. This is not final acceptance.
- Sagan's relocated diagnostic account-gate scenario passed, exit 0:
  `/tmp/codex-rudder-v20-account-gate.hzyZnX/smoke.log`.
- Main-e739 full build, full recursive typecheck, import lint, package validation,
  14 Desktop tests, 46 release-contract tests, and 4 release-note UI tests passed.
- One premature typecheck ran while packaging had temporarily hidden Desktop
  dependencies; its missing Node type definitions were resolved by the completed
  packaging restore and the full successful rerun, without a source workaround.

## Remaining updater failure

The identity repair lets the relocated update candidate reach real runtime
startup, but the diagnostic full updater still returned `dual_failure`:
`/tmp/codex-rudder-v20-auto-update.5GqFWq/smoke.log`.

Direct probes of the preserved same-data LKG and failed target both exited 0 in
5,377 ms and 4,451 ms respectively. A cold disposable LKG probe also exited 0
after initialization, taking longer than the helper's configured 10-second
probation budget. These observations do not establish why the full updater
failed, and do not justify marking the updater successful. No timeout was
changed on this evidence alone.

Diagnostic evidence is retained under
`/tmp/codex-rudder-probation-diagnose.nw8aVL/`: `sample.txt`, `errors.log`,
`second-probe.log`, `existing-probe.log`, and `target-probe.log`.

Fresh Main-e739 default packaged acceptance is running under
`/tmp/codex-rudder-e739-packaged.tuYl4E/`. Its result must be reconciled before
final review or publication. v19 is explicitly invalidated for the changed
package; unchanged backend observations require a scoped equivalence rebind.

## Preserved original checkout

The parent rechecked the protected `7b2a` checkout without modifying it:

- HEAD: `c54001819ca38079b627994557db0a18ed278fc0`.
- Tracked dirty diff: `a805bb0666c88f91f610b56bcc241a2acc04a88c0c4174bf639dbf256c3a54e0`.
- Index: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Untracked branding CLI test: `ebbfae2e69258d770a8ad9d435ab61e3c5f3fd4ecb3c4b1f533a3753e05a1f80`.

All three preservation digests match the previous recorded baseline.

## Follow-up recovery patch (not frozen)

The first Main-e739 package still failed the automatic update at the old 10
second probation boundary. The working-tree patch now uses a 60 second
probation budget, gives the native helper an outer two-probe budget, and makes
the asynchronous recovery wrapper wait for `close` before deleting its request.
`SIGTERM` escalates to `SIGKILL`; an unconfirmed child exit leaves the request
for recovery and returns `recoveryRequired`.

The native helper launches each Unix probation process in its own process group.
The journal records the probation leader and process group when cleanup is
needed. Recovery checks that both are gone before it probes the target or moves
the LKG; a live group returns `target_probation_cleanup_still_present` and
keeps the generation fence. A confirmed group cleanup follows the existing
rollback path. Native helper tests are currently `14 passed`, and the focused
Desktop update helper/flow suite is `68 passed`; Desktop typecheck and diff
check pass.

This patch is not yet a frozen acceptance candidate. The remaining proof is a
fresh rebuilt packaged update run that records the target Electron/runtime
descendants, embedded PostgreSQL port and runtime descriptor across timeout and
recovery, followed by independent verifier and final reviewer receipts.
Settings Rust mixed-patch rollback is at `8 passed`; the Node Chat coordinator
enqueue/claim integration is still in implementation, so no organization-wide
Rust writer authority is active. The separate analytics collector lane has
private checks and an expired loopback fixture, but Node remains its authority.
