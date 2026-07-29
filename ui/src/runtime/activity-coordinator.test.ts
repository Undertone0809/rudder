import type { LiveEvent } from "@rudderhq/shared";
import { describe, expect, it, vi } from "vitest";
import { ActivityCoordinator } from "./activity-coordinator";

function event(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1,
    orgId: "org-1",
    type: "heartbeat.run.status",
    createdAt: "2026-07-28T10:00:00.000Z",
    payload: { runId: "run-1", status: "running" },
    ...overrides,
  };
}

describe("ActivityCoordinator", () => {
  it("notifies only the summary key changed by an event", () => {
    const coordinator = new ActivityCoordinator("org-1");
    const runListener = vi.fn();
    const otherListener = vi.fn();
    coordinator.subscribeSummary("run:run-1", runListener);
    coordinator.subscribeSummary("chat:chat-1", otherListener);

    coordinator.publishLiveEvent(event());

    expect(runListener).toHaveBeenCalledTimes(1);
    expect(otherListener).not.toHaveBeenCalled();
    expect(coordinator.getSummary("run:run-1")?.status).toBe("running");
  });

  it("does not project a run lifecycle status onto its parent issue", () => {
    const coordinator = new ActivityCoordinator("org-1");

    coordinator.publishLiveEvent(event({
      payload: { runId: "run-1", issueId: "issue-1", status: "running" },
    }));

    expect(coordinator.getSummary("run:run-1")?.status).toBe("running");
    expect(coordinator.getSummary("issue:issue-1")?.status).toBeNull();
  });

  it("does not notify summary subscribers for log chunks", () => {
    const coordinator = new ActivityCoordinator("org-1");
    coordinator.publishLiveEvent(event());
    const listener = vi.fn();
    const liveListener = vi.fn();
    coordinator.subscribeSummary("run:run-1", listener);
    coordinator.subscribeLiveEvents(liveListener);

    coordinator.publishLiveEvent(event({
      id: 2,
      type: "heartbeat.run.log",
      payload: { runId: "run-1", chunk: "token" },
    }));

    expect(listener).not.toHaveBeenCalled();
    expect(liveListener).toHaveBeenCalledTimes(1);
  });

  it("reads issue status from activity detail payloads", () => {
    const coordinator = new ActivityCoordinator("org-1");

    coordinator.publishLiveEvent(event({
      type: "activity.logged",
      payload: {
        entityType: "issue",
        entityId: "issue-1",
        details: { status: "in_review" },
      },
    }));

    expect(coordinator.getSummary("issue:issue-1")?.status).toBe("in_review");
  });

  it("does not project an issue activity status onto its actor run", () => {
    const coordinator = new ActivityCoordinator("org-1");
    coordinator.updateSummary("run:run-1", { status: "running" });

    coordinator.publishLiveEvent(event({
      type: "activity.logged",
      payload: {
        runId: "run-1",
        entityType: "issue",
        entityId: "issue-1",
        details: { status: "done" },
      },
    }));

    expect(coordinator.getSummary("issue:issue-1")?.status).toBe("done");
    expect(coordinator.getSummary("run:run-1")?.status).toBe("running");
  });

  it("refreshes issue content without treating it as new Messenger activity", () => {
    const coordinator = new ActivityCoordinator("org-1");
    coordinator.updateSummary("issue:issue-1", {
      latestActivityAt: "2026-07-28T09:00:00.000Z",
      previewRevision: 4,
    });
    coordinator.updateSummary("run:run-1", {
      latestActivityAt: "2026-07-28T09:30:00.000Z",
      previewRevision: 2,
    });

    coordinator.publishLiveEvent(event({
      type: "issue.content_updated",
      createdAt: "2026-07-28T10:00:00.000Z",
      payload: {
        runId: "run-1",
        entityType: "issue",
        entityId: "issue-1",
        details: { description: "Refreshed description" },
      },
    }));

    expect(coordinator.getSummary("issue:issue-1")).toMatchObject({
      latestActivityAt: "2026-07-28T09:00:00.000Z",
      previewRevision: 5,
    });
    expect(coordinator.getSummary("run:run-1")).toMatchObject({
      latestActivityAt: "2026-07-28T09:30:00.000Z",
      previewRevision: 3,
    });
  });

  it("reference-counts detail leases", () => {
    const coordinator = new ActivityCoordinator("org-1");
    const first = coordinator.acquireDetail("run:run-1");
    const second = coordinator.acquireDetail("run:run-1");
    expect(coordinator.hasDetailLease("run:run-1")).toBe(true);

    first.release();
    expect(coordinator.hasDetailLease("run:run-1")).toBe(true);
    second.release();
    expect(coordinator.hasDetailLease("run:run-1")).toBe(false);
  });

  it("ignores events from another organization", () => {
    const coordinator = new ActivityCoordinator("org-1");
    coordinator.publishLiveEvent(event({ orgId: "org-2" }));
    expect(coordinator.getSummary("run:run-1")).toBeNull();
  });
});
