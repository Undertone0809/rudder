import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessageTranscriptEntries,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  goals,
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  organizationSkills,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
  runtimeSourceAliases,
  sideChatProviderCleanupIntents,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey, type ChatStreamTranscriptEntry } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { loadSideChatForkSource } from "./chat-assistant.side-chat-source.js";
import { chatService } from "./chats.js";
import { currentNativeSession, ensureRuntimeBinding } from "./runtime-kernel/native-session.js";

const nativeReads = vi.hoisted(() => new Map<string, unknown>());
const nativeReadCalls = vi.hoisted(() => vi.fn());
vi.mock("./runtime-kernel/historical-transcript-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-kernel/historical-transcript-reader.js")>();
  return { ...actual, createHistoricalTranscriptReader: (...args: Parameters<typeof actual.createHistoricalTranscriptReader>) => {
    const reader = actual.createHistoricalTranscriptReader(...args);
    return { ...reader, readRun: (input: Parameters<typeof reader.readRun>[0]) => {
      nativeReadCalls(input);
      const override = nativeReads.get(input.runId);
      if (typeof override === "function") {
        return Promise.resolve((override as (input: unknown) => unknown)(input));
      }
      return nativeReads.has(input.runId) ? Promise.resolve(override) : reader.readRun(input);
    } };
  } };
});

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getAvailablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const externalUrl = process.env.RUDDER_CHATS_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chats-transcript-"));
  const port = await getAvailablePort();
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
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
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("chatService transcript persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let chats!: ReturnType<typeof chatService>;
  let runs!: ReturnType<typeof chatAgentRunService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    chats = chatService(db);
    runs = chatAgentRunService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    nativeReads.clear();
    await db.delete(runtimeSourceAliases);
    await db.delete(sideChatProviderCleanupIntents);
    await db.delete(chatMessageTranscriptEntries);
    await db.delete(chatMessages);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRunAttempts);
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

  it("keeps exact native Fork history in aliases across source and middle deletion without copying raw transcripts", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    await db.insert(organizations).values({ id: orgId, name: "Native fork", urlKey: `fork-${orgId}`, issuePrefix: "FRK" });
    await db.insert(agents).values({ id: agentId, orgId, name: "Fork agent", role: "engineer", status: "active", agentRuntimeType: "codex_local", agentRuntimeConfig: {} });
    await db.insert(chatConversations).values({ id: conversationId, orgId, title: "Source", preferredAgentId: agentId });
    const binding = await ensureRuntimeBinding(db, { orgId, conversationId, principalScopeRef: `org:${orgId}`, agentId, runtimeType: "codex_local" });
    const session = await currentNativeSession(db, binding);
    await db.update(nativeSegments).set({ nativeSessionId: "thread-fork" }).where(eq(nativeSegments.id, session.segment.id));
    await db.insert(heartbeatRuns).values({ id: runId, orgId, agentId, chatConversationId: conversationId, status: "succeeded", sessionIdAfter: "thread-fork", contextSnapshot: { runtimeProviderProfile: { runtimeType: "codex_local" } } });
    await db.insert(runRuntimeSpans).values({ orgId, runId, bindingId: binding.id, segmentId: session.segment.id, attemptRef: "native-fork-test", ownerToken: randomUUID(),
      state: "sealed", completeness: "complete", nativeExecutionRef: "turn-fork", openedAt: new Date(Date.now() - 1000), closedAt: new Date(), writerLeaseReleasedAt: new Date(),
      selectorJson: { kind: "codex_turn", threadId: "thread-fork", turnId: "turn-fork" } });
    nativeReads.set(runId, { source: "native", availability: "available", completeness: "complete", items: [
      { id: "reason-1", kind: "thinking", text: "Private process".repeat(32768), ts: "2026-10-01T00:00:00Z" },
    ], nextCursor: null });
    const message = await chats.addMessage(conversationId, { orgId, role: "assistant", kind: "message", body: "Answer", runId });
    const forkInput = { orgId, sourceConversationId: conversationId, sourceMessageId: message.id, userId: "operator", createdByUserId: "operator" };
    await expect(chats.forkConversation({ ...forkInput, orgId: randomUUID() })).rejects.toThrow("not found");
    await db.update(runRuntimeSpans).set({ completeness: "partial" }).where(eq(runRuntimeSpans.runId, runId));
    await expect(chats.forkConversation(forkInput)).rejects.toThrow("sealed complete exact");
    await db.update(runRuntimeSpans).set({ completeness: "complete" }).where(eq(runRuntimeSpans.runId, runId));
    const readablePage = nativeReads.get(runId);
    nativeReads.set(runId, { source: "native", availability: "missing", items: [], nextCursor: null });
    await expect(chats.forkConversation(forkInput)).rejects.toThrow("unavailable");
    nativeReads.set(runId, readablePage);
    const partialPage = { ...(readablePage as Record<string, unknown>), completeness: "partial", nextCursor: "page-2" };
    const terminalPage = { ...(readablePage as Record<string, unknown>), items: [], completeness: "terminal_only", nextCursor: null };
    nativeReads.set(runId, { ...partialPage, nextCursor: null });
    await expect(chats.forkConversation(forkInput)).rejects.toThrow("unavailable");
    nativeReads.set(runId, (input: { cursor: string | null }) => input.cursor ? terminalPage : partialPage);
    await expect(chats.forkConversation(forkInput)).rejects.toThrow("unavailable");
    nativeReads.set(runId, (input: { cursor: string | null }) => input.cursor
      ? { ...terminalPage, completeness: "complete" }
      : partialPage);
    await expect(chats.forkConversation(forkInput)).rejects.toThrow("unavailable");
    nativeReads.set(runId, readablePage);
    const fork = await chats.forkConversation(forkInput);
    if (!fork) throw new Error("Fork was not created");
    const copied = (await chats.listMessages(fork.id)).find((row) => row.role === "assistant")!;
    expect(copied.runId).toBeNull();
    expect(copied.transcript?.length).toBeGreaterThan(0);
    const siblingForks = await Promise.all(Array.from({ length: 12 }, () => chats.forkConversation(forkInput)));
    nativeReadCalls.mockClear();
    const lightweight = await chats.listMessages(fork.id, { includeTranscript: false });
    expect(lightweight.find((row) => row.id === copied.id)?.transcript).toBeUndefined();
    for (const sibling of siblingForks) {
      expect(sibling).not.toBeNull();
      const messages = await chats.listMessages(sibling!.id, { includeTranscript: false });
      expect(messages.find((row) => row.role === "assistant")?.transcript).toBeUndefined();
      await chats.remove(sibling!.id);
    }
    expect(nativeReadCalls).not.toHaveBeenCalled();
    expect(await db.select().from(chatMessageTranscriptEntries).where(eq(chatMessageTranscriptEntries.messageId, copied.id))).toEqual([]);
    const [alias] = await db.select().from(runtimeSourceAliases).where(eq(runtimeSourceAliases.conversationId, fork.id));
    await db.update(runtimeSourceAliases).set({ principalScopeRef: "org:spoof" }).where(eq(runtimeSourceAliases.id, alias.id));
    await expect(chats.getMessageTranscript(fork.id, copied.id)).rejects.toThrow("principal");
    await db.update(runtimeSourceAliases).set({ principalScopeRef: `org:${orgId}`, createdAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000) }).where(eq(runtimeSourceAliases.id, alias.id));
    await expect(chats.getMessageTranscript(fork.id, copied.id)).rejects.toThrow("expired");
    await db.update(runtimeSourceAliases).set({ expiresAt: null }).where(eq(runtimeSourceAliases.id, alias.id));
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    await expect(chats.remove(conversationId)).rejects.toThrow("active Run or writer");
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, conversationId))).toHaveLength(1);
    expect(await db.select().from(runtimeSourceAliases).where(eq(runtimeSourceAliases.id, alias.id))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const second = await chats.forkConversation({ orgId, sourceConversationId: fork.id, sourceMessageId: copied.id, userId: "operator", createdByUserId: "operator" });
    if (!second) throw new Error("Nested Fork was not created");
    await chats.remove(conversationId);
    await chats.remove(fork.id);
    const retained = await db.select().from(runtimeBindings).where(eq(runtimeBindings.id, binding.id));
    expect(retained[0]).toMatchObject({ status: "closed", targetType: "manual", conversationId: null });
    expect((await db.select().from(sideChatProviderCleanupIntents).where(eq(sideChatProviderCleanupIntents.bindingId, binding.id)))[0])
      .toMatchObject({ state: "review_required", stateReason: "retained_native_source_requires_root_session_cleanup_authority" });
    const loaded = await loadSideChatForkSource(db, (await chats.getById(second.id))!);
    expect(loaded).toMatchObject({ sourceRunId: runId, sourceBinding: { id: binding.id }, session: { sessionId: "thread-fork" } });
    const finalMessage = (await chats.listMessages(second.id)).find((row) => row.role === "assistant")!;
    expect((await chats.getMessageTranscript(second.id, finalMessage.id))?.transcript).toEqual(copied.transcript);
    nativeReads.set(runId, { source: "native", availability: "available", items: [{ id: "reason-1", kind: "thinking", text: "Mutated process", ts: "2026-10-01T00:00:00Z" }], nextCursor: null });
    await expect(chats.getMessageTranscript(second.id, finalMessage.id)).rejects.toThrow("sealed source range");
    await chats.remove(second.id);
    expect(await db.select().from(runtimeSourceAliases).where(eq(runtimeSourceAliases.orgId, orgId))).toEqual([]);
    expect((await db.select().from(sideChatProviderCleanupIntents).where(eq(sideChatProviderCleanupIntents.bindingId, binding.id)))[0])
      .toMatchObject({ state: "review_required", stateReason: "retained_native_source_last_alias_released_cleanup_review_required", leaseEpoch: 1 });
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads Run ledger entries for linked messages and retains legacy snapshots without run IDs", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const label = `Chat transcript ${randomUUID()}`;
    await db.insert(organizations).values({
      id: orgId,
      name: label,
      urlKey: deriveOrganizationUrlKey(label),
      issuePrefix: "SUB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: `${label} agent`,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: `${label} conversation`,
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
    const run = await runs.createRun({
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
    });
    const runEntry: ChatStreamTranscriptEntry = {
      kind: "assistant",
      ts: "2026-09-24T00:00:00.000Z",
      text: "Recovered from the legacy Run ledger",
    };
    expect(await runs.markLegacyTranscriptSource(run)).toBe(true);
    await runs.appendTranscriptEntry(run, runEntry, { spanId: run.runtimeSpanId });

    const runMessage = await chats.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      body: "Run-backed answer",
      runId: run.id,
      transcript: [runEntry],
    });
    expect(runMessage.transcript).toEqual([expect.objectContaining(runEntry)]);
    expect(await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.messageId, runMessage.id))).toEqual([]);

    await db.insert(chatMessageTranscriptEntries).values({
      orgId,
      messageId: runMessage.id,
      entrySeq: 0,
      payload: { kind: "assistant", ts: runEntry.ts, text: "historical duplicate" },
    });
    await chats.updateMessageStructuredPayload(conversationId, runMessage.id, { note: "metadata only" });
    expect(await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.messageId, runMessage.id))).toHaveLength(1);

    const detachedEntry: ChatStreamTranscriptEntry = {
      kind: "assistant",
      ts: "2026-09-24T00:00:01.000Z",
      text: "Recovered from the legacy message snapshot",
    };
    const detachedMessage = await chats.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      body: "Historical message without a Run",
      transcript: [detachedEntry],
    });
    const visibleMessages = await chats.listMessages(conversationId);
    expect(visibleMessages.find((message) => message.id === runMessage.id)?.transcript)
      .toEqual([expect.objectContaining(runEntry)]);
    expect(visibleMessages.find((message) => message.id === detachedMessage.id)?.transcript)
      .toEqual([expect.objectContaining(detachedEntry)]);
    await expect(chats.getMessageTranscript(conversationId, runMessage.id)).resolves.toMatchObject({
      transcript: [expect.objectContaining(runEntry)],
    });
    // This Reader fixture never starts a provider. Close its synthetic writer
    // after the assertions so normal fenced deletion remains enforced.
    await db.update(runRuntimeSpans).set({
      state: "unresolved", completeness: "unknown", closedAt: new Date(),
      writerLeaseReleasedAt: new Date(),
    }).where(eq(runRuntimeSpans.runId, run.id));
  });

  it("reports completeness for production-sized and bounded Run transcripts without embedding them in the message", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const entryCount = 1_000;
    const userId = "board-user-large-transcript-reader";

    await db.insert(organizations).values({
      id: orgId,
      name: "Large Run Transcript Reader Org",
      urlKey: deriveOrganizationUrlKey("Large Run Transcript Reader Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Large transcript Reader agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Large Run transcript",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: `user:${userId}`,
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    const run = await runs.createRun({
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
    });
    expect(await runs.markLegacyTranscriptSource(run)).toBe(true);
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "stopped",
      acceptedThroughSeq: entryCount,
    });
    const assistantMessage = await chats.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Ledger-backed long transcript completed.",
      runId: run.id,
      replyingAgentId: agentId,
    });
    const entries = Array.from({ length: entryCount }, (_, index) => ({
      kind: "thinking" as const,
      ts: new Date(Date.UTC(2026, 6, 23, 8, 0, 0, index)).toISOString(),
      text: `production-shaped reasoning ${index} ${"x".repeat(1_050)}`,
      generationId,
      generationSeqStart: index + 1,
      generationSeqEnd: index + 1,
      sourceEntryId: `large-reader-entry-${index}`,
    }));
    await db.insert(chatGenerationEvents).values(entries.map((entry, index) => ({
      orgId,
      generationId,
      generationSeq: index + 1,
      attemptEpoch: 1,
      eventKind: "transcript" as const,
      payload: { entry },
      assistantMessageId: assistantMessage.id,
      runId: run.id,
    })));
    await db.insert(heartbeatRunEvents).values(entries.map((entry, index) => ({
      orgId,
      runId: run.id,
      agentId,
      seq: index + 1,
      eventType: "transcript.entry",
      stream: "system",
      level: "info",
      message: "chat transcript entry",
      payload: { entry },
    })));
    nativeReadCalls.mockClear();

    const transcript = await chats.getMessageTranscript(conversationId, assistantMessage.id);
    const [persistedMessage] = await db.select({ structuredPayload: chatMessages.structuredPayload })
      .from(chatMessages)
      .where(eq(chatMessages.id, assistantMessage.id));
    const persistedTranscriptEvents = await db.select({ id: chatGenerationEvents.id })
      .from(chatGenerationEvents)
      .where(eq(chatGenerationEvents.assistantMessageId, assistantMessage.id));
    const readerCalls = nativeReadCalls.mock.calls
      .map(([input]) => input as { runId: string; cursor: string | null })
      .filter((input) => input.runId === run.id);

    expect(persistedMessage?.structuredPayload?.__chatTranscript).toBeUndefined();
    expect(persistedTranscriptEvents).toHaveLength(entryCount);
    expect(readerCalls.length).toBeGreaterThan(1);
    expect(transcript?.transcript).toHaveLength(entryCount);
    expect(transcript?.transcript[0]).toMatchObject({ text: entries[0]?.text });
    expect(transcript?.transcript.at(-1)).toMatchObject({ text: entries.at(-1)?.text });
    expect(transcript).toMatchObject({
      source: "legacy",
      availability: "available",
      completeness: "partial",
      hasMore: false,
      limit: { pageSize: 200, maxPages: 25, maxItems: 5_000, maxBytes: 2 * 1024 * 1024 },
    });

    nativeReadCalls.mockClear();
    nativeReads.set(run.id, {
      source: "native",
      availability: "available",
      completeness: "complete",
      items: [{
        id: "bounded-normal-item",
        ordinal: 0,
        runId: run.id,
        spanId: null,
        sourceRef: null,
        kind: "thinking",
        ts: "2026-07-23T08:00:00.000Z",
        payload: { text: "bounded normal transcript item" },
        visibility: "visible",
        origin: "native",
      }],
      nextCursor: null,
    });
    const boundedNormalTranscript = await chats.getMessageTranscript(conversationId, assistantMessage.id);
    expect(boundedNormalTranscript?.transcript).toHaveLength(1);
    expect(boundedNormalTranscript).toMatchObject({
      source: "native",
      availability: "available",
      completeness: "complete",
      hasMore: false,
      limit: { pageSize: 200, maxPages: 25, maxItems: 5_000, maxBytes: 2 * 1024 * 1024 },
    });

    nativeReadCalls.mockClear();
    nativeReads.set(run.id, (input: { cursor: string | null }) => {
      const pageIndex = input.cursor ? Number(input.cursor.slice("page-".length)) : 0;
      const firstOrdinal = pageIndex * 200;
      return {
        source: "native",
        availability: "available",
        completeness: "complete",
        items: Array.from({ length: 200 }, (_, index) => ({
          id: `bounded-item-${firstOrdinal + index}`,
          ordinal: firstOrdinal + index,
          runId: run.id,
          spanId: null,
          sourceRef: null,
          kind: "thinking",
          ts: "2026-07-23T08:00:00.000Z",
          payload: { text: `bounded transcript item ${firstOrdinal + index}` },
          visibility: "visible",
          origin: "native",
        })),
        nextCursor: `page-${pageIndex + 1}`,
      };
    });
    const boundedTranscript = await chats.getMessageTranscript(conversationId, assistantMessage.id);
    const boundedReaderCalls = nativeReadCalls.mock.calls
      .map(([input]) => input as { runId: string })
      .filter((input) => input.runId === run.id);
    expect(boundedReaderCalls).toHaveLength(25);
    expect(boundedTranscript?.transcript).toHaveLength(5_000);
    expect(boundedTranscript).toMatchObject({
      source: "native",
      availability: "available",
      completeness: "partial",
      hasMore: true,
      limit: { pageSize: 200, maxPages: 25, maxItems: 5_000, maxBytes: 2 * 1024 * 1024 },
    });
    await db.update(runRuntimeSpans).set({
      state: "unresolved",
      completeness: "unknown",
      closedAt: new Date(),
      writerLeaseReleasedAt: new Date(),
    }).where(eq(runRuntimeSpans.runId, run.id));
  });
});
