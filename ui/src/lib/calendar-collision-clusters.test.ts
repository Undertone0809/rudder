import type { CalendarEvent } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { timedEventSegmentsForDay } from "./calendar-day-segments";
import { compactDenseTimedSegments } from "./calendar-collision-clusters";
import { buildCalendarDisplayItems } from "./calendar-display-items";

function event(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "id" | "startAt" | "endAt">): CalendarEvent {
  const { id, startAt, endAt, ...rest } = overrides;
  const agentId = overrides.ownerType === "user"
    ? null
    : overrides.ownerAgentId === undefined
      ? "agent-1"
      : overrides.ownerAgentId;
  return {
    id,
    orgId: "org-1",
    sourceId: null,
    eventKind: "agent_work_block",
    eventStatus: "planned",
    ownerType: agentId ? "agent" : "user",
    ownerUserId: agentId ? null : "user-1",
    ownerAgentId: agentId,
    title: `${agentId === "agent-2" ? "Other Bot" : "Cluster Bot"} · Calendar block`,
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
    sourceMode: "manual",
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

function segments(events: CalendarEvent[]) {
  return timedEventSegmentsForDay(buildCalendarDisplayItems(events), new Date(2026, 4, 1));
}

describe("compactDenseTimedSegments", () => {
  it("compacts groups that would require four overlapping columns in week view", () => {
    const items = compactDenseTimedSegments(segments([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 10, 0), ownerAgentId: "agent-1" }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 5), endAt: new Date(2026, 4, 1, 10, 5), ownerAgentId: "agent-2" }),
      event({ id: "c", startAt: new Date(2026, 4, 1, 9, 10), endAt: new Date(2026, 4, 1, 10, 10), ownerAgentId: "agent-3" }),
      event({ id: "d", startAt: new Date(2026, 4, 1, 9, 15), endAt: new Date(2026, 4, 1, 10, 15), ownerAgentId: "agent-4" }),
    ]));

    expect(items).toHaveLength(1);
    expect(items[0]?.event.kind).toBe("collision_cluster");
    if (items[0]?.event.kind !== "collision_cluster") throw new Error("Expected a collision cluster");
    expect(items[0].event.events.map((clusteredEvent) => clusteredEvent.id)).toEqual(["a", "b", "c", "d"]);
    expect(items[0].event.agentIds).toEqual(["agent-1", "agent-2", "agent-3", "agent-4"]);
    expect(items[0].startAt).toEqual(new Date(2026, 4, 1, 9, 0));
    expect(items[0].endAt).toEqual(new Date(2026, 4, 1, 10, 15));
  });

  it("compacts three-column agent-owned overlaps that are unreadable in week view", () => {
    const items = compactDenseTimedSegments(segments([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 10, 0), ownerAgentId: "agent-1" }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 5), endAt: new Date(2026, 4, 1, 10, 5), ownerAgentId: "agent-2" }),
      event({ id: "c", startAt: new Date(2026, 4, 1, 9, 10), endAt: new Date(2026, 4, 1, 10, 10), ownerAgentId: "agent-3" }),
    ]));

    expect(items).toHaveLength(1);
    expect(items[0]?.event.kind).toBe("collision_cluster");
    if (items[0]?.event.kind !== "collision_cluster") throw new Error("Expected a collision cluster");
    expect(items[0].event.events.map((clusteredEvent) => clusteredEvent.id)).toEqual(["a", "b", "c"]);
    expect(items[0].event.agentIds).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  it("keeps three-column human overlaps expanded for direct manipulation", () => {
    const items = compactDenseTimedSegments(segments([
      event({ id: "a", eventKind: "human_event", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 10, 0), ownerType: "user", ownerAgentId: null }),
      event({ id: "b", eventKind: "human_event", startAt: new Date(2026, 4, 1, 9, 5), endAt: new Date(2026, 4, 1, 10, 5), ownerType: "user", ownerAgentId: null }),
      event({ id: "c", eventKind: "human_event", startAt: new Date(2026, 4, 1, 9, 10), endAt: new Date(2026, 4, 1, 10, 10), ownerType: "user", ownerAgentId: null }),
    ]));

    expect(items.map((item) => item.event.kind)).toEqual(["single", "single", "single"]);
  });

  it("compacts three-column mixed agent and external overlaps", () => {
    const items = compactDenseTimedSegments(segments([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 10, 0), ownerAgentId: "agent-1" }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 5), endAt: new Date(2026, 4, 1, 10, 5), ownerAgentId: "agent-2" }),
      event({
        id: "c",
        eventKind: "external_event",
        eventStatus: "external",
        sourceMode: "imported",
        startAt: new Date(2026, 4, 1, 9, 10),
        endAt: new Date(2026, 4, 1, 10, 10),
        ownerType: "user",
        ownerAgentId: null,
      }),
    ]));

    expect(items).toHaveLength(1);
    expect(items[0]?.event.kind).toBe("collision_cluster");
    if (items[0]?.event.kind !== "collision_cluster") throw new Error("Expected a collision cluster");
    expect(items[0].event.events.map((clusteredEvent) => clusteredEvent.id)).toEqual(["a", "b", "c"]);
    expect(items[0].event.agentIds).toEqual(["agent-1", "agent-2"]);
  });

  it("keeps two-column agent-owned overlaps expanded", () => {
    const items = compactDenseTimedSegments(segments([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 10, 0), ownerAgentId: "agent-1" }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 15), endAt: new Date(2026, 4, 1, 10, 15), ownerAgentId: "agent-2" }),
    ]));

    expect(items.map((item) => item.event.kind)).toEqual(["single", "single"]);
  });

  it("does not compact long chains unless concurrency crosses the threshold", () => {
    const items = compactDenseTimedSegments(segments([
      event({ id: "a", startAt: new Date(2026, 4, 1, 9, 0), endAt: new Date(2026, 4, 1, 10, 0) }),
      event({ id: "b", startAt: new Date(2026, 4, 1, 9, 30), endAt: new Date(2026, 4, 1, 10, 30) }),
      event({ id: "c", startAt: new Date(2026, 4, 1, 10, 0), endAt: new Date(2026, 4, 1, 11, 0) }),
      event({ id: "d", startAt: new Date(2026, 4, 1, 10, 30), endAt: new Date(2026, 4, 1, 11, 30) }),
    ]));

    expect(items.map((item) => item.event.kind)).toEqual(["single", "single", "single", "single"]);
  });
});
