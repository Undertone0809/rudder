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
  it("keeps one full canonical prompt for equal legacy instructions without changing context", () => {
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
    expect(persisted).not.toHaveProperty("agentInstructionStack");
    expect(persisted.agentInstructionStack ?? persisted.prompt).toBe(payload.prompt);
    expect(persisted.context).toEqual(context);
    expect(persisted).not.toHaveProperty("invocationContent");
    expect(persisted.promptMetrics).toEqual({ promptChars: prompt.length });
  });

  it("removes exactly one 82187-byte Unicode body from serialized invoke metadata, not runtime input or snapshot", () => {
    const prompt = "界🙂\n\"".repeat(9_000) + "D".repeat(1_187);
    expect(Buffer.byteLength(prompt, "utf8")).toBe(82_187);
    const meta = { agentRuntimeType: "hermes_local", command: "hermes", prompt, agentInstructionStack: prompt,
      invocationInstructionSnapshot: { status: "available", objectKey: "org/run-instruction-snapshots/retained", byteSize: 82_187 } };
    const before = structuredClone(meta);
    const payload = buildHeartbeatAdapterInvokePayload({ meta, runtimeSkills: [] });
    const serialized = JSON.stringify(payload);
    const withoutAlias = { ...payload };
    delete withoutAlias.agentInstructionStackAlias;
    const duplicateSerialized = JSON.stringify({ ...withoutAlias, agentInstructionStack: prompt });
    const removedBytes = Buffer.byteLength(duplicateSerialized) - Buffer.byteLength(serialized);
    const aliasBytes = Buffer.byteLength(serialized) - Buffer.byteLength(JSON.stringify(withoutAlias));
    expect(removedBytes).toBe(Buffer.byteLength(JSON.stringify(prompt)) + Buffer.byteLength(',"agentInstructionStack":') - aliasBytes);
    expect(removedBytes).toBeGreaterThan(82_187);
    expect(payload).not.toHaveProperty("agentInstructionStack");
    expect(JSON.parse(serialized).prompt).toBe(prompt);
    expect(payload.invocationInstructionSnapshot).toEqual(meta.invocationInstructionSnapshot);
    expect(meta).toEqual(before);
    console.info("invoke-dedup synthetic bytes", { bodyBytes: Buffer.byteLength(prompt), beforeBytes: Buffer.byteLength(duplicateSerialized),
      afterBytes: Buffer.byteLength(serialized), aliasBytes, removedBytes });
  });

  it.each([
    { prompt: "input", agentInstructionStack: "different instructions" },
    { prompt: "input", agentInstructionStack: "input\nextra" },
    { prompt: "", agentInstructionStack: "" },
    { prompt: "", agentInstructionStack: "unique instructions" },
    { prompt: "input", agentInstructionStack: "" },
    { prompt: "input", agentInstructionStack: null },
    { prompt: "input" },
  ])("preserves distinct/empty/null/absent fields: %j", (fields) => {
    const meta = { agentRuntimeType: "hermes_local", command: "hermes", ...fields };
    const payload = buildHeartbeatAdapterInvokePayload({ meta: meta as never, runtimeSkills: [] });
    expect(payload.prompt).toBe(fields.prompt);
    if ("agentInstructionStack" in fields) expect(payload.agentInstructionStack).toBe(fields.agentInstructionStack);
    else expect(payload).not.toHaveProperty("agentInstructionStack");
    expect(meta).toEqual({ agentRuntimeType: "hermes_local", command: "hermes", ...fields });
  });

  it("compares sanitized persistence text and leaves distinct runtime annotations untouched", () => {
    const section = (quote: string) => `User-provided response annotations:\n${quote}\n\nConversation input:\nuser: same request`;
    const meta = { agentRuntimeType: "hermes_local", command: "hermes", prompt: section("PRIVATE_QUOTE_A"),
      agentInstructionStack: section("PRIVATE_QUOTE_B") };
    const before = structuredClone(meta);
    const payload = buildHeartbeatAdapterInvokePayload({ meta, runtimeSkills: [] });
    expect(payload.prompt).toContain("response annotation content redacted for persistence");
    expect(payload.prompt).toContain("user: same request");
    expect(payload).not.toHaveProperty("agentInstructionStack");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_QUOTE");
    expect(meta).toEqual(before);
  });

  it("does not delete invocation text on native mode without asynchronous readback proof", () => {
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

    expect(persisted.prompt).toBe(legacyPayload.prompt);
    expect(persisted.agentInstructionStack).toBe(legacyPayload.prompt);
    expect(persisted.context).toEqual({ chatMode: true, runtimeMetadata: { body: privateContext } });
    expect(invocationContent).toMatchObject({
      textStored: true,
      textSource: "persisted_invocation_inline",
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
    expect(serialized).toContain("PRIVATE_NATIVE_CONTEXT_");

    const legacySerialized = JSON.stringify(redactCurrentUserValue(legacyPayload));
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(Buffer.byteLength(legacySerialized));
  });

  it("retains distinct native text until snapshot equivalence is actually proven", () => {
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

    expect(persisted.prompt).toBe(prompt);
    expect(persisted.agentInstructionStack).toBe(instructionStack);
    expect(promptSummary.sanitizedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stackSummary.sanitizedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stackSummary).not.toHaveProperty("sameAsPrompt");
    expect(serialized).toContain(prompt);
    expect(serialized).toContain(instructionStack);
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
