import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { describe, expect, it } from "vitest";
import {
  boundNativeHeartbeatTranscriptMemory,
  hasVerifiedHeartbeatNativeTranscriptProfile,
  resolveHeartbeatTranscriptRetention,
  retainNativeHeartbeatResultJson,
  transcriptForHeartbeatRetention,
} from "./heartbeat-transcript-retention.js";

const entry = (text: string): TranscriptEntry => ({
  kind: "assistant",
  ts: "2026-09-22T00:00:00.000Z",
  text,
});

const binding = {
  id: "binding-1",
  orgId: "org-1",
  hostId: "host-1",
  profileId: "profile-1",
  workspaceBindingId: "workspace-1",
  capabilityRevision: "revision-1",
};

function profileCapability(overrides: {
  driverStatus?: "supported" | "unsupported" | "unknown";
  runtimeType?: string;
  resolvedRuntimeType?: string;
  profileResolved?: boolean;
  binding?: typeof binding;
  evidence?: { status: "supported" | "unsupported" | "unknown"; profileBound: boolean };
  hasReadRange?: boolean;
} = {}) {
  const runtimeType = overrides.runtimeType ?? "codex_local";
  const resolvedRuntimeType = overrides.resolvedRuntimeType ?? runtimeType;
  const evidence = overrides.evidence ?? { status: "supported" as const, profileBound: true };
  return {
    runtimeType,
    binding,
    driverStatus: overrides.driverStatus ?? "supported" as const,
    resolution: {
      adapter: {
        runtimeType: resolvedRuntimeType,
        transcript: {
          evidence: { ...evidence, reason: "profile-bound exact native history reader" },
          ...(overrides.hasReadRange === false ? {} : { readRange: async () => ({ items: [] }) }),
        },
      },
      binding: overrides.binding ?? binding,
      profileResolved: overrides.profileResolved ?? true,
    },
  };
}

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
      profileCapability: profileCapability(),
    }).persistRawResult).toBe(true);
  });

  it("uses verified profile-bound recovery capability to suppress execution-time raw mirrors", () => {
    const profile = profileCapability();
    expect(hasVerifiedHeartbeatNativeTranscriptProfile(profile)).toBe(true);
    const policy = resolveHeartbeatTranscriptRetention({
      hasBinding: true,
      bindingContinuity: "native",
      capabilityStatus: "supported",
      profileCapability: profile,
    });
    expect(policy).toMatchObject({
      mode: "native",
      persistRawLog: false,
      persistRawTranscript: false,
      persistRawTranscriptEvent: false,
      persistRawResult: false,
    });
    expect(transcriptForHeartbeatRetention(policy, [entry("hidden raw")])).toEqual([]);

    const unverifiedProfiles = [
      null,
      profileCapability({ driverStatus: "unknown" }),
      profileCapability({ driverStatus: "unsupported" }),
      profileCapability({ profileResolved: false }),
      profileCapability({ resolvedRuntimeType: "hermes_gateway" }),
      profileCapability({ binding: { ...binding, profileId: "different-profile" } }),
      profileCapability({ evidence: { status: "unknown", profileBound: true } }),
      profileCapability({ evidence: { status: "unsupported", profileBound: true } }),
      profileCapability({ evidence: { status: "supported", profileBound: false } }),
      profileCapability({ hasReadRange: false }),
    ];
    for (const profileCapabilityEvidence of unverifiedProfiles) {
      expect(resolveHeartbeatTranscriptRetention({
        hasBinding: true,
        bindingContinuity: "native",
        capabilityStatus: "supported",
        profileCapability: profileCapabilityEvidence,
      })).toMatchObject({
        mode: "legacy",
        reason: "native_profile_unverified",
        persistRawLog: true,
        persistRawTranscript: true,
        persistRawTranscriptEvent: true,
        persistRawResult: true,
      });
    }
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
    expect(retainNativeHeartbeatResultJson({
      retention: { transcriptSource: "legacy", rawResultPersisted: true },
      summary: "completed",
    })).toMatchObject({
      retention: { transcriptSource: "native", rawResultPersisted: false },
      summary: "completed",
    });
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
