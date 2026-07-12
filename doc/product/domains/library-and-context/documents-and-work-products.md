---
title: Documents And Work Products
domain: library-and-context
status: active
coverage: detailed
contract_ids:
  - DOCUMENT.WORKPRODUCT.001
related_code:
  - packages/db/src/schema/documents.ts
  - packages/db/src/schema/document_revisions.ts
  - packages/db/src/schema/issue_documents.ts
  - packages/db/src/schema/issue_work_products.ts
  - server/src/services/documents.ts
  - server/src/services/work-products.ts
related_tests:
  - server/src/__tests__/work-products.test.ts
  - tests/e2e/issue-detail-documents-ux.spec.ts
edit_policy: user_confirmed_only
---

# Documents And Work Products

## DOCUMENT.WORKPRODUCT.001

Why:

- Agent work often produces text artifacts, reports, notes, screenshots,
  previews, files, or PR links. Those outputs must be inspectable as work
  products instead of disappearing into raw transcripts.
- Long-form editable text should move toward Library/project documents, while
  legacy issue-bound documents remain readable for historical rows.

Product model:

- `documents` store editable markdown documents with latest body and revision
  pointers.
- `document_revisions` are append-only history.
- `issue_documents` exists for historical issue-bound documents; new durable
  agent-authored docs should be represented as Library/project artifacts and
  cited from issues/comments where practical.
- `issue_work_products` links issue work to output artifacts with type, URL or
  file identity, title, metadata, and producer context.
- Chat-native Outputs with structured production evidence are also indexed by
  `CHAT.THREAD.MANIFEST.001`; they do not need a synthetic Issue merely to remain
  inspectable from the producing conversation.

Flow:

1. Actor creates or edits a document/work product from an issue, Library, or
   output-producing run.
2. Document edits create a revision and update latest body metadata.
3. Work product records attach output evidence to the issue/run context.
4. Issue Detail, Library, Chat Work manifest, or output surfaces expose the
   artifact for review.
5. Future learning or reuse cites the artifact through Library/reference
   contracts rather than relying on raw run logs.

Invariants:

- A work product must stay connected to the organization and the work that
  produced it.
- Chat-native Output indexing must preserve conversation and Run/Agent
  provenance and must not classify an arbitrary assistant link as produced work.
- Document revision history must not be lost when latest body changes.
- Legacy issue documents remain readable; new durable documents should converge
  toward Library-backed artifacts.

Evidence:

- Issue document UX E2E covers visible document behavior.
- Work product service tests cover persisted output links.
- Chat Work Manifest service/E2E covers Chat-native output classification and
  inspection.
