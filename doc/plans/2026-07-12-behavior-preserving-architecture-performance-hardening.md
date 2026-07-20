---
title: Behavior-preserving architecture and performance hardening
date: 2026-07-12
kind: implementation
status: completed
area: api
entities:
  - rudder_workflows_performance
  - messenger_chat
  - module_boundaries
  - architecture_fitness
issue:
related_plans:
  - 2026-05-19-source-file-size-boundary-refactor.md
  - 2026-05-25-performance-workflow-optimization.md
  - 2026-06-18-architecture-fitness-and-hotspot-extraction.md
  - 2026-06-24-messenger-render-performance.md
supersedes: []
related_code:
  - server/src/routes/chats.ts
  - server/src/services/chats.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/chat-assistant.runtime-batch.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/__tests__/chat-assistant-runtime-batch.test.ts
  - server/src/__tests__/chat-assistant.test.ts
  - server/src/__tests__/chat-routes.test.ts
  - scripts/perf/workflow-baseline.ts
commit_refs:
  - "perf: deduplicate chat runtime enrichment"
updated_at: 2026-07-12
---

# Behavior-Preserving Architecture And Performance Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `subagent-driven-development` and `test-driven-development` to implement this
> plan task by task. Keep the verifier and final reviewer separate from the
> implementation author.

**Goal:** Establish the first measurable Rudder vertical-slice boundary by
removing duplicate Chat runtime resolution work while preserving every existing
product, API, persistence, runtime, and UI behavior.

**Architecture:** Keep Rudder as a modular monolith. Introduce narrow,
domain-named internal helpers behind the existing service facade, keep routes
and consumers on their current contracts, and use request-local batching rather
than cross-request caching. This first delivery slice proves the migration
method on the current Chat list hot path before later subsystems receive their
own implementation plans.

**Tech Stack:** TypeScript, Express, Drizzle/PostgreSQL, Vitest, pnpm.

---

## Summary

Rudder's current Chat list route loads conversations and then calls
`chatAssistantService.enrichConversations`. The enrichment implementation calls
`resolveConversationRuntime` once per conversation. Conversations that share
the same organization and preferred agent therefore repeat the same agent,
monthly-spend, runtime-config, secret, instance-setting, and skill-catalog work.

The first slice will deduplicate that resolution inside one service call. It
will resolve each unique `(orgId, preferredAgentId)` identity once, share the
in-flight promise among matching conversations, and preserve input order and
the exact `ChatConversation` response shape.

This is deliberately not a pagination or product-semantics change. Existing
full-list behavior stays compatible even when it is expensive. Bounded summary
APIs, route-lazy UI loading, realtime ownership, transactional outbox, migration
hardening, and runtime lifecycle ownership require separate implementation
plans because they touch independent failure and verification surfaces.

## Non-Negotiable Compatibility Guarantees

The user explicitly requires no changes to existing features or business
logic. This plan therefore guarantees:

- no `doc/product/**` edits;
- no HTTP route, query parameter, status code, response field, response order,
  or default-list-size changes;
- no database schema or migration changes;
- no runtime adapter, prompt, permission, skill-selection, secret-resolution,
  or agent-availability rule changes;
- no UI, React Query, realtime, polling, or loading-state changes;
- no cross-request cache and no extension of runtime-descriptor freshness;
- no new fallback behavior when runtime resolution fails;
- no mutation of input conversation objects;
- no removal or renaming of legacy `paperclip*` compatibility values.

The owning Product Logic Registry contracts remain unchanged:

- `CHAT.LIFECYCLE.001`;
- `RUN.CHAT.AGENT.001`;
- `MESSENGER.ATTENTION.001`.

The implementation must preserve those contracts and run
`pnpm product-logic:check`, but this plan does not authorize edits to the
guarded registry.

## Current Evidence

- `server/src/routes/chats.ts` passes the complete list result to
  `assistantSvc.enrichConversations`.
- `server/src/services/chat-assistant.ts` currently implements enrichment as
  `Promise.all(conversations.map(enrichConversation))`.
- `resolveConversationRuntime` depends only on `orgId`, `preferredAgentId`, and
  the optional materialization flag. List enrichment does not enable managed
  instruction materialization.
- A production-shaped read-only sample showed near-linear list cost as the
  requested Chat count increased. The deterministic implementation defect is
  duplicate runtime resolution; wall-clock samples remain environment evidence,
  not a test assertion.
- The existing Messenger cursor path demonstrates that bounded navigation can
  remain healthy, but changing Chat list semantics is outside this plan.

## Target Internal Boundary

The route and public service interface stay unchanged:

```text
GET /api/orgs/:orgId/chats
  -> chatService.list(...)
  -> chatAssistantService.enrichConversations(...)
  -> unchanged ChatConversation[] response
```

Only the private enrichment step changes:

```text
conversations
  -> build request-local key: JSON.stringify([orgId, preferredAgentId])
  -> create one in-flight resolver promise per unique key
  -> attach the resolved descriptor to every matching conversation
  -> preserve original array order
```

The helper belongs beside `chat-assistant.ts`, not in a generic utility module,
because its identity and error semantics are Chat-domain rules.

## Scope

In scope:

- extract a focused Chat runtime-enrichment batch helper;
- add unit coverage for identity isolation, stable ordering, output immutability,
  in-flight deduplication, and rejection propagation;
- wire `chatAssistantService.enrichConversations` through the helper;
- add service-level coverage proving that conversations sharing one preferred
  agent execute runtime preparation once;
- preserve the existing route contract and route tests;
- record resolver-call-count improvement as the deterministic performance
  assertion;
- run focused and repository validation, then spawned verifier and reviewer
  gates.

Out of scope:

- default limits, cursor pagination, summary/detail/evidence response splits;
- Run Intelligence payload projection;
- React Query key or route-lazy frontend work;
- WebSocket or log-polling consolidation;
- Activity authorization or HTTP log-redaction fixes;
- `RuntimeSupervisor`, DB-pool ownership, scheduler drain, or process cleanup;
- audit/outbox transaction changes;
- migration history repair, advisory locks, composite foreign keys, or status
  constraints;
- broad source-file splitting or architecture-baseline resets.

## Implementation Plan

### Task 1: Add The Request-Local Chat Runtime Batch Helper

**Files:**

- Create: `server/src/services/chat-assistant.runtime-batch.ts`
- Create: `server/src/__tests__/chat-assistant-runtime-batch.test.ts`

- [x] **Step 1: Write the failing deduplication and compatibility tests**

Create focused tests with a mock descriptor resolver. The tests must assert:

```ts
const conversations = Array.from({ length: 500 }, (_, index) =>
  makeConversation({ id: `chat-${index}`, orgId: "org-1", preferredAgentId: "agent-1" }),
);

const result = await enrichConversationRuntimeDescriptors(conversations, resolveDescriptor);

expect(resolveDescriptor).toHaveBeenCalledTimes(1);
expect(result).toHaveLength(500);
expect(result.map((row) => row.id)).toEqual(conversations.map((row) => row.id));
expect(conversations.every((row) => row.chatRuntime === originalDescriptor)).toBe(true);
```

Add separate cases proving:

```ts
// The same agent id in two organizations is resolved twice.
expect(resolveDescriptor).toHaveBeenCalledTimes(2);

// Rejected resolution still rejects the complete enrichment call.
await expect(enrichConversationRuntimeDescriptors(rows, rejectResolver))
  .rejects.toThrow("runtime unavailable");
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run server/src/__tests__/chat-assistant-runtime-batch.test.ts
```

Expected: FAIL because `chat-assistant.runtime-batch.ts` does not exist.

- [x] **Step 3: Implement the minimal domain helper**

Implement this interface without importing Express, Drizzle, filesystem, or
runtime services:

```ts
export async function enrichConversationRuntimeDescriptors<T extends ChatConversation>(
  conversations: readonly T[],
  resolveDescriptor: (
    conversation: Pick<ChatConversation, "orgId" | "preferredAgentId">,
  ) => Promise<ChatRuntimeDescriptor>,
): Promise<T[]>;
```

Use a request-local `Map<string, Promise<ChatRuntimeDescriptor>>`. Insert the
promise before awaiting it so concurrent rows share the same in-flight work.
Use `JSON.stringify([conversation.orgId, conversation.preferredAgentId])` as the
key so organization scope cannot collide. Return new conversation objects with
only `chatRuntime` replaced.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same Vitest command. Expected: all new tests PASS.

### Task 2: Rewire The Existing Chat Assistant Facade

**Files:**

- Modify: `server/src/services/chat-assistant.ts`
- Modify: `server/src/__tests__/chat-assistant.test.ts`

- [x] **Step 1: Write a failing service integration test**

Add a test that creates multiple `ChatConversation` rows with the same
`orgId/preferredAgentId`, configures the existing `mockAgentService` and
`mockRunContextService`, calls `svc.enrichConversations`, and asserts:

```ts
expect(mockAgentService.getInternalById).toHaveBeenCalledTimes(1);
expect(mockRunContextService.prepareRuntimeConfig).toHaveBeenCalledTimes(1);
expect(result.map((row) => row.id)).toEqual(input.map((row) => row.id));
expect(result.every((row) => row.chatRuntime.sourceLabel === "Chat Specialist")).toBe(true);
```

Also include two organizations sharing the same agent id and assert two
resolutions. This is the organization-isolation edge case required by repo
policy.

- [x] **Step 2: Run the integration test and verify RED**

Run:

```bash
pnpm exec vitest run server/src/__tests__/chat-assistant.test.ts -t "deduplicates list runtime enrichment"
```

Expected: FAIL because the current facade resolves once per conversation.

- [x] **Step 3: Wire the facade to the helper**

Keep `enrichConversation` unchanged for single-conversation callers. Replace
only `enrichConversations` with:

```ts
return enrichConversationRuntimeDescriptors(
  conversations,
  async (conversation) => (await resolveConversationRuntime(conversation)).descriptor,
);
```

Do not export internal resolver functions and do not change the returned service
object.

- [x] **Step 4: Run focused service and route tests**

Run:

```bash
pnpm exec vitest run \
  server/src/__tests__/chat-assistant-runtime-batch.test.ts \
  server/src/__tests__/chat-assistant.test.ts \
  server/src/__tests__/chat-routes.test.ts \
  --maxWorkers=1
```

Expected: PASS with the existing Chat route count, order, and response behavior
unchanged.

### Task 3: Record Compatibility And Performance Evidence

**Files:**

- Modify: `doc/plans/2026-07-12-behavior-preserving-architecture-performance-hardening.md`

- [x] **Step 1: Record deterministic before/after work counts**

Record the focused 500-conversation test result:

```text
before: 500 runtime resolver calls for 500 conversations sharing one agent
after: 1 runtime resolver call for the same input
response items, order, and descriptor values: unchanged
```

Do not add a wall-clock unit-test threshold. Runtime duration belongs in an
external benchmark because local process, database, and filesystem conditions
vary.

- [x] **Step 2: Verify no forbidden contract files changed**

Run:

```bash
git diff --name-only -- doc/product packages/db/src/schema packages/db/src/migrations ui/src
```

Expected: no output.

- [x] **Step 3: Run product and architecture guards**

Run:

```bash
pnpm product-logic:check
pnpm architecture:audit
```

Expected: product logic passes. Architecture audit remains advisory and the
new helper stays below the repository hotspot threshold. Do not raise the
architecture baseline to hide existing debt.

### Task 4: Writer Validation, Verifier, Review, And Git Handoff

**Files:**

- Modify: `doc/plans/2026-07-12-behavior-preserving-architecture-performance-hardening.md`

- [x] **Step 1: Run writer validation**

Run:

```bash
pnpm lint
pnpm -r typecheck
pnpm test:run --maxWorkers=1
pnpm build
```

Expected: changed-area tests, typecheck, lint, and build pass. The clean starting
snapshot has two unrelated persistent failures in
`ui/src/pages/Chat.attachment-preview.test.tsx`; do not edit or include those
Browser/Side Panel files in this change. A Messenger service database cold-start
timeout occurred once during the baseline but passed all 65 tests on isolated
rerun.

- [x] **Step 2: Spawn the black-box verifier**

The verifier must not edit files. It must inspect the changed diff and run the
focused Chat tests, confirm the forbidden-path diff is empty, and independently
verify that resolver calls scale with unique `(orgId, preferredAgentId)` pairs
rather than conversation count. Because no visible workflow changes, browser
screenshots are not required; the terminal surface is the unchanged Chat list
HTTP/service contract.

- [x] **Step 3: Run final spawned reviewer gates**

Use three lenses because Chat/runtime/product behavior is consequential:

- functional trust: compatibility, org isolation, tests, and claimed work-count
  improvement;
- adversarial: key correctness, rejected promise behavior, hidden resolver side
  effects, and freshness changes;
- heuristic/product-systems: whether the helper creates a durable boundary
  without generic abstraction or premature scope expansion.

Resolve every `conditional accept`, `needs more evidence`, or `reject` finding
before handoff.

- [x] **Step 4: Update plan evidence, commit, and push**

Update `commit_refs` with the final Conventional Commit subject and add a short
implementation-results section containing commands and verdicts. Stage only:

```text
doc/plans/2026-07-12-behavior-preserving-architecture-performance-hardening.md
server/src/services/chat-assistant.runtime-batch.ts
server/src/services/chat-assistant.ts
server/src/__tests__/chat-assistant-runtime-batch.test.ts
server/src/__tests__/chat-assistant.test.ts
```

Commit with:

```bash
git commit -m "perf: deduplicate chat runtime enrichment"
```

Push `codex/architecture-performance-hardening` only after verifier and reviewer
gates pass.

## Implementation Evidence

Writer-stage evidence:

- TDD RED: the helper suite failed because
  `chat-assistant.runtime-batch.js` did not exist; the facade test then failed
  with two `getInternalById` calls where one was required.
- Deterministic work count: 500 conversations sharing one
  `(orgId, preferredAgentId)` changed from 500 runtime resolver calls to 1.
  Response item count, input order, complete descriptor values, and input
  object immutability remain covered by tests.
- Focused compatibility suite: 3 files and 148 tests passed, including the
  existing Chat route suite.
- `pnpm lint`: passed for 1,895 files.
- `pnpm -r typecheck`: passed for all workspace projects.
- `pnpm build`: passed. Existing CSS pseudo-element and bundle-size warnings
  remain unchanged.
- `pnpm product-logic:check`: all 67 contracts valid.
- `pnpm architecture:audit`: advisory audit passed; the new helper is below the
  hotspot threshold and no architecture baseline was changed.
- Forbidden-path diff for `doc/product`, database schema/migrations, and `ui`
  is empty.
- Full `pnpm test:run --maxWorkers=1`: 493 files passed and 2 files failed;
  3,933 tests passed and 2 were skipped. The two persistent failures are the
  pre-existing Side Panel/Library cases in
  `ui/src/pages/Chat.attachment-preview.test.tsx`. One unrelated
  `board-mutation-guard` assertion also failed during the full run and passed
  all 7 tests on immediate isolated rerun.
- Task-level spec reviewer: passed after replacing a tautological descriptor
  assertion with a complete-value assertion.
- Task-level code-quality reviewer: ready to merge with no critical, important,
  or minor findings.
- Independent verifier: `PASS`. It independently checked the helper and service
  suites, exact Chat list route, second-call freshness, protected-path diff,
  Product Logic Registry guard, and unchanged route/API and single-conversation
  paths. One unchanged Feishu route guard flaked in an aggregate run and passed
  8/8 on fresh-process isolation.
- Final functional-trust reviewer: `accept`; independent focused run passed
  148/148 and no contract, organization-scope, evidence, or git-scope blocker
  remained.
- Final adversarial reviewer: `accept`; no key-collision, cache-lifetime,
  rejection, resolver-side-effect, freshness, or shared-descriptor blocker was
  found.
- Final heuristic/product-systems reviewer: `accept`; the 24-line Chat-domain
  helper was judged a durable, testable boundary rather than premature generic
  infrastructure, and the broader architecture claims remain explicitly
  deferred.

## Follow-On Architecture Slices

These are the approved architectural direction, but each must receive a
separate implementation plan and compatibility proof before code changes:

1. `RuntimeSupervisor`: explicit ownership and LIFO cleanup for DB pool, HTTP,
   WebSocket, schedulers, plugins, local PostgreSQL, and child processes while
   preserving startup and shutdown contracts.
2. Run Intelligence read model: additive lightweight summary path while the
   existing API remains available unchanged; UI migration only after response
   equivalence and E2E proof.
3. Chat/message/transcript paging: additive cursor APIs first; no change to
   existing full-list defaults until every internal and plugin consumer is
   migrated and product semantics are explicitly approved.
4. Frontend data ownership: feature-scoped query options, one schema per query
   key, route-lazy imports, and one realtime connection per organization while
   preserving rendered states and freshness rules.
5. Transactional activity/outbox: command-level atomicity for business state,
   activity, and event publication, with schema work and failure injection in a
   dedicated plan.
6. Architecture fitness: CI boundary rules and debt-ledger ratchets applied to
   new or touched code without resetting current oversized-file baselines.

## Success Criteria

- The existing Chat list route, response shape, item count, item order, error
  behavior, and runtime descriptors remain unchanged.
- Runtime resolution count is bounded by unique organization/agent identities
  within one enrichment call, not conversation count.
- No state survives across HTTP requests or service calls.
- A failed unique resolution still rejects the complete enrichment operation.
- Same agent ids in different organizations never share work.
- Focused tests, typecheck, lint, build, product-logic check, verifier, and final
  reviewers satisfy the evidence gate.
- No unrelated dirty files or original-checkout Browser work enters the commit.

## Rollback

Rollback is one scoped commit. Reverting the helper integration restores the
previous per-conversation resolution behavior without database, API, UI, or
migration cleanup. The helper and focused tests can be removed in the same
revert because no persisted state depends on them.

## Open Issues

There are no product decisions required for this first slice. Any later change
to list limits, pagination defaults, visible history, response fields, or
Product Logic Registry text requires a separate explicit user decision and is
not implied by approval of this plan.
