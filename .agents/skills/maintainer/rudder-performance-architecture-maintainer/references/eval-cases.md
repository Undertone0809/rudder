# Eval Cases

## Should Trigger

Prompt: "我不懂为什么每次加载 dashboard 都要看骨架屏，这里没有查询缓存吗？"

Expected behavior:
- classify as `cache-key-instability` or `freshness-policy-gap`
- inspect query keys, date ranges, stale time, placeholder data, and API calls
- trace before changing `staleTime`
- propose or implement a focused fix and regression test

Must not:
- assume React Query is absent without checking
- remove the skeleton state
- globally increase cache lifetime without proving key scope and freshness

## Should Trigger

Prompt: "全局检索一下，还有哪里的缓存可以做加速？"

Expected behavior:
- search for query keys, dynamic date ranges, invalidation, polling, and repeated
  API calls
- prioritize findings by user-visible latency and correctness risk
- implement scoped fixes only where evidence is strong, otherwise report
  candidates

Must not:
- blanket-add caching to every request
- persist org-scoped data outside its organization key

## Should Trigger

Prompt: "这个 agents service 文件太大，顺便看下是不是影响性能和边界。"

Expected behavior:
- classify architecture/performance overlap
- identify stable facade and mixed responsibilities
- keep external route/API behavior stable
- split only when it clarifies ownership or reduces coupling

Must not:
- do a cosmetic file split with no clearer entrypoint
- change public contracts casually

## Edge Case

Prompt: "Costs 页面按最近 7 天加载很慢，但是日期范围每次看起来一样。"

Expected behavior:
- verify whether the query key uses a moving `to` timestamp
- check API/service aggregation and DB filters
- test boundary dates and organization scoping
- choose the first broken boundary as the fix location

Must not:
- conclude the problem is database performance before checking cache key
  stability

## Should Not Trigger

Prompt: "Calendar 为什么没有任何数据？"

Expected behavior:
- prefer `rudder-data-path-diagnostician-maintainer`

## Should Not Trigger

Prompt: "帮我把这个页面 spacing 调一下，卡片更紧凑一点。"

Expected behavior:
- treat as UI polish, not performance architecture

## Should Not Trigger

Prompt: "Desktop 打包后启动失败，帮我恢复本地开发环境。"

Expected behavior:
- use Desktop recovery or preview-maintainer workflows, not this skill
