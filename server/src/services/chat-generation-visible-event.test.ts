import { describe, expect, it } from "vitest";
import { createVisibleEventPayload } from "./chat-generation-visible-event.js";

const bodyHash = "a".repeat(64);

describe("native generation visibility checkpoints", () => {
  it("keeps only source locators and the body hash, never raw process fields", () => {
    const raw = "native-process-marker-".repeat(16_384);
    const payload = createVisibleEventPayload({
      eventKind: "transcript",
      transcriptSource: "native",
      payload: {
        runId: "run-1",
        spanId: "span-1",
        entry: { kind: "thinking", text: raw },
        stdout: raw,
        toolOutput: raw,
        recoveryCheckpoint: { text: raw },
      },
    }, bodyHash);

    expect(payload).toEqual({ source: "native", runId: "run-1", spanId: "span-1", bodyHash });
    expect(JSON.stringify(payload)).not.toContain("native-process-marker-");
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(256);
  });

  it("does not forward malformed native locators or nested raw data", () => {
    expect(createVisibleEventPayload({
      eventKind: "transcript",
      transcriptSource: "native",
      payload: { runId: { text: "raw" }, spanId: ["raw"], entry: { text: "raw" } },
    }, bodyHash)).toEqual({ source: "native", bodyHash });
  });

  it("preserves legacy recovery evidence rather than applying native-only stripping", () => {
    const entry = { kind: "tool_result", content: "legacy tool output" };
    expect(createVisibleEventPayload({
      eventKind: "transcript",
      transcriptSource: "legacy",
      payload: { entry },
    }, bodyHash)).toEqual({ entry, bodyHash });
  });
});
