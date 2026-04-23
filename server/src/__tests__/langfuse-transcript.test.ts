import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { ExecutionObservabilityContext } from "@rudder/shared";

const mockStartExecutionChildObservation = vi.hoisted(() => vi.fn());
const mockUpdateExecutionObservation = vi.hoisted(() => vi.fn());

vi.mock("../langfuse.js", () => ({
  startExecutionChildObservation: mockStartExecutionChildObservation,
  updateExecutionObservation: mockUpdateExecutionObservation,
}));

const { emitExecutionTranscriptTree } = await import("../langfuse-transcript.js");

function makeObservation(name: string): LangfuseObservation {
  return {
    id: `obs-${name}`,
    traceId: "trace-1",
    type: "span",
    otelSpan: {
      spanContext: () => ({
        traceId: "trace-1",
        spanId: `span-${name}`,
        traceFlags: 1,
      }),
    },
    end: vi.fn(),
    updateOtelSpanAttributes: vi.fn(),
    startObservation: vi.fn(),
    setTraceAsPublic: vi.fn(),
    setTraceIO: vi.fn(),
  } as unknown as LangfuseObservation;
}

function makeContext(overrides: Partial<ExecutionObservabilityContext> = {}): ExecutionObservabilityContext {
  return {
    surface: "chat_turn",
    rootExecutionId: "turn-1",
    orgId: "organization-1",
    agentId: "agent-1",
    sessionKey: "chat-1",
    trigger: "assistant_reply",
    status: "succeeded",
    ...overrides,
  };
}

describe("emitExecutionTranscriptTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartExecutionChildObservation.mockImplementation((_parent, _context, input) => makeObservation(input.name));
  });

  it("maps transcript turns and tool calls into Langfuse child observations", () => {
    const parent = makeObservation("root");

    const stats = emitExecutionTranscriptTree({
      context: makeContext(),
      parentObservation: parent,
      transcript: [
        { kind: "init", ts: "2026-04-12T10:00:00.000Z", model: "gpt-5.4", sessionId: "session-1" },
        { kind: "assistant", ts: "2026-04-12T10:00:01.000Z", text: "Inspecting the issue.", delta: true },
        {
          kind: "tool_call",
          ts: "2026-04-12T10:00:02.000Z",
          name: "read_file",
          toolUseId: "tool-1",
          input: { path: "server/src/routes/chats.ts" },
        },
        {
          kind: "tool_result",
          ts: "2026-04-12T10:00:03.000Z",
          toolUseId: "tool-1",
          content: "loaded",
          isError: false,
        },
        {
          kind: "result",
          ts: "2026-04-12T10:00:04.000Z",
          text: "Inspecting the issue.",
          inputTokens: 120,
          outputTokens: 48,
          cachedTokens: 0,
          costUsd: 0.12,
          subtype: "success",
          isError: false,
          errors: [],
        },
      ],
    });

    expect(stats).toEqual({
      turnCount: 1,
      toolCount: 1,
      eventCount: 1,
      finalOutput: "Inspecting the issue.",
      finalModel: "gpt-5.4",
      finalUsage: {
        inputTokens: 120,
        outputTokens: 48,
        cachedInputTokens: 0,
      },
      finalSessionId: "session-1",
      hasError: false,
    });
    expect(mockStartExecutionChildObservation.mock.calls.map((call) => call[2].name)).toEqual([
      "runtime.init",
      "model_turn:1",
      "read_file",
    ]);
    expect(mockUpdateExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "obs-model_turn:1" }),
      expect.objectContaining({ surface: "chat_turn" }),
      expect.objectContaining({
        model: "gpt-5.4",
        output: "Inspecting the issue.",
        usageDetails: {
          input: 120,
          output: 48,
        },
        costDetails: {
          totalCost: 0.12,
        },
      }),
    );
    expect(mockUpdateExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "obs-root" }),
      expect.any(Object),
      expect.objectContaining({
        metadata: expect.objectContaining({
          transcriptEntryCount: 5,
          transcriptTurnCount: 1,
          transcriptToolCount: 1,
          transcriptEventCount: 1,
        }),
      }),
    );
  });

  it("closes dangling tools and generations with fallback error metadata", () => {
    const parent = makeObservation("root");

    const stats = emitExecutionTranscriptTree({
      context: makeContext({ surface: "issue_run", rootExecutionId: "run-1" }),
      parentObservation: parent,
      transcript: [
        { kind: "assistant", ts: "2026-04-12T10:10:00.000Z", text: "Trying a fix.", delta: true },
        {
          kind: "tool_call",
          ts: "2026-04-12T10:10:01.000Z",
          name: "apply_patch",
          toolUseId: "tool-2",
          input: { file: "server/src/services/heartbeat.ts" },
        },
      ],
      fallbackResult: {
        ts: "2026-04-12T10:10:05.000Z",
        output: "Run failed before the tool finished.",
        subtype: "failed",
        isError: true,
        errors: ["run_failed"],
      },
    });

    expect(stats).toEqual({
      turnCount: 1,
      toolCount: 1,
      eventCount: 0,
      finalOutput: "Run failed before the tool finished.",
      finalModel: null,
      finalUsage: null,
      finalSessionId: "chat-1",
      hasError: true,
    });
    expect(mockUpdateExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "obs-apply_patch" }),
      expect.any(Object),
      expect.objectContaining({
        statusMessage: "tool_result_missing",
        level: "ERROR",
      }),
    );
    expect(mockUpdateExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "obs-model_turn:1" }),
      expect.any(Object),
      expect.objectContaining({
        output: "Run failed before the tool finished.",
        statusMessage: "failed",
        level: "ERROR",
      }),
    );
  });
});
