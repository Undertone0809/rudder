# Recent Thread Signals

This reference captures durable patterns found in recent Rudder threads. Treat
them as starting hypotheses; re-check the current code and runtime before acting.

## Dashboard And Global Performance Scan

Threads:

- `查找前端缓存方案`
- `定位性能优化点`

Signals:

- Dashboard-like entry pages can fan out into many independent queries. First
  check whether those requests are all needed for first paint, whether the same
  data is fetched by multiple cards, and whether a bootstrap/summary contract
  would reduce repeated work.
- Issue and activity list clients may support `limit`, but call sites can still
  omit it. Search both API clients and page hooks; do not stop at route support.
- Context sidebars can become hidden global costs by loading issues, chats,
  agents, projects, and derived heatmap data on routes where the main surface
  does not need them.
- Code splitting and lazy route loading are performance levers when `App.tsx`
  statically imports many heavy pages.

Useful first searches:

```bash
rg "useQuery|queryKey|staleTime|placeholderData|keepPreviousData" ui/src
rg "status=all|limit\\?|limit:" ui/src server/src
rg "activityApi.list|issuesApi.list|chatsApi.list" ui/src
```

## Daily Performance Health Check

Thread:

- `Rudder daily performance check`

Signals:

- Prod-local and dev can have very different performance profiles. Measure both
  when both exist, and report which one produced evidence.
- Messenger-style pages can regress through unbounded chat lists even when
  thread pagination is healthy.
- Payload size matters: a bounded `limit=50` response can still be slow if the
  service hydrates too much per row.
- Command palette/search should be checked separately from default list loading;
  a palette may use remote limited search while the page still loads all data.
- Logs, trace warnings, and runtime RSS/CPU spikes are performance signals even
  when endpoint timings look acceptable.

## Runtime Context And Memory Loading

Threads:

- `优化 heartbeat 先读 memory`
- `设计启动记忆加载方案`

Signals:

- Agent startup context is a runtime contract, not just prompt text. Define
  source-of-truth, ordering, budget, omissions, and metrics.
- Memory and recent chat context must be bounded and source-linked. Default
  context should be a compact startup index unless the user explicitly asks for
  full transcripts.
- Keep the agent-visible prompt and persisted observability snapshot separate.
  It can be correct for the adapter prompt to include sensitive context while
  traces/snapshots store only metrics and source refs.
- Reviewer findings often catch architecture-performance issues that normal
  tests miss, especially privacy boundaries and context fan-out.

## Messenger Grouping And Transactionality

Thread:

- `修复 item 拖拽合并`

Signals:

- When a frontend workflow requires "create entity, then assign multiple items",
  chained mutations can leave half-complete state under refresh, race, or stale
  server conditions.
- If the product action is atomic to the user, consider a narrow server endpoint
  that performs the full operation inside one transaction.
- Add service tests for rollback, route tests for validation, UI tests for the
  action dispatch, and E2E for the visible workflow when environment permits.
- Existing-server browser tests are not enough for new backend routes unless the
  backend process was restarted or proven to have loaded the new route.

## Thread Mining Rules

- Use recent threads to find repeated symptoms and prior blockers, not to avoid
  reading current code.
- Preserve useful thread names and signal categories in the handoff when they
  justify a recommendation.
- Do not encode transient local timings, private file paths, screenshots, or
  one-off branch state as general rules.
- If a thread revealed a durable failure mode, add it to this file or the main
  checklist during the optimization handoff.
