import {
  applyPendingMigrations,
  assets,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatMessages,
  chatWorkManifestItems,
  createDb,
  ensurePostgresDatabase,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  organizations,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  deriveOrganizationUrlKey,
  MESSENGER_FORK_GROUP_DEFAULT_ICON,
} from "@rudderhq/shared";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashChatAnnotationSource } from "../services/chat-inline-annotations.js";
import { chatWorkManifestService } from "../services/chat-work-manifest.js";
import { chatService } from "../services/chats.js";
import { SIDE_CHAT_TTL_MS, sideChatService } from "../services/side-chats.js";

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
    await db.delete(messengerCustomGroupEntries);
    await db.delete(messengerCustomGroups);
    await db.delete(chatWorkManifestItems);
    await db.delete(chatAttachments);
    await db.delete(assets);
    await db.delete(chatContextLinks);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
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
    expect(copiedAnchor).toMatchObject({ runId: null, approvalId: null, structuredPayload: null });
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

  it("persists the provisional runtime override and rejects an idempotent replay with different runtime input", async () => {
    const source = await createSource();
    const input = {
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-runtime-selection",
      modelOverride: "gpt-5.6-sol",
      effortOverride: "high",
    };

    const created = await service.create(input);
    expect(created).toMatchObject({
      modelOverride: "gpt-5.6-sol",
      effortOverride: "high",
    });

    await expect(service.create({
      ...input,
      modelOverride: "gpt-5.6-terra",
    })).rejects.toThrow("Side Chat creation id was already used");
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
    await expect(service.destroy({ conversationId: sideChat.id, userId: source.userId })).rejects.toMatchObject({ status: 409 });
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
