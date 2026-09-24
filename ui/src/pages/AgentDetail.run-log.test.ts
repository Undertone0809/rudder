import type { HeartbeatRunEvent } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  advancePersistedRunEventCursor,
  canPersistRunTranscriptAnnotations,
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

describe("Run transcript annotation anchor trust", () => {
  const partial = { hasData: true, fetching: false, availability: "available", completeness: "partial" } as const;
  const complete = { hasData: true, fetching: false, availability: "available", completeness: "complete" } as const;

  it("gates new persistent annotations in both completeness transition orders", () => {
    expect([partial, complete].map(canPersistRunTranscriptAnnotations)).toEqual([false, true]);
    expect([complete, partial].map(canPersistRunTranscriptAnnotations)).toEqual([true, false]);
    expect(canPersistRunTranscriptAnnotations({ ...complete, availability: "offline" })).toBe(false);
    expect(canPersistRunTranscriptAnnotations({ ...complete, fetching: true })).toBe(false);
    expect(canPersistRunTranscriptAnnotations({ ...complete, hasData: false })).toBe(false);
    expect(canPersistRunTranscriptAnnotations(undefined)).toBe(false);
  });
});
