import type { TranscriptEntry } from "@/agent-runtimes";
import { describe, expect, it } from "vitest";
import { projectReaderTranscriptEntries } from "./native-presentation";
import { normalizeTranscript } from "./RunTranscriptView.normalize";

const ts = "2026-10-02T03:11:56.000Z";
const native = (entry: Record<string, unknown>) => entry as TranscriptEntry;

describe("shared native Reader presentation", () => {
  it("projects tool-only Hermes assistant rows without requiring text or changing Raw", () => {
    const raw = [
      native({ kind: "user", role: "user", rowId: 1, sessionId: "session", ts,
        sourceEntryId: "user", text: "Conversation input: private structured prompt" }),
      native({ kind: "assistant", role: "assistant", rowId: 2, sessionId: "session", ts,
        sourceEntryId: "call", reasoningContent: "Checking identity", toolCalls: [
          { id: "tool-1", function: { name: "tool_describe", arguments: "{}" } },
        ] }),
      native({ kind: "hermes:db:tool", ts, sourceEntryId: "result", toolCallId: "tool-1",
        toolName: "tool_describe", text: "Tool description" }),
      native({ kind: "assistant", role: "assistant", rowId: 4, sessionId: "session", ts,
        sourceEntryId: "final", text: "Done" }),
    ];
    const before = JSON.stringify(raw);
    const presented = projectReaderTranscriptEntries(raw);
    expect(presented.map((entry) => [entry.kind, entry.sourceEntryId])).toEqual([
      ["thinking", "call"], ["tool_call", "call"], ["tool_result", "result"], ["assistant", "final"],
    ]);
    expect(presented.filter((entry) => entry.kind === "assistant").map((entry) => entry.text.replace(/\s+$/u, "")))
      .toEqual(["Done"]);
    const tools = normalizeTranscript(presented, false).filter((block) => block.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: "completed", sourceEntryIds: ["call", "result"] });
    expect(JSON.stringify(raw)).toBe(before);
    expect(raw[1]).not.toHaveProperty("text");
  });

  it("detects an assistant-only Hermes page and preserves canonical supplemental tools", () => {
    const canonicalTool: TranscriptEntry = { kind: "tool_call", ts, name: "shell", input: {}, toolUseId: "supplement" };
    const raw = [native({ kind: "assistant", role: "assistant", rowId: 2, sessionId: "session", ts,
      toolCalls: [{ id: "native", function: { name: "tool_describe", arguments: "{}" } }] }), canonicalTool];
    expect(projectReaderTranscriptEntries(raw)).toEqual([
      { kind: "tool_call", ts, name: "tool_describe", input: "{}", toolUseId: "native", sourceEntryId: undefined },
      canonicalTool,
    ]);
  });

  it("passes canonical Codex and legacy entries through without reinterpretation", () => {
    const canonical: TranscriptEntry[] = [
      { kind: "user", ts, text: "Human message" },
      { kind: "thinking", ts, text: "Working" },
      { kind: "assistant", ts, text: "Done", phase: "final_answer" },
    ];
    expect(projectReaderTranscriptEntries(canonical)).toBe(canonical);
  });
});
