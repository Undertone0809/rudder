---
title: Replace Project read APIs for every project
date: 2026-10-04
kind: implementation
status: in_progress
area: api
entities:
  - project
  - backend_authority
issue:
related_plans:
  - 2026-09-29-rust-project-create-service-pilot.md
supersedes: []
related_code:
  - server/src/routes/projects.ts
  - server/src/services/rust-foundation-bridge.ts
  - native/crates/d1-persistence/src/project_reads.rs
  - native/crates/server-foundation/src/project_reads.rs
commit_refs:
  - bb785f029b0036652dc9012cd45f3ac8decafea6
updated_at: 2026-10-04
---

# Scope and intent

Migrate capabilities API by API, independently of a project's age or mutation
owner. This slice replaces three public reads for every project:

- `GET /api/orgs/:orgId/projects`
- `GET /api/projects/:id`
- `GET /api/projects/:id/resources`

Node retains HTTP admission, actor authorization, reference normalization, and
minimal project-to-organization lookup. Rust queries the existing PostgreSQL
schema and returns the canonical complete response. No ownership lookup, cohort,
allowlist, authority transfer, schema migration, mutation receipt, or production
flag change is part of this slice. PATCH, DELETE, import, jobs, and internal
service reads remain separate later capabilities.

# Implementation sequence

1. Add a pure, organization-scoped SQLx projection for projects, goals,
   resource attachments, legacy workspaces, and runtime services.
2. Add an authenticated private read command. The public endpoints remain GET;
   the private POST body binds the selected project, response surface, and
   trusted workspace root to the signed actor envelope. Verify organization,
   method, path, action, body, and nonce before database access.
3. Forward the Rust response without Node hydration or a hidden fallback. The
   foundation starts regardless of unrelated mutation pilot switches. Failures
   are visible and do not silently route business reads back to Node.
4. Test legacy Node-owned and Rust-created projects together, response parity,
   reference resolution, authorization, error behavior, and read-only effects.

The current list contract has no filters, pagination, or guaranteed project/goal
ordering; this cutover does not introduce them. Preserve explicit workspace,
resource, and runtime-service ordering. Preserve UTC timestamp/null fields,
short references, URL keys, normalized policy, and legacy codebase paths.

Read-only JSON decoding also preserves JavaScript number semantics for legacy
PostgreSQL JSONB: out-of-range values become null, finite values round once to
IEEE-754, and negative zero becomes zero. Strings and persisted values are not
rewritten. A shared numeric-index decoder avoids a second floating-point parse
and guards structural depth at 512 containers before recursive decoding. Deeper
structured Project payloads fail explicitly instead of risking stack exhaustion;
this safety limit remains a known boundary, not a claim of unbounded JSON parity.

The old read hydrator creates Library folders. Public GETs now only derive the
same paths and never provision folders. Existing creation/import/startup
provisioning remains unchanged. Missing legacy folders are not silently created
by listing or opening a project.

# Acceptance packet v1

- Same organization includes both a Node-owned historical project and a project
  created through the real Rust create path; all three public reads use Rust.
- Full response matches the legacy projection for goals, resource attachments,
  workspace/runtime data, null values, Unicode names, and UTC timestamps.
- Raw PostgreSQL JSONB number cases cover overflow, large integer rounding,
  underflow, precision-sensitive finite values, nested values, and numeric text
  across Project policy, resource/workspace metadata, and runtime stop policy.
- UUID, organization-scoped shortname, short reference, ambiguity, missing
  project, empty organization, agent access, and cross-organization denial retain
  their public behavior.
- The signed private endpoint rejects changed organization/target/body/action,
  unauthenticated requests, and replayed envelopes.
- Foundation failure produces explicit failure with no Node business-read
  fallback. Read success does not depend on mutation owner or pilot modes.
- Reads do not change ownership/fence state, create mutation receipts, or create
  directories. Legacy writer paths are unchanged.

# Gates and development environment

Implement in the isolated cloud worktree. Run available focused tests and static
checks there; blocked dependency fetches are not retried through alternate
routes. Stage review precedes a frozen candidate. The user's Mac and canonical
GitHub CI provide full dependency, real PostgreSQL/public API, and native-runtime
checks. A distinct Mac verifier must return PASS for the same frozen candidate
before final independent review and authorized branch publication. No automatic
main merge or deployment is authorized by this packet. C07 creation acceptance
is outside this read-only scope and is not rerun.
