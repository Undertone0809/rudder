import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  goals,
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  organizations,
  organizationSkills,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatAgentRunService } from "../services/chat-agent-runs.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { getRunSummary } from "../services/run-intelligence.ts";
import { createCursorTranscriptSupplementCapture } from "../services/runtime-kernel/cursor-transcript-supplement.ts";
import { attachRuntimeSpanSupplement, currentNativeSession, ensureRuntimeBinding } from "../services/runtime-kernel/native-session.ts";
import { persistNativeTransportProfile } from "../services/runtime-kernel/native-transport-profile.ts";
import { createTranscriptObjectReader, createTranscriptObjectStore, type TranscriptObjectStore } from "../services/runtime-kernel/transcript-object-store.ts";
import { createTranscriptReader, type NativeTranscriptReadInput } from "../services/runtime-kernel/transcript-reader.ts";
import { createHeartbeatUnifiedAgentRunAdapter } from "../services/runtime-kernel/unified-agent-run.integration.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_CHAT_AGENT_RUNS_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-agent-runs-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("chatAgentRunService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof chatAgentRunService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let objectDir = "";
  let objectStore: TranscriptObjectStore;

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    objectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-transcript-objects-"));
    objectStore = createTranscriptObjectStore(objectDir);
    svc = chatAgentRunService(db, { transcriptObjectStore: objectStore });
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatMessages);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(runRuntimeSpans);
    await db.delete(nativeSegments);
    await db.delete(runtimeBindings);
    await db.delete(chatConversations);
    await db.delete(goals);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(organizationSkills);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (objectDir) fs.rmSync(objectDir, { recursive: true, force: true });
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function createChatRunFixture(
    label: string,
    maxConcurrentRuns?: number,
    runService = svc,
    runtimeType: "codex_local" | "cursor" | "pi_local" = "codex_local",
  ) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const name = `${label} org`;
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(name),
      issuePrefix: "SUB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: `${label} agent`,
      role: "engineer",
      status: "active",
      agentRuntimeType: runtimeType,
      agentRuntimeConfig: {},
      runtimeConfig: maxConcurrentRuns === undefined ? {} : { heartbeat: { maxConcurrentRuns } },
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: `${label} chat`,
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType,
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    return runService.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: randomUUID(),
      ...(runtimeType === "pi_local" ? { runContext: {
        transcriptSource: "legacy",
        runtimeProviderProfile: { runtimeType: "pi_local", providerVersion: "0.76.0" },
      } } : {}),
    });
  }

  async function attestPiNativeTranscriptSource(run: Awaited<ReturnType<typeof createChatRunFixture>>) {
    await persistNativeTransportProfile(db, {
      orgId: run.orgId,
      runId: run.id,
      spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
      attemptEpoch: run.runtimeSpanAttemptEpoch!,
      attemptId: run.runtimeAttemptRef!.id,
      nativeTranscriptAttested: true,
      profile: {
        runtimeType: "pi_local",
        command: "pi",
        cwd: "/workspace",
        sessionDir: "/managed/sessions",
        providerVersion: "0.76.0",
        rpcArgs: ["--extension", "/managed/rudder-tools.ts"],
        rpcEnv: { HOME: "/operator" },
      },
    });
  }

  it("captures Cursor updates with durable occurrence IDs on one fenced span across writer restart", async () => {
    const run = await createChatRunFixture("Cursor transcript capture", undefined, svc, "cursor");
    const scope = { orgId: run.orgId, runId: run.id, spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!, attemptEpoch: run.runtimeSpanAttemptEpoch! };
    const capture = createCursorTranscriptSupplementCapture(db, objectStore);
    const repeated = { kind: "assistant" as const, ts: "2026-09-24T00:00:00.000Z", text: "Again ", delta: true };
    await capture.append(scope, [repeated, repeated]);
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, scope.spanId));
    const ref = span!.supplementalObjectRef!;
    expect(ref).toBeTruthy();
    const input = { objectRef: ref, orgId: scope.orgId, runId: scope.runId,
      spanId: scope.spanId, ownerToken: scope.ownerToken };
    const first = await objectStore.readRange(input);
    expect(first.entries).toHaveLength(2);
    const ids = first.entries.map((entry) => entry.sourceEntryId);
    expect(new Set(ids).size).toBe(2);
    await expect(capture.append({ ...scope, ownerToken: "stale" }, [repeated])).rejects.toThrow("stale");
    await expect(capture.append({ ...scope, orgId: randomUUID() }, [repeated])).rejects.toThrow("stale");
    const resumed = createCursorTranscriptSupplementCapture(db, objectStore);
    await resumed.append(scope, [repeated]);
    await resumed.seal();
    const after = await objectStore.readRange(input);
    expect(after.entries.map((entry) => entry.sourceEntryId).slice(0, 2)).toEqual(ids);
    expect(new Set(after.entries.map((entry) => entry.sourceEntryId)).size).toBe(3);
    expect(after.completeness).toBe("partial");
    expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id))).some(
      (event) => JSON.stringify(event).includes("Again "),
    )).toBe(false);
  });

  it("switches a live Cursor Run transcript source only for its current span owner", async () => {
    const run = await createChatRunFixture("Cursor source switch", undefined, svc, "cursor");
    const prompt = "Cursor transcript fallback keeps complete invocation evidence";
    await svc.appendAdapterInvoke(run, {
      agentRuntimeType: "cursor", command: "cursor", prompt,
      agentInstructionStack: prompt, context: { fallbackReason: "profile transcript unavailable" },
    }, []);
    const stale = { ...run, runtimeSpanOwnerToken: randomUUID() };
    expect(await svc.markLegacyTranscriptSource(stale)).toBe(false);
    const [before] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect((before?.contextSnapshot as Record<string, unknown>)?.transcriptSource).not.toBe("legacy");

    expect(await svc.markLegacyTranscriptSource(run)).toBe(true);
    const [updated] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect((updated?.contextSnapshot as Record<string, unknown>)?.transcriptSource).toBe("legacy");

    await svc.sealSpan(run, { completeness: "complete" });
    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed" },
      transcriptDelivery: { source: "legacy", spanId: run.runtimeSpanId! },
    });
    const [invoke] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(invoke?.payload).toMatchObject({ prompt, agentInstructionStack: prompt });
    expect(await svc.markLegacyTranscriptSource(run)).toBe(false);
  });

  it("attests a fresh Pi transcript only with a complete fenced Host RPC profile", async () => {
    const run = await createChatRunFixture("Pi first-run source", undefined, svc, "pi_local");
    const input = {
      orgId: run.orgId, runId: run.id, spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!, attemptEpoch: run.runtimeSpanAttemptEpoch!,
      attemptId: run.runtimeAttemptRef!.id, nativeTranscriptAttested: true,
      profile: { runtimeType: "pi_local", command: "pi", cwd: "/workspace",
        sessionDir: "/managed/sessions", rpcArgs: ["--extension", "/managed/rudder-tools.ts"],
        rpcEnv: { HOME: "/operator" } },
    };
    await expect(persistNativeTransportProfile(db, { ...input, profile: {
      ...input.profile, rpcArgs: [],
    } })).rejects.toThrow("complete Host RPC profile");
    await expect(persistNativeTransportProfile(db, { ...input, ownerToken: "stale" }))
      .rejects.toThrow("stale Run owner");
    const [before] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(before!.contextSnapshot?.transcriptSource).toBe("legacy");

    await persistNativeTransportProfile(db, input);
    const [after] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(after!.contextSnapshot).toMatchObject({
      transcriptSource: "native",
      runtimeProviderProfile: { ...input.profile, providerVersion: "0.76.0" },
    });
    await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { outcome: "completed" } });
    await expect(persistNativeTransportProfile(db, input)).rejects.toThrow("stale Run owner");
  });

  it("compacts adapter invocation and terminal result only after final native source and span attestation", async () => {
    const run = await createChatRunFixture("Native invocation retention", undefined, svc, "pi_local");
    const prompt = `Chat prompt ${"p".repeat(20_000)}`;
    const instructionStack = `Instruction stack ${"i".repeat(12_000)}`;
    const productReply = "Useful bounded product reply ".repeat(120);
    const earlierAttemptPrompt = "earlier fallback attempt remains fully auditable";
    await svc.appendAdapterInvoke({
      ...run,
      runtimeSpanId: "earlier-attempt-span",
      runtimeAttemptRef: { id: "earlier-attempt-id", attemptIndex: 0 },
    }, {
      agentRuntimeType: "claude_local",
      command: "claude",
      prompt: earlierAttemptPrompt,
      agentInstructionStack: earlierAttemptPrompt,
      context: { fallbackAttempt: true },
    }, []);
    await svc.appendAdapterInvoke(run, {
      agentRuntimeType: "pi_local",
      command: "pi",
      prompt,
      agentInstructionStack: instructionStack,
      context: { chatMode: true, privatePromptContext: "private context marker" },
      loadedSkills: [{ key: "run-skill", name: "Run skill" }],
      usedSkills: [{ key: "proof-skill", name: "Proof skill" }],
    }, [{ key: "run-skill", runtimeName: "run-skill", name: "Run skill", description: "Loaded for this run" }]);

    const stagedEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    const stagedEvent = stagedEvents.find((event) => event.payload?.invocationAttemptId === run.runtimeAttemptRef!.id);
    expect(stagedEvent?.payload).toMatchObject({ prompt, agentInstructionStack: instructionStack });
    expect(stagedEvent?.seq).toBeTruthy();

    await attestPiNativeTranscriptSource(run);
    await svc.sealSpan(run, { completeness: "complete" });
    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: {
        outcome: "completed",
        kind: "message",
        body: productReply,
        generatedAttachmentCount: 2,
      },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });

    const compactedEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    const compactedEvent = compactedEvents.find((event) => event.payload?.invocationAttemptId === run.runtimeAttemptRef!.id);
    const earlierInvoke = compactedEvents.find((event) => event.payload?.invocationAttemptId === "earlier-attempt-id");
    const payload = compactedEvent?.payload as Record<string, unknown>;
    const invocationContent = payload.invocationContent as Record<string, unknown>;
    const promptEvidence = invocationContent.prompt as Record<string, unknown>;
    const contextEvidence = invocationContent.context as Record<string, unknown>;
    const [finalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const retainedResult = finalizedRun?.resultJson as Record<string, unknown>;

    expect(compactedEvent?.seq).toBe(stagedEvent?.seq);
    expect(earlierInvoke?.payload).toMatchObject({
      prompt: earlierAttemptPrompt,
      agentInstructionStack: earlierAttemptPrompt,
    });
    expect(payload).not.toHaveProperty("prompt");
    expect(payload).not.toHaveProperty("agentInstructionStack");
    expect(payload).not.toHaveProperty("context");
    expect(JSON.stringify(payload)).not.toContain(prompt);
    expect(JSON.stringify(payload)).not.toContain(instructionStack);
    expect(invocationContent).toMatchObject({ textStored: false, textSource: "agent_run_transcript_reader" });
    expect(promptEvidence).toMatchObject({ present: true, sourceCharacterLength: prompt.length });
    expect(promptEvidence.sanitizedSha256).toBe(createHash("sha256").update(prompt, "utf8").digest("hex"));
    expect(contextEvidence).toMatchObject({ present: true, keys: ["chatMode", "privatePromptContext"] });
    expect(payload.desiredSkillKeys).toEqual(["run-skill"]);
    expect(payload.usedSkillKeys).toEqual(["proof-skill"]);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(8_000);
    expect(retainedResult).toMatchObject({
      outcome: "completed",
      kind: "message",
      body: productReply.slice(0, 2_000),
      productReply: {
        textStored: true,
        characterLength: productReply.length,
        sha256: createHash("sha256").update(productReply, "utf8").digest("hex"),
        truncated: true,
      },
      retention: {
        transcriptSource: "native",
        transcriptSpanId: run.runtimeSpanId,
        rawResultPersisted: false,
        productReplyStored: true,
        productReplyTruncated: true,
      },
    });
  });

  it("does not trust a preflight native hint or compact failure evidence", async () => {
    const run = await createChatRunFixture("Unattested invocation retention");
    const prompt = "full invocation audit remains until final source is attested";
    const preflightMarkedRun = {
      ...run,
      contextSnapshot: { ...run.contextSnapshot, transcriptSource: "native" },
    };
    await svc.appendAdapterInvoke(preflightMarkedRun, {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: prompt,
      context: { chatMode: true, privatePromptContext: "preserve until final policy" },
    }, []);
    await svc.sealSpan(run, { completeness: "complete" });
    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: "unattested result stays full" },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });
    let [event] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(event?.payload).toMatchObject({ prompt, agentInstructionStack: prompt });
    let [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(savedRun?.resultJson).toMatchObject({ body: "unattested result stays full" });
  });

  it("keeps complete invocation and failure result evidence when final status is failed", async () => {
    const failedRun = await createChatRunFixture("Failed native invocation retention", undefined, svc, "pi_local");
    const failurePrompt = "failure audit prompt must remain complete";
    await svc.appendAdapterInvoke(failedRun, {
      agentRuntimeType: "pi_local", command: "pi", prompt: failurePrompt,
      agentInstructionStack: failurePrompt, context: { failureContext: "retain" },
    }, []);
    await attestPiNativeTranscriptSource(failedRun);
    await svc.sealSpan(failedRun, { completeness: "complete" });
    await svc.finalizeRun(failedRun.id, {
      status: "failed",
      resultJson: { outcome: "failed", partialBody: "failure body remains complete" },
      transcriptDelivery: { source: "native", spanId: failedRun.runtimeSpanId! },
    });
    const [event] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, failedRun.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(event?.payload).toMatchObject({ prompt: failurePrompt, agentInstructionStack: failurePrompt });
    const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRun.id));
    expect(savedRun?.resultJson).toMatchObject({ partialBody: "failure body remains complete" });
  });

  it("keeps the full invocation durable while a native Run waits for network recovery", async () => {
    const run = await createChatRunFixture("Network pending invocation", undefined, svc, "pi_local");
    const prompt = "persist complete invocation while waiting for provider recovery";
    await svc.appendAdapterInvoke(run, {
      agentRuntimeType: "pi_local", command: "pi", prompt,
      agentInstructionStack: prompt, context: { retryContext: "preserve" },
    }, []);
    await attestPiNativeTranscriptSource(run);
    await svc.markWaitingForNetwork(run, {
      kind: "network_unavailable",
      submissionPhase: "indeterminate",
      continuation: "resume_same_session",
      transport: "stream_disconnect",
      provider: "pi",
      model: "test-model",
      modelOutputObserved: false,
      toolActivityObserved: false,
      sideEffectRisk: "none",
      message: "provider stream disconnected",
    }, run.runtimeSpanOwnerToken!);

    const [event] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    const [waitingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(event?.payload).toMatchObject({ prompt, agentInstructionStack: prompt });
    expect(waitingRun).toMatchObject({ status: "running", runningSubstate: "waiting_for_network" });
    expect(waitingRun?.resultJson).toBeNull();
    svc.releaseOwnedRun(run.id, run.runtimeSpanOwnerToken);
  });

  it("creates one active run per conversation, finalizes stale runs, and links assistant messages", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const goalId = randomUUID();
    const foreignOrgId = randomUUID();
    const foreignGoalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(organizations).values({
      id: foreignOrgId,
      name: "Other Rudder",
      urlKey: deriveOrganizationUrlKey("Other Rudder"),
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values([
      { id: goalId, orgId, title: "Conversation Goal" },
      { id: foreignGoalId, orgId: foreignOrgId, title: "Foreign Goal" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "pi_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Run-backed chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "pi_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);

    const conversation = {
      id: conversationId,
      orgId,
      primaryIssueId: null,
      planMode: false,
    };

    const firstRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      userMessageId: messageId,
      linkedIssueIds: [],
      linkedProjectId: null,
      linkedGoalId: goalId,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: messageId,
      runtimeModel: null,
    });

    expect(firstRun.status).toBe("running");
    expect(firstRun.invocationSource).toBe("chat");
    expect(firstRun.sessionReuseScope).toBe("none");
    expect(firstRun.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "chat_conversation",
      targetId: conversationId,
      conversationId,
      messageId,
      userMessageId: messageId,
      goalId,
    });
    expect(firstRun.goalId).toBe(goalId);
    const transportInput = {
      orgId, runId: firstRun.id, spanId: firstRun.runtimeSpanId!,
      ownerToken: firstRun.runtimeSpanOwnerToken!,
      attemptEpoch: firstRun.runtimeSpanAttemptEpoch!,
      attemptId: firstRun.runtimeAttemptRef!.id,
      profile: { runtimeType: "pi_local", cwd: "/trusted/workspace" },
    };
    await persistNativeTransportProfile(db, transportInput);
    for (const override of [
      { ownerToken: "stale" }, { attemptEpoch: transportInput.attemptEpoch + 1 },
      { attemptId: randomUUID() }, { orgId: foreignOrgId },
      { profile: { runtimeType: "codex_local", cwd: "/foreign/workspace" } },
    ]) {
      await expect(persistNativeTransportProfile(db, { ...transportInput, ...override })).rejects.toThrow("Native transport profile rejected");
    }
    const [profileRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(profileRun!.contextSnapshot?.runtimeProviderProfile).toEqual(transportInput.profile);
    const observed = { kind: "assistant" as const, ts: new Date().toISOString(), text: "native supplement marker" };
    await svc.appendTranscriptEntry(firstRun, observed, { persistRaw: false, spanId: firstRun.runtimeSpanId });
    const [spanWithObject] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, firstRun.runtimeSpanId!));
    expect(spanWithObject?.supplementalObjectRef).toBeTruthy();
    const competingAttachment = await attachRuntimeSpanSupplement(db, {
      orgId, runId: firstRun.id, spanId: firstRun.runtimeSpanId!,
      ownerToken: firstRun.runtimeSpanOwnerToken!, attemptEpoch: spanWithObject!.attemptEpoch,
      objectRef: "competing-object-must-not-replace-evidence",
    });
    expect(competingAttachment?.supplementalObjectRef).toBe(spanWithObject!.supplementalObjectRef);
    const objectInput = { objectRef: spanWithObject!.supplementalObjectRef!, orgId, runId: firstRun.id,
      spanId: spanWithObject!.id, ownerToken: firstRun.runtimeSpanOwnerToken! };
    const objectPage = await objectStore.readRange(objectInput);
    expect(objectPage.entries).toContainEqual(expect.objectContaining(observed));
    expect(objectPage.source).toBe("native_plus_objects");
    expect(objectPage.completeness).toBe("partial");
    const reader = createTranscriptReader(db, {
      nativeReader: { readRange: async () => ({ items: [], revision: "native-offline", availability: "offline", completeness: "unknown" }) },
      objectReader: createTranscriptObjectReader(objectStore),
    });
    const readerPage = await reader.readRun({ orgId, runId: firstRun.id,
      principal: { type: "board", orgId, authorized: true, scopeRef: "user:operator" } });
    expect(readerPage.source).toBe("native_plus_objects");
    expect(readerPage.items).toEqual(expect.arrayContaining([expect.objectContaining({ runId: firstRun.id, spanId: firstRun.runtimeSpanId, text: observed.text })]));
    await expect(objectStore.readRange({ ...objectInput, orgId: foreignOrgId })).rejects.toThrow();
    const persistedEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, firstRun.id));
    expect(JSON.stringify(persistedEvents)).not.toContain(observed.text);
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      linkedGoalId: foreignGoalId,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    })).rejects.toThrow("same organization");
    const firstRunSummary = await getRunSummary(db, firstRun.id, { orgIds: [orgId] });
    expect(firstRunSummary?.sessionReuseScope).toBe("none");
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    })).rejects.toThrow("already active");

    await expect(svc.finalizeStaleRuns({
      conversationId,
      olderThanMs: 0,
      error: "test stale chat run",
      errorCode: "test_chat_run_stale",
    })).resolves.toBe(0);

    const recoveryNow = new Date(Date.now() + 10 * 60_000);
    await db
      .update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(recoveryNow.getTime() - 1) })
      .where(eq(heartbeatRuns.id, firstRun.id));
    const recoveryResults = await Promise.all([
      heartbeatService(db).reapOrphanedRuns({ now: recoveryNow, recoveryCutoff: recoveryNow }),
      heartbeatService(db).reapOrphanedRuns({ now: recoveryNow, recoveryCutoff: recoveryNow }),
    ]);
    expect(recoveryResults.reduce((total, result) => total + result.reaped, 0)).toBe(1);

    const [timedOutRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(timedOutRun?.status).toBe("failed");
    expect(timedOutRun?.errorCode).toBe("process_lost");
    const [reapedAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, firstRun.id));
    const [reapedSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, firstRun.id));
    expect(reapedAttempt).toMatchObject({ status: "failed", id: firstRun.runtimeAttemptRef?.id });
    expect(reapedSpan).toMatchObject({ state: "sealed", attemptId: reapedAttempt?.id });

    await svc.finalizeRun(firstRun.id, {
      status: "succeeded",
      resultJson: { summary: "late chat completion" },
      usageJson: { inputTokens: 10, outputTokens: 2 },
    });
    const [lateFinalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(lateFinalizedRun).toMatchObject({
      status: "failed",
      errorCode: "process_lost",
      resultJson: { summary: "late chat completion" },
    });

    const secondRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    });

    await expect(svc.linkAssistantMessage(secondRun.id, conversationId, randomUUID())).resolves.toBeNull();
    const eventsBeforeLink = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(eventsBeforeLink.some((event) => event.eventType === "chat.message_linked")).toBe(false);

    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Done.",
      replyingAgentId: agentId,
    });

    await svc.linkAssistantMessage(secondRun.id, conversationId, messageId);

    const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
    expect(message?.runId).toBe(secondRun.id);

    const [linkedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRun.id));
    expect(linkedRun?.chatConversationId).toBe(conversationId);
    expect(linkedRun?.contextSnapshot).toMatchObject({ assistantMessageId: messageId, messageId });

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(events.some((event) => event.eventType === "chat.message_linked")).toBe(true);

    const largeRawResult = "x".repeat(200_000);
    await svc.finalizeRun(secondRun.id, {
      status: "succeeded",
      resultJson: {
        summary: "s".repeat(800),
        costUsd: 0.42,
        raw: largeRawResult,
      },
    });
    const [finalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRun.id));
    expect(finalizedRun?.resultJson).toMatchObject({ raw: largeRawResult });
    expect(finalizedRun?.resultSummaryJson).toEqual({
      summary: "s".repeat(500),
      costUsd: 0.42,
    });
  });

  it("gives an older queued heartbeat Run priority over repeated Chat stream arrivals", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const secondConversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Cross-scene capacity org",
      urlKey: deriveOrganizationUrlKey("Cross-scene capacity org"),
      issuePrefix: "CSC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Capacity-limited Chat Runner",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(chatConversations).values([
      {
        id: conversationId,
        orgId,
        title: "Stream race",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: secondConversationId,
        orgId,
        title: "Capacity rejection",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    const [runtimeBinding, secondBinding] = await Promise.all([
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
      ensureRuntimeBinding(db, {
        orgId,
        conversationId: secondConversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
    ]);
    const [nativeSession, secondSession] = await Promise.all([
      currentNativeSession(db, runtimeBinding),
      currentNativeSession(db, secondBinding),
    ]);

    let enterClaim!: () => void;
    let releaseClaim!: () => void;
    const claimEntered = new Promise<void>((resolve) => { enterClaim = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const heartbeat = heartbeatService(db, {
      beforeRunClaim: async () => {
        enterClaim();
        await claimGate;
      },
    });
    const wakeupPromise = heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "chat_stream_capacity_race",
      contextSnapshot: {},
    });

    try {
      await claimEntered;
      const queuedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .then((rows) => rows[0] ?? null);
      expect(queuedRun).toBeTruthy();

      for (const [targetConversationId, binding, segment] of [
        [conversationId, runtimeBinding, nativeSession.segment],
        [secondConversationId, secondBinding, secondSession.segment],
        [conversationId, runtimeBinding, nativeSession.segment],
      ] as const) {
        await expect(svc.createRun({
          conversation: { id: targetConversationId, orgId, primaryIssueId: null, planMode: false },
          agentId,
          triggerDetail: "chat_assistant_reply_stream",
          userMessageId: randomUUID(),
          linkedIssueIds: [],
          linkedProjectId: null,
          runtimeBinding: binding,
          runtimeSegment: segment,
          inputCorrelationRef: randomUUID(),
          scene: "chat",
        })).rejects.toThrow("older due queued run");
      }

      releaseClaim();
      await wakeupPromise;

      const agentRuns = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(agentRuns).toHaveLength(1);
      expect(agentRuns[0]).toMatchObject({ id: queuedRun!.id });
      expect(agentRuns[0]?.status).not.toBe("queued");
      await vi.waitFor(async () => {
        const [attempt] = await db.select({ id: heartbeatRunAttempts.id })
          .from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, queuedRun!.id));
        const [settled] = await db.select({
          status: heartbeatRuns.status,
          terminalEffectsPending: heartbeatRuns.terminalEffectsPending,
        }).from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRun!.id));
        expect(attempt).toBeTruthy();
        expect(settled?.status).not.toBe("running");
        expect(settled?.terminalEffectsPending).toBe(false);
      }, { timeout: 10_000 });
    } finally {
      releaseClaim();
      await wakeupPromise.catch(() => undefined);
    }
  });

  it("keeps a Chat-first admission running when a heartbeat wakeup arrives later", async () => {
    const streamRun = await createChatRunFixture("Chat wins first", 1);
    const queuedRun = await heartbeatService(db).wakeup(streamRun.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "after_chat_admission",
      contextSnapshot: { taskKey: "later-heartbeat-work" },
    });
    const agentRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, streamRun.agentId));
    expect(agentRuns).toEqual(expect.arrayContaining([
      { id: streamRun.id, status: "running" },
      { id: queuedRun.id, status: "queued" },
    ]));
  });

  it("does not signal lease loss to the live stream after committing Run success", async () => {
    const run = await createChatRunFixture("Successful Chat stream owner");
    const execution = svc.beginOwnedRunExecution(run);
    try {
      await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { outcome: "completed" } });
      expect(execution.signal.aborted).toBe(false);
      expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id)))[0]?.status).toBe("succeeded");
    } finally {
      execution.release();
    }
  });

  it("holds capacity for a live Chat provider through expiry and owner loss until execution settles", async () => {
    const ownedSvc = chatAgentRunService(db, {
      transcriptObjectStore: objectStore,
      leaseRenewIntervalMs: 20,
    });
    const run = await createChatRunFixture("Held Chat provider", 1, ownedSvc);
    const execution = ownedSvc.beginOwnedRunExecution(run);
    let settleProvider!: () => void;
    const providerSettled = new Promise<void>((resolve) => { settleProvider = resolve; });
    let providerWorkCount = 0;
    const providerWork = (async () => {
      providerWorkCount += 1;
      await providerSettled;
    })();
    const queued = await heartbeatService(db).wakeup(run.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "queued_during_held_chat_provider",
      contextSnapshot: { taskKey: "waiting-for-held-chat" },
    });
    const recovery = heartbeatService(db);
    try {
      const now = new Date();
      await db.update(heartbeatRuns).set({ executionLeaseExpiresAt: new Date(now.getTime() - 1) })
        .where(eq(heartbeatRuns.id, run.id));
      expect(await recovery.reapOrphanedRuns({ now, recoveryCutoff: now })).toMatchObject({ reaped: 0 });
      expect(execution.signal.aborted).toBe(false);
      expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queued.id)))[0]?.status).toBe("queued");

      await db.update(heartbeatRuns).set({
        executionOwnerToken: randomUUID(),
        executionLeaseExpiresAt: new Date(Date.now() - 1),
      }).where(eq(heartbeatRuns.id, run.id));
      await vi.waitFor(() => expect(execution.signal.aborted).toBe(true), { timeout: 5_000 });
      expect(await recovery.reapOrphanedRuns({ now: new Date(), recoveryCutoff: new Date() }))
        .toMatchObject({ reaped: 0 });
      expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queued.id)))[0]?.status).toBe("queued");
      expect(await db.select({ id: heartbeatRunAttempts.id }).from(heartbeatRunAttempts)
        .where(eq(heartbeatRunAttempts.runId, queued.id))).toHaveLength(0);
      expect(providerWorkCount).toBe(1);

      settleProvider();
      await providerWork;
      execution.release();
      expect(await recovery.reapOrphanedRuns({ now: new Date(), recoveryCutoff: new Date() }))
        .toMatchObject({ reaped: 1 });
      expect(providerWorkCount).toBe(1);
      await vi.waitFor(async () => {
        const [attempt] = await db.select({ id: heartbeatRunAttempts.id })
          .from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, queued.id));
        const [settled] = await db.select({ status: heartbeatRuns.status, terminalEffectsPending: heartbeatRuns.terminalEffectsPending })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
        expect(attempt).toBeTruthy();
        expect(settled?.status).not.toBe("running");
        expect(settled?.terminalEffectsPending).toBe(false);
      }, { timeout: 10_000 });
    } finally {
      settleProvider();
      await providerWork;
      execution.release();
    }
  });

  it("stores automation run target metadata on chat-backed agent runs", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const automationRunId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Automation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);

    const run = await svc.createRun({
      conversation: {
        id: conversationId,
        orgId,
        primaryIssueId: null,
        planMode: false,
      },
      agentId,
      triggerDetail: "chat_assistant_reply_stream",
      userMessageId,
      linkedIssueIds: [],
      linkedProjectId: null,
      runContext: {
        targetType: "automation_run",
        targetId: automationRunId,
        automationRunId,
      },
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: userMessageId,
    });

    expect(run.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "automation_run",
      targetId: automationRunId,
      automationRunId,
      conversationId,
      messageId: userMessageId,
      userMessageId,
    });
  });

  it("persists and validates the exact source Run span selector", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const sourceConversationId = randomUUID();
    const targetConversationId = randomUUID();
    const sourceRunId = randomUUID();
    const sourceSpanId = randomUUID();
    const createdAt = new Date("2026-09-23T01:00:00.000Z");
    const sealedAt = new Date("2026-09-23T01:01:00.000Z");
    const selectorJson = {
      kind: "codex_turn",
      threadId: "source-thread",
      turnId: "source-turn",
      inputCorrelationRef: "source-message",
    };

    await db.insert(organizations).values({
      id: orgId,
      name: "Source span metadata org",
      urlKey: deriveOrganizationUrlKey("Source span metadata org"),
      issuePrefix: "SSM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Source span metadata agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values([
      {
        id: sourceConversationId,
        orgId,
        title: "Source chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: targetConversationId,
        orgId,
        title: "Side chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    const sourceBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId: sourceConversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const sourceSession = await currentNativeSession(db, sourceBinding);
    await db.update(nativeSegments).set({
      nativeSessionId: "source-thread",
      rootSessionId: "source-thread",
      state: "open",
      providerStateJson: { sessionId: "source-thread" },
      updatedAt: createdAt,
    }).where(eq(nativeSegments.id, sourceSession.segment.id));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      orgId,
      agentId,
      invocationSource: "chat",
      status: "succeeded",
      chatConversationId: sourceConversationId,
      sessionReuseScope: "explicit",
      sessionIdAfter: "source-thread",
      startedAt: createdAt,
      finishedAt: sealedAt,
    });
    await db.insert(runRuntimeSpans).values({
      id: sourceSpanId,
      orgId,
      runId: sourceRunId,
      bindingId: sourceBinding.id,
      segmentId: sourceSession.segment.id,
      attemptRef: "source-attempt",
      attemptEpoch: 1,
      ownerToken: "source-owner",
      ordinal: 0,
      relation: "primary",
      nativeExecutionRef: "source-turn",
      inputCorrelationRef: "source-message",
      selectorJson,
      state: "sealed",
      completeness: "complete",
      openedAt: createdAt,
      closedAt: sealedAt,
      updatedAt: sealedAt,
    });

    const targetBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId: targetConversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const targetSession = await currentNativeSession(db, targetBinding);
    const targetConversation = {
      id: targetConversationId,
      orgId,
      primaryIssueId: null,
      planMode: false,
    };

    await expect(svc.createRun({
      conversation: targetConversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: targetBinding,
      runtimeSegment: targetSession.segment,
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: { ...selectorJson, turnId: "wrong-turn" },
      inputCorrelationRef: "target-message-invalid",
    })).rejects.toThrow("selectorJson does not match");

    const targetRun = await svc.createRun({
      conversation: targetConversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: targetBinding,
      runtimeSegment: targetSession.segment,
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: selectorJson,
      inputCorrelationRef: "target-message",
    });
    expect(targetRun.contextSnapshot).toMatchObject({
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: selectorJson,
    });
    const [persistedTarget] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, targetRun.id));
    expect(persistedTarget?.contextSnapshot).toMatchObject({
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: selectorJson,
    });
  });

  it("binds each chat run to one fenced native span and rejects a late owner", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Native span org",
      urlKey: deriveOrganizationUrlKey("Native span org"),
      issuePrefix: "NSP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Native span agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Native span chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const bindingResults = await Promise.all([
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
    ]);
    expect(bindingResults[0].id).toBe(bindingResults[1].id);
    const nativeSession = await currentNativeSession(db, bindingResults[0]);
    const conversation = { id: conversationId, orgId, primaryIssueId: null, planMode: false };

    // A stale caller-selected segment must fail closed, not silently resolve
    // whichever segment is currently on the conversation binding.
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: { ...nativeSession.segment, id: randomUUID() },
      inputCorrelationRef: "stale-segment-message",
    })).rejects.toThrow();

    const firstRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "message-1",
    });
    expect(firstRun.runtimeSpanId).toBeTruthy();

    const firstResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "codex-thread-1",
      sessionDisplayId: "codex-thread-1",
      sessionParams: { sessionId: "codex-thread-1", cwd: "/tmp/native-span" },
      resultJson: { turnId: "turn-1" },
    };
    await svc.recordNativeExecutionResult(firstRun.id, firstResult, {
      orgId,
      spanId: firstRun.runtimeSpanId,
      ownerToken: firstRun.runtimeSpanOwnerToken,
      attemptEpoch: firstRun.runtimeSpanAttemptEpoch,
    });
    const [sealedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, firstRun.runtimeSpanId!));
    expect(sealedSpan).toMatchObject({ state: "sealed", completeness: "complete", nativeExecutionRef: "turn-1" });
    const [firstSegment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, sealedSpan!.segmentId));
    expect(firstSegment?.nativeSessionId).toBe("codex-thread-1");

    await svc.finalizeRun(firstRun.id, { status: "succeeded", resultJson: { summary: "first" } });
    const nextSession = await currentNativeSession(db, bindingResults[0]);
    const secondRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: nextSession.segment,
      nativeSessionId: nextSession.sessionId,
      nativeSessionParams: nextSession.sessionParams,
      inputCorrelationRef: "message-2",
    });
    await expect(svc.recordNativeExecutionResult(secondRun.id, firstResult, {
      orgId,
      spanId: secondRun.runtimeSpanId,
      ownerToken: firstRun.runtimeSpanOwnerToken,
      attemptEpoch: secondRun.runtimeSpanAttemptEpoch,
    })).resolves.toBeNull();
    const [stillOpen] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, secondRun.runtimeSpanId!));
    expect(stillOpen?.state).toBe("open");
    await svc.recordNativeExecutionResult(secondRun.id, {
      ...firstResult,
      resultJson: { turnId: "turn-2" },
    }, {
      orgId,
      spanId: secondRun.runtimeSpanId,
      ownerToken: secondRun.runtimeSpanOwnerToken,
      attemptEpoch: secondRun.runtimeSpanAttemptEpoch,
    });
    await svc.finalizeRun(secondRun.id, { status: "succeeded", resultJson: { summary: "second" } });
    const bindings = await db.select().from(runtimeBindings).where(eq(runtimeBindings.orgId, orgId));
    expect(bindings).toHaveLength(1);
  });

  it("fails closed for stale owners and stale attempt refs across every Chat Run write", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Owner fencing org",
      urlKey: deriveOrganizationUrlKey("Owner fencing org"),
      issuePrefix: "OFG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Owner fencing agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Owner fencing chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    const run = await svc.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "owner-fencing-message",
    });
    const preRecoveryEntry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "before owner recovery" };
    await svc.appendTranscriptEntry(run, preRecoveryEntry, { persistRaw: false, spanId: run.runtimeSpanId });
    const [spanBeforeRecovery] = await db
      .select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const originalSupplementRef = spanBeforeRecovery?.supplementalObjectRef;
    expect(originalSupplementRef).toBeTruthy();
    const staleRun = {
      ...run,
      runtimeAttemptRef: run.runtimeAttemptRef ? { ...run.runtimeAttemptRef } : null,
    };
    const staleResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "stale-owner-thread",
      sessionDisplayId: "stale-owner-thread",
      sessionParams: { sessionId: "stale-owner-thread" },
      resultJson: { turnId: "stale-owner-turn" },
    };

    await db
      .update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, run.id));
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const claimed = await adapter.claimOwner(run.id);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(`expected recovery claim, got ${claimed.reason}`);

    await expect(svc.beginRuntimeAttempt(staleRun, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.markRuntimeAttemptWaiting(staleRun, {
      submissionPhase: "indeterminate",
      providerThreadId: "stale-owner-thread",
      error: "late owner",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.finishRuntimeAttempt(staleRun, {
      status: "failed",
      submissionPhase: "accepted",
      providerTurnId: "stale-owner-turn",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.recordNativeExecutionResult(run.id, staleResult, {
      orgId,
      spanId: staleRun.runtimeSpanId,
      ownerToken: staleRun.runtimeSpanOwnerToken!,
      attemptEpoch: staleRun.runtimeSpanAttemptEpoch,
    })).resolves.toBeNull();
    await expect(svc.acceptSubmission(staleRun, { providerTurnId: "stale-owner-turn" })).resolves.toBeNull();
    await expect(svc.markAcceptanceUnknown(staleRun, { reason: "stale owner" })).resolves.toBeNull();
    await expect(svc.sealSpan(staleRun, { completeness: "complete" })).resolves.toBeNull();

    await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { source: "stale-owner" } });
    const [stillRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.executionOwnerToken).toBe(claimed.value.ownerToken);

    const recoveredSvc = chatAgentRunService(db, { transcriptObjectStore: objectStore });
    const recoveredRun = await recoveredSvc.adoptRecoveredRun(run.id, claimed.value.ownerToken);
    expect(recoveredRun).not.toBeNull();
    if (!recoveredRun) throw new Error("expected recovered Chat run");
    const postRecoveryEntry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "after owner recovery" };
    await recoveredSvc.appendTranscriptEntry(recoveredRun, postRecoveryEntry, {
      persistRaw: false,
      spanId: recoveredRun.runtimeSpanId,
    });
    const [spanAfterRecovery] = await db
      .select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.id, recoveredRun.runtimeSpanId!));
    expect(spanAfterRecovery?.supplementalObjectRef).toBe(originalSupplementRef);
    const oldOwnerPage = await objectStore.readRange({
      objectRef: originalSupplementRef!,
      orgId,
      runId: run.id,
      spanId: recoveredRun.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
    });
    expect(oldOwnerPage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining(preRecoveryEntry),
      expect.objectContaining(postRecoveryEntry),
    ]));
    const recoveryReader = createTranscriptObjectReader(objectStore);
    const recoveredPage = await recoveryReader.readRange!({
      readonly: true,
      scope: "run",
      orgId,
      run: { id: run.id },
      span: {
        id: recoveredRun.runtimeSpanId!,
        ownerToken: recoveredRun.runtimeSpanOwnerToken!,
        supplementalObjectRef: originalSupplementRef,
      },
    } as unknown as NativeTranscriptReadInput);
    expect(recoveredPage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining(preRecoveryEntry),
      expect.objectContaining(postRecoveryEntry),
    ]));
    await recoveredSvc.beginRuntimeAttempt(recoveredRun, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    });
    await recoveredSvc.finishRuntimeAttempt(recoveredRun, {
      status: "succeeded",
      submissionPhase: "accepted",
      providerTurnId: "first-attempt-turn",
    });
    const staleAttemptRun = {
      ...recoveredRun,
      runtimeAttemptRef: recoveredRun.runtimeAttemptRef ? { ...recoveredRun.runtimeAttemptRef } : null,
    };
    const secondAttemptRef = await recoveredSvc.beginRuntimeAttempt(recoveredRun, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "pristine_replay",
    });
    expect(secondAttemptRef.attemptIndex).toBe(1);
    await expect(recoveredSvc.finishRuntimeAttempt(staleAttemptRun, {
      status: "failed",
      submissionPhase: "accepted",
      providerTurnId: "late-first-attempt-turn",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(recoveredSvc.acceptSubmission(staleAttemptRun, { providerTurnId: "late-first-attempt-turn" })).resolves.toBeNull();
    await expect(recoveredSvc.sealSpan(staleAttemptRun, { completeness: "complete" })).resolves.toBeNull();

    const attempts = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, run.id));
    expect(attempts.find((attempt) => attempt.attemptIndex === 1)?.status).toBe("started");
    await recoveredSvc.finishRuntimeAttempt(recoveredRun, {
      status: "succeeded",
      submissionPhase: "accepted",
      providerTurnId: "second-attempt-turn",
    });
    await expect(recoveredSvc.sealSpan(recoveredRun, {
      completeness: "complete",
      visibilityCutoffRef: "second-attempt-turn",
    })).resolves.toMatchObject({ state: "sealed", completeness: "complete" });
    await recoveredSvc.finalizeRun(run.id, { status: "succeeded", resultJson: { source: "current-owner" } });
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(finished?.status).toBe("succeeded");
  });

  it("records an explicit pre-submission finish as rejected and retryable", async () => {
    const run = await createChatRunFixture("Pre-submission");
    await svc.beginRuntimeAttempt(run, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    });

    const finished = await svc.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "pre_submission",
      error: "provider call was never made",
    });

    expect(finished).toMatchObject({
      status: "failed",
      submission: {
        state: "rejected",
        phase: "pre_submission",
        retry: "allowed",
        reason: "provider call was never made",
      },
    });
    await expect(svc.beginRuntimeAttempt(run, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "pristine_replay",
    })).resolves.toMatchObject({ attemptIndex: 1 });
  });

  it("keeps acceptance-unknown Chat attempts fenced from duplicate retries", async () => {
    const run = await createChatRunFixture("Acceptance unknown");
    await svc.beginRuntimeAttempt(run, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    });

    const finished = await svc.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "indeterminate",
      providerThreadId: "provider-thread-unknown",
      error: "connection closed after provider submission",
    });

    expect(finished).toMatchObject({
      status: "failed",
      submission: {
        state: "acceptance_unknown",
        phase: "indeterminate",
        retry: "blocked_until_reconciled",
        providerThreadId: "provider-thread-unknown",
      },
    });
    await expect(svc.beginRuntimeAttempt(run, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "pristine_replay",
    })).rejects.toThrow("cannot create a retry attempt before reconciling provider acceptance");
    const attempts = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, run.id));
    expect(attempts).toHaveLength(1);
  });

  it("keeps the runtime terminal outcome when supplement sealing fails", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Supplement seal failure org",
      urlKey: deriveOrganizationUrlKey("Supplement seal failure org"),
      issuePrefix: "SSF",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Supplement seal failure agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Supplement seal failure chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    const failingStore: TranscriptObjectStore = {
      ...objectStore,
      finalize: async () => {
        throw new Error("simulated transcript seal failure");
      },
    };
    const failingSvc = chatAgentRunService(db, { transcriptObjectStore: failingStore });
    const run = await failingSvc.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "supplement-seal-failure",
    });
    const entry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "retained evidence" };
    await failingSvc.appendTranscriptEntry(run, entry, { persistRaw: false, spanId: run.runtimeSpanId });
    const terminal = await failingSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { source: "runtime", retained: true },
    });
    expect(terminal?.status).toBe("succeeded");

    const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persistedRun).toMatchObject({
      status: "succeeded",
      resultJson: { source: "runtime", retained: true },
    });
    const [span] = await db
      .select()
      .from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    expect(span?.supplementalObjectRef).toBeTruthy();
    await expect(objectStore.readRange({
      objectRef: span!.supplementalObjectRef!,
      orgId,
      runId: run.id,
      spanId: span!.id,
      ownerToken: run.runtimeSpanOwnerToken!,
    })).resolves.toMatchObject({
      completeness: "partial",
      entries: [entry],
    });
  });
});
