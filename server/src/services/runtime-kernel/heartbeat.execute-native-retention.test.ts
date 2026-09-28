import { describe, expect, it } from "vitest";
import type { AgentRuntimeInvocationMeta } from "../../agent-runtimes/index.js";
import { buildHeartbeatAdapterInvokePayload } from "./heartbeat.core.js";
import {
  compactHeartbeatAdapterInvokePayload,
  projectHeartbeatAdapterResult,
} from "./heartbeat.execute-native-retention.js";

describe("heartbeat native retention projections", () => {
  it("compacts invocation payloads and keeps native raw prompt content out", () => {
    const compacted = compactHeartbeatAdapterInvokePayload({
      agentRuntimeType: "claude",
      command: "claude",
      prompt: "private prompt content",
      desiredSkills: [
        { key: "  docs  ", runtimeName: " docs-runtime ", name: "Docs", description: "Reference docs" },
        { key: "  " },
        null,
      ],
    });

    expect(compacted).not.toHaveProperty("prompt");
    expect(compacted).toMatchObject({
      desiredSkillCount: 1,
      desiredSkillKeys: ["docs"],
      desiredSkills: [{ key: "docs", runtimeName: " docs-runtime ", name: "Docs", description: "Reference docs" }],
      invocationContent: {
        textStored: false,
        textSource: "agent_run_transcript_reader",
        transcriptRetentionMode: "native",
      },
    });
  });

  it("preserves a deduplicated instruction locator and Run Attempt Span link through compaction", () => {
    const instructionStack = "private injected instruction stack";
    const locator = {
      status: "available",
      objectKey: `org/run-instruction-snapshots/${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      byteSize: instructionStack.length,
    };
    const meta: AgentRuntimeInvocationMeta & Record<string, unknown> = {
      agentRuntimeType: "claude_local",
      command: "claude",
      prompt: "private task prompt",
      agentInstructionStack: instructionStack,
      invocationInstructionSnapshot: locator,
      invocationAttemptId: "attempt-1",
      invocationSpanId: "span-1",
    };
    const recorded = buildHeartbeatAdapterInvokePayload({
      meta,
      runtimeSkills: [],
      transcriptRetention: {
        mode: "native",
        persistRawTranscript: false,
        reason: "native_transcript_capability",
      },
    });
    const compacted = compactHeartbeatAdapterInvokePayload(recorded);

    expect(compacted).toMatchObject({
      invocationInstructionSnapshot: locator,
      invocationAttemptId: "attempt-1",
      invocationSpanId: "span-1",
    });
    expect(compacted).not.toHaveProperty("prompt");
    expect(compacted).not.toHaveProperty("agentInstructionStack");
    expect(JSON.stringify(compacted)).not.toContain(instructionStack);
  });

  it("projects native adapter results without raw transcript fields while preserving summary fallback", () => {
    const projection = projectHeartbeatAdapterResult({
      adapterResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        model: "test-model",
        summary: "short completion",
        resultJson: { stdout: "large raw transcript", summary: "short completion", sessionId: "session-1" },
      },
      persistRawResult: false,
      outcome: "succeeded",
      status: "succeeded",
      timestamp: "2026-09-28T00:00:00.000Z",
    });

    expect(projection.persistedResultJson).not.toHaveProperty("stdout");
    expect(projection.persistedResultJson).toMatchObject({
      summary: "short completion",
      retention: { transcriptSource: "native", rawResultPersisted: false },
    });
    expect(projection.persistedAdapterResult.resultJson).toEqual(projection.persistedResultJson);
    expect(projection.persistedResultSummary).toMatchObject({ summary: "short completion" });
    expect(projection.transcriptFallbackResult).toMatchObject({
      ts: "2026-09-28T00:00:00.000Z",
      model: "test-model",
      output: "short completion",
      subtype: "succeeded",
      isError: false,
    });
  });
});
