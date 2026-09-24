import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  boundNativeHeartbeatTranscriptMemory,
  resolveHeartbeatTranscriptRetention,
  retainNativeHeartbeatResultJson,
  transcriptForHeartbeatRetention,
} from "./heartbeat-transcript-retention.js";

const entry = (text: string): TranscriptEntry => ({
  kind: "assistant",
  ts: "2026-09-22T00:00:00.000Z",
  text,
});

describe("heartbeat transcript retention", () => {
  it("keeps legacy persistence when native identity or capability is not proven", () => {
    expect(resolveHeartbeatTranscriptRetention({ hasBinding: false }).persistRawLog).toBe(true);
    expect(resolveHeartbeatTranscriptRetention({
      hasBinding: true,
      bindingContinuity: "native",
      capabilityStatus: "unknown",
    }).persistRawTranscript).toBe(true);
    expect(resolveHeartbeatTranscriptRetention({
      hasBinding: true,
      bindingContinuity: "context_handoff",
      capabilityStatus: "supported",
    }).persistRawResult).toBe(true);
  });

  it("disables duplicate raw persistence only for a proven native source", () => {
    const policy = resolveHeartbeatTranscriptRetention({
      hasBinding: true,
      bindingContinuity: "native",
      capabilityStatus: "supported",
    });
    expect(policy).toMatchObject({
      mode: "native",
      persistRawLog: false,
      persistRawTranscript: false,
      persistRawTranscriptEvent: false,
      persistRawResult: false,
    });
    expect(transcriptForHeartbeatRetention(policy, [entry("hidden raw")])).toEqual([]);
  });

  it("retains bounded diagnostics without copying native transcript-shaped fields", () => {
    const retained = retainNativeHeartbeatResultJson({
      sessionId: "session-1",
      stdout: "full stdout transcript",
      events: [{ text: "full event history" }],
      summary: "short result",
      nested: { providerVersion: "1.2.3" },
    });
    expect(retained).toMatchObject({
      summary: "short result",
      nested: { providerVersion: "1.2.3" },
      retention: { rawTranscriptPersisted: false },
    });
    expect(retained).not.toHaveProperty("stdout");
    expect(retained).not.toHaveProperty("events");
  });

  it("bounds native execution transcript memory while preserving the newest entries", () => {
    const byEntryCount = Array.from({ length: 129 }, (_, index) => entry(`message ${index}`));
    boundNativeHeartbeatTranscriptMemory(byEntryCount);
    expect(byEntryCount).toHaveLength(128);
    expect(byEntryCount[0]).toEqual(entry("message 1"));
    expect(byEntryCount[byEntryCount.length - 1]).toEqual(entry("message 128"));

    const bySerializedBytes = [
      entry("older ".repeat(15_000)),
      entry("newest ".repeat(8_000)),
    ];
    boundNativeHeartbeatTranscriptMemory(bySerializedBytes);
    expect(bySerializedBytes).toEqual([entry("newest ".repeat(8_000))]);
  });
});
