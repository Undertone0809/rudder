import { describe, expect, it } from "vitest";
import type { AgentRuntimeInvocationMeta } from "../../agent-runtimes/index.js";
import { buildHeartbeatAdapterInvokePayload } from "./heartbeat.core.js";
import {
  compactHeartbeatAdapterInvokePayload,
  projectHeartbeatAdapterResult,
} from "./heartbeat.execute-native-retention.js";

describe("heartbeat native retention projections", () => {
  it("preserves equal Instructions provenance through actual raw-builder to heartbeat compactor", () => {
    const prompt = "Instructions 原文🙂";
    const recorded = buildHeartbeatAdapterInvokePayload({ meta: { agentRuntimeType: "hermes_gateway",
      command: "hermes", prompt, agentInstructionStack: prompt }, runtimeSkills: [] });
    expect(recorded).not.toHaveProperty("agentInstructionStack");
    const compacted = compactHeartbeatAdapterInvokePayload(JSON.parse(JSON.stringify(recorded)));
    expect(compacted).toMatchObject({ invocationContent: { agentInstructionStack: {
      present: true, sameAsPrompt: true, sourceCharacterLength: prompt.length, sourceUtf8ByteLength: Buffer.byteLength(prompt),
    } } });
    expect(compacted.prompt).toBe(prompt);
    expect(compacted).not.toHaveProperty("agentInstructionStack");
    expect(compactHeartbeatAdapterInvokePayload(compacted)).toMatchObject({ invocationContent: {
      agentInstructionStack: compacted.invocationContent && (compacted.invocationContent as Record<string, unknown>).agentInstructionStack,
    } });
  });

  it.each([
    { prompt: "task", present: false },
    { prompt: "task", agentInstructionStack: null, present: false },
    { prompt: "task", agentInstructionStack: "", present: true },
    { prompt: "", agentInstructionStack: "", present: true },
    { prompt: "task", agentInstructionStack: "different instructions", present: true },
  ])("does not invent an equality alias for absent/distinct/null/empty instructions: %j", ({ present, ...fields }) => {
    const recorded = buildHeartbeatAdapterInvokePayload({ meta: { agentRuntimeType: "hermes_gateway", command: "hermes", ...fields } as never, runtimeSkills: [] });
    expect(recorded).not.toHaveProperty("agentInstructionStackAlias");
    const compacted = compactHeartbeatAdapterInvokePayload(recorded);
    expect(compacted).not.toHaveProperty("agentInstructionStackAlias");
    const summary = (compacted.invocationContent as Record<string, unknown>).agentInstructionStack;
    expect(summary).toMatchObject({ present });
    expect(summary).not.toHaveProperty("sameAsPrompt");
  });

  it("rejects partial alias markers and does not allow runtime meta to invent persisted provenance", () => {
    const prompt = "task";
    const real = buildHeartbeatAdapterInvokePayload({ meta: { agentRuntimeType: "hermes_gateway", command: "hermes",
      prompt, agentInstructionStack: prompt }, runtimeSkills: [] });
    const alias = real.agentInstructionStackAlias;
    const runtime = buildHeartbeatAdapterInvokePayload({ meta: { agentRuntimeType: "hermes_gateway", command: "hermes",
      prompt, agentInstructionStackAlias: alias } as never, runtimeSkills: [] });
    expect(runtime).not.toHaveProperty("agentInstructionStackAlias");
    for (const agentInstructionStack of [null, "", "distinct instructions"]) {
      const compacted = compactHeartbeatAdapterInvokePayload({ ...real, agentInstructionStack });
      expect(compacted).not.toHaveProperty("agentInstructionStackAlias");
      expect((compacted.invocationContent as Record<string, unknown>).agentInstructionStack).not.toHaveProperty("sameAsPrompt");
    }
    for (const fields of [{}, { agentInstructionStack: null }, { agentInstructionStack: "" }]) {
      const compacted = compactHeartbeatAdapterInvokePayload({ ...real, ...fields,
        agentInstructionStackAlias: { sameAsPrompt: true, textSource: "persisted_prompt" } });
      expect(compacted).not.toHaveProperty("agentInstructionStackAlias");
      expect((compacted.invocationContent as Record<string, unknown>).agentInstructionStack).not.toHaveProperty("sameAsPrompt");
    }
  });

  it("retains source/sanitization provenance without restoring text after later redaction", () => {
    const section = (quote: string) => `User-provided response annotations:\n${quote}\n\nConversation input:\nuser: same request`;
    const meta = { agentRuntimeType: "hermes_gateway", command: "hermes", prompt: section("PRIVATE_A"), agentInstructionStack: section("PRIVATE_STACK_B") };
    const recorded = buildHeartbeatAdapterInvokePayload({ meta, runtimeSkills: [] });
    const alias = recorded.agentInstructionStackAlias as Record<string, unknown>;
    expect(alias).toMatchObject({ present: true, sameAsPrompt: true, sanitizedForPersistence: true,
      sourceCharacterLength: meta.agentInstructionStack.length, sourceUtf8ByteLength: Buffer.byteLength(meta.agentInstructionStack) });
    const compacted = compactHeartbeatAdapterInvokePayload({ ...recorded, prompt: "[later user redaction]" });
    expect((compacted.invocationContent as Record<string, unknown>).agentInstructionStack).toEqual(alias);
    expect(JSON.stringify(compacted)).not.toContain("PRIVATE_");
    expect(compacted.prompt).toBe("[later user redaction]");
    expect(compacted).not.toHaveProperty("agentInstructionStack");
  });

  it("keeps unproven raw invocation fallback through terminal compaction", () => {
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

    expect(compacted.prompt).toBe("private prompt content");
    expect(compacted).toMatchObject({
      desiredSkillCount: 1,
      desiredSkillKeys: ["docs"],
      desiredSkills: [{ key: "  docs  ", runtimeName: " docs-runtime ", name: "Docs", description: "Reference docs" }, { key: "  " }, null],
      invocationContent: {
        textStored: true,
        textSource: "persisted_invocation_inline",
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
    expect(compacted.prompt).toBe("private task prompt");
    expect(compacted.agentInstructionStack).toBe(instructionStack);
    expect(JSON.stringify(compacted)).toContain(instructionStack);
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
