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

  it("does not persist chat run identifiers as heartbeat run foreign keys", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
    };

    await logActivity(db as never, {
      orgId: "org-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "agent.hire_created",
      entityType: "agent",
      entityId: "agent-2",
      agentId: "agent-1",
      runId: "chat-conversation-turn",
      details: {
        name: "Theo",
      },
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ runId: null }));
    expect(mockPublishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ runId: null }),
      }),
    );
  });

  it("retries activity logging without run linkage when the run row is absent", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const values = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing heartbeat run"), {
        code: "23503",
        constraint_name: "activity_log_run_id_heartbeat_runs_id_fk",
      }))
      .mockResolvedValueOnce(undefined);
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
    };

    await logActivity(db as never, {
      orgId: "org-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "agent.hire_created",
      entityType: "agent",
      entityId: "agent-2",
      agentId: "agent-1",
      runId,
    });

    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ runId }));
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({ runId: null }));
  });
});
