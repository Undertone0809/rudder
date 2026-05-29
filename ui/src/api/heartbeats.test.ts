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
      `/orgs/org-1/heartbeat-runs?limit=${HEARTBEAT_RUN_LIST_DEFAULT_LIMIT}`,
    );
  });

  it("preserves explicit history and agent limits", async () => {
    await heartbeatsApi.list("org-1", undefined, HEARTBEAT_RUN_LIST_HISTORY_LIMIT);
    await heartbeatsApi.list("org-1", "agent-1", HEARTBEAT_RUN_LIST_AGENT_LIMIT);

    expect(clientMocks.get).toHaveBeenNthCalledWith(
      1,
      `/orgs/org-1/heartbeat-runs?limit=${HEARTBEAT_RUN_LIST_HISTORY_LIMIT}`,
    );
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      2,
      `/orgs/org-1/heartbeat-runs?agentId=agent-1&limit=${HEARTBEAT_RUN_LIST_AGENT_LIMIT}`,
    );
  });
});
