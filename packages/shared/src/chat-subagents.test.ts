import { describe, expect, it } from "vitest";
import { collectChatSubagentInspections, mergeChatSubagentSummaries } from "./chat-subagents.js";
import type { ChatStreamTranscriptEntry } from "./types/chat.js";

const context = {
  sourceMessageId: "message-1",
  runId: "run-1",
  sourceActive: true,
};

describe("chat subagent transcript projection", () => {
  it("merges spawn results into one completed thread with inspectable evidence", () => {
    const entries: ChatStreamTranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-07-29T01:00:00.000Z",
        name: "spawn_agent",
        toolUseId: "spawn-1",
        input: { id: "spawn-1", message: "Review the roadmap", receiver_thread_ids: [] },
      },
      {
        kind: "tool_result",
        ts: "2026-07-29T01:00:04.000Z",
        toolUseId: "spawn-1",
        toolName: "spawn_agent",
        isError: false,
        content: JSON.stringify({
          status: "completed",
          receiver_thread_ids: ["thread-reviewer"],
          agents_states: {
            "thread-reviewer": { status: "completed", message: "Review passed." },
          },
          agent_transcripts: {
            "thread-reviewer": {
              status: "completed",
              entries: [
                { kind: "thinking", ts: "2026-07-29T01:00:01.000Z", text: "Inspecting." },
                { kind: "assistant", ts: "2026-07-29T01:00:03.000Z", text: "Review passed." },
              ],
            },
          },
        }),
      },
    ];

    expect(collectChatSubagentInspections(entries, context)).toEqual([
      expect.objectContaining({
        callId: "spawn-1",
        threadId: "thread-reviewer",
        label: "Review the roadmap",
        prompt: "Review the roadmap",
        state: "done",
        status: "completed",
        response: "Review passed.",
        updatedAt: "2026-07-29T01:00:03.000Z",
      }),
    ]);
  });

  it("normalizes active and failed activity statuses and humanizes agent paths", () => {
    const active = collectChatSubagentInspections([{
      kind: "tool_call",
      ts: "2026-07-29T02:00:00.000Z",
      name: "subagent_activity",
      toolUseId: "activity-1",
      input: {
        id: "activity-1",
        activity_kind: "started",
        agent_path: "/root/runtime_verifier",
        receiver_thread_ids: ["thread-runtime"],
        agent_transcripts: {
          "thread-runtime": { status: "inProgress", entries: [] },
        },
      },
    }], context);
    expect(active[0]).toMatchObject({
      label: "Runtime Verifier",
      state: "active",
      status: "running",
    });

    const failed = collectChatSubagentInspections([{
      kind: "tool_call",
      ts: "2026-07-29T02:00:00.000Z",
      name: "subagent_activity",
      toolUseId: "activity-2",
      input: {
        id: "activity-2",
        activity_kind: "interrupted",
        agent_path: "/root/runtime_verifier",
        receiver_thread_ids: ["thread-runtime"],
      },
    }], context);
    expect(failed[0]).toMatchObject({
      state: "done",
      status: "interrupted",
    });
  });

  it("does not keep a stale active snapshot alive after its native generation completed", () => {
    const completedGeneration = collectChatSubagentInspections([{
      kind: "tool_call",
      ts: "2026-07-29T02:00:00.000Z",
      name: "subagent_activity",
      toolUseId: "activity-terminal-source",
      input: {
        id: "activity-terminal-source",
        activity_kind: "interacted",
        agent_path: "/root/runtime_verifier",
        receiver_thread_ids: ["thread-runtime"],
        agent_transcripts: {
          "thread-runtime": {
            status: "inProgress",
            entries: [{
              kind: "assistant",
              ts: "2026-07-29T02:00:01.000Z",
              text: "Runtime verification passed.",
            }],
          },
        },
      },
    }], {
      ...context,
      sourceActive: false,
      sourceTerminalStatus: "completed",
    });

    expect(completedGeneration[0]).toMatchObject({
      state: "done",
      status: "completed",
      response: "Runtime verification passed.",
    });
  });

  it("deduplicates a thread across observations while preserving first identity and latest state", () => {
    const merged = mergeChatSubagentSummaries([
      {
        callId: "spawn-1",
        threadId: "thread-1",
        sourceMessageId: "message-1",
        runId: "run-1",
        label: "Roadmap reviewer",
        prompt: "Review the roadmap",
        avatarSeed: "spawn-1",
        model: "gpt-test",
        reasoningEffort: "high",
        state: "active",
        status: "running",
        startedAt: "2026-07-29T01:00:00.000Z",
        updatedAt: "2026-07-29T01:00:01.000Z",
      },
      {
        callId: "wait-1",
        threadId: "thread-1",
        sourceMessageId: "message-2",
        runId: "run-2",
        label: "Later label",
        prompt: "Wait for reviewer",
        avatarSeed: "wait-1",
        model: null,
        reasoningEffort: null,
        state: "done",
        status: "completed",
        startedAt: "2026-07-29T01:00:05.000Z",
        updatedAt: "2026-07-29T01:00:06.000Z",
      },
    ]);

    expect(merged).toEqual([
      expect.objectContaining({
        callId: "spawn-1",
        sourceMessageId: "message-2",
        label: "Roadmap reviewer",
        prompt: "Review the roadmap",
        avatarSeed: "spawn-1",
        state: "done",
        status: "completed",
      }),
    ]);
  });

  it("merges a terminal wait snapshot without treating tool completion as child completion", () => {
    const entries: ChatStreamTranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-07-29T03:00:00.000Z",
        name: "spawn_agent",
        toolUseId: "spawn-wait",
        input: {
          id: "spawn-wait",
          message: "Verify the runtime",
          receiver_thread_ids: [],
        },
      },
      {
        kind: "tool_result",
        ts: "2026-07-29T03:00:01.000Z",
        toolUseId: "spawn-wait",
        toolName: "spawn_agent",
        isError: false,
        content: JSON.stringify({
          status: "completed",
          receiver_thread_ids: ["thread-wait"],
          agents_states: { "thread-wait": { status: "inProgress" } },
          agent_transcripts: {
            "thread-wait": {
              status: "inProgress",
              entries: [{ kind: "thinking", ts: "2026-07-29T03:00:00.500Z", text: "Working." }],
            },
          },
        }),
      },
      {
        kind: "tool_call",
        ts: "2026-07-29T03:00:02.000Z",
        name: "wait_agent",
        toolUseId: "wait-1",
        input: { receiver_thread_ids: ["thread-wait"] },
      },
      {
        kind: "tool_result",
        ts: "2026-07-29T03:00:04.000Z",
        toolUseId: "wait-1",
        toolName: "wait_agent",
        isError: false,
        content: JSON.stringify({
          status: "completed",
          receiver_thread_ids: ["thread-wait"],
          agents_states: {
            "thread-wait": { status: "completed", message: "Runtime verified." },
          },
          agent_transcripts: {
            "thread-wait": {
              status: "completed",
              entries: [
                { kind: "thinking", ts: "2026-07-29T03:00:00.500Z", text: "Working." },
                { kind: "assistant", ts: "2026-07-29T03:00:03.500Z", text: "Runtime verified." },
              ],
            },
          },
        }),
      },
    ];

    expect(collectChatSubagentInspections(entries, context)).toEqual([
      expect.objectContaining({
        callId: "spawn-wait",
        threadId: "thread-wait",
        label: "Verify the runtime",
        prompt: "Verify the runtime",
        state: "done",
        status: "completed",
        response: "Runtime verified.",
        updatedAt: "2026-07-29T03:00:03.500Z",
      }),
    ]);
  });

  it("keeps a captured response and transcript when a newer status snapshot is sparse", () => {
    const entries: ChatStreamTranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-07-29T04:00:00.000Z",
        name: "subagent_activity",
        toolUseId: "activity-complete",
        input: {
          id: "activity-complete",
          activity_kind: "completed",
          agent_path: "/root/runtime_verifier",
          receiver_thread_ids: ["thread-runtime"],
          agent_transcripts: {
            "thread-runtime": {
              status: "completed",
              entries: [
                {
                  kind: "assistant",
                  ts: "2026-07-29T04:00:01.000Z",
                  text: "Runtime verification passed.",
                  phase: "final_answer",
                  segmentId: "final-a",
                },
                {
                  kind: "assistant",
                  ts: "2026-07-29T04:00:01.000Z",
                  text: "Runtime verification passed.",
                  phase: "final_answer",
                  segmentId: "final-b",
                },
              ],
            },
          },
        },
      },
      {
        kind: "tool_result",
        ts: "2026-07-29T04:00:01.500Z",
        toolUseId: "activity-complete",
        toolName: "subagent_activity",
        isError: false,
        content: JSON.stringify({
          id: "activity-complete",
          activity_kind: "completed",
          agent_path: "/root/runtime_verifier",
          receiver_thread_ids: ["thread-runtime"],
          agent_transcripts: {
            "thread-runtime": {
              status: "completed",
              entries: [
                {
                  kind: "assistant",
                  ts: "2026-07-29T04:00:01.000Z",
                  text: "Runtime verification passed.",
                  phase: "final_answer",
                  segmentId: "final-a",
                  generationId: "generation-projection",
                  generationSeqStart: 7,
                  generationSeqEnd: 7,
                },
                {
                  kind: "assistant",
                  ts: "2026-07-29T04:00:01.000Z",
                  text: "Runtime verification passed.",
                  phase: "final_answer",
                  segmentId: "final-b",
                  generationId: "generation-projection",
                  generationSeqStart: 8,
                  generationSeqEnd: 8,
                },
              ],
            },
          },
        }),
      },
      {
        kind: "tool_call",
        ts: "2026-07-29T04:00:02.000Z",
        name: "wait_agent",
        toolUseId: "wait-after-complete",
        input: { receiver_thread_ids: ["thread-runtime"] },
      },
      {
        kind: "tool_result",
        ts: "2026-07-29T04:00:03.000Z",
        toolUseId: "wait-after-complete",
        toolName: "wait_agent",
        isError: false,
        content: JSON.stringify({
          receiver_thread_ids: ["thread-runtime"],
          agents_states: {
            "thread-runtime": { status: "completed" },
          },
        }),
      },
    ];

    expect(collectChatSubagentInspections(entries, context)).toEqual([
      expect.objectContaining({
        threadId: "thread-runtime",
        state: "done",
        status: "completed",
        response: "Runtime verification passed.",
        entries: [
          expect.objectContaining({
            kind: "assistant",
            segmentId: "final-a",
            generationId: "generation-projection",
          }),
          expect.objectContaining({
            kind: "assistant",
            segmentId: "final-b",
            generationId: "generation-projection",
          }),
        ],
      }),
    ]);
  });
});
