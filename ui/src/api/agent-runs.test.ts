import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_EVENTS_PAGE_LIMIT,
  AGENT_RUN_LIST_AGENT_LIMIT,
  AGENT_RUN_LIST_DEFAULT_LIMIT,
  AGENT_RUN_LIST_HISTORY_LIMIT,
  AGENT_RUN_TRANSCRIPT_TURN_LIMIT,
  agentRunsApi,
} from "./agent-runs";
import {
  HEARTBEAT_RUN_LIST_DEFAULT_LIMIT,
  heartbeatsApi,
  schedulerHeartbeatsApi,
} from "./heartbeats";

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: {
    get: clientMocks.get,
    post: clientMocks.post,
  },
}));

describe("agentRunsApi", () => {
  beforeEach(() => {
    clientMocks.get.mockReset();
    clientMocks.post.mockReset();
    clientMocks.get.mockResolvedValue([]);
  });

  it("defaults agent run lists to a bounded request", async () => {
    await agentRunsApi.list("org-1");

    expect(clientMocks.get).toHaveBeenCalledWith(
      `/orgs/org-1/agent-runs?limit=${AGENT_RUN_LIST_DEFAULT_LIMIT}`,
    );
  });

  it("preserves explicit history and agent limits", async () => {
    await agentRunsApi.list("org-1", undefined, AGENT_RUN_LIST_HISTORY_LIMIT);
    await agentRunsApi.list("org-1", "agent-1", AGENT_RUN_LIST_AGENT_LIMIT);

    expect(clientMocks.get).toHaveBeenNthCalledWith(
      1,
      `/orgs/org-1/agent-runs?limit=${AGENT_RUN_LIST_HISTORY_LIMIT}`,
    );
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      2,
      `/orgs/org-1/agent-runs?agentId=agent-1&limit=${AGENT_RUN_LIST_AGENT_LIMIT}`,
    );
  });

  it("can request agent runs by date range without a recency limit", async () => {
    await agentRunsApi.list("org-1", undefined, null, {
      startDate: "2026-06-10T00:00:00.000Z",
      endDate: "2026-06-16T12:00:00.000Z",
    });

    expect(clientMocks.get).toHaveBeenCalledWith(
      "/orgs/org-1/agent-runs?startDate=2026-06-10T00%3A00%3A00.000Z&endDate=2026-06-16T12%3A00%3A00.000Z",
    );
  });

  it("uses agent-run aliases for run detail operations", async () => {
    await agentRunsApi.get("run-1");
    await agentRunsApi.events("run-1");
    await agentRunsApi.log("run-1");
    await agentRunsApi.workspaceOperations("run-1");
    await agentRunsApi.retry("run-1");
    await agentRunsApi.cancel("run-1");

    expect(clientMocks.get).toHaveBeenNthCalledWith(1, "/agent-runs/run-1");
    expect(clientMocks.get).toHaveBeenNthCalledWith(2, "/agent-runs/run-1/events?afterSeq=0&limit=200");
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      3,
      "/agent-runs/run-1/log?offset=0&limitBytes=256000",
      { cache: "no-store" },
    );
    expect(clientMocks.get).toHaveBeenNthCalledWith(4, "/agent-runs/run-1/workspace-operations");
    expect(clientMocks.post).toHaveBeenNthCalledWith(1, "/agent-runs/run-1/retry", {});
    expect(clientMocks.post).toHaveBeenNthCalledWith(2, "/agent-runs/run-1/cancel", {});
  });

  it("loads every event page for a run detail transcript", async () => {
    const firstPage = Array.from({ length: AGENT_RUN_EVENTS_PAGE_LIMIT }, (_, index) => ({
      seq: index + 1,
    }));
    const finalPage = [{ seq: AGENT_RUN_EVENTS_PAGE_LIMIT + 1 }];
    clientMocks.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(finalPage);

    await expect(agentRunsApi.allEvents("run-1")).resolves.toHaveLength(
      AGENT_RUN_EVENTS_PAGE_LIMIT + 1,
    );
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      1,
      `/agent-runs/run-1/events?afterSeq=0&limit=${AGENT_RUN_EVENTS_PAGE_LIMIT}`,
    );
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      2,
      `/agent-runs/run-1/events?afterSeq=${AGENT_RUN_EVENTS_PAGE_LIMIT}&limit=${AGENT_RUN_EVENTS_PAGE_LIMIT}`,
    );
  });

  it("requests the unified transcript projection with an explicit cursor", async () => {
    clientMocks.get.mockResolvedValueOnce({
      entries: [],
      page: { hasMore: false, nextCursor: null, order: "oldest" },
    });

    await agentRunsApi.transcript("run/1", {
      cursor: "cursor-1",
      turnLimit: 12,
      includeOutput: false,
      maxChars: 400,
    });

    expect(clientMocks.get).toHaveBeenCalledWith(
      "/run-intelligence/runs/run%2F1/transcript?output=full&order=oldest&turnLimit=12&cursor=cursor-1&includeOutput=false&maxChars=400",
      { cache: "no-store" },
    );
  });

  it("follows transcript cursors and deduplicates stable reader items", async () => {
    clientMocks.get
      .mockResolvedValueOnce({
        entries: [{
          id: "entry-1",
          entry: { kind: "assistant", ts: "2026-06-19T11:06:00.000Z", text: "first" },
        }],
        source: "legacy",
        revision: "revision-1",
        availability: "available",
        completeness: "complete",
        page: { cursor: null, hasMore: true, nextCursor: "cursor-1", order: "oldest" },
      })
      .mockResolvedValueOnce({
        entries: [
          {
            id: "entry-1",
            entry: { kind: "assistant", ts: "2026-06-19T11:06:00.000Z", text: "first (refreshed)" },
          },
          {
            id: "entry-2",
            entry: { kind: "assistant", ts: "2026-06-19T11:07:00.000Z", text: "second" },
          },
        ],
        source: "legacy",
        revision: "revision-1",
        availability: "available",
        completeness: "complete",
        page: { cursor: "cursor-1", hasMore: false, nextCursor: null, order: "oldest" },
      });

    await expect(agentRunsApi.allTranscript("run-1", { turnLimit: AGENT_RUN_TRANSCRIPT_TURN_LIMIT }))
      .resolves.toMatchObject({
        entries: [
          { sourceEntryId: "entry-1", text: "first (refreshed)" },
          { sourceEntryId: "entry-2", text: "second" },
        ],
        source: "legacy",
        revision: "revision-1",
      });
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      1,
      "/run-intelligence/runs/run-1/transcript?output=full&order=oldest&turnLimit=50",
      { cache: "no-store" },
    );
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      2,
      "/run-intelligence/runs/run-1/transcript?output=full&order=oldest&turnLimit=50&cursor=cursor-1",
      { cache: "no-store" },
    );
  });

  it("rejects a transcript page whose cursor does not advance", async () => {
    clientMocks.get
      .mockResolvedValueOnce({
        entries: [],
        page: { hasMore: true, nextCursor: "same-cursor", order: "oldest" },
      })
      .mockResolvedValueOnce({
        entries: [],
        page: { hasMore: true, nextCursor: "same-cursor", order: "oldest" },
      });

    await expect(agentRunsApi.allTranscript("run-1"))
      .rejects.toThrow("non-advancing cursor");
  });
});

describe("heartbeatsApi compatibility facade", () => {
  beforeEach(() => {
    clientMocks.get.mockReset();
    clientMocks.post.mockReset();
    clientMocks.get.mockResolvedValue([]);
  });

  it("keeps legacy imports on the agent run facade", async () => {
    await heartbeatsApi.list("org-1");
    await heartbeatsApi.retry("run-1");

    expect(HEARTBEAT_RUN_LIST_DEFAULT_LIMIT).toBe(AGENT_RUN_LIST_DEFAULT_LIMIT);
    expect(clientMocks.get).toHaveBeenCalledWith(
      `/orgs/org-1/agent-runs?limit=${AGENT_RUN_LIST_DEFAULT_LIMIT}`,
    );
    expect(clientMocks.post).toHaveBeenCalledWith("/agent-runs/run-1/retry", {});
  });

  it("keeps scheduler heartbeat calls separate from agent runs", async () => {
    await schedulerHeartbeatsApi.listInstanceSchedulerAgents();
    await heartbeatsApi.listInstanceSchedulerAgents();

    expect(clientMocks.get).toHaveBeenNthCalledWith(1, "/instance/scheduler-heartbeats");
    expect(clientMocks.get).toHaveBeenNthCalledWith(2, "/instance/scheduler-heartbeats");
  });
});
