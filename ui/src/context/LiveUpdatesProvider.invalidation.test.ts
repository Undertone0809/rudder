// @vitest-environment node

import type { LiveEvent } from "@rudderhq/shared";
import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";

function observeDeferredQueries(keys: QueryKey[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const queries = keys.map((queryKey) => {
    const requests: Array<(value: unknown[]) => void> = [];
    client.setQueryData(queryKey, []);
    const observer = new QueryObserver(client, {
      queryKey,
      // Deliberately non-abortable, like API calls that do not consume signal.
      queryFn: () => new Promise<unknown[]>((resolve) => requests.push(resolve)),
    });
    const unsubscribe = observer.subscribe(() => {});
    return { queryKey, requests, unsubscribe };
  });
  return {
    client,
    queries,
    counts: () => queries.map(({ requests }) => requests.length),
    dispose: () => {
      queries.forEach(({ requests, unsubscribe }) => {
        requests.forEach((resolve) => resolve([]));
        unsubscribe();
      });
      client.clear();
    },
  };
}

function deliver(client: QueryClient, type: LiveEvent["type"], payload: Record<string, unknown>, orgId = "org-1") {
  __liveUpdatesTestUtils.handleLiveEvent(
    client,
    "org-1",
    "/ORG/messenger",
    { type, orgId, payload } as LiveEvent,
    () => null,
    { cooldownHits: new Map(), suppressUntil: 0 },
    { userId: "user-1", agentId: null },
    { issueNotifications: false, chatNotifications: false },
  );
}

function issueListKeys(orgId: string) {
  return [
    queryKeys.issues.list(orgId),
    queryKeys.issues.listTouchedByMe(orgId),
    queryKeys.issues.listUnreadTouchedByMe(orgId),
    queryKeys.issues.listPreview(orgId, 10),
    queryKeys.messenger.threads(orgId),
    queryKeys.messenger.threadPages(orgId, false),
    queryKeys.messenger.threadPages(orgId, true),
    queryKeys.messenger.threadPreview(orgId),
    queryKeys.messenger.issues(orgId),
    queryKeys.chats.workManifests(orgId),
    queryKeys.sidebarBadges(orgId),
  ];
}

describe("live invalidation with active QueryObservers", () => {
  it("invalidates heartbeat descendants once per event and preserves a later authoritative terminal read", async () => {
    const keys = [
      queryKeys.agentRuns("org-1"),
      queryKeys.agentRuns("org-1", "agent-1"),
      queryKeys.agentRunsOverview("org-1"),
      queryKeys.sidebarBadges("org-1"),
      queryKeys.runDetail("run-1"),
      queryKeys.runEvents("run-1"),
    ];
    const fixture = observeDeferredQueries(keys);
    try {
      const payload = { runId: "run-1", agentId: "agent-1" };
      deliver(fixture.client, "heartbeat.run.status", { ...payload, status: "running" });
      expect(fixture.counts()).toEqual(keys.map(() => 1));
      deliver(fixture.client, "heartbeat.run.status", { ...payload, status: "succeeded" });
      expect(fixture.counts()).toEqual(keys.map(() => 2));
      fixture.queries.forEach(({ requests }) => requests[1](["succeeded"]));
      await vi.waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      fixture.queries.forEach(({ requests }) => requests[0](["running"]));
      await Promise.resolve();
      keys.forEach((key) => expect(fixture.client.getQueryData(key)).toEqual(["succeeded"]));
    } finally {
      fixture.dispose();
    }
  });

  it.each(["activity.logged", "issue.content_updated"] as const)("%s starts one request per issue/list descendant and leaves other organizations untouched", async (eventType) => {
    const ownKeys = issueListKeys("org-1");
    const otherKeys = issueListKeys("org-2");
    const fixture = observeDeferredQueries([...ownKeys, ...otherKeys]);
    try {
      const payload = { entityType: "issue", entityId: "issue-1", action: "issue.updated" };
      deliver(fixture.client, eventType, payload, "org-2");
      expect(fixture.counts()).toEqual([...ownKeys, ...otherKeys].map(() => 0));
      deliver(fixture.client, eventType, payload);
      expect(fixture.counts()).toEqual([...ownKeys.map(() => 1), ...otherKeys.map(() => 0)]);
      // Keep original cancellation semantics across distinct authoritative events.
      for (let index = 0; index < 9; index += 1) {
        deliver(fixture.client, eventType, payload);
      }
      expect(fixture.counts()).toEqual([...ownKeys.map(() => 10), ...otherKeys.map(() => 0)]);
      fixture.queries.forEach(({ requests }) => requests.at(-1)?.(["latest"]));
      await vi.waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      fixture.queries.forEach(({ requests }) => requests.slice(0, -1).forEach((resolve) => resolve(["stale"])));
      await Promise.resolve();
      ownKeys.forEach((key) => expect(fixture.client.getQueryData(key)).toEqual(["latest"]));
    } finally {
      fixture.dispose();
    }
  });
});
