import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_EVENTS_PAGE_LIMIT,
  AGENT_RUN_LIST_AGENT_LIMIT,
  AGENT_RUN_LIST_DEFAULT_LIMIT,
  AGENT_RUN_LIST_HISTORY_LIMIT,
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
