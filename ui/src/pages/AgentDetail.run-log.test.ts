import type { HeartbeatRunEvent } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  advancePersistedRunEventCursor,
  canPersistRunTranscriptAnnotations,
  getRunTranscriptEmptyMessage,
  isTerminalRunTranscriptPage,
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

describe("Run transcript empty-state lifecycle", () => {
  const missing = { availability: "missing", loading: false, error: null } as const;

  it("waits for an empty live transcript even when its source is not yet available", () => {
    expect(getRunTranscriptEmptyMessage(missing, true)).toBe("Waiting for transcript...");
  });

  it("leaves terminal source-unavailable messaging to the continuation status", () => {
    expect(getRunTranscriptEmptyMessage(missing, false)).toBeUndefined();
  });

  it.each(["offline", "expired"] as const)("defers %s copy to the continuation status", (availability) => {
    expect(getRunTranscriptEmptyMessage({ ...missing, availability }, true)).toBeUndefined();
  });

  it("leaves read-error messaging to the continuation status instead of duplicating it", () => {
    expect(getRunTranscriptEmptyMessage({ ...missing, error: new Error("Read failed") }, true))
      .toBeUndefined();
  });

  it("preserves pending, loading, and ordinary terminal-empty copy", () => {
    expect(getRunTranscriptEmptyMessage({ ...missing, availability: "pending" }, false))
      .toBe("Waiting for transcript...");
    expect(getRunTranscriptEmptyMessage({ ...missing, availability: "available", loading: true }, false))
      .toBe("Waiting for transcript...");
    expect(getRunTranscriptEmptyMessage({ ...missing, availability: "available" }, false))
      .toBe("No transcript for this run.");
  });
});

describe("terminal Run transcript presentation", () => {
  it("marks a complete successful Hermes transcript as terminal so its final answer is labeled", () => {
    expect(isTerminalRunTranscriptPage({
      status: "succeeded",
      hasData: true,
      availability: "available",
      completeness: "complete",
      canNext: false,
    })).toBe(true);
  });

  it.each([
    { status: "failed", hasData: true, availability: "available", completeness: "complete", canNext: false },
    { status: "succeeded", hasData: false, availability: "available", completeness: "complete", canNext: false },
    { status: "succeeded", hasData: true, availability: "offline", completeness: "complete", canNext: false },
    { status: "succeeded", hasData: true, availability: "available", completeness: "partial", canNext: false },
    { status: "succeeded", hasData: true, availability: "available", completeness: "complete", canNext: true },
  ])("does not mark a nonterminal transcript page as final: $status/$availability/$completeness", (input) => {
    expect(isTerminalRunTranscriptPage(input)).toBe(false);
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
