import type { HeartbeatRunEvent } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../agent-runtimes";
import {
  heartbeatRunEventsToTranscriptEntries,
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

  it("hydrates transcript.entry event payloads instead of generic event labels", () => {
    const entry = heartbeatRunEventToTranscriptEntry(
      makeEvent({
        eventType: "transcript.entry",
        message: "chat transcript entry",
        payload: {
          kind: "assistant",
          ts: "2026-06-17T09:00:01.000Z",
          text: "web search completed",
        },
      }),
    );

    expect(entry).toEqual({
      kind: "assistant",
      ts: "2026-06-17T09:00:01.000Z",
      text: "web search completed",
    });
  });

  it("uses embedded transcript entries as the replay timeline when run events contain them", () => {
    const entries = heartbeatRunEventsToTranscriptEntries([
      makeEvent({
        seq: 1,
        eventType: "lifecycle",
        message: "chat run started",
      }),
      makeEvent({
        seq: 2,
        eventType: "transcript.entry",
        message: "chat transcript entry",
        payload: {
          kind: "assistant",
          ts: "2026-06-17T09:00:01.000Z",
          text: "Loaded agent instructions file",
        },
      }),
      makeEvent({
        seq: 3,
        eventType: "transcript.entry",
        message: "chat transcript entry",
        payload: {
          kind: "tool_result",
          ts: "2026-06-17T09:00:02.000Z",
          toolUseId: "tool-1",
          toolName: "exec_command",
          content: "web search completed",
          isError: false,
        },
      }),
      makeEvent({
        seq: 4,
        eventType: "chat.message_linked",
        message: "chat message linked",
      }),
    ]);

    expect(entries).toEqual([
      {
        kind: "assistant",
        ts: "2026-06-17T09:00:01.000Z",
        text: "Loaded agent instructions file",
      },
      {
        kind: "tool_result",
        ts: "2026-06-17T09:00:02.000Z",
        toolUseId: "tool-1",
        toolName: "exec_command",
        content: "web search completed",
        isError: false,
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries).not.toContainEqual(expect.objectContaining({ text: "chat transcript entry" }));
  });

  it("omits internal issue execution release events from fallback run detail entries", () => {
    const entries = heartbeatRunEventsToTranscriptEntries([
      makeEvent({
        seq: 1,
        eventType: "lifecycle",
        message: "Visible terminal lifecycle evidence",
      }),
      makeEvent({
        seq: 2,
        eventType: "issue.execution_released",
        message: "Issue execution released after terminal run",
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ text: "Visible terminal lifecycle evidence" }),
    ]);
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
