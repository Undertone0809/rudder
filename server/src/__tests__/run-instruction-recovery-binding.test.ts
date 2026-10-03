import type { Db } from "@rudderhq/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverCodexDeveloperInstructions } from "../services/run-instruction-recovery.js";
import { readRecoveredRunDeveloperInstructions } from "../services/run-instruction-snapshots.js";

vi.mock("../services/run-instruction-recovery.js", () => ({ recoverCodexDeveloperInstructions: vi.fn() }));
const orgId = "22222222-2222-4222-8222-222222222222";
const runId = "11111111-1111-4111-8111-111111111111";
const revision = "a".repeat(64);
function fixture() {
  const sessionIntent = { sessionId: "session", sessionParams: {
    transport: "codex_app_server", profileOrgId: orgId, profileBindingId: "binding", profileHostId: "local",
    profileId: "default", workspaceBindingId: "workspace", capabilityRevision: "cap",
    threadId: "session", sessionId: "session", rudderChatDeveloperInstructionsRevision: revision,
  } };
  return {
    agentId: "agent", sessionIntent,
    attempt: { id: "attempt", agentId: "agent", runtimeType: "codex_local", status: "succeeded", finishedAt: new Date(),
      submissionPhase: "accepted", providerThreadId: "session", providerTurnId: "turn",
      sessionParamsJson: { ...sessionIntent.sessionParams },
    },
    context: { runtimeBindingId: "binding", runtimeSegmentId: "segment",
      runtimeProviderProfile: { runtimeType: "codex_local", codexHome: "/profile" },
      unifiedAgentRun: { runtimeBindingId: "binding", runtimeSegmentId: "segment", runtimeType: "codex_local", agentId: "agent", sessionIntent },
    },
    binding: { id: "binding", agentId: "agent", runtimeType: "codex_local", continuity: "native", hostId: "local", profileId: "default", workspaceBindingId: "workspace", capabilityRevision: "cap" },
    segment: { id: "segment", runtimeType: "codex_local", nativeSessionId: "session" },
    span: { id: "span", relation: "primary", selectorJson: { kind: "codex_turn", runId, threadId: "session", turnId: "turn" } },
  };
}
function dbFor(row: unknown, snapshotStatus?: string) {
  const rows = [[{ payload: { agentRuntimeType: "codex_local", invocationAttemptId: "attempt", invocationSpanId: "span",
    ...(snapshotStatus ? { invocationInstructionSnapshot: { status: snapshotStatus } } : {}),
  } }], row ? [row] : []];
  const query: any = {};
  for (const method of ["from", "innerJoin", "where"]) query[method] = () => query;
  query.limit = async () => rows.shift() ?? [];
  return { select: () => query } as unknown as Db;
}
const read = (db: Db) => readRecoveredRunDeveloperInstructions({ db, orgId, runId, eventId: 6 });

describe("historical instruction recovery binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recoverCodexDeveloperInstructions).mockResolvedValue({ text: "verified", sha256: revision, byteSize: 8 });
  });
  it("returns a distinct partial result, never a snapshot or full stack", async () => {
    const value = await read(dbFor(fixture()));
    expect(value).toMatchObject({ source: "codex_native_rollout", completeness: "partial", snapshotStatus: "missing", developerInstructions: "verified" });
    expect(value).not.toHaveProperty("agentInstructionStack");
    expect(recoverCodexDeveloperInstructions).toHaveBeenCalledWith(expect.objectContaining({ persistedHome: "/profile", sha256: revision, sessionId: "session", turnId: "turn" }));
  });
  it("never falls back from an available but unreadable snapshot", async () => {
    expect(await read(dbFor(fixture(), "available"))).toBeNull();
    expect(recoverCodexDeveloperInstructions).not.toHaveBeenCalled();
  });
  it("rejects a missing exact Run/Attempt/Span join", async () => {
    expect(await read(dbFor(null))).toBeNull();
    expect(recoverCodexDeveloperInstructions).not.toHaveBeenCalled();
  });
  it.each(["org", "binding", "agent", "session", "run", "profile", "runtime", "segment", "revision", "host"])("rejects mismatched %s identity before filesystem access", async (field) => {
    const row = fixture();
    switch (field) {
      case "org": row.attempt.sessionParamsJson.profileOrgId = "other"; break;
      case "binding": row.attempt.sessionParamsJson.profileBindingId = "other"; break;
      case "agent": row.binding.agentId = "other"; break;
      case "session": row.span.selectorJson.threadId = "other"; break;
      case "run": row.span.selectorJson.runId = "other"; break;
      case "profile": row.binding.profileId = "other"; break;
      case "runtime": row.binding.runtimeType = "claude_local"; break;
      case "segment": row.context.runtimeSegmentId = "other"; break;
      case "revision": row.binding.capabilityRevision = "other"; break;
      case "host": row.binding.hostId = "remote"; break;
    }
    expect(await read(dbFor(row))).toBeNull();
    expect(recoverCodexDeveloperInstructions).not.toHaveBeenCalled();
  });
  it("uses revision B from the exact resulting Attempt after same-session A to B instructions", async () => {
    const row = fixture();
    const revisionB = "b".repeat(64);
    row.attempt.sessionParamsJson.rudderChatDeveloperInstructionsRevision = revisionB;
    // Incoming intent still records A; a later Segment can already hold C.
    Object.assign(row.segment, { providerStateJson: { rudderChatDeveloperInstructionsRevision: "c".repeat(64) } });
    await read(dbFor(row));
    expect(recoverCodexDeveloperInstructions).toHaveBeenCalledWith(expect.objectContaining({ sha256: revisionB, sessionId: "session", turnId: "turn" }));
    expect(row.sessionIntent.sessionParams.rudderChatDeveloperInstructionsRevision).toBe(revision);
  });
  it.each([
    ["result params", { sessionParamsJson: null }],
    ["result revision", { sessionParamsJson: { ...fixture().attempt.sessionParamsJson, rudderChatDeveloperInstructionsRevision: undefined } }],
    ["provider session", { providerThreadId: "other" }],
    ["provider turn", { providerTurnId: "other" }],
    ["missing provider turn", { providerTurnId: null }],
    ["attempt runtime", { runtimeType: "claude_local" }],
    ["attempt agent", { agentId: "other" }],
    ["unfinished attempt", { finishedAt: null }],
    ["running attempt", { status: "started" }],
    ["unaccepted attempt", { submissionPhase: "indeterminate" }],
  ])("fails closed without exact Attempt authority: %s", async (_name, patch) => {
    const row = fixture();
    Object.assign(row.attempt, patch);
    expect(await read(dbFor(row))).toBeNull();
    expect(recoverCodexDeveloperInstructions).not.toHaveBeenCalled();
  });
});
