# Final independent review r4

**Verdict: ACCEPT** for pushing/updating PR #398 at exact candidate `64800e00ffda3affaaa0e04ee79e8a9a6787548b`. Exact-head CI remains required before merge. This verdict does not authorize release or deployment.

## Candidate and evidence

- Candidate: `64800e00ffda3affaaa0e04ee79e8a9a6787548b`; branch `codex/rust-agent-execution-core-20261028`; base merge parent `452be7085f7f5a2d91207a0d0fb6ef915f503511`.
- The independent UTF8 PAV returned `PASS` for all 12 approved public selectors and the public Goal/generic execution Stop/retry selector. The PAV report is `/private/tmp/rudder-c-steer-pav-r4.8yuPIg/pav-report.md` (SHA-256 `6e1899aaffd7df5845d9d924588b7647ce02bd4e2c5d6fb8f211da924660e40d`); machine receipt `/private/tmp/rudder-c-steer-pav-r4.8yuPIg/pav-final.json` (SHA-256 `37e272245265ef9babb3c9e99fa33bafb5ad64831417643caf0e835cf39ea166`). These hashes match `acceptance-packet-repair-r4.json`.
- The report binds the frozen foundation test binary SHA-256 `ca7223b8ace364baf738d445e07dbae9aecde3ab7a7cbcd2221e3ad81783e023`, the UTF8 external fixture, and the separately self-owned UTF8 Goal-test database. Processes stopped and no formal Rudder data was touched. Initial prerequisite failures and the earlier SQL_ASCII fixture failure remain disclosed; they are not counted as passes.
- I independently confirmed no native source diff from checkpoint `ea2f74e5d6fd16175171c7738e260ade3852069b` to `648`. The merge brings main’s release/workflow/documentation/test changes; the authority comparison receipt reports no failures. The PAV confirms its 12-selector block remained unchanged.
- Stage review `/Users/zeeland/.codex/rudder-rust-delivery/2026-10-28/agent-execution-core-source-r1/steer-repair-stage-r4.md` accepts the narrow Steer repair for PAV. The updated Issue match still rejects a conflicting non-null Run pointer and only rebinds the same-org, same-agent, running captured Run when the existing Issue context identifies that Issue. Test cleanup and diagnostics do not weaken product guards.

## Remaining boundary

The candidate is ready for push/PR update. Exact-head PR CI is pending. The PAV covers the named native execution cutline and does not claim full Node retirement, real account login, a complete packaged provider loop, or signed/notarized release.
