import {
  activityLog,
  agents,
  applyPendingMigrations,
  assets,
  chatAttachments,
  chatContextLinks,
  chatControlActions,
  chatConversations,
  chatGenerations,
  chatMessages,
  chatQueuedMessages,
  chatWorkManifestItems,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  nativeSegments,
  organizationLogos,
  organizations,
  productAnalyticsEvents,
  runRuntimeSpans,
  runtimeBindings,
  runtimeRetentionClaims,
  runtimeSourceAliases,
  sideChatCloseIntents,
  sideChatFirstInputs,
  sideChatProviderCleanupIntents,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  deriveOrganizationUrlKey,
  MESSENGER_FORK_GROUP_DEFAULT_ICON,
} from "@rudderhq/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeDriver } from "../agent-runtimes/index.js";
import { hashChatAnnotationSource } from "../services/chat-inline-annotations.js";
import { chatWorkManifestService } from "../services/chat-work-manifest.js";
import { chatService } from "../services/chats.js";
import { lockNodeMutationAuthority } from "../services/organization-mutation-fence.js";
import { lockRuntimeRetentionScope, type RuntimeRetentionDb } from "../services/runtime-kernel/runtime-retention.js";
import { sideChatCloseService } from "../services/side-chat-close.js";
import { sideChatProviderCleanupService } from "../services/side-chat-provider-cleanup.js";
import { SIDE_CHAT_TTL_MS, sideChatService } from "../services/side-chats.js";
import type { StorageService } from "../storage/types.js";

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

async function getAvailablePort() {
  const configuredPort = process.env.RUDDER_SIDE_CHAT_TEST_PORT?.trim();
  if (configuredPort) {
    const port = Number(configuredPort);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      throw new Error("RUDDER_SIDE_CHAT_TEST_PORT must be a valid TCP port");
    }
    return port;
  }

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
  const external = process.env.RUDDER_SIDE_CHAT_TEST_DATABASE_URL?.trim();
  if (external) {
    await applyPendingMigrations(external);
    return { connectionString: external, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-side-chat-"));
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
  });
  await instance.initialise();
  await instance.start();
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

async function waitForDatabaseLockWaiters(db: ReturnType<typeof createDb>, minimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$client.unsafe(
      `select count(*)::int as count
       from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'`,
    ) as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiters`);
}

describe("sideChatService", () => {
  let db!: ReturnType<typeof createDb>;
  let chats!: ReturnType<typeof chatService>;
  let service!: ReturnType<typeof sideChatService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    chats = chatService(db);
    service = sideChatService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    // This suite owns its disposable DB and seeds provider rows without
    // launching native writers; retire only those synthetic leases at teardown.
    const cleanedAt = new Date();
    await db.update(runRuntimeSpans).set({
      state: "unresolved",
      closedAt: cleanedAt,
      writerLeaseReleasedAt: cleanedAt,
    }).where(isNull(runRuntimeSpans.writerLeaseReleasedAt));
    await db.delete(activityLog);
    await db.delete(sideChatCloseIntents);
    await db.delete(sideChatFirstInputs);
    await db.delete(sideChatProviderCleanupIntents);
    await db.delete(runtimeRetentionClaims);
    await db.delete(runtimeBindings);
    await db.delete(heartbeatRuns);
    await db.delete(productAnalyticsEvents);
    await db.delete(messengerCustomGroupEntries);
    await db.delete(messengerCustomGroups);
    await db.delete(chatWorkManifestItems);
    await db.delete(chatAttachments);
    await db.delete(assets);
    await db.delete(chatContextLinks);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createSource(userId = "side-chat-owner", title = "Source answer") {
    const orgId = randomUUID();
    const sourceConversationId = randomUUID();
    const anchorMessageId = randomUUID();
    const startedAt = new Date("2026-07-19T02:00:00.000Z");
    await db.insert(organizations).values({
      id: orgId,
      name: `Side Chat ${orgId}`,
      urlKey: deriveOrganizationUrlKey(`Side Chat ${orgId}`),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: sourceConversationId,
      orgId,
      title,
      createdByUserId: userId,
      modelOverride: "gpt-5.6-terra",
      effortOverride: "xhigh",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId,
        conversationId: sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Original question",
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      {
        id: anchorMessageId,
        orgId,
        conversationId: sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Anchored answer",
        structuredPayload: { privateRuntimeData: true },
        createdAt: new Date(startedAt.getTime() + 1_000),
        updatedAt: new Date(startedAt.getTime() + 1_000),
      },
      {
        id: randomUUID(),
        orgId,
        conversationId: sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Must not be copied",
        createdAt: new Date(startedAt.getTime() + 2_000),
        updatedAt: new Date(startedAt.getTime() + 2_000),
      },
    ]);
    return { orgId, sourceConversationId, anchorMessageId, userId };
  }

  async function createSideChat(source: Awaited<ReturnType<typeof createSource>>) {
    return service.create({
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-test-mutation",
    });
  }

  async function seedProviderForkForCleanup(
    source: Awaited<ReturnType<typeof createSource>>,
    sideChat: Awaited<ReturnType<typeof createSideChat>>,
    options: { runtimeType?: string; initialRunStatus?: "completed" | "running" } = {},
  ) {
    const runtimeType = options.runtimeType ?? "test_runtime";
    const initialRunStatus = options.initialRunStatus ?? "completed";
    const spanClosedAt = new Date();
    const spanOpenedAt = new Date(spanClosedAt.getTime() - 1_000);
    const agentId = randomUUID();
    const forkRunId = randomUUID();
    const parentBindingId = randomUUID();
    const bindingId = randomUUID();
    const parentSessionId = "opencode-parent-session";
    const nativeSessionId = "opencode-side-chat-session";
    const cwd = "/workspace/side-chat-cleanup";
    const exportEnv = { HOME: "/operator" };
    const sessionParams = {
      sessionId: nativeSessionId,
      profileBindingId: bindingId,
      profileOrgId: source.orgId,
      hostId: "local",
      profileId: "opencode-profile",
      capabilityRevision: "opencode-capability-1",
      transport: "opencode-managed-server-http",
      serverUrl: "http://127.0.0.1:43123",
      cwd,
      directory: cwd,
      serverCommand: "opencode",
      exportCommand: "opencode",
      providerVersion: "1.2.3",
      exportEnv,
    };
    await db.insert(agents).values({
      id: agentId,
      orgId: source.orgId,
      name: "Side Chat cleanup agent",
      role: "engineer",
      agentRuntimeType: runtimeType,
      permissions: {},
    });
    await db.insert(runtimeBindings).values({
      id: parentBindingId,
      orgId: source.orgId,
      conversationId: source.sourceConversationId,
      principalScopeRef: `user:${source.userId}`,
      agentId,
      runtimeType,
      hostId: "local",
      profileId: "opencode-profile",
      capabilityRevision: "opencode-capability-1",
      continuity: "native",
    });
    const [parentSegment] = await db.insert(nativeSegments).values({
      orgId: source.orgId,
      bindingId: parentBindingId,
      runtimeType,
      nativeSessionId: parentSessionId,
      rootSessionId: parentSessionId,
      providerStateJson: { sessionId: parentSessionId },
      state: "open",
    }).returning();
    await db.update(runtimeBindings).set({ currentSegmentId: parentSegment!.id })
      .where(eq(runtimeBindings.id, parentBindingId));

    await db.insert(runtimeBindings).values({
      id: bindingId,
      orgId: source.orgId,
      conversationId: sideChat.id,
      principalScopeRef: `user:${source.userId}`,
      agentId,
      runtimeType,
      hostId: "local",
      profileId: "opencode-profile",
      capabilityRevision: "opencode-capability-1",
      continuity: "native",
      parentBindingId,
      sourceBoundaryRef: "opencode-parent-turn",
      bindingEpoch: 7,
    });
    const [segment] = await db.insert(nativeSegments).values({
      orgId: source.orgId,
      bindingId,
      runtimeType,
      nativeSessionId,
      rootSessionId: parentSessionId,
      providerStateJson: sessionParams,
      sourceBoundaryRef: "opencode-child-turn",
      state: "open",
    }).returning();
    await db.update(runtimeBindings).set({ currentSegmentId: segment!.id })
      .where(eq(runtimeBindings.id, bindingId));

    await db.insert(heartbeatRuns).values({
      id: forkRunId,
      orgId: source.orgId,
      agentId,
      status: initialRunStatus,
      chatConversationId: sideChat.id,
      scene: "side_chat",
      targetType: "chat_conversation",
      targetId: sideChat.id,
      idempotencyKey: `side-chat-cleanup:${sideChat.id}`,
      sessionIntentJson: {
        kind: "fork",
        reuseScope: "explicit",
        sourceRunId: "parent-run",
        sourceBoundaryRef: "opencode-parent-turn",
        sessionId: nativeSessionId,
        sessionParams,
      },
      contextSnapshot: {
        runtimeProviderProfile: {
          runtimeType,
          cwd,
          providerVersion: "1.2.3",
          command: "opencode",
          serverCommand: "opencode",
          exportCommand: "opencode",
          exportEnv,
        },
      },
    });
    await db.insert(runRuntimeSpans).values({
      orgId: source.orgId,
      runId: forkRunId,
      bindingId,
      segmentId: segment!.id,
      attemptRef: `side-chat-cleanup:${forkRunId}`,
      ownerToken: "test-run-owner",
      ordinal: 0,
      selectorJson: { kind: "opencode_message", sessionId: nativeSessionId },
      state: initialRunStatus === "completed" ? "sealed" : "open",
      completeness: initialRunStatus === "completed" ? "complete" : "partial",
      openedAt: spanOpenedAt,
      updatedAt: initialRunStatus === "completed" ? spanClosedAt : spanOpenedAt,
      ...(initialRunStatus === "completed"
        ? { closedAt: spanClosedAt, writerLeaseReleasedAt: spanClosedAt }
        : {}),
    });
    return { agentId, bindingId, forkRunId, nativeSessionId, parentSessionId, runtimeType, segmentId: segment!.id };
  }

  it("hydrates runtime continuity from each conversation binding, with legacy fallback", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const legacySource = await createSource("side-chat-legacy-owner", "Legacy source");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId: source.orgId,
      name: "Continuity Test Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      permissions: {},
    });
    await db.insert(runtimeBindings).values([
      {
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        principalScopeRef: "board:continuity-parent",
        agentId,
        runtimeType: "codex_local",
        continuity: "native",
      },
      {
        orgId: source.orgId,
        conversationId: sideChat.id,
        principalScopeRef: "board:continuity-side-chat",
        agentId,
        runtimeType: "codex_local",
        continuity: "context_handoff",
      },
    ]);

    const [parent, child, legacy] = await Promise.all([
      chats.getById(source.sourceConversationId),
      chats.getById(sideChat.id),
      chats.getById(legacySource.sourceConversationId),
    ]);

    expect(parent?.runtimeContinuity).toBe("native");
    expect(child?.runtimeContinuity).toBe("context_handoff");
    expect(legacy?.runtimeContinuity).toBe("legacy");
  });

  async function createKeptSideChatWithParentAnchorAnnotation(
    source: Awaited<ReturnType<typeof createSource>>,
  ) {
    const sideChat = await createSideChat(source);
    const annotationId = randomUUID();
    const selectedText = "Anchored answer";
    const annotatedUser = await chats.addUserChatMessage(
      sideChat.id,
      source.orgId,
      "Explain the parent evidence.",
      null,
      {
        structuredPayloadProvided: true,
        structuredPayload: {
          inlineAnnotations: [{
            id: annotationId,
            selectedText,
            comment: "Keep the exact parent anchor.",
            sourceConversationId: source.sourceConversationId,
            sourceMessageId: source.anchorMessageId,
            surface: "assistant_body",
            sourceHash: hashChatAnnotationSource(selectedText),
            start: 0,
            end: selectedText.length,
            prefix: "",
            suffix: "",
            attachmentIds: [],
          }],
        },
        attachments: [{
          provider: "local_disk",
          objectKey: `side-chat-parent-annotation-${randomUUID()}`,
          contentType: "image/png",
          byteSize: 16,
          sha256: "d".repeat(64),
          originalFilename: "parent-annotation.png",
          createdByAgentId: null,
          createdByUserId: source.userId,
        }],
        attachmentFileIndexesByAnnotationId: new Map([[annotationId, [0]]]),
      },
    );
    const reply = await chats.addMessage(sideChat.id, {
      orgId: source.orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Follow-up answer in the Side Chat.",
    });
    await service.keepInMessenger({
      conversationId: sideChat.id,
      userId: source.userId,
    });
    return { annotatedUser, annotationId, reply, sideChat };
  }

  it("creates one hidden Side Chat per client mutation and copies context only through the anchor", async () => {
    const source = await createSource();
    const projectId = randomUUID();
    await db.insert(chatContextLinks).values({
      orgId: source.orgId,
      conversationId: source.sourceConversationId,
      entityType: "project",
      entityId: projectId,
      metadata: { inheritedBy: "side-chat" },
    });
    const before = Date.now();
    const first = await createSideChat(source);
    const second = await createSideChat(source);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      title: "Side chat from: Source answer",
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      forkedFromConversationId: source.sourceConversationId,
      forkedFromMessageId: source.anchorMessageId,
      createdByUserId: source.userId,
      modelOverride: null,
      effortOverride: null,
    });
    expect(first.sideChatExpiresAt?.getTime()).toBeGreaterThanOrEqual(before + SIDE_CHAT_TTL_MS - 1_000);

    const copied = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, first.id))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    expect(copied.map((message) => message.body)).toEqual(expect.arrayContaining([
      "Original question",
      "Anchored answer",
    ]));
    expect(copied.map((message) => message.body)).not.toContain("Must not be copied");
    const copiedAnchor = copied.find((message) => message.body === "Anchored answer");
    expect(copiedAnchor).toMatchObject({
      runId: null,
      approvalId: null,
      structuredPayload: {
        sideChatSource: {
          conversationId: source.sourceConversationId,
          messageId: source.anchorMessageId,
        },
      },
    });
    expect(copiedAnchor?.structuredPayload).not.toHaveProperty("privateRuntimeData");
    const copiedContextLinks = await db
      .select()
      .from(chatContextLinks)
      .where(eq(chatContextLinks.conversationId, first.id));
    expect(copiedContextLinks).toEqual([
      expect.objectContaining({
        orgId: source.orgId,
        entityType: "project",
        entityId: projectId,
        metadata: { inheritedBy: "side-chat" },
      }),
    ]);
    expect(await db.select().from(messengerCustomGroups)).toHaveLength(0);
    expect(await db.select().from(messengerCustomGroupEntries)).toHaveLength(0);
  });

  it("lists active and expired Side Chats for one parent and creator without touching their lifecycle", async () => {
    const source = await createSource();
    const active = await service.create({
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-list-active",
    });
    const expired = await service.create({
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-list-expired",
    });
    const otherOwner = await service.create({
      orgId: source.orgId,
      userId: "another-user",
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-list-other-owner",
    });
    await db.update(chatConversations)
      .set({ sideChatState: "expired", sideChatExpiresAt: null })
      .where(eq(chatConversations.id, expired.id));

    const ownerSideChats = await service.listForSource({
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: source.userId,
    });
    const otherOwnersSideChats = await service.listForSource({
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: "another-user",
    });
    const expiredAfterRead = await db.select({ sideChatState: chatConversations.sideChatState })
      .from(chatConversations)
      .where(eq(chatConversations.id, expired.id));

    expect(ownerSideChats.items.map(({ id }) => id)).toEqual(expect.arrayContaining([active.id, expired.id]));
    expect(ownerSideChats.items).toHaveLength(2);
    expect(ownerSideChats.nextCursor).toBeNull();
    expect(otherOwnersSideChats.items.map(({ id }) => id)).toEqual([otherOwner.id]);
    expect(expiredAfterRead[0]?.sideChatState).toBe("expired");
  });

  it("paginates Side Chat history across tied timestamps with a stable creation-time cursor", async () => {
    const source = await createSource();
    const tiedCreatedAt = new Date("2026-08-01T12:00:00.000Z");
    const makeRow = (overrides: Partial<typeof chatConversations.$inferInsert> = {}) => ({
      id: randomUUID(),
      orgId: source.orgId,
      title: "Side Chat history row",
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      createdByUserId: source.userId,
      forkedFromConversationId: source.sourceConversationId,
      forkedFromMessageId: source.anchorMessageId,
      createdAt: tiedCreatedAt,
      updatedAt: tiedCreatedAt,
      ...overrides,
    });
    const matchingRows = Array.from({ length: 63 }, (_, index) => makeRow({
      sideChatState: index % 2 === 0 ? "active" : "expired",
    }));
    const foreignOrganization = await createSource(source.userId, "Foreign organization");
    await db.insert(chatConversations).values([
      ...matchingRows,
      makeRow({ createdByUserId: "another-user" }),
      makeRow({ sideChatState: "kept" }),
      makeRow({ messengerVisible: true }),
      makeRow({ conversationKind: "chat" }),
      makeRow({ orgId: foreignOrganization.orgId }),
    ]);

    const input = {
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: source.userId,
      limit: 25,
    };
    const firstPage = await service.listForSource(input);
    const pageLengths = [firstPage.items.length];
    const returnedIds = firstPage.items.map(({ id }) => id);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    await db.update(chatConversations)
      .set({ updatedAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(chatConversations.id, matchingRows[40]!.id));

    let cursor = firstPage.nextCursor;
    while (cursor) {
      const page = await service.listForSource({ ...input, cursor });
      pageLengths.push(page.items.length);
      returnedIds.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    }

    expect(pageLengths).toEqual([25, 25, 13]);
    expect(returnedIds).toEqual(matchingRows.map(({ id }) => id).sort((left, right) => left.localeCompare(right)));
    expect(new Set(returnedIds).size).toBe(63);
  });

  it("preserves PostgreSQL microseconds in Side Chat history cursors", async () => {
    const source = await createSource();
    const matchingRows = Array.from({ length: 3 }, () => ({
      id: randomUUID(),
      orgId: source.orgId,
      title: "Microsecond Side Chat",
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      createdByUserId: source.userId,
      forkedFromConversationId: source.sourceConversationId,
      forkedFromMessageId: source.anchorMessageId,
    }));
    await db.insert(chatConversations).values(matchingRows);
    for (const [index, createdAt] of [
      "2026-08-01T12:00:00.123001Z",
      "2026-08-01T12:00:00.123400Z",
      "2026-08-01T12:00:00.123999Z",
    ].entries()) {
      await db.update(chatConversations)
        .set({ createdAt: sql`${createdAt}::timestamptz` })
        .where(eq(chatConversations.id, matchingRows[index]!.id));
    }

    const input = {
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: source.userId,
      limit: 1,
    };
    const returnedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.listForSource({ ...input, cursor });
      returnedIds.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(returnedIds).toEqual(matchingRows.map(({ id }) => id).reverse());
  });

  it("rejects malformed and cross-scope Side Chat history cursors", async () => {
    const source = await createSource();
    await db.insert(chatConversations).values([
      {
        id: randomUUID(),
        orgId: source.orgId,
        title: "First row",
        conversationKind: "side_chat",
        messengerVisible: false,
        sideChatState: "active",
        createdByUserId: source.userId,
        forkedFromConversationId: source.sourceConversationId,
        forkedFromMessageId: source.anchorMessageId,
      },
      {
        id: randomUUID(),
        orgId: source.orgId,
        title: "Second row",
        conversationKind: "side_chat",
        messengerVisible: false,
        sideChatState: "active",
        createdByUserId: source.userId,
        forkedFromConversationId: source.sourceConversationId,
        forkedFromMessageId: source.anchorMessageId,
      },
    ]);
    const firstPage = await service.listForSource({
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: source.userId,
      limit: 1,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    await expect(service.listForSource({
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: source.userId,
      cursor: "not-a-valid-cursor",
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.listForSource({
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: "another-user",
      cursor: firstPage.nextCursor,
    })).rejects.toMatchObject({ status: 400 });

    const otherOrganization = await createSource(source.userId, "Other organization");
    await expect(service.listForSource({
      orgId: otherOrganization.orgId,
      sourceConversationId: otherOrganization.sourceConversationId,
      userId: source.userId,
      cursor: firstPage.nextCursor,
    })).rejects.toMatchObject({ status: 400 });
  });

  it.each([0, 101, 1.5])("rejects out-of-range Side Chat history page size %s", async (limit) => {
    const source = await createSource();
    await expect(service.listForSource({
      orgId: source.orgId,
      sourceConversationId: source.sourceConversationId,
      userId: source.userId,
      limit,
    })).rejects.toMatchObject({ status: 400 });
  });

  it("copies the selected completed historical turn variant instead of the stopped active variant", async () => {
    const source = await createSource();
    const turnId = randomUUID();
    const supersededAt = new Date("2026-07-30T16:54:30.434Z");
    const sourceMessages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, source.sourceConversationId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    const originalUser = sourceMessages.find((message) => message.body === "Original question");
    expect(originalUser).toBeTruthy();

    await db
      .update(chatMessages)
      .set({ chatTurnId: turnId, turnVariant: 0, supersededAt })
      .where(eq(chatMessages.id, originalUser!.id));
    await db
      .update(chatMessages)
      .set({ chatTurnId: turnId, turnVariant: 0, supersededAt })
      .where(eq(chatMessages.id, source.anchorMessageId));
    await db.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Replacement question",
        chatTurnId: turnId,
        turnVariant: 1,
        createdAt: new Date("2026-07-30T16:54:30.434Z"),
        updatedAt: new Date("2026-07-30T16:54:30.434Z"),
      },
      {
        id: randomUUID(),
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "stopped",
        body: "Chat run stopped before a final reply.",
        chatTurnId: turnId,
        turnVariant: 1,
        createdAt: new Date("2026-07-30T16:54:35.390Z"),
        updatedAt: new Date("2026-07-30T16:54:35.390Z"),
      },
    ]);

    const sideChat = await createSideChat(source);
    const copied = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, sideChat.id))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

    expect(copied.map((message) => message.body)).toEqual(expect.arrayContaining([
      "Original question",
      "Anchored answer",
    ]));
    expect(copied.map((message) => message.body)).not.toEqual(expect.arrayContaining([
      "Replacement question",
      "Chat run stopped before a final reply.",
    ]));
  });

  it("does not persist runtime overrides during Side Chat creation", async () => {
    const source = await createSource();
    const input = {
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-runtime-selection",
    };

    const created = await service.create(input);
    expect(created).toMatchObject({
      modelOverride: null,
      effortOverride: null,
    });
  });

  it("remaps copied annotation sources and attachment ownership without exposing annotation files to the manifest", async () => {
    const source = await createSource();
    const selectedText = "Selected answer text";
    const sourceMessageId = randomUUID();
    const annotatedMessageId = randomUUID();
    const annotationAttachmentId = randomUUID();
    const ordinaryAttachmentId = randomUUID();
    const startedAt = new Date("2026-07-19T02:00:00.000Z");
    await db.insert(chatMessages).values([
      {
        id: sourceMessageId,
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: selectedText,
        createdAt: new Date(startedAt.getTime() + 250),
        updatedAt: new Date(startedAt.getTime() + 250),
      },
      {
        id: annotatedMessageId,
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Please explain this evidence.",
        structuredPayload: {
          inlineAnnotations: [{
            id: randomUUID(),
            selectedText,
            comment: "Compare this with the attached image.",
            sourceConversationId: source.sourceConversationId,
            sourceMessageId,
            surface: "assistant_body",
            sourceHash: "a".repeat(64),
            start: 0,
            end: selectedText.length,
            prefix: "",
            suffix: "",
            attachmentIds: [annotationAttachmentId],
          }],
        },
        createdAt: new Date(startedAt.getTime() + 500),
        updatedAt: new Date(startedAt.getTime() + 500),
      },
    ]);
    const [annotationAsset, ordinaryAsset] = await db.insert(assets).values([
      {
        orgId: source.orgId,
        provider: "local",
        objectKey: `side-chat-annotation-${randomUUID()}`,
        contentType: "image/png",
        byteSize: 12,
        sha256: "b".repeat(64),
        originalFilename: "annotation-context.png",
        createdByUserId: source.userId,
      },
      {
        orgId: source.orgId,
        provider: "local",
        objectKey: `side-chat-ordinary-${randomUUID()}`,
        contentType: "text/plain",
        byteSize: 12,
        sha256: "c".repeat(64),
        originalFilename: "ordinary-source.txt",
        createdByUserId: source.userId,
      },
    ]).returning();
    await db.insert(chatAttachments).values([
      {
        id: annotationAttachmentId,
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        messageId: annotatedMessageId,
        assetId: annotationAsset!.id,
      },
      {
        id: ordinaryAttachmentId,
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        messageId: annotatedMessageId,
        assetId: ordinaryAsset!.id,
      },
    ]);

    const sideChat = await createSideChat(source);
    const copiedMessages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, sideChat.id));
    const copiedSource = copiedMessages.find((message) => message.body === selectedText);
    const copiedAnnotated = copiedMessages.find((message) => message.body === "Please explain this evidence.");
    expect(copiedSource).toBeDefined();
    expect(copiedAnnotated).toBeDefined();
    const [copiedAnnotation] = chatInlineAnnotationsFromStructuredPayload(
      copiedAnnotated?.structuredPayload,
    );
    expect(copiedAnnotation).toMatchObject({
      selectedText,
      sourceConversationId: sideChat.id,
      sourceMessageId: copiedSource?.id,
    });
    expect(copiedAnnotation?.attachmentIds).toHaveLength(1);
    expect(copiedAnnotation?.attachmentIds[0]).not.toBe(annotationAttachmentId);

    const copiedAttachments = await db
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.conversationId, sideChat.id));
    expect(copiedAttachments).toHaveLength(2);
    expect(copiedAttachments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: copiedAnnotation?.attachmentIds[0],
        messageId: copiedAnnotated?.id,
        assetId: annotationAsset?.id,
      }),
      expect.objectContaining({
        messageId: copiedAnnotated?.id,
        assetId: ordinaryAsset?.id,
      }),
    ]));

    const manifestService = chatWorkManifestService(db);
    await manifestService.reconcileConversation(sideChat.id);
    const manifest = await manifestService.getConversationManifest(sideChat.id);
    expect(manifest.sources.map((item) => item.title)).toContain("ordinary-source.txt");
    expect(manifest.sources.map((item) => item.title)).not.toContain("annotation-context.png");
  });

  it("remaps an exact inherited parent-anchor annotation when opening a nested Side Chat from a kept Side Chat", async () => {
    const source = await createSource();
    const kept = await createKeptSideChatWithParentAnchorAnnotation(source);

    const nested = await service.create({
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: kept.sideChat.id,
      sourceMessageId: kept.reply.id,
      clientMutationId: "nested-side-chat-parent-annotation",
    });
    const copiedMessages = await chats.listMessages(nested.id, {
      includeTranscript: false,
    });
    const copiedSource = copiedMessages.find((message) => message.body === "Anchored answer");
    const copiedUser = copiedMessages.find((message) => message.body === kept.annotatedUser.body);
    const [copiedAnnotation] = chatInlineAnnotationsFromStructuredPayload(
      copiedUser?.structuredPayload,
    );

    expect(copiedSource).toBeDefined();
    expect(copiedAnnotation).toMatchObject({
      id: kept.annotationId,
      sourceConversationId: nested.id,
      sourceMessageId: copiedSource?.id,
      attachmentIds: [copiedUser?.attachments[0]?.id],
    });
    expect(copiedUser?.attachments[0]?.id).not.toBe(kept.annotatedUser.attachments[0]?.id);
  });

  it("copies workspace-file annotations without inventing an assistant source message", async () => {
    const source = await createSource();
    const annotatedMessageId = randomUUID();
    const laterAnchorId = randomUUID();
    const annotationId = randomUUID();
    const libraryEntryId = randomUUID();
    await db.insert(chatMessages).values([
      {
        id: annotatedMessageId,
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Please review this file selection.",
        structuredPayload: {
          inlineAnnotations: [{
            id: annotationId,
            surface: "workspace_file",
            selectedText: "const answer = 42",
            comment: "Is this correct?",
            sourceConversationId: source.sourceConversationId,
            sourceFilePath: "src/answer.ts",
            sourceLibraryEntryId: libraryEntryId,
            sourceRenderMode: "text",
            sourceHash: "a".repeat(64),
            start: 7,
            end: 24,
            prefix: "export ",
            suffix: ";\n",
            attachmentIds: [],
          }],
        },
        createdAt: new Date("2026-07-19T02:00:03.000Z"),
        updatedAt: new Date("2026-07-19T02:00:03.000Z"),
      },
      {
        id: laterAnchorId,
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "I reviewed the file.",
        createdAt: new Date("2026-07-19T02:00:04.000Z"),
        updatedAt: new Date("2026-07-19T02:00:04.000Z"),
      },
    ]);

    const sideChat = await service.create({
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: laterAnchorId,
      clientMutationId: "side-chat-file-annotation",
    });
    const copiedMessages = await chats.listMessages(sideChat.id, {
      includeTranscript: false,
    });
    const copiedUser = copiedMessages.find((message) =>
      message.body === "Please review this file selection."
    );
    const [copiedAnnotation] = chatInlineAnnotationsFromStructuredPayload(
      copiedUser?.structuredPayload,
    );

    expect(copiedAnnotation).toMatchObject({
      id: annotationId,
      surface: "workspace_file",
      sourceConversationId: sideChat.id,
      sourceFilePath: "src/answer.ts",
      sourceLibraryEntryId: libraryEntryId,
      selectedText: "const answer = 42",
    });
    expect("sourceMessageId" in (copiedAnnotation ?? {})).toBe(false);
  });

  it("remaps an exact inherited parent-anchor annotation when forking a kept Side Chat", async () => {
    const source = await createSource();
    const kept = await createKeptSideChatWithParentAnchorAnnotation(source);
    const boundary = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, kept.sideChat.id))
      .then((messages) => messages.find((message) =>
        message.structuredPayload?.eventType === "side_chat_started"
      ));
    const legacyBoundaryPayload = { ...(boundary?.structuredPayload ?? {}) };
    delete legacyBoundaryPayload.copiedSourceMessageId;
    await db
      .update(chatMessages)
      .set({ structuredPayload: legacyBoundaryPayload })
      .where(eq(chatMessages.id, boundary!.id));

    const fork = await chats.forkConversation({
      sourceConversationId: kept.sideChat.id,
      orgId: source.orgId,
      userId: source.userId,
      sourceMessageId: kept.reply.id,
      createdByUserId: source.userId,
    });
    const copiedMessages = await chats.listMessages(fork.id, {
      includeTranscript: false,
    });
    const copiedSource = copiedMessages.find((message) => message.body === "Anchored answer");
    const copiedUser = copiedMessages.find((message) => message.body === kept.annotatedUser.body);
    const [copiedAnnotation] = chatInlineAnnotationsFromStructuredPayload(
      copiedUser?.structuredPayload,
    );

    expect(copiedSource).toBeDefined();
    expect(copiedAnnotation).toMatchObject({
      id: kept.annotationId,
      sourceConversationId: fork.id,
      sourceMessageId: copiedSource?.id,
      attachmentIds: [copiedUser?.attachments[0]?.id],
    });
    expect(copiedUser?.attachments[0]?.id).not.toBe(kept.annotatedUser.attachments[0]?.id);
  });

  it.each([
    ["a same-organization sibling", false],
    ["a cross-organization conversation", true],
  ])("rejects %s as inherited annotation lineage when forking a kept Side Chat", async (_label, crossOrganization) => {
    const source = await createSource();
    const kept = await createKeptSideChatWithParentAnchorAnnotation(source);
    const foreign = crossOrganization
      ? await createSource("foreign-side-chat-owner", "Foreign source")
      : null;
    const foreignConversationId = foreign?.sourceConversationId ?? randomUUID();
    const foreignMessageId = foreign?.anchorMessageId ?? randomUUID();
    if (!foreign) {
      await db.insert(chatConversations).values({
        id: foreignConversationId,
        orgId: source.orgId,
        title: "Sibling source",
        createdByUserId: source.userId,
        issueCreationMode: "manual_approval",
        planMode: false,
      });
      await db.insert(chatMessages).values({
        id: foreignMessageId,
        orgId: source.orgId,
        conversationId: foreignConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Sibling source",
      });
    }
    await db
      .update(chatMessages)
      .set({
        structuredPayload: {
          inlineAnnotations: [{
            id: kept.annotationId,
            selectedText: foreign ? "Anchored answer" : "Sibling source",
            comment: "Forged lineage",
            sourceConversationId: foreignConversationId,
            sourceMessageId: foreignMessageId,
            surface: "assistant_body",
            sourceHash: hashChatAnnotationSource(
              foreign ? "Anchored answer" : "Sibling source",
            ),
            start: 0,
            end: (foreign ? "Anchored answer" : "Sibling source").length,
            prefix: "",
            suffix: "",
            attachmentIds: [],
          }],
        },
      })
      .where(eq(chatMessages.id, kept.annotatedUser.id));

    await expect(chats.forkConversation({
      sourceConversationId: kept.sideChat.id,
      orgId: source.orgId,
      userId: source.userId,
      sourceMessageId: kept.reply.id,
      createdByUserId: source.userId,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("outside"),
    });
  });

  it("snapshots and bounds the direct source title when the Side Chat is created", async () => {
    const sourceTitle = "S".repeat(250);
    const source = await createSource("side-chat-title-owner", sourceTitle);
    const sideChat = await createSideChat(source);

    await db
      .update(chatConversations)
      .set({ title: "Renamed after Side Chat creation" })
      .where(eq(chatConversations.id, source.sourceConversationId));

    expect(sideChat.title).toBe(`Side chat from: ${sourceTitle.slice(0, 184)}`);
    expect(sideChat.title).toHaveLength(200);
    const [persisted] = await db
      .select({ title: chatConversations.title })
      .from(chatConversations)
      .where(eq(chatConversations.id, sideChat.id));
    expect(persisted?.title).toBe(sideChat.title);
  });

  it("records one deduplicated analytics event for Side Chat creation", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const retry = await createSideChat(source);

    expect(retry.id).toBe(sideChat.id);
    const events = await db.select().from(productAnalyticsEvents)
      .where(eq(productAnalyticsEvents.entityId, sideChat.id));
    expect(events.filter((event) => event.eventName === "chat_created")).toMatchObject([
      {
        orgId: source.orgId,
        actorType: "human",
        origin: "human",
        properties: { creation_path: "side_chat", initial_role: "system" },
      },
    ]);
    expect(events.filter((event) => event.eventName === "chat_created")).toHaveLength(1);
  });

  it("coalesces concurrent Side Chat creation and conflicts on owner, source, or Agent reuse", async () => {
    const source = await createSource();
    const input = {
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-create-intent-race",
    };
    const [first, concurrentRetry] = await Promise.all([
      service.create(input),
      service.create(input),
    ]);

    expect(concurrentRetry.id).toBe(first.id);
    await expect(service.create({ ...input, userId: "different-owner" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.create({ ...input, sourceConversationId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.create({ ...input, preferredAgentId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });

    const crossOwnerMutationId = "side-chat-cross-owner-race";
    const crossOwnerAttempts = await Promise.allSettled([
      service.create({ ...input, clientMutationId: crossOwnerMutationId }),
      service.create({ ...input, userId: "different-owner", clientMutationId: crossOwnerMutationId }),
    ]);
    expect(crossOwnerAttempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(crossOwnerAttempts.filter((attempt) => attempt.status === "rejected")).toMatchObject([
      { reason: { status: 409 } },
    ]);
    expect(await db.select().from(chatConversations).where(eq(
      chatConversations.sideChatClientMutationId,
      crossOwnerMutationId,
    ))).toHaveLength(1);

    const replayed = await sideChatService(db).findExistingForCreate(input);
    const persistedIntents = await db.select().from(sideChatFirstInputs)
      .where(eq(sideChatFirstInputs.conversationId, first.id));
    expect(replayed?.id).toBe(first.id);
    expect(persistedIntents).toMatchObject([{
      ownerUserId: source.userId,
      creationMutationId: input.clientMutationId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      status: "awaiting",
    }]);
  });

  it("serializes the first input, retries a released claim, and reads its accepted state after service recreation", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const input = {
      orgId: source.orgId,
      conversationId: sideChat.id,
      userId: source.userId,
      clientMutationId: "side-chat-first-input-mutation",
      requestFingerprint: "side-chat-first-input-fingerprint",
    };
    const [claimA, claimB] = await Promise.all([
      service.claimFirstInput(input),
      service.claimFirstInput(input),
    ]);
    const claim = claimA.kind === "claimed" ? claimA : claimB;
    expect([claimA.kind, claimB.kind].sort()).toEqual(["claimed", "pending"]);
    if (claim.kind !== "claimed") throw new Error("Expected one Side Chat first-input claim");

    await expect(service.claimFirstInput({
      ...input,
      requestFingerprint: "different-first-input",
    })).rejects.toMatchObject({ status: 409 });

    await expect(chats.addUserChatMessage(
      sideChat.id,
      source.orgId,
      "First Side Chat input",
      null,
      {
        clientMutationId: input.clientMutationId,
        clientMutationFingerprint: input.requestFingerprint,
        sideChatFirstInputClaimToken: randomUUID(),
        sideChatFirstInputFingerprint: input.requestFingerprint,
      },
    )).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, sideChat.id),
      eq(chatMessages.clientMutationId, input.clientMutationId),
    ))).toHaveLength(0);

    await service.releaseFirstInputClaim({ conversationId: sideChat.id, claimToken: claim.claimToken });
    const retryClaim = await sideChatService(db).claimFirstInput(input);
    expect(retryClaim.kind).toBe("claimed");
    if (retryClaim.kind !== "claimed") throw new Error("Expected released Side Chat input claim to retry");
    const acceptedMessage = await chats.addUserChatMessage(
      sideChat.id,
      source.orgId,
      "First Side Chat input",
      null,
      {
        clientMutationId: input.clientMutationId,
        clientMutationFingerprint: input.requestFingerprint,
        sideChatFirstInputClaimToken: retryClaim.claimToken,
        sideChatFirstInputFingerprint: input.requestFingerprint,
      },
    );

    const readbackService = sideChatService(db);
    await expect(readbackService.claimFirstInput(input)).resolves.toMatchObject({
      kind: "replay",
      userMessageId: acceptedMessage.id,
      activityLogged: false,
    });
    await expect(readbackService.claimFirstInput({
      ...input,
      requestFingerprint: "different-first-input-after-acceptance",
    })).rejects.toMatchObject({ status: 409 });
    const [persistedIntent] = await db.select().from(sideChatFirstInputs)
      .where(eq(sideChatFirstInputs.conversationId, sideChat.id));
    const acceptedMessages = await db.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, sideChat.id),
      eq(chatMessages.clientMutationId, input.clientMutationId),
    ));
    const generations = await db.select().from(chatGenerations)
      .where(eq(chatGenerations.conversationId, sideChat.id));
    expect(persistedIntent).toMatchObject({
      creationMutationId: "side-chat-test-mutation",
      requestClientMutationId: input.clientMutationId,
      requestFingerprint: input.requestFingerprint,
      status: "accepted",
      userMessageId: acceptedMessage.id,
      claimToken: null,
      claimExpiresAt: null,
    });
    expect(acceptedMessages).toHaveLength(1);
    expect(generations).toHaveLength(0);
  });

  it("recovers an accepted first input after a crash before Generation admission without duplicating either row", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const input = {
      orgId: source.orgId,
      conversationId: sideChat.id,
      userId: source.userId,
      clientMutationId: "first-input-crash-boundary",
      requestFingerprint: "first-input-crash-boundary-fingerprint",
    };
    const claim = await service.claimFirstInput(input);
    if (claim.kind !== "claimed") throw new Error("Expected first-input claim before simulated crash");
    const userMessage = await chats.addUserChatMessage(
      sideChat.id,
      source.orgId,
      "Resume this accepted first input",
      null,
      {
        clientMutationId: input.clientMutationId,
        clientMutationFingerprint: input.requestFingerprint,
        sideChatFirstInputClaimToken: claim.claimToken,
        sideChatFirstInputFingerprint: input.requestFingerprint,
      },
    );

    const acceptedBeforeRestart = await db.select().from(sideChatFirstInputs)
      .where(eq(sideChatFirstInputs.conversationId, sideChat.id));
    expect(acceptedBeforeRestart[0]).toMatchObject({
      status: "accepted",
      userMessageId: userMessage.id,
      generationId: null,
    });
    expect(await db.select().from(chatGenerations)
      .where(eq(chatGenerations.conversationId, sideChat.id))).toHaveLength(0);

    const restartedChatService = chatService(db);
    const recovered = await Promise.all([
      restartedChatService.ensureSideChatFirstInputGeneration({
        orgId: source.orgId,
        conversationId: sideChat.id,
        userMessageId: userMessage.id,
      }),
      restartedChatService.ensureSideChatFirstInputGeneration({
        orgId: source.orgId,
        conversationId: sideChat.id,
        userMessageId: userMessage.id,
      }),
    ]);

    expect(recovered.map(({ generation }) => generation.id)).toEqual([
      recovered[0]!.generation.id,
      recovered[0]!.generation.id,
    ]);
    expect(recovered.map(({ executionAdmitted }) => executionAdmitted)).toEqual([false, false]);
    expect(await db.select().from(chatGenerations)
      .where(eq(chatGenerations.conversationId, sideChat.id))).toHaveLength(1);
    expect(await db.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, sideChat.id),
      eq(chatMessages.clientMutationId, input.clientMutationId),
    ))).toHaveLength(1);
    expect(await db.select().from(sideChatFirstInputs)
      .where(eq(sideChatFirstInputs.conversationId, sideChat.id))).toMatchObject([{
      generationId: recovered[0]!.generation.id,
    }]);
  });

  it("treats distinct mutation keys as new sends before, during, and after the first reply", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const firstRequest = {
      orgId: source.orgId,
      conversationId: sideChat.id,
      userId: source.userId,
      clientMutationId: "first-send-key",
      requestFingerprint: "same-message-content",
    };
    const claim = await service.claimFirstInput(firstRequest);
    if (claim.kind !== "claimed") throw new Error("Expected initial Side Chat first-input claim");
    const acceptedMessage = await chats.addUserChatMessage(sideChat.id, source.orgId, "Same message content", null, {
      clientMutationId: firstRequest.clientMutationId,
      clientMutationFingerprint: firstRequest.requestFingerprint,
      sideChatFirstInputClaimToken: claim.claimToken,
      sideChatFirstInputFingerprint: firstRequest.requestFingerprint,
    });
    const { generation } = await chats.ensureSideChatFirstInputGeneration({
      orgId: source.orgId,
      conversationId: sideChat.id,
      userMessageId: acceptedMessage.id,
    });
    await expect(service.claimFirstInput({
      ...firstRequest,
      clientMutationId: "second-send-before-first-reply",
      requestFingerprint: "different-follow-up-content",
    })).resolves.toEqual({ kind: "not_first" });

    await expect(service.claimFirstInput({
      ...firstRequest,
      clientMutationId: "second-send-during-generation",
    })).resolves.toEqual({ kind: "not_first" });

    await db.update(chatGenerations)
      .set({ status: "completed", runtimeTerminalAt: new Date() })
      .where(eq(chatGenerations.id, generation!.id));
    await expect(service.claimFirstInput({
      ...firstRequest,
      clientMutationId: "second-send-after-generation",
      requestFingerprint: "different-follow-up-content",
    })).resolves.toEqual({ kind: "not_first" });
  });

  it("validates a migrated source-less Side Chat against the legacy creation-id fallback", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const legacyMessage = await chats.addUserChatMessage(
      sideChat.id,
      source.orgId,
      "Previously accepted Side Chat input",
      null,
      {
        clientMutationId: "legacy-first-message",
        clientMutationFingerprint: "legacy-first-message-fingerprint",
      },
    );
    await db.update(chatConversations).set({
      sideChatClientMutationId: null,
      forkedFromConversationId: null,
      forkedFromMessageId: null,
    }).where(eq(chatConversations.id, sideChat.id));
    await db.update(sideChatFirstInputs).set({
      creationMutationId: `legacy:${sideChat.id}`,
      sourceConversationId: null,
      sourceMessageId: null,
    }).where(eq(sideChatFirstInputs.conversationId, sideChat.id));

    await expect(service.claimFirstInput({
      orgId: source.orgId,
      conversationId: sideChat.id,
      userId: source.userId,
      clientMutationId: "legacy-first-message",
      requestFingerprint: "legacy-first-message-fingerprint",
    })).resolves.toMatchObject({
      kind: "replay",
      userMessageId: legacyMessage.id,
      activityLogged: false,
    });
  });

  it("reclaims an expired first-input lease with a new fencing token", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const input = {
      orgId: source.orgId,
      conversationId: sideChat.id,
      userId: source.userId,
      clientMutationId: "side-chat-expired-first-input",
      requestFingerprint: "same-request-on-retry",
    };
    const original = await service.claimFirstInput(input);
    if (original.kind !== "claimed") throw new Error("Expected initial first-input claim");
    await db.update(sideChatFirstInputs)
      .set({ claimExpiresAt: new Date(Date.now() - 1) })
      .where(eq(sideChatFirstInputs.conversationId, sideChat.id));

    const reclaimed = await service.claimFirstInput(input);
    expect(reclaimed.kind).toBe("claimed");
    if (reclaimed.kind !== "claimed") throw new Error("Expected expired first-input claim to be reclaimed");
    expect(reclaimed.claimToken).not.toBe(original.claimToken);
    await expect(chats.addUserChatMessage(
      sideChat.id,
      source.orgId,
      "Fenced stale claimant",
      null,
      {
        clientMutationId: input.clientMutationId,
        clientMutationFingerprint: input.requestFingerprint,
        sideChatFirstInputClaimToken: original.claimToken,
        sideChatFirstInputFingerprint: input.requestFingerprint,
      },
    )).rejects.toMatchObject({ status: 409 });
  });

  it("keeps Side Chat data until the active provider generation is terminal", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [generation] = await db.insert(chatGenerations).values({
      orgId: source.orgId,
      conversationId: sideChat.id,
      status: "stopping",
    }).returning();
    await expect(service.destroy({ conversationId: sideChat.id, userId: source.userId }))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id))).toHaveLength(1);
    await db.update(chatGenerations).set({ status: "completed", runtimeTerminalAt: new Date() })
      .where(eq(chatGenerations.id, generation!.id));
    await expect(service.destroy({ conversationId: sideChat.id, userId: source.userId }))
      .resolves.toEqual({ id: sideChat.id });
  });

  it("persists Side Chat close, stops only its generation, and resumes deletion after restart", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [parentGeneration] = await db.insert(chatGenerations).values({
      orgId: source.orgId, conversationId: source.sourceConversationId, status: "running",
    }).returning();
    const [childGeneration] = await db.insert(chatGenerations).values({
      orgId: source.orgId, conversationId: sideChat.id, status: "running",
    }).returning();
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    expect((await service.requestClose({ conversationId: sideChat.id, userId: source.userId })).id).toBe(intent.id);
    const [marked] = await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id));
    expect(marked).toMatchObject({ sideChatState: "completed", sideChatExpiresAt: null });
    await expect(service.assertMutable(sideChat, source.userId))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.keepInMessenger({ conversationId: sideChat.id, userId: source.userId }))
      .rejects.toMatchObject({ status: 409 });
    const storage = { deleteObject: vi.fn() } as unknown as StorageService;
    const close = sideChatCloseService(db, storage, service, "close-worker-before-restart");
    expect(await close.processIntent(intent.id)).toBe("pending");
    const [stopAction] = await db.select().from(chatControlActions)
      .where(eq(chatControlActions.id, intent.stopControlActionId));
    expect(stopAction).toMatchObject({ actionKind: "stop", expectedGenerationId: childGeneration!.id });
    expect((await db.select().from(chatGenerations).where(eq(chatGenerations.id, childGeneration!.id)))[0]?.status)
      .toBe("stop_requested");
    expect((await db.select().from(chatGenerations).where(eq(chatGenerations.id, parentGeneration!.id)))[0]?.status)
      .toBe("running");
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id)))
      .toHaveLength(1);

    await db.update(chatGenerations).set({
      status: "stopped", controlState: "terminal", runtimeTerminalAt: new Date(), completedAt: new Date(),
    }).where(eq(chatGenerations.id, childGeneration!.id));
    await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    const restarted = sideChatCloseService(db, storage, service, "close-worker-after-restart");
    expect(await restarted.processBatch(1)).toBe(1);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id))).toEqual([]);
    expect(await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id))).toEqual([]);
    expect((await db.select().from(chatGenerations).where(eq(chatGenerations.id, parentGeneration!.id)))[0]?.status)
      .toBe("running");
  });

  it("serializes removal of shared attachment references and cleans the final asset once", async () => {
    const source = await createSource();
    const [asset] = await db.insert(assets).values({
      orgId: source.orgId, provider: "local_disk", objectKey: "shared-removal.txt",
      contentType: "text/plain", byteSize: 4, sha256: "b".repeat(64),
    }).returning();
    const attachments = await db.insert(chatAttachments).values([0, 1].map(() => ({
      orgId: source.orgId, conversationId: source.sourceConversationId,
      messageId: source.anchorMessageId, assetId: asset!.id,
    }))).returning();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select().from(assets).where(eq(assets.id, asset!.id)).for("update");
      acquired();
      await held;
    });
    let removals: Promise<unknown[]> | undefined;
    try {
      await ready;
      removals = Promise.all(attachments.map((attachment) => chats.removeAttachment(attachment.id)));
      // Both removers must serialize before checking the remaining references,
      // rather than each seeing the other's uncommitted reference and skipping cleanup.
      await waitForDatabaseLockWaiters(db, 2);
      release();
      await blocker;
      const results = await removals;
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ assetDeleted: false }),
        expect.objectContaining({ assetDeleted: true }),
      ]));
      expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toEqual([]);
      expect(await chats.removeAttachment(attachments[0]!.id)).toBeNull();
    } finally {
      release();
      await blocker;
      await removals;
    }
  }, 15_000);

  it("does not invert message-edit and asset locks during conversation removal", async () => {
    const source = await createSource();
    const [asset] = await db.insert(assets).values({
      orgId: source.orgId, provider: "local_disk", objectKey: "edit-removal.txt",
      contentType: "text/plain", byteSize: 4, sha256: "c".repeat(64),
    }).returning();
    const attachment = {
      orgId: source.orgId, conversationId: source.sourceConversationId,
      messageId: source.anchorMessageId, assetId: asset!.id,
    };
    await db.insert(chatAttachments).values(attachment);
    let proceed!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const canCopy = new Promise<void>((resolve) => { proceed = resolve; });
    const editing = db.transaction(async (tx) => {
      await lockNodeMutationAuthority(tx, source.orgId, "shared");
      await tx.select().from(chatMessages).where(eq(chatMessages.id, source.anchorMessageId)).for("update");
      acquired();
      await canCopy;
      await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
      // Matches an admitted message edit copying an existing attachment.
      await tx.insert(chatAttachments).values(attachment);
    });
    let removing: ReturnType<typeof chats.remove> | undefined;
    try {
      await ready;
      removing = chats.remove(source.sourceConversationId);
      await waitForDatabaseLockWaiters(db, 1);
      proceed();
      await editing;
      expect(await removing).toMatchObject({ id: source.sourceConversationId });
      expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toEqual([]);
    } finally {
      proceed();
      await Promise.allSettled([editing, removing]);
    }
  }, 15_000);

  it("shares Chat authority between writers while fencing a Rust ownership handoff", async () => {
    const source = await createSource();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const writer = db.transaction(async (tx) => {
      await lockNodeMutationAuthority(tx, source.orgId, "shared");
      acquired();
      await held;
    });
    let handoff: Promise<unknown> | undefined;
    try {
      await ready;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await lockNodeMutationAuthority(tx, source.orgId, "shared");
      });
      let handedOff = false;
      handoff = db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(sql`UPDATE organization_mutation_state
          SET owner = 'rust', fence_epoch = fence_epoch + 1, fence_token = gen_random_uuid()
          WHERE org_id = ${source.orgId}::uuid`);
      }).then(() => { handedOff = true; });
      await waitForDatabaseLockWaiters(db, 1);
      expect(handedOff).toBe(false);
      release();
      await writer;
      await handoff;
      await expect(db.transaction((tx) => lockNodeMutationAuthority(tx, source.orgId, "shared")))
        .rejects.toMatchObject({ status: 409 });
    } finally {
      release();
      await writer;
      await handoff;
      await db.execute(sql`UPDATE organization_mutation_state
        SET owner = 'node', fence_epoch = fence_epoch + 1, fence_token = gen_random_uuid()
        WHERE org_id = ${source.orgId}::uuid`);
    }
  }, 15_000);

  it("serializes close with new user and queued writes without blocking the parent chat", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    let releaseClose!: () => void;
    let closeLocked!: () => void;
    const released = new Promise<void>((resolve) => { releaseClose = resolve; });
    const locked = new Promise<void>((resolve) => { closeLocked = resolve; });
    const closing = db.transaction(async (tx) => {
      await lockNodeMutationAuthority(tx, source.orgId, "shared");
      await lockRuntimeRetentionScope(tx as unknown as RuntimeRetentionDb, source.orgId);
      await tx.select({ id: chatConversations.id }).from(chatConversations)
        .where(eq(chatConversations.id, sideChat.id)).for("update");
      await tx.insert(sideChatCloseIntents).values({
        orgId: source.orgId,
        conversationId: sideChat.id,
        ownerUserId: source.userId,
        sourceConversationId: source.sourceConversationId,
        sourceMessageId: source.anchorMessageId,
      });
      await tx.update(chatConversations).set({
        sideChatState: "completed", sideChatCompletedAt: new Date(), sideChatExpiresAt: null,
      }).where(eq(chatConversations.id, sideChat.id));
      closeLocked();
      await released;
    });
    await locked;

    const failures = [
      chats.addUserChatMessage(sideChat.id, source.orgId, "Late user message"),
      chats.createQueuedMessage({
        orgId: source.orgId,
        conversationId: sideChat.id,
        clientMutationId: "close-race-queued",
        payload: { body: "Late queued message" },
      }),
      chats.addMessage(sideChat.id, {
        orgId: source.orgId, role: "user", kind: "message", body: "Late direct user message",
      }),
    ].map((promise) => promise.then(() => null, (error: unknown) => error));
    try {
      await waitForDatabaseLockWaiters(db, 2);
      await expect(chats.addUserChatMessage(source.sourceConversationId, source.orgId, "Parent remains writable"))
        .resolves.toMatchObject({ body: "Parent remains writable" });
      await expect(chats.createQueuedMessage({
        orgId: source.orgId,
        conversationId: source.sourceConversationId,
        clientMutationId: "parent-close-race-queue",
        payload: { body: "Parent queue remains writable" },
      })).resolves.toMatchObject({ conversationId: source.sourceConversationId });
    } finally {
      releaseClose();
      await closing;
    }
    expect(await Promise.all(failures)).toEqual([
      expect.objectContaining({ status: 409 }),
      expect.objectContaining({ status: 409 }),
      expect.objectContaining({ status: 409 }),
    ]);
    expect(await db.select().from(chatMessages).where(eq(chatMessages.conversationId, sideChat.id)))
      .not.toContainEqual(expect.objectContaining({ body: "Late user message" }));
    expect(await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.conversationId, sideChat.id)))
      .toEqual([]);
  });

  it("rejects message and queue replays after a durable close request", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const messageInput = [
      sideChat.id, source.orgId, "Accepted before close", null,
      { clientMutationId: "side-chat-close-replay" },
    ] as const;
    const queueInput = {
      orgId: source.orgId,
      conversationId: sideChat.id,
      clientMutationId: "side-chat-close-queue-replay",
      payload: { body: "Queued before close" },
    };
    await chats.addUserChatMessage(...messageInput);
    await chats.createQueuedMessage(queueInput);
    const beforeClose = await db.select().from(chatMessages)
      .where(eq(chatMessages.conversationId, sideChat.id));
    await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    await expect(chats.addUserChatMessage(...messageInput)).rejects.toMatchObject({ status: 409 });
    await expect(chats.createQueuedMessage(queueInput)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(chatMessages).where(eq(chatMessages.conversationId, sideChat.id)))
      .toHaveLength(beforeClose.length);
    expect(await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.conversationId, sideChat.id)))
      .toHaveLength(1);
  });

  it("waits for the child Run terminal and writes provider cleanup only after destruction", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const fork = await seedProviderForkForCleanup(source, sideChat, { initialRunStatus: "running" });
    const [generation] = await db.insert(chatGenerations).values({
      orgId: source.orgId, conversationId: sideChat.id, status: "running",
    }).returning();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, fork.forkRunId));
    const [targetOnlyRun] = await db.insert(heartbeatRuns).values({
      orgId: source.orgId,
      agentId: fork.agentId,
      status: "running",
      scene: "side_chat",
      targetType: "chat_conversation",
      targetId: sideChat.id,
      idempotencyKey: `side-chat-close-target-only:${sideChat.id}`,
      sessionIntentJson: {
        kind: "fresh", reuseScope: "none", sourceRunId: null, sessionId: null, sessionParams: null,
      },
    }).returning();
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    const close = sideChatCloseService(db, { deleteObject: vi.fn() } as unknown as StorageService, service);
    expect(await close.processIntent(intent.id)).toBe("pending");
    const [stopAction] = await db.select().from(chatControlActions)
      .where(eq(chatControlActions.id, intent.stopControlActionId));
    expect(stopAction).toMatchObject({ actionKind: "stop", expectedGenerationId: generation!.id });
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id)))
      .toHaveLength(1);
    expect(await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id))).toEqual([]);

    await db.update(chatGenerations).set({
      status: "stopped", controlState: "terminal", runtimeTerminalAt: new Date(), completedAt: new Date(),
    }).where(eq(chatGenerations.id, generation!.id));
    await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    expect(await close.processIntent(intent.id)).toBe("pending");
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id)))
      .toHaveLength(1);

    await db.update(heartbeatRuns).set({ status: "completed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fork.forkRunId));
    const runClosedAt = new Date();
    await db.update(runRuntimeSpans).set({
      state: "sealed",
      completeness: "complete",
      closedAt: runClosedAt,
      writerLeaseReleasedAt: runClosedAt,
      updatedAt: runClosedAt,
    }).where(eq(runRuntimeSpans.runId, fork.forkRunId));
    await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    expect(await close.processIntent(intent.id)).toBe("pending");
    await expect(service.destroy({ conversationId: sideChat.id, userId: source.userId }))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id))).toEqual([]);
    await db.update(heartbeatRuns).set({ status: "completed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, targetOnlyRun!.id));
    await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    expect(await close.processIntent(intent.id)).toBe("closed");
    expect(await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id))).toHaveLength(1);
  });

  it("retains a close intent when runtime termination is unverified", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await db.insert(chatGenerations).values({
      orgId: source.orgId,
      conversationId: sideChat.id,
      status: "interrupted_unverified",
      controlState: "control_lost",
      runtimeTerminalAt: new Date(),
    });
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    const close = sideChatCloseService(db, { deleteObject: vi.fn() } as unknown as StorageService, service);
    expect(await close.processIntent(intent.id)).toBe("pending");
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id)))
      .toHaveLength(1);
    expect((await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id)))[0])
      .toMatchObject({ state: "retry_wait", lastError: "generation_terminal_not_verified" });
  });

  it("requires review for a legacy terminal generation without runtime terminal evidence", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await db.insert(chatGenerations).values({
      orgId: source.orgId, conversationId: sideChat.id, status: "completed",
      completedAt: new Date(), runtimeTerminalAt: null,
    });
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    const close = sideChatCloseService(db, { deleteObject: vi.fn() } as unknown as StorageService, service);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await close.processIntent(intent.id)).toBe("pending");
      await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
        .where(eq(sideChatCloseIntents.id, intent.id));
    }
    expect(await close.processIntent(intent.id)).toBe("review_required");
    expect((await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id)))[0])
      .toMatchObject({ state: "review_required", lastError: "generation_terminal_not_verified" });
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id)))
      .toHaveLength(1);
  });

  it("retries object cleanup after conversation deletion without losing attachment identity", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [message] = await db.select({ id: chatMessages.id }).from(chatMessages)
      .where(eq(chatMessages.conversationId, sideChat.id)).limit(1);
    const [asset] = await db.insert(assets).values({
      orgId: source.orgId, provider: "local_disk", objectKey: "close-object.png",
      contentType: "image/png", byteSize: 4, sha256: "a".repeat(64),
    }).returning();
    await db.insert(chatAttachments).values({
      orgId: source.orgId, conversationId: sideChat.id, messageId: message!.id, assetId: asset!.id,
    });
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    const deleteObject = vi.fn().mockRejectedValueOnce(new Error("storage temporarily unavailable"))
      .mockResolvedValue(undefined);
    const storage = {
      deleteObject,
      headObject: vi.fn().mockResolvedValueOnce({ exists: true }).mockResolvedValue({ exists: false }),
    } as unknown as StorageService;
    expect(await sideChatCloseService(db, storage, service, "first-close-worker").processIntent(intent.id))
      .toBe("pending");
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id))).toEqual([]);
    const [retained] = await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id));
    expect(retained).toMatchObject({
      attachmentCursor: 0,
      attachmentsJson: [{ orgId: source.orgId, assetId: asset!.id, objectKey: "close-object.png", provider: "local_disk" }],
      state: "retry_wait",
    });

    await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    const restarted = sideChatCloseService(db, storage, service, "restarted-close-worker");
    expect(await restarted.processIntent(intent.id)).toBe("pending");
    expect((await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id)))[0])
      .toMatchObject({ attachmentCursor: 0, state: "retry_wait" });
    await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    expect(await restarted.processBatch(1))
      .toBe(1);
    expect(deleteObject).toHaveBeenCalledTimes(3);
    expect(await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id))).toEqual([]);
  });

  it("persists unmaterialized queued assets through deletion and resumes cleanup after restart", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [asset] = await db.insert(assets).values({
      orgId: source.orgId, provider: "local_disk", objectKey: "staged-queue.png",
      contentType: "image/png", byteSize: 4, sha256: "a".repeat(64),
    }).returning();
    await db.insert(chatQueuedMessages).values({
      orgId: source.orgId, conversationId: sideChat.id, position: 1,
      clientMutationId: "pending-file", payload: {
        body: "Queued file", __rudderQueueAnnotationAssets: {
          version: 1, fingerprint: "pending-file", attachments: [{
            assetId: asset!.id, annotationId: randomUUID(), fileIndex: 0,
          }],
        },
      },
    });
    // A repeated queue reference must not produce duplicate object deletion.
    await db.insert(chatQueuedMessages).values({
      orgId: source.orgId, conversationId: sideChat.id, position: 2,
      clientMutationId: "pending-file-repeated", payload: {
        body: "Another queued reference", __rudderQueueAnnotationAssets: {
          version: 1, fingerprint: "pending-file-repeated", attachments: [{
            assetId: asset!.id, annotationId: randomUUID(), fileIndex: 0,
          }],
        },
      },
    });
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    const deleteObject = vi.fn().mockRejectedValueOnce(new Error("temporary object-store failure"))
      .mockResolvedValue(undefined);
    const storage = {
      deleteObject, headObject: vi.fn().mockResolvedValue({ exists: false }),
    } as unknown as StorageService;
    expect(await sideChatCloseService(db, storage, service, "queued-first-worker").processIntent(intent.id))
      .toBe("pending");
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id))).toEqual([]);
    expect(await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.conversationId, sideChat.id)))
      .toEqual([]);
    const [retained] = await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id));
    expect(retained).toMatchObject({
      state: "retry_wait", attachmentCursor: 0,
      attachmentsJson: [{ orgId: source.orgId, assetId: asset!.id,
        objectKey: "staged-queue.png", provider: "local_disk" }],
    });
    expect(retained!.attachmentsJson).toHaveLength(1);
    await db.update(sideChatCloseIntents).set({ nextAttemptAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    expect(await sideChatCloseService(db, storage, service, "queued-restarted-worker").processIntent(intent.id))
      .toBe("closed");
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toEqual([]);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, source.sourceConversationId)))
      .toHaveLength(1);
  });

  it("preserves an asset still referenced by another conversation's queued message", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [asset] = await db.insert(assets).values({
      orgId: source.orgId, provider: "local_disk", objectKey: "shared-queue.png",
      contentType: "image/png", byteSize: 4, sha256: "a".repeat(64),
    }).returning();
    const payload = { body: "Pending file", __rudderQueueAnnotationAssets: {
      version: 1, fingerprint: "shared-queue", attachments: [{
        assetId: asset!.id, annotationId: randomUUID(), fileIndex: 0,
      }],
    } };
    await db.insert(chatQueuedMessages).values([
      { orgId: source.orgId, conversationId: sideChat.id, position: 1,
        clientMutationId: "child-shared-queue", payload },
      { orgId: source.orgId, conversationId: source.sourceConversationId, position: 1,
        clientMutationId: "parent-shared-queue", payload },
    ]);
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    const deleteObject = vi.fn();
    expect(await sideChatCloseService(db, { deleteObject } as unknown as StorageService, service)
      .processIntent(intent.id)).toBe("closed");
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toHaveLength(1);
    expect(await db.select().from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.conversationId, source.sourceConversationId))).toHaveLength(1);
  });

  it.each(["attachment org", "asset org"] as const)(
    "fails closed when the Side Chat %s differs from its conversation organization",
    async (mismatch) => {
      const source = await createSource();
      const other = await createSource();
      const sideChat = await createSideChat(source);
      const [message] = await db.select({ id: chatMessages.id }).from(chatMessages)
        .where(eq(chatMessages.conversationId, sideChat.id)).limit(1);
      const [asset] = await db.insert(assets).values({
        orgId: mismatch === "asset org" ? other.orgId : source.orgId,
        provider: "local_disk", objectKey: `cross-org-${mismatch}.png`,
        contentType: "image/png", byteSize: 4, sha256: "a".repeat(64),
      }).returning();
      await db.insert(chatAttachments).values({
        orgId: mismatch === "attachment org" ? other.orgId : source.orgId,
        conversationId: sideChat.id, messageId: message!.id, assetId: asset!.id,
      });
      const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
      const deleteObject = vi.fn();
      expect(await sideChatCloseService(db, { deleteObject } as unknown as StorageService, service)
        .processIntent(intent.id)).toBe("pending");
      expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id)))
        .toHaveLength(1);
      expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toHaveLength(1);
      expect(deleteObject).not.toHaveBeenCalled();
      expect((await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id)))[0])
        .toMatchObject({
          state: "retry_wait", attachmentsJson: [],
          lastError: "Side Chat attachment identity is missing or outside its organization",
        });
    },
  );

  it("preserves an attachment asset shared with the organization logo", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [message] = await db.select({ id: chatMessages.id }).from(chatMessages)
      .where(eq(chatMessages.conversationId, sideChat.id)).limit(1);
    const [asset] = await db.insert(assets).values({
      orgId: source.orgId, provider: "local_disk", objectKey: "shared-logo.png",
      contentType: "image/png", byteSize: 4, sha256: "a".repeat(64),
    }).returning();
    await db.insert(chatAttachments).values({
      orgId: source.orgId, conversationId: sideChat.id, messageId: message!.id, assetId: asset!.id,
    });
    await db.insert(organizationLogos).values({ orgId: source.orgId, assetId: asset!.id });
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    const deleteObject = vi.fn();
    expect(await sideChatCloseService(db, { deleteObject } as unknown as StorageService, service)
      .processIntent(intent.id)).toBe("closed");
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toHaveLength(1);
    expect(await db.select().from(organizationLogos).where(eq(organizationLogos.assetId, asset!.id)))
      .toHaveLength(1);
  });

  it("fences a slow object delete after another worker reclaims its lease", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [message] = await db.select({ id: chatMessages.id }).from(chatMessages)
      .where(eq(chatMessages.conversationId, sideChat.id)).limit(1);
    const [asset] = await db.insert(assets).values({
      orgId: source.orgId, provider: "local_disk", objectKey: "slow-close.png",
      contentType: "image/png", byteSize: 4, sha256: "a".repeat(64),
    }).returning();
    await db.insert(chatAttachments).values({
      orgId: source.orgId, conversationId: sideChat.id, messageId: message!.id, assetId: asset!.id,
    });
    const intent = await service.requestClose({ conversationId: sideChat.id, userId: source.userId });
    let releaseDelete!: () => void;
    let signalDelete!: () => void;
    const deleting = new Promise<void>((resolve) => { signalDelete = resolve; });
    const heldDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const deleteObject = vi.fn().mockImplementationOnce(async () => {
      signalDelete();
      await heldDelete;
    }).mockResolvedValue(undefined);
    const storage = { deleteObject, headObject: vi.fn().mockResolvedValue({ exists: false }) } as unknown as StorageService;
    const first = sideChatCloseService(db, storage, service, "slow-close-worker").processIntent(intent.id);
    await deleting;
    expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toEqual([]);
    await db.update(sideChatCloseIntents).set({ leaseExpiresAt: new Date(0) })
      .where(eq(sideChatCloseIntents.id, intent.id));
    expect(await sideChatCloseService(db, storage, service, "recovery-close-worker")
      .processIntent(intent.id)).toBe("closed");
    releaseDelete();
    expect(await first).toBe("pending");
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(await db.select().from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intent.id))).toEqual([]);
  });

  it("rejects queued Side Chat runtime admission when expiry passes after queue acceptance", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const queuedItem = await chats.createQueuedMessage({
      orgId: source.orgId,
      conversationId: sideChat.id,
      clientMutationId: "side-chat-expiry-queued-admission",
      runtimeSnapshotVersion: 1,
      payload: { body: "Wait until the Side Chat expires" },
      requestActor: {
        type: "board",
        source: "session",
        userId: source.userId,
        orgIds: [source.orgId],
      },
    });
    expect(sideChat.sideChatExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const claim = await chats.claimNextServerQueuedMessage({
      workerId: "side-chat-expiry-worker",
      leaseMs: 30_000,
    });
    expect(claim?.item.id).toBe(queuedItem.id);

    await db.update(chatConversations)
      .set({ sideChatExpiresAt: new Date(Date.now() - 1) })
      .where(eq(chatConversations.id, sideChat.id));

    await expect(chats.admitQueuedSideChatRuntime({
      orgId: source.orgId,
      conversationId: sideChat.id,
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
    })).resolves.toEqual({ admitted: false, reason: "side_chat_expired" });

    const [expired] = await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id));
    expect(expired).toMatchObject({ sideChatState: "expired", sideChatExpiresAt: null });
    const agentRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.chatConversationId, sideChat.id));
    expect(agentRuns).toEqual([]);
  });

  it("destroys an unkept Side Chat and turns an elapsed Side Chat read-only", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await expect(service.destroy({ conversationId: sideChat.id, userId: source.userId })).resolves.toEqual({ id: sideChat.id });
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id))).toHaveLength(0);

    const other = await service.create({
      ...source,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-expiry-test",
    });
    const expiredAt = new Date("2026-07-19T04:00:00.000Z");
    await db.update(chatConversations).set({ sideChatExpiresAt: expiredAt }).where(eq(chatConversations.id, other.id));
    const stale = { ...other, sideChatExpiresAt: expiredAt };
    await expect(service.assertMutable(stale, source.userId, new Date(expiredAt.getTime() + 1))).rejects.toMatchObject({ status: 409 });
    const [expired] = await db.select().from(chatConversations).where(eq(chatConversations.id, other.id));
    expect(expired?.sideChatState).toBe("expired");

    const staleKeep = await service.create({
      ...source,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-expired-keep-test",
    });
    await db
      .update(chatConversations)
      .set({ sideChatExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(chatConversations.id, staleKeep.id));
    await expect(service.keepInMessenger({ conversationId: staleKeep.id, userId: source.userId }))
      .rejects.toMatchObject({ status: 409 });
    const [rejectedKeep] = await db.select().from(chatConversations).where(eq(chatConversations.id, staleKeep.id));
    expect(rejectedKeep).toMatchObject({ sideChatState: "expired", messengerVisible: false });
  });

  it("atomically persists a fork cleanup intent and resumes an expired worker lease after restart", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const seeded = await seedProviderForkForCleanup(source, sideChat);

    await service.destroy({ conversationId: sideChat.id, userId: source.userId });
    const [persisted] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id));
    expect(persisted).toMatchObject({
      ownerUserId: source.userId,
      bindingId: seeded.bindingId,
      bindingEpoch: 7,
      segmentId: seeded.segmentId,
      forkRunId: seeded.forkRunId,
      nativeSessionId: seeded.nativeSessionId,
      parentSessionId: seeded.parentSessionId,
      state: "pending",
    });

    await db.update(sideChatProviderCleanupIntents).set({
      state: "claimed",
      leaseOwner: "crashed-worker",
      leaseEpoch: 4,
      leaseExpiresAt: new Date(Date.now() - 1_000),
      attemptCount: 1,
    }).where(eq(sideChatProviderCleanupIntents.id, persisted!.id));

    let deleteRequest: Record<string, unknown> | null = null;
    const driver = {
      resume: () => ({
        status: "supported",
        value: {
          sessionId: seeded.nativeSessionId,
          sessionDisplayId: seeded.nativeSessionId,
          sessionParams: persisted!.sessionParamsJson,
        },
      }),
      deleteSideChatForkSession: async (request: Record<string, unknown>) => {
        deleteRequest = request;
        return { status: "supported", value: undefined };
      },
    } as unknown as RuntimeDriver;
    const restartedWorker = sideChatProviderCleanupService(db, {
      workerId: "worker-after-restart",
      resolveDriver: () => driver,
    });

    await expect(restartedWorker.processBatch(1)).resolves.toBe(1);
    expect(deleteRequest).toMatchObject({
      expectedParentSessionId: seeded.parentSessionId,
      forkRunId: seeded.forkRunId,
      binding: { id: seeded.bindingId, orgId: source.orgId },
    });
    const [completed] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.id, persisted!.id));
    expect(completed).toMatchObject({
      state: "completed",
      leaseOwner: null,
      leaseEpoch: 5,
      attemptCount: 2,
    });
    expect(completed?.completedAt).toBeInstanceOf(Date);
  });

  it("collects rotated provider sessions and detaches every historical Side Chat alias reference", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const seeded = await seedProviderForkForCleanup(source, sideChat);
    const [firstSegment] = await db.select().from(nativeSegments)
      .where(eq(nativeSegments.id, seeded.segmentId));
    const [firstRun] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.forkRunId));
    const rotatedSessionId = "opencode-side-chat-session-rotated";
    const rotatedSessionParams = {
      ...(firstSegment!.providerStateJson ?? {}),
      sessionId: rotatedSessionId,
    };
    const [rotatedSegment] = await db.insert(nativeSegments).values({
      orgId: source.orgId,
      bindingId: seeded.bindingId,
      runtimeType: seeded.runtimeType,
      segmentOrdinal: 1,
      nativeSessionId: rotatedSessionId,
      rootSessionId: seeded.parentSessionId,
      providerStateJson: rotatedSessionParams,
      sourceBoundaryRef: "opencode-child-turn-rotated",
      state: "open",
    }).returning();
    await db.update(runtimeBindings).set({ currentSegmentId: rotatedSegment!.id })
      .where(eq(runtimeBindings.id, seeded.bindingId));

    const rotatedRunId = randomUUID();
    const rotatedSpanClosedAt = new Date();
    await db.insert(heartbeatRuns).values({
      id: rotatedRunId,
      orgId: source.orgId,
      agentId: seeded.agentId,
      status: "completed",
      chatConversationId: sideChat.id,
      scene: "side_chat",
      targetType: "chat_conversation",
      targetId: sideChat.id,
      idempotencyKey: `side-chat-cleanup-rotated:${sideChat.id}`,
      sessionIntentJson: {
        ...(firstRun!.sessionIntentJson as Record<string, unknown>),
        sessionId: rotatedSessionId,
        sessionParams: rotatedSessionParams,
      },
      contextSnapshot: firstRun!.contextSnapshot,
    });
    await db.insert(runRuntimeSpans).values({
      orgId: source.orgId,
      runId: rotatedRunId,
      bindingId: seeded.bindingId,
      segmentId: rotatedSegment!.id,
      attemptRef: `side-chat-cleanup:${rotatedRunId}`,
      ownerToken: "rotated-test-run-owner",
      ordinal: 0,
      selectorJson: { kind: "opencode_message", sessionId: rotatedSessionId },
      state: "sealed",
      completeness: "complete",
      openedAt: new Date(rotatedSpanClosedAt.getTime() - 1_000),
      closedAt: rotatedSpanClosedAt,
      writerLeaseReleasedAt: rotatedSpanClosedAt,
      updatedAt: rotatedSpanClosedAt,
    });

    const aliasRefs = ["side-chat-history-alias", "side-chat-current-alias", "side-chat-conversation-alias"];
    await db.insert(runtimeSourceAliases).values([
      {
        orgId: source.orgId,
        conversationId: sideChat.id,
        runId: seeded.forkRunId,
        bindingId: seeded.bindingId,
        segmentId: seeded.segmentId,
        sourceKind: "test_side_chat_history",
        sourceRef: aliasRefs[0]!,
        principalScopeRef: `user:${source.userId}`,
      },
      {
        orgId: source.orgId,
        conversationId: sideChat.id,
        runId: rotatedRunId,
        bindingId: seeded.bindingId,
        segmentId: rotatedSegment!.id,
        sourceKind: "test_side_chat_current",
        sourceRef: aliasRefs[1]!,
        principalScopeRef: `user:${source.userId}`,
      },
      {
        orgId: source.orgId,
        conversationId: sideChat.id,
        sourceKind: "test_side_chat_conversation",
        sourceRef: aliasRefs[2]!,
        principalScopeRef: `user:${source.userId}`,
      },
    ]);

    await service.destroy({ conversationId: sideChat.id, userId: source.userId });

    const intents = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id));
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map(({ nativeSessionId }) => nativeSessionId)).size).toBe(2);
    expect(intents).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeSessionId: seeded.nativeSessionId }),
      expect.objectContaining({ nativeSessionId: rotatedSessionId }),
    ]));
    expect(intents.every(({ state }) => state === "review_required")).toBe(true);

    const aliases = await db.select().from(runtimeSourceAliases)
      .where(inArray(runtimeSourceAliases.sourceRef, aliasRefs));
    expect(aliases).toHaveLength(aliasRefs.length);
    expect(aliases).toEqual(expect.arrayContaining(aliasRefs.map((sourceRef) =>
      expect.objectContaining({
        sourceRef,
        conversationId: null,
        runId: null,
        bindingId: null,
        segmentId: null,
      }),
    )));
  });

  it("keeps OpenCode cleanup review-required because Fork/delete exclusion is process-local", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const seeded = await seedProviderForkForCleanup(source, sideChat, { runtimeType: "opencode_local" });
    await service.destroy({ conversationId: sideChat.id, userId: source.userId });

    const [intent] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id));
    expect(intent).toMatchObject({
      state: "review_required",
      stateReason: "provider_fork_delete_mutual_exclusion_is_process_local",
    });
    let deleteCalls = 0;
    const driver = {
      resume: () => ({
        status: "supported",
        value: {
          sessionId: seeded.nativeSessionId,
          sessionDisplayId: seeded.nativeSessionId,
          sessionParams: intent!.sessionParamsJson,
        },
      }),
      deleteSideChatForkSession: async () => {
        deleteCalls += 1;
        return { status: "supported", value: undefined };
      },
    } as unknown as RuntimeDriver;
    const cleanup = sideChatProviderCleanupService(db, { resolveDriver: () => driver });

    await expect(cleanup.processBatch(1)).resolves.toBe(0);
    await expect(cleanup.retryReviewRequired({ orgId: source.orgId, intentId: intent!.id }))
      .resolves.toMatchObject({ state: "pending" });
    await expect(cleanup.processBatch(1)).resolves.toBe(1);
    expect(deleteCalls).toBe(0);
    const [stillReviewRequired] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.id, intent!.id));
    expect(stillReviewRequired).toMatchObject({
      state: "review_required",
      stateReason: "provider_fork_delete_mutual_exclusion_is_process_local",
      attemptCount: 1,
    });
  });

  it("retains and marks review-required when the Provider session is shared by another binding", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const seeded = await seedProviderForkForCleanup(source, sideChat);
    const sharedConversationId = randomUUID();
    const sharedBindingId = randomUUID();
    await db.insert(chatConversations).values({
      id: sharedConversationId,
      orgId: source.orgId,
      title: "Other session consumer",
      createdByUserId: source.userId,
    });
    await db.insert(runtimeBindings).values({
      id: sharedBindingId,
      orgId: source.orgId,
      conversationId: sharedConversationId,
      principalScopeRef: `user:${source.userId}`,
      agentId: seeded.agentId,
      runtimeType: seeded.runtimeType,
      hostId: "local",
      profileId: "opencode-profile",
      capabilityRevision: "opencode-capability-1",
      continuity: "native",
    });
    await db.insert(nativeSegments).values({
      orgId: source.orgId,
      bindingId: sharedBindingId,
      runtimeType: seeded.runtimeType,
      nativeSessionId: seeded.nativeSessionId,
      state: "open",
    });

    await service.destroy({ conversationId: sideChat.id, userId: source.userId });
    const [intent] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id));
    expect(intent).toMatchObject({
      state: "review_required",
      stateReason: "provider_session_id_is_referenced_by_another_binding",
      nativeSessionId: seeded.nativeSessionId,
    });
  });

  it("refuses to destroy a Side Chat whose native binding is a parent of another runtime", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const seeded = await seedProviderForkForCleanup(source, sideChat);
    const childConversationId = randomUUID();
    await db.insert(chatConversations).values({
      id: childConversationId,
      orgId: source.orgId,
      title: "Native descendant",
      createdByUserId: source.userId,
    });
    await db.insert(runtimeBindings).values({
      orgId: source.orgId,
      conversationId: childConversationId,
      principalScopeRef: `user:${source.userId}`,
      agentId: seeded.agentId,
      runtimeType: seeded.runtimeType,
      hostId: "local",
      profileId: "opencode-profile",
      capabilityRevision: "opencode-capability-1",
      continuity: "native",
      parentBindingId: seeded.bindingId,
    });

    await expect(service.destroy({ conversationId: sideChat.id, userId: source.userId }))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(chatConversations).where(eq(chatConversations.id, sideChat.id)))
      .toHaveLength(1);
    expect(await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id))).toEqual([]);
  });

  it("detaches retained lineage references but never sends an unsafe provider delete", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const seeded = await seedProviderForkForCleanup(source, sideChat);
    await db.insert(runtimeRetentionClaims).values({
      orgId: source.orgId,
      bindingId: seeded.bindingId,
      segmentId: seeded.segmentId,
      resourceRef: `provider-session:${seeded.nativeSessionId}`,
      purpose: "transcript-reader",
      principalScopeRef: `user:${source.userId}`,
    });

    await service.destroy({ conversationId: sideChat.id, userId: source.userId });
    const [intent] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id));
    const [claim] = await db.select().from(runtimeRetentionClaims)
      .where(eq(runtimeRetentionClaims.resourceRef, `provider-session:${seeded.nativeSessionId}`));
    expect(intent).toMatchObject({
      state: "review_required",
      stateReason: "provider_resource_has_descendant_or_retention_references",
    });
    expect(claim).toMatchObject({ bindingId: null, segmentId: null, status: "active" });
  });

  it("makes an unsupported Provider cleanup observable without retrying deletion", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await seedProviderForkForCleanup(source, sideChat);
    await service.destroy({ conversationId: sideChat.id, userId: source.userId });

    const deleteForkedSession = async () => ({
      status: "unsupported",
      capability: "side_chat_fork_cleanup",
      reason: "Provider does not support safe fork deletion",
    });
    const driver = {
      resume: () => ({
        status: "supported",
        value: {
          sessionId: "opencode-side-chat-session",
          sessionDisplayId: "opencode-side-chat-session",
          sessionParams: {},
        },
      }),
      deleteSideChatForkSession: deleteForkedSession,
    } as unknown as RuntimeDriver;
    const cleanup = sideChatProviderCleanupService(db, { resolveDriver: () => driver });

    await expect(cleanup.processBatch(1)).resolves.toBe(1);
    const reviewRequired = await cleanup.listReviewRequired();
    expect(reviewRequired).toHaveLength(1);
    expect(reviewRequired[0]).toMatchObject({
      state: "review_required",
      stateReason: expect.stringContaining("Provider does not support safe fork deletion"),
      lastError: expect.stringContaining("Provider does not support safe fork deletion"),
    });
  });

  it("keeps direct source aliases fail-closed and allows an explicit review retry after release", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const seeded = await seedProviderForkForCleanup(source, sideChat);
    const aliasRef = `provider-session:${seeded.nativeSessionId}`;
    await db.insert(runtimeSourceAliases).values({
      orgId: source.orgId,
      sourceKind: "provider_session",
      sourceRef: aliasRef,
      principalScopeRef: `user:${source.userId}`,
    });
    await service.destroy({ conversationId: sideChat.id, userId: source.userId });

    const [intent] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.conversationId, sideChat.id));
    expect(intent).toMatchObject({ state: "review_required" });
    let deleteCalls = 0;
    const driver = {
      resume: () => ({
        status: "supported",
        value: {
          sessionId: seeded.nativeSessionId,
          sessionDisplayId: seeded.nativeSessionId,
          sessionParams: intent!.sessionParamsJson,
        },
      }),
      deleteSideChatForkSession: async () => {
        deleteCalls += 1;
        return { status: "supported", value: undefined };
      },
    } as unknown as RuntimeDriver;
    const cleanup = sideChatProviderCleanupService(db, { resolveDriver: () => driver });

    await expect(cleanup.processBatch(1)).resolves.toBe(0);
    expect(deleteCalls).toBe(0);
    const [stillBlocked] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.id, intent!.id));
    expect(stillBlocked).toMatchObject({
      state: "review_required",
      stateReason: "provider_resource_has_descendant_or_retention_references",
    });

    const releasedAt = new Date();
    await db.update(runtimeSourceAliases).set({ releasedAt, updatedAt: releasedAt })
      .where(eq(runtimeSourceAliases.sourceRef, aliasRef));
    await expect(cleanup.retryReviewRequired({ orgId: randomUUID(), intentId: intent!.id }))
      .resolves.toBeNull();
    await expect(cleanup.retryReviewRequired({ orgId: source.orgId, intentId: intent!.id }))
      .resolves.toMatchObject({ state: "pending", stateReason: null });

    await expect(cleanup.processBatch(1)).resolves.toBe(1);
    expect(deleteCalls).toBe(1);
    const [completed] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.id, intent!.id));
    expect(completed).toMatchObject({ state: "completed", attemptCount: 1 });
  });

  it("takes the retention advisory lock before an expired Side Chat row lock", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await db.update(chatConversations).set({ sideChatExpiresAt: new Date(0) })
      .where(eq(chatConversations.id, sideChat.id));
    const stale = { ...sideChat, sideChatExpiresAt: new Date(0) };
    const now = new Date();

    let releaseAdvisory!: () => void;
    const advisoryRelease = new Promise<void>((resolve) => {
      releaseAdvisory = resolve;
    });
    let advisoryHeld!: () => void;
    const advisoryAcquired = new Promise<void>((resolve) => {
      advisoryHeld = resolve;
    });
    const holderTransaction = db.transaction(async (tx) => {
      await lockRuntimeRetentionScope(tx as unknown as RuntimeRetentionDb, source.orgId);
      advisoryHeld();
      await advisoryRelease;
    });
    await advisoryAcquired;

    const expiredAttempt = service.assertMutable(stale, source.userId, now);
    let releaseRow!: () => void;
    const rowRelease = new Promise<void>((resolve) => {
      releaseRow = resolve;
    });
    let rowLockTransaction: Promise<unknown> | null = null;
    try {
      await waitForDatabaseLockWaiters(db, 1);

      let rowAcquired!: () => void;
      const rowAcquisition = new Promise<void>((resolve) => {
        rowAcquired = resolve;
      });
      rowLockTransaction = db.transaction(async (tx) => {
        await tx.select({ id: chatConversations.id })
          .from(chatConversations)
          .where(eq(chatConversations.id, sideChat.id))
          .for("update");
        rowAcquired();
        await rowRelease;
      });

      const rowWasAvailableBeforeAdvisoryRelease = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 1_000);
        rowAcquisition.then(() => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
      expect(rowWasAvailableBeforeAdvisoryRelease).toBe(true);
    } finally {
      releaseAdvisory();
      await holderTransaction;
      releaseRow();
      await rowLockTransaction;
    }
    await expect(expiredAttempt).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an assistant anchor that has not completed", async () => {
    const source = await createSource();
    await db.update(chatMessages)
      .set({ status: "interrupted" })
      .where(eq(chatMessages.id, source.anchorMessageId));

    await expect(service.create({
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-incomplete-anchor",
    })).rejects.toMatchObject({ status: 422 });
  });

  it("hides a Side Chat from every user except its owner", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await expect(service.assertAccessible(sideChat, "different-user")).rejects.toMatchObject({ status: 404 });
    await expect(service.destroy({ conversationId: sideChat.id, userId: "different-user" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the same conversation id and joins the source Messenger group when present", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [group] = await db.insert(messengerCustomGroups).values({
      orgId: source.orgId,
      userId: source.userId,
      name: "Source work",
      sortOrder: 0,
    }).returning();
    await db.insert(messengerCustomGroupEntries).values({
      orgId: source.orgId,
      userId: source.userId,
      groupId: group!.id,
      threadKey: `chat:${source.sourceConversationId}`,
      sortOrder: 0,
    });

    const kept = await service.keepInMessenger({ conversationId: sideChat.id, userId: source.userId });
    expect(kept).toMatchObject({ id: sideChat.id, messengerVisible: true, sideChatState: "kept" });
    const entries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, group!.id))
      .orderBy(asc(messengerCustomGroupEntries.sortOrder));
    expect(entries.map((entry) => entry.threadKey)).toEqual([
      `chat:${source.sourceConversationId}`,
      `chat:${sideChat.id}`,
    ]);
    await expect(service.requestClose({ conversationId: sideChat.id, userId: source.userId })).rejects.toMatchObject({
      status: 409,
      details: { code: "side_chat_kept" },
    });
    await expect(service.destroy({ conversationId: sideChat.id, userId: source.userId })).rejects.toMatchObject({
      status: 409,
      details: { code: "side_chat_kept" },
    });
  });

  it("creates a fork-family Messenger group when the source is not grouped", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);

    await service.keepInMessenger({ conversationId: sideChat.id, userId: source.userId });

    const groups = await db
      .select()
      .from(messengerCustomGroups)
      .where(eq(messengerCustomGroups.userId, source.userId));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: "Source answer",
      icon: MESSENGER_FORK_GROUP_DEFAULT_ICON,
    });
    const entries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, groups[0]!.id))
      .orderBy(asc(messengerCustomGroupEntries.sortOrder));
    expect(entries.map((entry) => entry.threadKey)).toEqual([
      `chat:${source.sourceConversationId}`,
      `chat:${sideChat.id}`,
    ]);
  });

  it("rolls back the move when the direct source no longer exists", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await db
      .delete(chatConversations)
      .where(eq(chatConversations.id, source.sourceConversationId));

    await expect(service.keepInMessenger({ conversationId: sideChat.id, userId: source.userId }))
      .rejects.toMatchObject({ status: 409 });

    const [persisted] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, sideChat.id));
    expect(persisted).toMatchObject({
      sideChatState: "active",
      messengerVisible: false,
    });
    expect(await db.select().from(messengerCustomGroups)).toHaveLength(0);
    expect(await db.select().from(messengerCustomGroupEntries)).toHaveLength(0);
  });

  it("serializes concurrent moves into one fork-family Messenger group", async () => {
    const source = await createSource();
    const [first, second] = await Promise.all([
      service.create({
        ...source,
        sourceMessageId: source.anchorMessageId,
        clientMutationId: "side-chat-concurrent-move-1",
      }),
      service.create({
        ...source,
        sourceMessageId: source.anchorMessageId,
        clientMutationId: "side-chat-concurrent-move-2",
      }),
    ]);

    await Promise.all([
      service.keepInMessenger({ conversationId: first.id, userId: source.userId }),
      service.keepInMessenger({ conversationId: second.id, userId: source.userId }),
    ]);

    const groups = await db
      .select()
      .from(messengerCustomGroups)
      .where(eq(messengerCustomGroups.userId, source.userId));
    expect(groups).toHaveLength(1);
    const entries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, groups[0]!.id));
    expect(new Set(entries.map((entry) => entry.threadKey))).toEqual(new Set([
      `chat:${source.sourceConversationId}`,
      `chat:${first.id}`,
      `chat:${second.id}`,
    ]));
  });

  it("reuses the root fork-family group for a Side Chat created from a nested source", async () => {
    const source = await createSource();
    const rootConversationId = randomUUID();
    await db.insert(chatConversations).values({
      id: rootConversationId,
      orgId: source.orgId,
      title: "Root conversation",
      createdByUserId: source.userId,
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db
      .update(chatConversations)
      .set({
        forkedFromConversationId: rootConversationId,
        forkRootConversationId: rootConversationId,
      })
      .where(eq(chatConversations.id, source.sourceConversationId));
    const [group] = await db.insert(messengerCustomGroups).values({
      orgId: source.orgId,
      userId: source.userId,
      name: "Existing fork family",
      icon: "rocket::teal",
      sortOrder: 0,
    }).returning();
    const [sourceGroup] = await db.insert(messengerCustomGroups).values({
      orgId: source.orgId,
      userId: source.userId,
      name: "Source's former group",
      icon: "folder::amber",
      sortOrder: 1,
    }).returning();
    await db.insert(messengerCustomGroupEntries).values([
      {
        orgId: source.orgId,
        userId: source.userId,
        groupId: group!.id,
        threadKey: `chat:${rootConversationId}`,
        sortOrder: 0,
      },
      {
        orgId: source.orgId,
        userId: source.userId,
        groupId: sourceGroup!.id,
        threadKey: `chat:${source.sourceConversationId}`,
        sortOrder: 0,
      },
    ]);
    const sideChat = await createSideChat(source);

    await service.keepInMessenger({ conversationId: sideChat.id, userId: source.userId });

    const groups = await db
      .select()
      .from(messengerCustomGroups)
      .where(eq(messengerCustomGroups.userId, source.userId));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ name: "Existing fork family", icon: "rocket::teal" });
    const entries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, group!.id))
      .orderBy(asc(messengerCustomGroupEntries.sortOrder));
    expect(entries.map((entry) => [entry.threadKey, entry.sortOrder])).toEqual([
      [`chat:${rootConversationId}`, 0],
      [`chat:${source.sourceConversationId}`, 1],
      [`chat:${sideChat.id}`, 2],
    ]);
    const sourceGroupEntries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, sourceGroup!.id));
    expect(sourceGroupEntries).toHaveLength(0);
  });
});
