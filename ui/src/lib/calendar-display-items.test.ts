import type { CalendarEvent } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { buildCalendarDisplayItems } from "./calendar-display-items";

function event(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "id" | "startAt" | "endAt">): CalendarEvent {
  const { id, startAt, endAt, ...rest } = overrides;
  const agentId = overrides.ownerAgentId ?? "agent-1";
  return {
    id,
    orgId: "org-1",
    sourceId: null,
    eventKind: "agent_work_block",
    eventStatus: "projected",
    ownerType: "agent",
    ownerUserId: null,
    ownerAgentId: agentId,
    title: "Cluster Bot · Projected heartbeat",
    description: null,
    startAt,
    endAt,
    timezone: "UTC",
    allDay: false,
    visibility: "full",
    issueId: null,
    projectId: null,
    goalId: null,
    approvalId: null,
    heartbeatRunId: null,
    activityId: null,
    sourceMode: "derived",
    externalProvider: null,
    externalCalendarId: null,
    externalEventId: null,
    externalEtag: null,
    externalUpdatedAt: null,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: new Date(2026, 4, 1, 8),
    updatedAt: new Date(2026, 4, 1, 8),
    deletedAt: null,
    source: null,
    agent: agentId
      ? { id: agentId, name: agentId === "agent-2" ? "Other Bot" : "Cluster Bot", role: "engineer", title: null, urlKey: null }
      : null,
    issue: null,
    ...rest,
  };
}

describe("buildCalendarDisplayItems", () => {
  it("clusters small derived agent activity by local hour and agent", () => {
    const items = buildCalendarDisplayItems([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 9, 15) }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 10), endAt: new Date(2026, 4, 1, 9, 25) }),
      event({ id: "c", startAt: new Date(2026, 4, 1, 9, 40), endAt: new Date(2026, 4, 1, 9, 55), eventStatus: "actual" }),
    ], { groupAgentActivity: true });

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("cluster");
    if (items[0]?.kind !== "cluster") throw new Error("Expected a cluster");
    expect(items[0].agentName).toBe("Cluster Bot");
    expect(items[0].events.map((clusteredEvent) => clusteredEvent.id)).toEqual(["a", "b", "c"]);
    expect(items[0].startAt).toEqual(new Date(2026, 4, 1, 9, 0));
    expect(items[0].endAt).toEqual(new Date(2026, 4, 1, 9, 55));
    expect(items[0].statusCounts).toEqual([
      { status: "actual", count: 1 },
      { status: "projected", count: 2 },
    ]);
  });

  it("does not cluster manual blocks, long runs, human events, or different agents", () => {
    const items = buildCalendarDisplayItems([
      event({ id: "manual-a", startAt: new Date(2026, 4, 1, 10, 0), endAt: new Date(2026, 4, 1, 10, 15), sourceMode: "manual" }),
      event({ id: "manual-b", startAt: new Date(2026, 4, 1, 10, 15), endAt: new Date(2026, 4, 1, 10, 30), sourceMode: "manual" }),
      event({ id: "long-a", startAt: new Date(2026, 4, 1, 11, 0), endAt: new Date(2026, 4, 1, 12, 0) }),
      event({ id: "long-b", startAt: new Date(2026, 4, 1, 11, 15), endAt: new Date(2026, 4, 1, 12, 15) }),
      event({ id: "human-a", startAt: new Date(2026, 4, 1, 13, 0), endAt: new Date(2026, 4, 1, 13, 15), eventKind: "human_event", ownerType: "user", ownerAgentId: null }),
      event({ id: "human-b", startAt: new Date(2026, 4, 1, 13, 15), endAt: new Date(2026, 4, 1, 13, 30), eventKind: "human_event", ownerType: "user", ownerAgentId: null }),
      event({ id: "agent-a", startAt: new Date(2026, 4, 1, 14, 0), endAt: new Date(2026, 4, 1, 14, 15), ownerAgentId: "agent-1" }),
      event({ id: "agent-b", startAt: new Date(2026, 4, 1, 14, 15), endAt: new Date(2026, 4, 1, 14, 30), ownerAgentId: "agent-2" }),
    ], { groupAgentActivity: true });

    expect(items.every((item) => item.kind === "single")).toBe(true);
  });

  it("keeps short events that cross bucket boundaries as singles", () => {
    const items = buildCalendarDisplayItems([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 50), endAt: new Date(2026, 4, 1, 10, 5) }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 55), endAt: new Date(2026, 4, 1, 10, 10) }),
    ], { groupAgentActivity: true });

    expect(items.map((item) => item.kind)).toEqual(["single", "single"]);
  });

  it("returns singles when grouping is disabled", () => {
    const items = buildCalendarDisplayItems([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 9, 15) }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 15), endAt: new Date(2026, 4, 1, 9, 30) }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["single", "single"]);
  });
});
