import { describe, expect, it } from "vitest";
import { isNativeTranscriptSource, markLegacyTranscriptSource } from "./transcript-source.js";

describe("transcript source classification", () => {
  it("keeps an explicitly native run native even when its span is missing", () => {
    expect(isNativeTranscriptSource({
      contextSnapshot: { transcriptSource: "native" },
    })).toBe(true);
  });

  it("treats a run span and context handoff as native sources", () => {
    expect(isNativeTranscriptSource({}, { hasRuntimeSpan: true })).toBe(true);
    expect(isNativeTranscriptSource({}, { bindingContinuity: "context_handoff" })).toBe(true);
  });

  it("leaves an unmarked legacy run eligible for its old log", () => {
    expect(isNativeTranscriptSource({
      contextSnapshot: { transcriptSource: "legacy" },
      resultJson: { summary: "legacy result" },
    })).toBe(false);
  });

  it("honors persisted legacy retention ahead of a span and native binding continuity", () => {
    expect(isNativeTranscriptSource({
      contextSnapshot: { transcriptSource: "legacy", runtimeBindingId: "binding-1" },
    }, { hasRuntimeSpan: true, bindingContinuity: "native" })).toBe(false);
    expect(isNativeTranscriptSource({
      resultJson: { retention: { transcriptSource: "legacy" } },
    }, { hasRuntimeSpan: true, bindingContinuity: "context_handoff" })).toBe(false);
    expect(isNativeTranscriptSource({
      contextSnapshot: { transcriptSource: "native" },
    }, { hasRuntimeSpan: true, bindingContinuity: "legacy" })).toBe(false);
  });

  it("marks legacy retention without replacing the persisted result payload", () => {
    const resultJson = {
      stdout: "original stdout",
      summary: "provider summary",
      retention: { rawResultPersisted: true, providerPolicy: "keep" },
    };
    const persisted = markLegacyTranscriptSource(resultJson);

    expect(persisted).toEqual({
      stdout: "original stdout",
      summary: "provider summary",
      retention: {
        rawResultPersisted: true,
        providerPolicy: "keep",
        transcriptSource: "legacy",
      },
    });
    expect(isNativeTranscriptSource({ resultJson: persisted }, {
      hasRuntimeSpan: true,
      bindingContinuity: "native",
    })).toBe(false);
  });
});
