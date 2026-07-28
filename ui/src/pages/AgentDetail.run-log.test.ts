import type { HeartbeatRunEvent } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  advancePersistedRunEventCursor,
  mergeRunEvents,
} from "./AgentDetail.run-log";

function runEvent(seq: number): HeartbeatRunEvent {
  return {
    id: seq,
    orgId: "org-1",
    runId: "run-1",
    agentId: "agent-1",
    seq,
    eventType: "test.event",
    stream: "system",
    level: "info",
    color: null,
    message: `event ${seq}`,
    payload: null,
    createdAt: new Date(`2026-07-28T00:00:0${seq}.000Z`),
  };
}

describe("Run event cursor reconciliation", () => {
  it("does not let a later socket event skip a missing persisted sequence", () => {
    let cursor = advancePersistedRunEventCursor(0, [runEvent(1)]);
    let visibleEvents = mergeRunEvents([runEvent(1)], [runEvent(3)]);

    expect(cursor).toBe(1);
    expect(visibleEvents.map((event) => event.seq)).toEqual([1, 3]);

    const persistedBackfill = [runEvent(2), runEvent(3)];
    cursor = advancePersistedRunEventCursor(cursor, persistedBackfill);
    visibleEvents = mergeRunEvents(visibleEvents, persistedBackfill);

    expect(cursor).toBe(3);
    expect(visibleEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
  });
});
