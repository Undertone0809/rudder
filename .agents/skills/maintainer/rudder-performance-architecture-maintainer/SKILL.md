---
name: rudder-performance-architecture-maintainer
description: >
  Use when Rudder needs architecture or system performance optimization:
  slow pages, repeated skeleton loading, query cache misses, refetch storms,
  over-fetching, expensive API/service/DB paths, hot files, module-boundary
  erosion, or requests to record optimization know-how. Do not use for pure
  visual polish, release operations, missing-data diagnosis, or Desktop startup
  recovery.
---

# Rudder Performance Architecture Maintainer

Use this skill when the user wants Rudder to become faster, more stable, or
cleaner at the architecture boundary. The default result should be evidence-led
optimization that preserves product contracts, not speculative tuning.

This skill covers two related classes of work:

- performance fixes: cache behavior, network waterfalls, repeated skeletons,
  slow queries, refetch loops, expensive renders, build/test slowness
- architecture fixes: unstable boundaries, oversized modules, duplicated data
  paths, unclear ownership, abstractions that make performance hard to reason
  about

Read `references/optimization-checklist.md` before doing non-trivial work with
this skill. When the user asks for broad optimization or know-how capture, also
read `references/recent-thread-signals.md`.

## Use When

Use this skill for requests like:

- "为什么 dashboard 每次都骨架屏"
- "全局看看哪里可以做缓存加速"
- "这个页面/API 太慢，找一下瓶颈"
- "做一版系统性能优化"
- "这里是不是 query key / staleTime / invalidation 写错了"
- "架构上有什么热点文件或边界可以优化"
- "把这次性能优化 know how 沉淀成 skill"
- "分析一下最近的 thread 里有没有类似性能/架构任务"

## Do Not Use When

Do not use this skill when the primary task is:

- data exists but a page shows missing, stale, sparse, or wrong data; use
  `rudder-data-path-diagnostician-maintainer`
- a large refactor where the user explicitly wants plan plus execution as the
  main deliverable; use `architecture-refactor-driver-maintainer`
- pure UI polish, spacing, copy, or visual QA
- release, package, installer, or Desktop startup recovery
- a single agent transcript or runtime failure investigation

If the task overlaps, choose the skill that matches the user's visible pain. For
example, repeated skeleton loading after navigation belongs here; empty dashboard
data belongs to data-path diagnosis.

## Inputs

Capture or infer:

- affected surface, route, API, service, or subsystem
- user-visible symptom and expected improvement
- runtime and organization when live data is involved
- current cache, invalidation, polling, and freshness expectations
- constraints that must remain stable: API shape, schema, org scoping, runtime
  contracts, UI behavior
- acceptable validation depth for the blast radius

## Evidence Ledger

Before proposing a fix, build a small evidence ledger. Keep it in your working
notes unless it is useful to show the user.

```markdown
| Observation | Evidence | Implication |
|---|---|---|
| Page remounts show skeleton | query key includes moving `to` timestamp | cache miss, not missing cache library |
| API is called by multiple cards | network trace or code search | candidate for shared query/prefetch |
| Service loads broad rows then filters | route/service/SQL inspection | push filter down or add index/test |
```

Evidence can come from code search, tests, API calls, browser/network traces,
React Query Devtools-style reasoning, logs, SQL `EXPLAIN`, benchmarks, or
profiling. Do not tune from screenshots alone.

## Workflow

### 1. Load Local Context

Read the minimum Rudder context needed for the surface:

- `AGENTS.md`
- `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md` when the work
  changes behavior or architecture
- relevant UI page/hooks/API clients, server routes/services, shared contracts,
  DB schema, and nearby tests

Use `rg` first for call sites, query keys, endpoints, invalidation keys, and
hot modules.

### 2. Mine Recent Threads When The Task Is Broad

When the user asks for global optimization, reusable know-how, or "recent
thread" analysis, inspect recent Codex threads before editing code. Look for:

- prior performance scans and daily health checks
- repeated slow surfaces, large payloads, or unbounded list symptoms
- architecture decisions that moved work across UI/API/service boundaries
- reviewer-discovered blockers, especially privacy, transactionality, and
  org-scoping issues
- validation gaps caused by dev-server restarts, embedded Postgres bootstrap, or
  dirty shared worktrees

Use the thread evidence as hypotheses, not truth. Re-check the current code and
runtime before implementing. Store durable patterns in
`references/recent-thread-signals.md` or `references/optimization-checklist.md`.

### 3. Classify The Optimization

Pick the dominant class:

- `cache-key-instability`: keys include moving timestamps, object identity, or
  non-canonical filters
- `freshness-policy-gap`: stale time, refetch, polling, or invalidation does not
  match product freshness needs
- `network-waterfall`: serial requests could be shared, prefetched, batched, or
  moved server-side
- `over-fetch`: UI/API requests more data than the surface needs
- `server-hot-path`: service aggregation, DB query, filesystem scan, or external
  process work is too expensive
- `render-hot-path`: React render, memoization, virtualization, or derived state
  work is too expensive
- `boundary-erosion`: architecture makes data ownership, caching, or performance
  contracts unclear
- `validation-slowness`: build/test/dev loop is slow because of avoidable setup,
  scope, or fixture cost
- `frontend-race`: a UI workflow depends on multiple ordered requests where the
  server should own atomicity

Name the first broken boundary. Downstream symptoms matter, but the first broken
boundary is where fixes usually belong.

### 4. Trace The Path End To End

For UI performance, trace:

```text
surface -> hook/query key -> API client -> route -> service -> DB/runtime source
```

For server/runtime performance, trace:

```text
entrypoint -> facade/service -> query/process/filesystem -> response contract
```

Record:

- query key and parameter canonicalization
- `staleTime`, `gcTime`, placeholder data, polling, focus/reconnect behavior
- invalidation and mutation side effects
- endpoint path, request validators, and org scoping
- response shape and client-side filtering/aggregation
- expensive loops, broad scans, N+1 calls, and repeated derived computation

### 5. Choose The Smallest Correct Fix

Prefer behavior-preserving changes that make the real contract explicit:

- stabilize query keys before increasing `staleTime`
- canonicalize date ranges, filters, and sort options at the boundary
- use `placeholderData`, prefetch, or shared queries only when stale display is
  acceptable and errors remain visible
- push filters to API/DB when the server owns the data contract
- batch or share requests when multiple components need the same data
- move multi-step UI writes into a narrow transactional API when partial success
  creates broken product state
- introduce a facade when multiple consumers duplicate data-path or caching
  semantics
- add indexes only with evidence and a migration path
- split hot files by responsibility when that reduces real coupling or clarifies
  performance ownership

Avoid adding cache as a blanket cover for slow or incorrect code. Cache should
encode a freshness contract, not hide broken invalidation.

### 6. Add Regression Coverage

Match tests to the failure mode:

- cache-key stability: unit-test canonical range/filter helpers
- React Query behavior: component or hook tests for stable keys,
  `placeholderData`, and invalidation behavior
- API/service hot path: route/service tests for filtering, org scoping, and
  response shape
- DB query changes: integration tests around date/status/org boundaries
- user-visible workflow: E2E test when the repo rules require it
- multi-step writes: service/route tests for rollback and UI tests for the
  single product action

Include at least one edge case when the optimization depends on dates, org
boundaries, permissions, async runtime state, or large data volume.

### 7. Validate And Commit

Run the narrow validation first, then the repo-appropriate baseline:

```bash
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
```

For visible UI changes, verify in a browser or desktop shell and include final
screenshots when useful. If a baseline command fails for unrelated reasons,
report the failing suite and keep the optimization commit scoped.

Per repo rules, commit and push completed skill, performance, or architecture
work. Stage only files for the current task when the worktree has unrelated
changes.

### 8. Record Know How

When a performance or architecture investigation produces a durable rule, add it
to `references/optimization-checklist.md` or a more specific future reference.
Do not record one-off local paths, private data, or transient timings as general
rules.

## Decision Rules

- Measure or trace first; optimize second.
- Treat repeated skeletons as a cache-key/freshness problem until proven
  otherwise.
- A changing `now`, `Date`, random id, object literal, or unsorted filter inside
  a query key is a cache miss factory.
- Do not persist org-scoped or sensitive data outside the intended cache
  boundary.
- Keep API, DB, shared types, and UI contracts synchronized.
- Preserve organization scoping on every server-side optimization.
- Prefer one stable abstraction over duplicated ad hoc fixes across pages.
- Do not change product semantics during a performance refactor unless the user
  asked for that change and tests cover it.

## Output Shape

For diagnosis:

```markdown
Root cause: <classification and concrete broken boundary>

Evidence:
- ...

Optimization:
- ...

Validation:
- ...

Follow-up opportunities:
- ...
```

For implementation handoff:

```markdown
Changed:
- ...

Why it is faster/cleaner:
- ...

Validation:
- ...

Residual risk:
- ...
```

## Safety

- Keep diagnosis read-only unless the user asked for implementation.
- Never run destructive cleanup or unscoped SQL as part of performance work.
- Do not broaden cache lifetime for sensitive, permissioned, or org-scoped data
  without proving the key includes the correct scope.
- Do not remove loading, error, or empty states just to hide latency.
- Do not stage or revert unrelated user changes.

## Validation Cases

See `references/eval-cases.md` for trigger tests and expected behavior.
