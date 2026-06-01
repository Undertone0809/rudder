---
name: run-diagnostics-maintainer
description: >
  Process Rudder run diagnostic findings created from completed heartbeat runs.
  Use when the user asks to handle accumulated tool-call, CLI, adapter,
  dependency, permission, timeout, or runtime errors recorded by the Run
  Diagnostics ledger. Group repeated fingerprints, identify the smallest
  system fix, patch skills/config/runtime/docs when appropriate, and mark
  findings resolved, ignored, or needs_human through the diagnostics API.
---

# Run Diagnostics Maintainer

This skill consumes Rudder's run diagnostics ledger.

It is for recurring maintenance after `Settings > General > Developer >
Analyze completed agent runs` has recorded findings from heartbeat runs.

## Goal

Turn repeated run-level diagnostic findings into small, reviewable system
improvements.

The skill should answer:

- Which diagnostics are repeated enough to fix now?
- Is the root cause a skill instruction, runtime adapter, CLI contract,
  workspace/dependency setup, permission/auth issue, or one-off environment
  failure?
- What is the smallest durable fix?
- Which findings should be marked `resolved`, `ignored`, or `needs_human`?

## Default Workflow

1. Identify the target organization.
   - Prefer the current UI organization or the org named by the user.
   - If only one local org is relevant, use that org after verifying it through
     `/api/orgs`.
2. Fetch open diagnostics:
   - `GET /api/orgs/:orgId/run-diagnostics?status=open&limit=100`
   - Also fetch summary when useful:
     `GET /api/orgs/:orgId/run-diagnostics/summary`
3. Group findings by `fingerprint`, then by `kind`, affected agent, and recent
   run evidence.
4. Inspect only the evidence needed:
   - finding summary and excerpt first
   - linked run via run-intelligence only when the excerpt is insufficient
   - linked issue only when the fix depends on the work context
5. Decide the root-cause layer:
   - skill instructions
   - agent runtime adapter
   - CLI/tool contract
   - workspace/dependency setup
   - permissions/auth
   - product workflow gap
   - one-off/no action
6. Apply the smallest fix when it is local, clear, and testable.
7. Mark findings:
   - `resolved` when a fix landed or the root cause is already gone
   - `ignored` when it is a one-off or expected noise
   - `needs_human` when credentials, policy, product judgment, or destructive
     action is required

## API Notes

Patch status with:

```text
PATCH /api/orgs/:orgId/run-diagnostics/:findingId
{
  "status": "resolved",
  "resolutionNote": "Short explanation of the fix or decision."
}
```

Use `resolved` only after the fix or decision is real. Do not mark findings
resolved just because they were read.

## Guardrails

- Do not convert every finding into a new issue.
- Do not rewrite broad skills or docs for a single weak finding.
- Do not fetch full transcripts unless the stored excerpt is not enough.
- Do not change credentials, secrets, or permissions silently.
- Keep fixes scoped to the root cause and validate them before marking
  findings resolved.

## Completion Standard

The maintenance pass is done when every targeted open finding group has one of:

- a landed fix with validation evidence and `resolved` status
- a clear no-action reason and `ignored` status
- a human blocker and `needs_human` status
