import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_RUN_LIST_AGENT_LIMIT,
  HEARTBEAT_RUN_LIST_DEFAULT_LIMIT,
  HEARTBEAT_RUN_LIST_HISTORY_LIMIT,
  heartbeatsApi,
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

describe("heartbeatsApi", () => {
  beforeEach(() => {
    clientMocks.get.mockReset();
    clientMocks.post.mockReset();
    clientMocks.get.mockResolvedValue([]);
  });

  it("defaults heartbeat run lists to a bounded request", async () => {
    await heartbeatsApi.list("org-1");

    expect(clientMocks.get).toHaveBeenCalledWith(
      `/orgs/org-1/agent-runs?limit=${HEARTBEAT_RUN_LIST_DEFAULT_LIMIT}`,
    );
  });

  it("preserves explicit history and agent limits", async () => {
    await heartbeatsApi.list("org-1", undefined, HEARTBEAT_RUN_LIST_HISTORY_LIMIT);
    await heartbeatsApi.list("org-1", "agent-1", HEARTBEAT_RUN_LIST_AGENT_LIMIT);

    expect(clientMocks.get).toHaveBeenNthCalledWith(
      1,
      `/orgs/org-1/agent-runs?limit=${HEARTBEAT_RUN_LIST_HISTORY_LIMIT}`,
    );
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      2,
      `/orgs/org-1/agent-runs?agentId=agent-1&limit=${HEARTBEAT_RUN_LIST_AGENT_LIMIT}`,
    );
  });

  it("can request heartbeat runs by date range without a recency limit", async () => {
    await heartbeatsApi.list("org-1", undefined, null, {
      startDate: "2026-06-10T00:00:00.000Z",
      endDate: "2026-06-16T12:00:00.000Z",
    });

    expect(clientMocks.get).toHaveBeenCalledWith(
      "/orgs/org-1/agent-runs?startDate=2026-06-10T00%3A00%3A00.000Z&endDate=2026-06-16T12%3A00%3A00.000Z",
    );
  });

  it("uses agent-run aliases for run detail operations", async () => {
    await heartbeatsApi.get("run-1");
    await heartbeatsApi.events("run-1");
    await heartbeatsApi.log("run-1");
    await heartbeatsApi.workspaceOperations("run-1");
    await heartbeatsApi.retry("run-1");
    await heartbeatsApi.cancel("run-1");

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
});
