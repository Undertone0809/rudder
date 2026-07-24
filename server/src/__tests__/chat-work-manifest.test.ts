import {
  agents,
  applyPendingMigrations,
  assets,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatMessages,
  chatWorkManifestItems,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  organizationResources,
  organizations,
  projectResourceAttachments,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatWorkManifestService } from "../services/chat-work-manifest.ts";

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

async function availablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Failed to allocate port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const external = process.env.RUDDER_CHAT_WORK_MANIFEST_TEST_DATABASE_URL?.trim();
  if (external) {
    await applyPendingMigrations(external);
    return { connectionString: external, dataDir: "", instance: null };
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-work-manifest-"));
  const port = await availablePort();
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
  await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("chatWorkManifestService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof chatWorkManifestService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = chatWorkManifestService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatWorkManifestItems);
    await db.delete(chatAttachments);
    await db.delete(assets);
    await db.delete(chatMessages);
    await db.delete(heartbeatRuns);
    await db.delete(chatContextLinks);
    await db.delete(chatConversations);
    await db.delete(projectResourceAttachments);
    await db.delete(organizationResources);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedBase(label = "Manifest") {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: `${label} Org`,
      urlKey: deriveOrganizationUrlKey(`${label} ${orgId}`),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, orgId, name: `${label} Agent` });
    await db.insert(chatConversations).values({ id: conversationId, orgId, title: `${label} Chat` });
    return { orgId, agentId, conversationId };
  }

  it("classifies visible message links and attachments with output precedence", async () => {
    const { orgId, agentId, conversationId } = await seedBase();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      status: "completed",
      chatConversationId: conversationId,
    });
    await db.insert(chatMessages).values([
      {
        id: userMessageId,
        orgId,
        conversationId,
        role: "user",
        body: "Use https://example.com/report and [brief](library-file://file?p=docs%2Fbrief.md)",
      },
      {
        id: assistantMessageId,
        orgId,
        conversationId,
        role: "assistant",
        body: "Built [report](library-file://file?p=artifacts%2Freports%2Freport.md) and cited https://example.com/report#result",
        runId,
        replyingAgentId: agentId,
      },
    ]);
    const [userAsset, agentAsset] = await db.insert(assets).values([
      {
        orgId,
        provider: "local",
        objectKey: `user-${randomUUID()}`,
        contentType: "text/plain",
        byteSize: 12,
        sha256: randomUUID(),
        originalFilename: "brief.txt",
        createdByUserId: "operator",
      },
      {
        orgId,
        provider: "local",
        objectKey: `agent-${randomUUID()}`,
        contentType: "text/markdown",
        byteSize: 42,
        sha256: randomUUID(),
        originalFilename: "result.md",
        createdByAgentId: agentId,
      },
    ]).returning();
    await db.insert(chatAttachments).values([
      { orgId, conversationId, messageId: userMessageId, assetId: userAsset!.id },
      { orgId, conversationId, messageId: assistantMessageId, assetId: agentAsset!.id },
    ]);

    await svc.reconcileConversation(conversationId);
    const manifest = await svc.getConversationManifest(conversationId);

    expect(manifest.outputs.map((item) => item.title)).toEqual(expect.arrayContaining(["report", "result.md"]));
    expect(manifest.sources.map((item) => item.title)).toEqual(expect.arrayContaining(["brief", "brief.txt"]));
    expect(manifest.references).toHaveLength(0);
    expect(manifest.outputs.some((item) => item.url === "https://example.com/report")).toBe(false);
    expect(manifest.sources.filter((item) => item.url === "https://example.com/report")).toHaveLength(1);
  });

  it("excludes annotation-owned attachments and quoted annotation content from work sources", async () => {
    const { orgId, conversationId } = await seedBase("Annotations");
    const messageId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "user",
      body: "Please review the selected response.",
    });
    const [annotationAsset, ordinaryAsset] = await db.insert(assets).values([
      {
        orgId,
        provider: "local",
        objectKey: `annotation-${randomUUID()}`,
        contentType: "text/plain",
        byteSize: 12,
        sha256: randomUUID(),
        originalFilename: "annotation-context.txt",
        createdByUserId: "operator",
      },
      {
        orgId,
        provider: "local",
        objectKey: `ordinary-${randomUUID()}`,
        contentType: "text/plain",
        byteSize: 12,
        sha256: randomUUID(),
        originalFilename: "ordinary-source.txt",
        createdByUserId: "operator",
      },
    ]).returning();
    const [annotationAttachment] = await db.insert(chatAttachments).values([
      { orgId, conversationId, messageId, assetId: annotationAsset!.id },
      { orgId, conversationId, messageId, assetId: ordinaryAsset!.id },
    ]).returning();
    await db.update(chatMessages).set({
      structuredPayload: {
        inlineAnnotations: [{
          id: randomUUID(),
          surface: "assistant_body",
          selectedText: "https://quoted.example/private",
          comment: "[private](library-file://file?p=private.md)",
          sourceConversationId: conversationId,
          sourceMessageId: randomUUID(),
          sourceHash: "a".repeat(64),
          start: 0,
          end: 5,
          prefix: "",
          suffix: "",
          attachmentIds: [annotationAttachment!.id],
        }],
      },
    }).where(eq(chatMessages.id, messageId));

    await svc.reconcileConversation(conversationId);
    const manifest = await svc.getConversationManifest(conversationId);

    expect(manifest.sources.map((item) => item.title)).toEqual(["ordinary-source.txt"]);
    expect(manifest.sources.some((item) => item.url?.includes("quoted.example"))).toBe(false);
    expect(manifest.sources.some((item) => item.title === "private")).toBe(false);
  });

  it("excludes trusted message-owned inline visuals and removes historical misclassified outputs", async () => {
    const { orgId, agentId, conversationId } = await seedBase("InlineVisual");
    const messageId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      body: 'Capacity\n::rudder-inline-vis{slot="0"}',
      replyingAgentId: agentId,
    });
    const [asset] = await db.insert(assets).values({
      orgId,
      provider: "local",
      objectKey: `visual-${randomUUID()}`,
      contentType: "text/html",
      byteSize: 42,
      sha256: "a".repeat(64),
      originalFilename: "inline-visual-1.html",
      createdByAgentId: agentId,
    }).returning();
    const [attachment] = await db.insert(chatAttachments).values({
      orgId,
      conversationId,
      messageId,
      assetId: asset!.id,
    }).returning();

    await svc.reconcileConversation(conversationId);
    expect((await svc.getConversationManifest(conversationId)).outputs.map((item) => item.title))
      .toContain("inline-visual-1.html");

    await db.update(chatMessages).set({
      structuredPayload: {
        inlineVisualsV1: [{
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "ready",
          attachmentId: attachment!.id,
          contentType: "text/html",
          byteSize: 42,
          sha256: "a".repeat(64),
        }],
      },
    }).where(eq(chatMessages.id, messageId));
    await svc.reconcileConversation(conversationId);

    expect((await svc.getConversationManifest(conversationId)).outputs).toEqual([]);
    expect(await db.select().from(chatWorkManifestItems)).toEqual([]);
  });

  it("does not hide ordinary or forged Agent HTML attachments", async () => {
    const { orgId, agentId, conversationId } = await seedBase("OrdinaryHtml");
    const messageId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      body: 'Report\n::rudder-inline-vis{slot="0"}',
      replyingAgentId: agentId,
      structuredPayload: {
        inlineVisualsV1: [{
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "ready",
          attachmentId: randomUUID(),
          contentType: "text/html",
          byteSize: 42,
          sha256: "b".repeat(64),
        }],
      },
    });
    const [asset] = await db.insert(assets).values({
      orgId,
      provider: "local",
      objectKey: `report-${randomUUID()}`,
      contentType: "text/html",
      byteSize: 42,
      sha256: "a".repeat(64),
      originalFilename: "report.html",
      createdByAgentId: agentId,
    }).returning();
    await db.insert(chatAttachments).values({ orgId, conversationId, messageId, assetId: asset!.id });

    await svc.reconcileConversation(conversationId);
    expect((await svc.getConversationManifest(conversationId)).outputs.map((item) => item.title))
      .toEqual(["report.html"]);
  });

  it("removes stale derived items but preserves durable outputs", async () => {
    const { orgId, agentId, conversationId } = await seedBase("Reconcile");
    const runId = randomUUID();
    const messageId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, orgId, agentId, status: "completed", chatConversationId: conversationId });
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      body: "[artifact](library-file://file?p=artifacts%2Fartifact.md) https://reference.example/path",
      runId,
      replyingAgentId: agentId,
    });
    await svc.reconcileConversation(conversationId);
    await db.update(chatMessages).set({ body: "Refreshed answer" }).where(eq(chatMessages.id, messageId));
    await svc.reconcileConversation(conversationId);
    const manifest = await svc.getConversationManifest(conversationId);

    expect(manifest.outputs.map((item) => item.title)).toContain("artifact");
    expect(manifest.references).toHaveLength(0);
  });

  it("includes visible Rudder entity links in references", async () => {
    const { orgId, conversationId } = await seedBase("References");
    const referencedConversationId = randomUUID();
    const referencedConversationTitle = "Original referenced chat title that is much longer than the compact manifest row";
    const renamedConversationTitle = "Renamed referenced chat title that remains much longer than the compact manifest row";
    await db.insert(chatConversations).values({
      id: referencedConversationId,
      orgId,
      title: referencedConversationTitle,
    });
    const privateSideChatId = randomUUID();
    await db.insert(chatConversations).values({
      id: privateSideChatId,
      orgId,
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      title: "Another user's private Side Chat title",
      createdByUserId: "other-user",
    });
    const keptSideChatId = randomUUID();
    await db.insert(chatConversations).values({
      id: keptSideChatId,
      orgId,
      conversationKind: "side_chat",
      messengerVisible: true,
      sideChatState: "kept",
      title: "A kept but still owner-private Side Chat title",
      createdByUserId: "other-user",
    });
    const crossOrganizationConversation = await seedBase("Cross organization");
    await db.insert(chatMessages).values({
      orgId,
      conversationId,
      role: "user",
      body: [
        "[Issue](issue://issue-1?r=REF-1)",
        "[Automation](automation://automation-1?t=Daily%20report)",
        `[Stale referenced title](chat://${referencedConversationId}?messageId=message-1)`,
        `[](chat://${privateSideChatId})`,
        `[](chat://${keptSideChatId})`,
        `[](chat://${crossOrganizationConversation.conversationId})`,
        "[](chat://chat-123)",
      ].join(" "),
    });

    await svc.reconcileConversation(conversationId);
    const manifest = await svc.getConversationManifest(conversationId);
    const referencedChat = manifest.references.find((item) =>
      item.metadata?.conversationId === referencedConversationId
    );

    expect(manifest.references.map((item) => item.targetType)).toEqual([
      "issue",
      "automation",
      "chat_conversation",
      "chat_conversation",
      "chat_conversation",
      "chat_conversation",
      "chat_conversation",
    ]);
    expect(manifest.references.map((item) => item.title)).toEqual([
      "Issue",
      "Automation",
      referencedConversationTitle,
      "Chat",
      "Chat",
      "Chat",
      "Chat",
    ]);
    expect(manifest.references.map((item) => item.metadata)).toEqual([
      { issueId: "issue-1", ref: "REF-1", commentId: null },
      { automationId: "automation-1" },
      { conversationId: referencedConversationId, messageId: "message-1" },
      { conversationId: privateSideChatId, messageId: null },
      { conversationId: keptSideChatId, messageId: null },
      { conversationId: crossOrganizationConversation.conversationId, messageId: null },
      { conversationId: "chat-123", messageId: null },
    ]);

    const privateSideChat = manifest.references.find((item) =>
      item.metadata?.conversationId === privateSideChatId
    );
    expect(privateSideChat).toMatchObject({ title: "Chat" });
    if (!privateSideChat) throw new Error("Expected private Side Chat manifest reference");
    await db.update(chatWorkManifestItems)
      .set({ title: "Previously persisted private Side Chat title" })
      .where(eq(chatWorkManifestItems.id, privateSideChat.id));
    await svc.reconcileConversation(conversationId);
    const repairedManifest = await svc.getConversationManifest(conversationId);
    expect(repairedManifest.references.find((item) =>
      item.metadata?.conversationId === privateSideChatId
    )).toMatchObject({
      id: privateSideChat.id,
      title: "Chat",
    });

    await db.update(chatConversations)
      .set({ title: renamedConversationTitle })
      .where(eq(chatConversations.id, referencedConversationId));
    await svc.reconcileConversation(conversationId);
    const renamedManifest = await svc.getConversationManifest(conversationId);
    const renamedReferencedChats = renamedManifest.references.filter((item) =>
      item.metadata?.conversationId === referencedConversationId
    );

    expect(renamedReferencedChats).toHaveLength(1);
    expect(renamedReferencedChats[0]).toMatchObject({
      id: referencedChat?.id,
      title: renamedConversationTitle,
    });
  });

  it("keeps project resources in the project roll-up and enforces organization boundaries", async () => {
    const first = await seedBase("Project");
    const second = await seedBase("Other");
    const projectId = randomUUID();
    const resourceId = randomUUID();
    const runId = randomUUID();
    await db.insert(projects).values({ id: projectId, orgId: first.orgId, name: "Manifest Project" });
    await db.insert(organizationResources).values({
      id: resourceId,
      orgId: first.orgId,
      name: "Research brief",
      kind: "document",
      locator: "https://research.example/brief",
    });
    await db.insert(projectResourceAttachments).values({ orgId: first.orgId, projectId, resourceId });
    await db.insert(chatContextLinks).values({
      orgId: first.orgId,
      conversationId: first.conversationId,
      entityType: "project",
      entityId: projectId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId: first.orgId,
      agentId: first.agentId,
      status: "completed",
      chatConversationId: first.conversationId,
      contextSnapshot: { projectId },
    });
    await db.insert(chatMessages).values({
      orgId: second.orgId,
      conversationId: second.conversationId,
      role: "user",
      body: "https://private.example",
    });

    await svc.reconcileConversation(first.conversationId);
    const manifest = await svc.getConversationManifest(first.conversationId);

    expect(manifest.sources).toHaveLength(0);
    expect(manifest.project).toEqual({ id: projectId, totalCount: 1 });
    expect(manifest.outputs.concat(manifest.sources, manifest.references).some((item) => item.orgId === second.orgId)).toBe(false);
  });

  it("returns project roll-up work when the current chat has no manifest items", async () => {
    const { orgId, conversationId } = await seedBase("Empty project chat");
    const otherConversationId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, orgId, name: "Shared Project" });
    await db.insert(chatConversations).values({ id: otherConversationId, orgId, title: "Project work chat" });
    await db.insert(chatContextLinks).values([
      { orgId, conversationId, entityType: "project", entityId: projectId },
      { orgId, conversationId: otherConversationId, entityType: "project", entityId: projectId },
    ]);
    await db.insert(chatMessages).values({
      orgId,
      conversationId: otherConversationId,
      role: "user",
      body: "https://shared-project.example/source",
    });
    await svc.reconcileConversation(otherConversationId);
    await svc.reconcileConversation(conversationId);

    const manifest = await svc.getConversationManifest(conversationId);

    expect(manifest.totalCount).toBe(0);
    expect(manifest.project).toEqual({ id: projectId, totalCount: 1 });
  });
});
