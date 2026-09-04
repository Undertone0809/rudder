---
title: R6Z-134 evidence log read slice
date: 2026-09-04
kind: implementation
status: in_progress
issue: R6Z-134
contract_ids:
  - RUN.RESULT.001
  - ORG.IDENTITY.001
  - AGENT.CONTROL.TOOLS.001
---

# Evidence log read authority slice

## Selected surface

- API: `GET /api/run-intelligence/runs/:runId/log`.
- CLI: `rudder runs log <run-id> --offset <bytes> --limit-bytes <n>`.
- MCP: `rudder_runs_log`.
- Authority transition: Node retains authentication, short-reference resolution,
  organization authorization, response paging projection, and user redaction.
  The bounded local-file byte read moves from Node to `rudder-native evidence
  read`, with explicit fallback only under the existing native-mode policy.
  Reads above the native surface limit of 1,000,000 bytes remain Node-owned so
  existing internal 2 MB and unbounded consumers cannot lose evidence.

## Non-goals

- Run event, transcript, error, summary, or mutation routes.
- Run-log append/finalize behavior or evidence-index construction.
- Workspace backup, Library filesystem, plugin archive, or import authority.
- Any database writer, public-listener cutover, or Node authorization removal.

## Differential evidence

`native/fixtures/run-evidence-read-parity.json` is the shared API/CLI/MCP byte
page fixture. Rust core and receipt tests consume the same cases as an
integration harness that builds the real `rudder-native`, reads through the
production `getObservedRunLog` service and heartbeat bridge, serves its exact
response on the bounded HTTP route path, and compares every response with the
JSON CLI and MCP structured projections. The harness does not duplicate the
production response projection.

| Acceptance dimension | Evidence or applicability |
| --- | --- |
| Projection | CLI JSON and MCP structured content equal every native-backed HTTP fixture response. |
| Ordering | Not applicable: this surface is one immutable byte stream, not a collection. Offset order is instead proved by page reconstruction. |
| Pagination | Byte offsets, EOF, next offset, clamped offsets, and UTF-8 boundaries are fixture-covered. |
| Organization scope | Node keeps scoped run-reference resolution and authorization; existing route/E2E tests remain the authority. |
| Limits | Rust rejects zero and greater-than-1,000,000-byte reads; the API retains its 500,000-byte route cap, and larger internal readers retain Node authority. |
| Errors | Missing, non-regular/symlink, invalid UTF-8, invalid limit, malformed process envelope, and policy-governed fallback are covered. Structured native failure receipts preserve a 404 for missing evidence and stable native error codes for other failures. |
| Cancellation | The HTTP request lifecycle propagates an `AbortSignal` through the service and store to `execFile`; tests prove explicit cancellation terminates a hanging native read without fallback. The separate 30-second deadline remains covered. |
| Bytes | Shared multibyte UTF-8 cases prove byte-accurate offsets without replacement characters. |
| Process receipt | `evidence.read` emits protocol version, capability, target, binary version, operation, content, offsets, and EOF. |

Mutation dependencies are unchanged. Backup create/delete/restore still require
recovery backup, filesystem ownership, activity receipt, crash recovery, and
rollback evidence in a separately fenced issue.
