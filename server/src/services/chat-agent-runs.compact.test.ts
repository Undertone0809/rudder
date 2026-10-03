import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { runRuntimeSpans } from "@rudderhq/db";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { resolveChatTranscriptRetention, withNativeSupplementProfile } from "./chat-assistant.transcript-delivery.js";
import type { HeartbeatTranscriptRetentionInput } from "./runtime-kernel/heartbeat-transcript-retention.js";
import { createTranscriptObjectStore } from "./runtime-kernel/transcript-object-store.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./runtime-kernel/transcript-reader.test-support.js";

const authority = vi.hoisted(() => ({ entry: null as unknown }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("./live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("./runtime-kernel/unified-agent-run.integration.js", async importOriginal => ({
  ...await importOriginal<typeof import("./runtime-kernel/unified-agent-run.integration.js")>(),
  createHeartbeatUnifiedAgentRunAdapter: () => ({ get: async () => authority.entry }),
}));

// Actual service/attachment/store call chain with modeled DB authority, NOT PG
// or provider evidence. No caller extraction, loader, model or user-config flag.
describe("actual Chat caller first-write eligibility", () => {
  it.each(["qualified", "missing-proof", "profile-unknown", "profile-mismatch", "range-pending", "pending-then-known", "session-mismatch", "attempt-mismatch", "owner-lost", "legacy-existing"])(
    "%s does not widen the native/owner/range gate or switch existing refs", async mode => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-compact-chat-caller-"));
      try {
        const store = createTranscriptObjectStore(root);
        const run = { id: "run-1", orgId: "org-1", agentId: "agent-1", runtimeSpanId: "span-1",
          runtimeSpanOwnerToken: "owner-1", runtimeSpanAttemptEpoch: 1, runtimeAttemptRef: { id: "attempt-1", attemptIndex: 1 } };
        const fence = { id: "span-1", ownerToken: "owner-1", attemptEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60_000) };
        authority.entry = { orgId: run.orgId, runId: run.id, ownerFence: { ...fence, ownerToken: mode === "owner-lost" ? "successor" : "owner-1" },
          span: { id: "span-1" }, attempt: { ref: run.runtimeAttemptRef } };
        const selector = { kind: "codex_turn", runId: run.id, threadId: "thread-1", turnId: "turn-1" };
        const span = databaseSpan("span-1", { orgId: run.orgId, state: "open", ownerToken: "owner-1", attemptEpoch: 1,
          selectorJson: mode === "range-pending" || mode === "pending-then-known" ? { kind: "pending" } : selector,
          attemptId: mode === "attempt-mismatch" ? "other-attempt" : "attempt-1", nativeExecutionRef: "turn-1" });
        const binding = databaseBinding("span-1", { runtimeType: "codex_local", status: "active", continuity: "native",
          hostId: "host-1", profileId: "profile-1", workspaceBindingId: "workspace-1", capabilityRevision: "cap-1" });
        const profileBinding = { orgId: run.orgId, hostId: "host-1", profileId: "profile-1", workspaceBindingId: "workspace-1", capabilityRevision: "cap-1" };
        const profile = { runtimeType: "codex_local", binding: profileBinding, driverStatus: "supported",
          resolution: { runtimeType: "codex_local", binding: profileBinding, profileResolved: true,
            adapter: { runtimeType: "codex_local", transcript: { evidence: { status: "supported", profileBound: true, reason: "synthetic profile" },
              readRange: async () => { throw new Error("fixture must not invoke provider"); } } } } } as NonNullable<HeartbeatTranscriptRetentionInput["profileCapability"]>;
        if (mode === "profile-unknown") profile.resolution!.profileResolved = false;
        if (mode === "profile-mismatch") binding.profileId = "other-profile";
        if (mode === "legacy-existing") {
          const old = await store.begin({ orgId: run.orgId, runId: run.id, spanId: "span-1", ownerToken: "owner-1" });
          span.supplementalObjectRef = old.objectRef;
        }
        const originalRef = span.supplementalObjectRef;
        const base = mockDatabase({ run: databaseRun({ status: "running", executionOwnerToken: "owner-1", executionLeaseExpiresAt: fence.leaseExpiresAt }), spans: [span], bindings: [binding],
          segments: [databaseSegment("span-1", { runtimeType: "codex_local", nativeSessionId: mode === "session-mismatch" ? "other-thread" : "thread-1" })] });
        const db = { ...base, execute: vi.fn(async () => undefined), transaction: async (fn: (tx: unknown) => unknown) => fn(db),
          update: (table: unknown) => {
            expect(table).toBe(runRuntimeSpans);
            let changes: Record<string, unknown> = {};
            const q = { set: (value: Record<string, unknown>) => { changes = value; return q; }, where: () => q,
              returning: async () => { Object.assign(span, changes); return [span]; } };
            return q;
          } };
        const runs = chatAgentRunService(db as never, { transcriptObjectStore: store });
        const entry: TranscriptEntry = { kind: "assistant", ts: "2026-10-03T00:00:00.123456Z", sourceEntryId: "entry-1", text: "synthetic界🌍".repeat(1000) };
        const host = resolveChatTranscriptRetention({ hasBinding: true, bindingContinuity: "native", capabilityStatus: "supported",
          profileCapability: mode === "missing-proof" ? null : profile });
        const append = withNativeSupplementProfile((value, delivery) => runs.appendTranscriptEntry(run, value, delivery), host.profileCapability);
        const call = append(entry, { source: "native", runId: run.id, spanId: "span-1", persistRaw: false, persistSupplement: true });
        if (mode === "owner-lost") {
          await expect(call).rejects.toThrow("stale");
          expect(await fs.readdir(root)).toEqual([]);
          return;
        }
        await call;
        const ref = String(span.supplementalObjectRef);
        if (mode === "pending-then-known") {
          // Real fresh admission starts pending; a terminal selector arriving
          // later is NOT permission to upgrade/switch the already attached ref.
          span.selectorJson = selector;
          await runs.appendTranscriptEntry(run, entry, { persistRaw: false, nativeProfileCapability: profile });
          expect(span.supplementalObjectRef).toBe(ref);
          const reopenedRuns = chatAgentRunService(db as never, { transcriptObjectStore: createTranscriptObjectStore(root) });
          await reopenedRuns.appendTranscriptEntry(run, entry, { persistRaw: false, nativeProfileCapability: profile });
          expect(span.supplementalObjectRef).toBe(ref);
        }
        if (originalRef) expect(ref).toBe(originalRef);
        const meta = JSON.parse(await fs.readFile(path.join(root, "transcript-objects", ref + ".json"), "utf8"));
        expect(meta.encoding).toBe(mode === "qualified" ? "codex-gap-dictionary-v1" : undefined);
        expect((await store.readRange({ ...run, runId: run.id, spanId: "span-1", ownerToken: "owner-1", objectRef: ref })).entries)
          .toEqual(mode === "pending-then-known" ? [entry, entry, entry] : [entry]);
      } finally { authority.entry = null; await fs.rm(root, { recursive: true, force: true }); }
    });
});
