import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { describe, expect, it } from "vitest";
import { redactCurrentUserValue } from "../../log-redaction.js";
import {
  appendTranscriptEntriesFromChunk,
  buildHeartbeatAdapterInvokePayload,
  createHeartbeatTranscriptFinalizer,
  MAX_TRANSCRIPT_LINE_BUFFER_BYTES,
  type TranscriptChunkBuffer,
} from "./heartbeat.core.js";

function buffer(): TranscriptChunkBuffer {
  return { pending: "", droppingOverlongLine: false };
}

function textOf(entry: TranscriptEntry): string {
  return "text" in entry ? entry.text : "";
}

describe("heartbeat adapter invocation persistence", () => {
  it("keeps legacy invocation prompt, instruction stack, and context unchanged by default", () => {
    const prompt = `# Agent instruction stack\n${"keep this auditable\n".repeat(2_000)}`;
    const context = { chatMode: true, runtimeMetadata: { body: "PRIVATE_CONTEXT_BODY" } };
    const payload = buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "codex_local",
        command: "codex",
        prompt,
        agentInstructionStack: prompt,
        context,
        promptMetrics: { promptChars: prompt.length },
      },
      runtimeSkills: [],
    });
    const persisted = JSON.parse(JSON.stringify(redactCurrentUserValue(payload))) as Record<string, unknown>;

    expect(persisted.prompt).toBe(payload.prompt);
    expect(persisted.agentInstructionStack).toBe(payload.agentInstructionStack);
    expect(persisted.context).toEqual(context);
    expect(persisted).not.toHaveProperty("invocationContent");
    expect(persisted.promptMetrics).toEqual({ promptChars: prompt.length });
  });

  it("compacts prompt, instruction stack, and nested context only for native transcript retention", () => {
    const prompt = `# Agent instruction stack\n${"keep this auditable\n".repeat(2_000)}`;
    const privateContext = "PRIVATE_NATIVE_CONTEXT_" + "C".repeat(2_000);
    const meta = {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: prompt,
      context: {
        chatMode: true,
        chatPrompt: "PRIVATE_CHAT_PROMPT",
        runtimeMetadata: { body: privateContext },
      },
      promptMetrics: { promptChars: prompt.length },
      usedSkills: [{ key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" }],
    };
    const nativeRetention = {
      mode: "native" as const,
      persistRawTranscript: false,
      reason: "native_transcript_capability" as const,
    };
    const payload = buildHeartbeatAdapterInvokePayload({
      meta,
      runtimeSkills: [],
      transcriptRetention: nativeRetention,
    });
    const legacyPayload = buildHeartbeatAdapterInvokePayload({ meta, runtimeSkills: [] });
    const serialized = JSON.stringify(redactCurrentUserValue(payload));
    const persisted = JSON.parse(serialized) as Record<string, unknown>;
    const invocationContent = persisted.invocationContent as Record<string, unknown>;
    const promptSummary = invocationContent.prompt as Record<string, unknown>;
    const stackSummary = invocationContent.agentInstructionStack as Record<string, unknown>;
    const contextSummary = invocationContent.context as Record<string, unknown>;

    expect(persisted).not.toHaveProperty("prompt");
    expect(persisted).not.toHaveProperty("agentInstructionStack");
    expect(persisted).not.toHaveProperty("context");
    expect(invocationContent).toMatchObject({
      textStored: false,
      textSource: "agent_run_transcript_reader",
      transcriptRetentionMode: "native",
      transcriptRetentionReason: "native_transcript_capability",
    });
    expect(promptSummary).toMatchObject({
      present: true,
      sourceCharacterLength: prompt.length,
      sourceUtf8ByteLength: Buffer.byteLength(prompt, "utf8"),
    });
    expect(promptSummary.sanitizedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stackSummary).toMatchObject({ present: true, sameAsPrompt: true });
    expect(contextSummary).toMatchObject({
      present: true,
      keyCount: 2,
      keys: ["chatMode", "runtimeMetadata"],
    });
    expect(contextSummary.sanitizedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.promptMetrics).toEqual({ promptChars: prompt.length });
    expect(persisted.usedSkillKeys).toEqual(["rudder/build-advisor"]);
    expect(persisted.skillEvidenceKeys).toEqual(["rudder/build-advisor"]);
    expect(serialized).not.toContain("PRIVATE_CHAT_PROMPT");
    expect(serialized).not.toContain("PRIVATE_CONTEXT_BODY");
    expect(serialized).not.toContain("PRIVATE_NATIVE_CONTEXT_");

    const legacySerialized = JSON.stringify(redactCurrentUserValue(legacyPayload));
    expect(Buffer.byteLength(legacySerialized, "utf8") - Buffer.byteLength(serialized, "utf8"))
      .toBeGreaterThan(Buffer.byteLength(prompt, "utf8") * 2);
  });

  it("keeps distinct native prompt and instruction digests without persisting either text", () => {
    const prompt = "task prompt 内容";
    const instructionStack = "runtime instruction stack 规则";
    const payload = buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "claude_local",
        command: "claude",
        prompt,
        agentInstructionStack: instructionStack,
      },
      runtimeSkills: [],
      transcriptRetention: {
        mode: "native",
        persistRawTranscript: false,
        reason: "native_transcript_capability",
      },
    });
    const serialized = JSON.stringify(redactCurrentUserValue(payload));
    const persisted = JSON.parse(serialized) as Record<string, unknown>;
    const invocationContent = persisted.invocationContent as Record<string, unknown>;
    const promptSummary = invocationContent.prompt as Record<string, unknown>;
    const stackSummary = invocationContent.agentInstructionStack as Record<string, unknown>;

    expect(persisted).not.toHaveProperty("prompt");
    expect(persisted).not.toHaveProperty("agentInstructionStack");
    expect(promptSummary.sanitizedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stackSummary.sanitizedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stackSummary).not.toHaveProperty("sameAsPrompt");
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain(instructionStack);
  });

  it("preserves invocation text when native transcript retention is not active", () => {
    const prompt = "still required for legacy transcript retention";
    const payload = buildHeartbeatAdapterInvokePayload({
      meta: { agentRuntimeType: "codex_local", command: "codex", prompt },
      runtimeSkills: [],
      transcriptRetention: {
        mode: "native",
        persistRawTranscript: true,
        reason: "native_transcript_unknown",
      },
    });

    expect(payload.prompt).toBe(prompt);
    expect(payload).not.toHaveProperty("invocationContent");
  });
});

describe("heartbeat transcript chunk buffering", () => {
  it("bounds unterminated lines and records that the whole oversized line was dropped", () => {
    const transcript: TranscriptEntry[] = [];
    const stdoutBuffer = buffer();
    const chunk = "x".repeat(8 * 1024);

    for (let index = 0; index < 128; index += 1) {
      appendTranscriptEntriesFromChunk({
        buffer: stdoutBuffer,
        chunk,
        transcript,
        kind: "stdout",
      });
      expect(Buffer.byteLength(stdoutBuffer.pending, "utf8")).toBeLessThanOrEqual(MAX_TRANSCRIPT_LINE_BUFFER_BYTES);
    }

    expect(stdoutBuffer).toEqual({ pending: "", droppingOverlongLine: true });
    expect(transcript).toEqual([]);

    appendTranscriptEntriesFromChunk({
      buffer: stdoutBuffer,
      chunk: "",
      transcript,
      finalize: true,
      kind: "stdout",
    });

    expect(transcript).toHaveLength(1);
    expect(textOf(transcript[0]!)).toContain("transcript line dropped");
    expect(textOf(transcript[0]!)).not.toContain("x".repeat(100));
    expect(stdoutBuffer).toEqual({ pending: "", droppingOverlongLine: false });
  });

  it("drops through the oversized line delimiter and still parses following lines", () => {
    const transcript: TranscriptEntry[] = [];
    const stdoutBuffer = buffer();
    const parsedLines: string[] = [];
    const parser = (line: string, ts: string): TranscriptEntry[] => {
      parsedLines.push(line);
      return [{ kind: "assistant", ts, text: line }];
    };
    appendTranscriptEntriesFromChunk({
      buffer: stdoutBuffer,
      chunk: "x".repeat(MAX_TRANSCRIPT_LINE_BUFFER_BYTES + 1),
      transcript,
      parser,
      kind: "stdout",
    });

    appendTranscriptEntriesFromChunk({
      buffer: stdoutBuffer,
      chunk: "\nvalid line\n",
      transcript,
      parser,
      kind: "stdout",
    });

    expect(transcript.map(textOf)).toEqual([
      expect.stringContaining("transcript line dropped"),
      "valid line",
    ]);
    expect(parsedLines).toEqual(["valid line"]);
    expect(stdoutBuffer).toEqual({ pending: "", droppingOverlongLine: false });
  });
});

describe("heartbeat transcript finalization", () => {
  it.each(["success", "failure"] as const)("appends the trailing stdout entry once before seal on %s", async (outcome) => {
    const transcript: TranscriptEntry[] = [];
    const stdoutBuffer = buffer();
    const stderrBuffer = buffer();
    const captured: TranscriptEntry[] = [];
    const lifecycle: string[] = [];
    const parser = (line: string, ts: string): TranscriptEntry[] => line.startsWith("record:")
      ? [{ kind: "assistant", ts, text: line.slice("record:".length) }]
      : [];

    const beforeOnLog = transcript.length;
    appendTranscriptEntriesFromChunk({
      buffer: stdoutBuffer,
      chunk: "record:observed\nrecord:trailing",
      transcript,
      parser,
      kind: "stdout",
    });
    captured.push(...transcript.slice(beforeOnLog));
    appendTranscriptEntriesFromChunk({
      buffer: stderrBuffer,
      chunk: "stderr tail",
      transcript,
      kind: "stderr",
    });

    const finalize = createHeartbeatTranscriptFinalizer({
      transcript,
      stdoutBuffer,
      stderrBuffer,
      stdoutParser: () => parser,
      appendFinalizedStdoutEntries: async (entries) => {
        await Promise.resolve();
        captured.push(...entries);
        lifecycle.push("supplement append");
      },
    });

    await finalize();
    lifecycle.push(`terminal ${outcome}`);
    lifecycle.push("seal");
    await finalize();

    expect(transcript.map(textOf)).toEqual(["observed", "trailing", "stderr tail"]);
    expect(captured.map(textOf)).toEqual(["observed", "trailing"]);
    expect(lifecycle).toEqual(["supplement append", `terminal ${outcome}`, "seal"]);
    expect(stdoutBuffer).toEqual({ pending: "", droppingOverlongLine: false });
    expect(stderrBuffer).toEqual({ pending: "", droppingOverlongLine: false });
  });
});
