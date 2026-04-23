import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPublishLiveEvent = vi.hoisted(() => vi.fn());
const mockObserveExecutionEvent = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({
      censorUsernameInLogs: false,
    }),
  }),
}));

vi.mock("../langfuse.js", () => ({
  observeExecutionEvent: mockObserveExecutionEvent,
}));

import { logActivity } from "../services/activity-log.js";

describe("activity log Langfuse export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not export low-signal activity mutations into Langfuse traces", async () => {
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    };

    await logActivity(db as never, {
      orgId: "org-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      details: {
        issueId: "issue-1",
        field: "status",
      },
    });

    expect(mockObserveExecutionEvent).not.toHaveBeenCalled();
  });
});
