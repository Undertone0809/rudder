import {
  agents,
  applyPendingMigrations,
  assets,
  automations,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  chatWorkManifestItems,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issueComments,
  issues,
  organizationResources,
  organizations,
  projectResourceAttachments,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey, shortRefFor } from "@rudderhq/shared";
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
    await db.delete(automations);
    await db.delete(chatAttachments);
    await db.delete(assets);
    await db.delete(chatMessages);
    await db.delete(heartbeatRuns);
    await db.delete(chatContextLinks);
    await db.delete(chatConversations);
    await db.delete(issueComments);
    await db.delete(issues);
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

  it("projects conversation subagents from current legacy transcript evidence", async () => {
    const { orgId, agentId, conversationId } = await seedBase("Subagents");
    const firstMessageId = randomUUID();
    const latestMessageId = randomUUID();
    const supersededMessageId = randomUUID();
    const transcriptEntry = (
      id: string,
      threadId: string,
      status: string,
      agentPath: string,
      response?: string,
    ) => ({
      kind: "tool_call",
      ts: id === "spawn-1" ? "2026-07-29T01:00:00.000Z" : "2026-07-29T01:00:10.000Z",
      name: "subagent_activity",
      toolUseId: id,
      input: {
        id,
        activity_kind: status,
        agent_path: agentPath,
        receiver_thread_ids: [threadId],
        agent_transcripts: {
          [threadId]: {
            status,
            entries: response
              ? [{ kind: "assistant", ts: "2026-07-29T01:00:12.000Z", text: response }]
              : [],
          },
        },
      },
    });
    await db.insert(chatMessages).values([
      {
        id: firstMessageId,
        orgId,
        conversationId,
        role: "assistant",
        status: "completed",
        body: "Delegating.",
        replyingAgentId: agentId,
        structuredPayload: {
          __chatTranscript: [
            transcriptEntry("spawn-1", "thread-review", "inProgress", "/root/roadmap_reviewer"),
          ],
        },
      },
      {
        id: latestMessageId,
        orgId,
        conversationId,
        role: "assistant",
        status: "completed",
        body: "Review complete.",
        replyingAgentId: agentId,
        structuredPayload: {
          __chatTranscript: [
            transcriptEntry("activity-1", "thread-review", "completed", "/root/roadmap_reviewer", "Passed."),
            transcriptEntry("activity-2", "thread-active", "inProgress", "/root/runtime_verifier"),
          ],
        },
      },
      {
        id: supersededMessageId,
        orgId,
        conversationId,
        role: "assistant",
        status: "completed",
        body: "Superseded.",
        replyingAgentId: agentId,
        supersededAt: new Date("2026-07-29T01:00:20.000Z"),
        structuredPayload: {
          __chatTranscript: [
            transcriptEntry("activity-hidden", "thread-hidden", "completed", "/root/hidden_reviewer"),
          ],
        },
      },
    ]);

    const manifest = await svc.getConversationManifest(conversationId);

    expect(manifest.subagents.totalCount).toBe(2);
    expect(manifest.subagents.active).toEqual([
      expect.objectContaining({
        threadId: "thread-active",
        label: "Runtime Verifier",
        state: "active",
      }),
    ]);
    expect(manifest.subagents.done).toEqual([
      expect.objectContaining({
        threadId: "thread-review",
        sourceMessageId: latestMessageId,
        label: "Roadmap Reviewer",
        state: "done",
        status: "completed",
      }),
    ]);
    expect([
      ...manifest.subagents.active,
      ...manifest.subagents.done,
    ]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "thread-hidden" }),
    ]));
  });

  it("uses accepted native generation transcript events instead of legacy payloads", async () => {
    const { orgId, agentId, conversationId } = await seedBase("NativeSubagents");
    const messageId = randomUUID();
    const generationId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      status: "streaming",
      body: "Working.",
      replyingAgentId: agentId,
      structuredPayload: {
        __chatTranscript: [{
          kind: "tool_call",
          ts: "2026-07-29T01:00:00.000Z",
          name: "subagent_activity",
          toolUseId: "legacy-hidden",
          input: {
            id: "legacy-hidden",
            receiver_thread_ids: ["thread-legacy-hidden"],
          },
        }],
      },
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
      acceptedThroughSeq: 1,
    });
    await db.insert(chatGenerationEvents).values([
      {
        orgId,
        generationId,
        generationSeq: 1,
        attemptEpoch: 1,
        eventKind: "transcript",
        assistantMessageId: messageId,
        payload: {
          entry: {
            kind: "tool_call",
            ts: "2026-07-29T01:00:01.000Z",
            name: "subagent_activity",
            toolUseId: "native-active",
            input: {
              id: "native-active",
              agent_path: "/root/native_verifier",
              receiver_thread_ids: ["thread-native"],
            },
          },
        },
      },
      {
        orgId,
        generationId,
        generationSeq: 2,
        attemptEpoch: 1,
        eventKind: "transcript",
        assistantMessageId: messageId,
        payload: {
          entry: {
            kind: "tool_call",
            ts: "2026-07-29T01:00:02.000Z",
            name: "subagent_activity",
            toolUseId: "native-late",
            input: {
              id: "native-late",
              receiver_thread_ids: ["thread-native-late"],
            },
          },
        },
      },
    ]);

    const manifest = await svc.getConversationManifest(conversationId);
    expect(manifest.subagents.active).toEqual([
      expect.objectContaining({
        threadId: "thread-native",
        label: "Native Verifier",
      }),
    ]);
    expect(manifest.subagents.done).toEqual([]);
    expect(manifest.subagents.totalCount).toBe(1);
  });

  it("closes stale active subagent snapshots when the native generation is terminal", async () => {
    const { orgId, agentId, conversationId } = await seedBase("TerminalNativeSubagents");
    const messageId = randomUUID();
    const generationId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      status: "completed",
      body: "Finished.",
      replyingAgentId: agentId,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "completed",
      acceptedThroughSeq: 1,
    });
    await db.insert(chatGenerationEvents).values({
      orgId,
      generationId,
      generationSeq: 1,
      attemptEpoch: 1,
      eventKind: "transcript",
      assistantMessageId: messageId,
      payload: {
        entry: {
          kind: "tool_call",
          ts: "2026-07-29T01:00:01.000Z",
          name: "subagent_activity",
          toolUseId: "native-stale-active",
          input: {
            id: "native-stale-active",
            activity_kind: "interacted",
            agent_path: "/root/native_verifier",
            receiver_thread_ids: ["thread-native-terminal"],
            agent_transcripts: {
              "thread-native-terminal": {
                status: "inProgress",
                entries: [{
                  kind: "assistant",
                  ts: "2026-07-29T01:00:02.000Z",
                  text: "Verification passed.",
                }],
              },
            },
          },
        },
      },
    });

    const manifest = await svc.getConversationManifest(conversationId);
    expect(manifest.subagents.active).toEqual([]);
    expect(manifest.subagents.done).toEqual([
      expect.objectContaining({
        threadId: "thread-native-terminal",
        label: "Native Verifier",
        state: "done",
        status: "completed",
      }),
    ]);
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
    const { orgId, agentId, conversationId } = await seedBase("References");
    const referencedAutomationId = randomUUID();
    const referencedAutomationTitle = "Daily standup review";
    const renamedAutomationTitle = "Operator morning review";
    await db.insert(automations).values({
      id: referencedAutomationId,
      orgId,
      title: referencedAutomationTitle,
      assigneeAgentId: agentId,
    });
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
    const crossOrganizationAutomationId = randomUUID();
    await db.insert(automations).values({
      id: crossOrganizationAutomationId,
      orgId: crossOrganizationConversation.orgId,
      title: "Foreign automation title must stay private",
      assigneeAgentId: crossOrganizationConversation.agentId,
    });
    await db.insert(chatMessages).values({
      orgId,
      conversationId,
      role: "user",
      body: [
        "[Issue](issue://issue-1?r=REF-1)",
        `[](automation://${referencedAutomationId})`,
        `[](automation://${crossOrganizationAutomationId})`,
        "[](automation://automation-1)",
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
      "automation",
      "automation",
      "chat_conversation",
      "chat_conversation",
      "chat_conversation",
      "chat_conversation",
      "chat_conversation",
    ]);
    expect(manifest.references.map((item) => item.title)).toEqual([
      "Issue",
      referencedAutomationTitle,
      "Automation",
      "Automation",
      referencedConversationTitle,
      "Chat",
      "Chat",
      "Chat",
      "Chat",
    ]);
    expect(manifest.references.map((item) => item.metadata)).toEqual([
      { issueId: "issue-1", ref: "REF-1", commentId: null },
      { automationId: referencedAutomationId },
      { automationId: crossOrganizationAutomationId },
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

    const referencedAutomation = renamedManifest.references.find((item) =>
      item.metadata?.automationId === referencedAutomationId
    );
    if (!referencedAutomation) throw new Error("Expected hydrated Automation manifest reference");
    await db.update(chatWorkManifestItems)
      .set({ title: "Automation" })
      .where(eq(chatWorkManifestItems.id, referencedAutomation.id));
    await db.update(automations)
      .set({ title: renamedAutomationTitle })
      .where(eq(automations.id, referencedAutomationId));
    await svc.reconcileConversation(conversationId);
    const renamedAutomationManifest = await svc.getConversationManifest(conversationId);
    expect(renamedAutomationManifest.references.find((item) =>
      item.metadata?.automationId === referencedAutomationId
    )).toMatchObject({
      id: referencedAutomation.id,
      title: renamedAutomationTitle,
    });
    expect(renamedAutomationManifest.references.find((item) =>
      item.metadata?.automationId === crossOrganizationAutomationId
    )).toMatchObject({ title: "Automation" });
    expect(renamedAutomationManifest.references).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Foreign automation title must stay private" }),
    ]));
  });

  it("does not project an issue before the conversation has a created primary issue", async () => {
    const { orgId, agentId, conversationId } = await seedBase("PendingIssue");
    await db.insert(chatMessages).values({
      orgId,
      conversationId,
      role: "assistant",
      kind: "issue_proposal",
      body: "Propose an issue, but wait for operator approval.",
      replyingAgentId: agentId,
    });

    await svc.reconcileConversation(conversationId);

    expect((await svc.getConversationManifest(conversationId)).references).toEqual([]);
  });

  it("projects the same-organization primary issue once with readable identity and valid proposal provenance", async () => {
    const { orgId, agentId, conversationId } = await seedBase("PrimaryIssue");
    const issueId = randomUUID();
    const messageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Expose the created issue",
      identifier: "PRI-42",
      status: "todo",
      createdByAgentId: agentId,
    });
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      kind: "issue_proposal",
      body: [
        `[PRI-42](issue://${issueId}?r=PRI-42)`,
        "[PRI-42 route](/issues/pri-42)",
      ].join(" "),
      replyingAgentId: agentId,
    });
    await db.insert(chatContextLinks).values({
      orgId,
      conversationId,
      entityType: "issue",
      entityId: issueId,
      metadata: { sourceMessageId: messageId },
    });
    await db.update(chatConversations)
      .set({ primaryIssueId: issueId })
      .where(eq(chatConversations.id, conversationId));

    await svc.reconcileConversation(conversationId);
    const manifest = await svc.getConversationManifest(conversationId);

    expect(manifest.references).toHaveLength(1);
    expect(manifest.references[0]).toMatchObject({
      targetType: "issue",
      targetKey: `issue:${issueId}`,
      title: "PRI-42 · Expose the created issue",
      messageId,
      sourceRole: "assistant",
      createdByAgentId: agentId,
      metadata: {
        issueId,
        issueIdentifier: "PRI-42",
        issueTitle: "Expose the created issue",
        ref: "PRI-42",
        issueStatus: "todo",
      },
    });
  });

  it("canonicalizes issue and comment references, repairs historical rows, and preserves organization boundaries", async () => {
    const first = await seedBase("IssueStatus");
    const second = await seedBase("ForeignIssueStatus");
    const issueId = randomUUID();
    const foreignIssueId = randomUUID();
    const commentId = randomUUID();
    const uppercaseCommentId = randomUUID();
    const deletedCommentId = randomUUID();
    const foreignCommentId = randomUUID();
    await db.insert(issues).values([
      {
        id: issueId,
        orgId: first.orgId,
        title: "Visible status issue",
        identifier: "STATUS-1",
        status: "in_progress",
      },
      {
        id: foreignIssueId,
        orgId: second.orgId,
        title: "Foreign status issue",
        identifier: "FOREIGN-STATUS-1",
        status: "blocked",
      },
    ]);
    await db.insert(issueComments).values([
      {
        id: commentId,
        orgId: first.orgId,
        issueId,
        body: "Canonical comment",
      },
      {
        id: deletedCommentId,
        orgId: first.orgId,
        issueId,
        body: "Deleted comment",
        deletedAt: new Date(),
      },
      {
        id: uppercaseCommentId,
        orgId: first.orgId,
        issueId,
        body: "Uppercase UUID comment",
      },
      {
        id: foreignCommentId,
        orgId: second.orgId,
        issueId: foreignIssueId,
        body: "Foreign comment",
      },
    ]);
    await db.insert(chatMessages).values({
      orgId: first.orgId,
      conversationId: first.conversationId,
      role: "user",
      body: [
        `[Stale visible issue](issue://${issueId}?r=STATUS-1)`,
        "[Identifier route](/issues/status-1)",
        `[Comment](issue://STATUS-1?c=${shortRefFor("issue_comment", commentId)})`,
        `[Uppercase UUID comment](issue://STATUS-1?c=${uppercaseCommentId.toUpperCase()})`,
        `[Deleted comment](issue://${issueId}?c=${deletedCommentId})`,
        `[Foreign issue](issue://${foreignIssueId}?r=FOREIGN-STATUS-1)`,
        `[Foreign comment](issue://${foreignIssueId}?c=${foreignCommentId})`,
      ].join(" "),
    });

    await svc.reconcileConversation(first.conversationId);
    const initialManifest = await svc.getConversationManifest(first.conversationId);
    expect(initialManifest.references).toHaveLength(6);
    expect(initialManifest.references.filter((item) => item.targetType === "issue")).toHaveLength(2);
    expect(initialManifest.references.find((item) => item.targetKey === `issue:${issueId}`)).toMatchObject({
      title: "STATUS-1 · Visible status issue",
      metadata: {
        issueId,
        issueIdentifier: "STATUS-1",
        issueTitle: "Visible status issue",
        ref: "STATUS-1",
        issueStatus: "in_progress",
      },
    });
    expect(initialManifest.references.find((item) => item.targetType === "issue_comment" && item.metadata?.commentId === commentId))
      .toMatchObject({
        targetKey: `issue-comment:${issueId}:${commentId}`,
        title: "STATUS-1 · Visible status issue",
        metadata: {
          issueId,
          issueIdentifier: "STATUS-1",
          issueTitle: "Visible status issue",
          ref: "STATUS-1",
          issueStatus: "in_progress",
          commentId,
        },
      });
    expect(initialManifest.references.find((item) => item.metadata?.commentId === uppercaseCommentId))
      .toMatchObject({
        targetKey: `issue-comment:${issueId}:${uppercaseCommentId}`,
        title: "STATUS-1 · Visible status issue",
        metadata: {
          issueId,
          issueStatus: "in_progress",
          commentId: uppercaseCommentId,
        },
      });
    const deletedComment = initialManifest.references.find((item) => item.metadata?.commentId === deletedCommentId);
    expect(deletedComment).toMatchObject({ title: "Deleted comment" });
    expect(deletedComment?.metadata).not.toHaveProperty("issueStatus");
    const foreignIssue = initialManifest.references.find((item) => item.metadata?.issueId === foreignIssueId);
    expect(foreignIssue).toMatchObject({ title: "Foreign issue" });
    expect(foreignIssue?.metadata).not.toHaveProperty("issueStatus");
    const foreignComment = initialManifest.references.find((item) => item.metadata?.commentId === foreignCommentId);
    expect(foreignComment).toMatchObject({ title: "Foreign comment" });
    expect(foreignComment?.metadata).not.toHaveProperty("issueStatus");

    const canonicalIssueRow = initialManifest.references.find((item) => item.targetKey === `issue:${issueId}`);
    if (!canonicalIssueRow) throw new Error("Expected canonical issue row");
    await db.update(chatWorkManifestItems)
      .set({ title: "Issue", metadata: { issueId } })
      .where(eq(chatWorkManifestItems.id, canonicalIssueRow.id));
    await db.update(issues)
      .set({ title: "Renamed visible issue", status: "done" })
      .where(eq(issues.id, issueId));
    await svc.reconcileConversation(first.conversationId);
    const refreshedManifest = await svc.getConversationManifest(first.conversationId);
    expect(refreshedManifest.references.find((item) => item.targetKey === `issue:${issueId}`)).toMatchObject({
      id: canonicalIssueRow.id,
      title: "STATUS-1 · Renamed visible issue",
      metadata: {
        issueId,
        issueTitle: "Renamed visible issue",
        issueStatus: "done",
      },
    });
    expect(refreshedManifest.references.find((item) => item.targetType === "issue_comment" && item.metadata?.commentId === commentId))
      .toMatchObject({
        title: "STATUS-1 · Renamed visible issue",
        metadata: { issueTitle: "Renamed visible issue", issueStatus: "done" },
      });
    expect(refreshedManifest.references.find((item) => item.metadata?.issueId === foreignIssueId)?.metadata)
      .not.toHaveProperty("issueStatus");
  });

  it("omits stale primary-issue provenance and rejects cross-organization primary issues", async () => {
    const first = await seedBase("PrimaryBoundary");
    const second = await seedBase("ForeignPrimary");
    const issueId = randomUUID();
    const foreignIssueId = randomUUID();
    const sourceMessageId = randomUUID();
    await db.insert(issues).values([
      {
        id: issueId,
        orgId: first.orgId,
        title: "Scoped primary issue",
        identifier: "SCOPED-1",
        status: "todo",
      },
      {
        id: foreignIssueId,
        orgId: second.orgId,
        title: "Foreign primary issue",
        identifier: "FOREIGN-1",
        status: "todo",
      },
    ]);
    await db.insert(chatMessages).values({
      id: sourceMessageId,
      orgId: first.orgId,
      conversationId: first.conversationId,
      role: "assistant",
      kind: "issue_proposal",
      body: "Superseded issue proposal",
      supersededAt: new Date(),
    });
    await db.insert(chatContextLinks).values({
      orgId: first.orgId,
      conversationId: first.conversationId,
      entityType: "issue",
      entityId: issueId,
      metadata: { sourceMessageId },
    });
    await db.update(chatConversations)
      .set({ primaryIssueId: issueId })
      .where(eq(chatConversations.id, first.conversationId));

    await svc.reconcileConversation(first.conversationId);
    expect((await svc.getConversationManifest(first.conversationId)).references[0]).toMatchObject({
      targetKey: `issue:${issueId}`,
      messageId: null,
    });

    await db.update(chatConversations)
      .set({ primaryIssueId: foreignIssueId })
      .where(eq(chatConversations.id, first.conversationId));
    await svc.reconcileConversation(first.conversationId);

    expect((await svc.getConversationManifest(first.conversationId)).references).toEqual([]);
  });

  it("removes the derived primary-issue row when the association is cleared or the issue is deleted", async () => {
    const { orgId, conversationId } = await seedBase("StalePrimary");
    const firstIssueId = randomUUID();
    const deletedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: firstIssueId,
        orgId,
        title: "Detached primary issue",
        identifier: "STALE-1",
        status: "todo",
      },
      {
        id: deletedIssueId,
        orgId,
        title: "Deleted primary issue",
        identifier: "STALE-2",
        status: "todo",
      },
    ]);
    await db.update(chatConversations)
      .set({ primaryIssueId: firstIssueId })
      .where(eq(chatConversations.id, conversationId));
    await svc.reconcileConversation(conversationId);
    expect((await svc.getConversationManifest(conversationId)).references).toHaveLength(1);

    await db.update(chatConversations)
      .set({ primaryIssueId: null })
      .where(eq(chatConversations.id, conversationId));
    await svc.reconcileConversation(conversationId);
    expect((await svc.getConversationManifest(conversationId)).references).toEqual([]);

    await db.update(chatConversations)
      .set({ primaryIssueId: deletedIssueId })
      .where(eq(chatConversations.id, conversationId));
    await svc.reconcileConversation(conversationId);
    expect((await svc.getConversationManifest(conversationId)).references).toHaveLength(1);

    await db.delete(issues).where(eq(issues.id, deletedIssueId));
    await svc.reconcileConversation(conversationId);

    expect((await svc.getConversationManifest(conversationId)).references).toEqual([]);
    expect(await db.select().from(chatWorkManifestItems)).toEqual([]);
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
