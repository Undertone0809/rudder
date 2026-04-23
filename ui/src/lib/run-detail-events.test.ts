import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../agent-runtimes";
import type { HeartbeatRunEvent } from "@rudder/shared";
import {
  heartbeatRunEventText,
  heartbeatRunEventToTranscriptEntry,
  mergeTranscriptEntries,
} from "./run-detail-events";

function makeEvent(overrides: Partial<HeartbeatRunEvent> = {}): HeartbeatRunEvent {
  return {
    id: 1,
    orgId: "org-1",
    runId: "run-1",
    agentId: "agent-1",
    seq: 1,
    eventType: "lifecycle",
    stream: "system",
    level: "info",
    color: null,
    message: "run started",
    payload: null,
    createdAt: new Date("2026-04-12T10:00:00.000Z"),
    ...overrides,
  };
}

describe("run-detail-events", () => {
  it("maps error events to stderr transcript entries", () => {
    const entry = heartbeatRunEventToTranscriptEntry(
      makeEvent({
        eventType: "error",
        level: "error",
        message: "Process lost -- child pid 123 is no longer running",
      }),
    );

    expect(entry).toEqual({
      kind: "stderr",
      ts: "2026-04-12T10:00:00.000Z",
      text: "Process lost -- child pid 123 is no longer running",
    });
  });

  it("falls back to event type plus payload when message is absent", () => {
    const text = heartbeatRunEventText(
      makeEvent({
        eventType: "adapter.invoke",
        message: null,
        payload: { command: "/bin/codex", cwd: "/tmp/workspace" },
      }),
    );

    expect(text).toContain("Adapter Invoke:");
    expect(text).toContain("\"command\":\"/bin/codex\"");
  });

  it("merges log transcript entries and event entries in timestamp order", () => {
    const logEntries: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-04-12T10:00:02.000Z", text: "Working now." },
      { kind: "stdout", ts: "2026-04-12T10:00:04.000Z", text: "done" },
    ];
    const eventEntries: TranscriptEntry[] = [
      { kind: "system", ts: "2026-04-12T10:00:01.000Z", text: "run started" },
      { kind: "system", ts: "2026-04-12T10:00:03.000Z", text: "adapter invocation" },
    ];

    expect(mergeTranscriptEntries(logEntries, eventEntries)).toEqual([
      { kind: "system", ts: "2026-04-12T10:00:01.000Z", text: "run started" },
      { kind: "assistant", ts: "2026-04-12T10:00:02.000Z", text: "Working now." },
      { kind: "system", ts: "2026-04-12T10:00:03.000Z", text: "adapter invocation" },
      { kind: "stdout", ts: "2026-04-12T10:00:04.000Z", text: "done" },
    ]);
  });
});
