import {
  activityLog,
  agentIntegrationChatBindings,
  agentIntegrations,
  agentIssueCreationRequests,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  approvalComments,
  approvals,
  assets,
  automationRuns,
  automations,
  chatAttachments,
  chatContextLinks,
  chatControlActions,
  chatConversations,
  chatConversationUserStates,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  chatQueuedMessages,
  createDb,
  documents,
  ensurePostgresDatabase,
  heartbeatRuns,
  invites,
  issueComments,
  issueDocuments,
  issueFollows,
  issues,
  joinRequests,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerSavedViewMutations,
  messengerSavedViews,
  messengerThreadUserStates,
  organizations,
  organizationSecrets,
  productAnalyticsEvents,
  projects,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  deriveOrganizationUrlKey,
  MESSENGER_FORK_GROUP_DEFAULT_ICON,
  type MessengerSavedViewTarget,
} from "@rudderhq/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentIssueCreationService } from "../services/agent-issue-creation.ts";
import { hashChatGenerationBody } from "../services/chat-generation-protocol.ts";
import {
  chatInlineAnnotationService,
  hashChatAnnotationSource,
} from "../services/chat-inline-annotations.ts";
import { chatSteerMessageService } from "../services/chat-steer-messages.ts";
import { chatService } from "../services/chats.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import {
  messengerSavedViewCanonicalResourceKey,
  messengerSavedViewResourceKey,
  messengerSavedViewsService,
} from "../services/messenger-saved-views.ts";
import { messengerService } from "../services/messenger.ts";

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
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function getExternalDatabaseUrl(): string | null {
  return process.env.RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL?.trim() || null;
}

function boardQueueRequestActor(orgId: string, userId = "messenger-test-user") {
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    orgIds: [orgId],
    isInstanceAdmin: false,
  };
}

async function startTempDatabase() {
  const externalDatabaseUrl = getExternalDatabaseUrl();
  if (externalDatabaseUrl) {
    await applyPendingMigrations(externalDatabaseUrl);
    return { connectionString: externalDatabaseUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-messenger-service-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => console.log(message),
    onError: (message) => console.error(message),
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("messengerService and issue follows", () => {
  let db!: ReturnType<typeof createDb>;
  let chatSvc!: ReturnType<typeof chatService>;
  let issueSvc!: ReturnType<typeof issueService>;
  let messengerSvc!: ReturnType<typeof messengerService>;
  let savedViewsSvc!: ReturnType<typeof messengerSavedViewsService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  async function insertSavedViewFixture(
    orgId: string,
    userId: string,
    input: {
      target: MessengerSavedViewTarget;
      title: string;
      subtitle?: string | null;
      favicon?: string | null;
    },
  ) {
    const [last] = await db.select({ sortOrder: messengerSavedViews.sortOrder })
      .from(messengerSavedViews)
      .where(and(eq(messengerSavedViews.orgId, orgId), eq(messengerSavedViews.userId, userId)))
      .orderBy(desc(messengerSavedViews.sortOrder))
      .limit(1);
    const [savedView] = await db.insert(messengerSavedViews).values({
      orgId,
      userId,
      targetKind: input.target.kind,
      targetPayload: input.target,
      resourceKey: messengerSavedViewResourceKey(input.target),
      instanceId: input.target.viewInstanceId,
      canonicalResourceKey: messengerSavedViewCanonicalResourceKey(input.target),
      title: input.title,
      subtitle: input.subtitle ?? null,
      favicon: input.favicon ?? null,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    }).returning();
    return savedView;
  }

  async function insertChatAnnotationSource(
    orgId: string,
    conversationId: string,
    body: string,
  ) {
    const createdAt = new Date(Date.now() - 1_000);
    const [source] = await db.insert(chatMessages).values({
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body,
      createdAt,
      updatedAt: createdAt,
    }).returning();
    return source!;
  }

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    chatSvc = chatService(db);
    issueSvc = issueService(db);
    messengerSvc = messengerService(db);
    savedViewsSvc = messengerSavedViewsService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(productAnalyticsEvents);
    await db.delete(issueFollows);
    await db.delete(messengerCustomGroupEntries);
    await db.delete(messengerCustomGroups);
    await db.delete(messengerSavedViewMutations);
    await db.delete(messengerSavedViews);
    await db.delete(messengerThreadUserStates);
    await db.delete(chatQueuedMessages);
    await db.delete(chatMessages);
    await db.delete(chatGenerations);
    await db.delete(agentIntegrationChatBindings);
    await db.delete(chatConversations);
    await db.delete(assets);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(automationRuns);
    await db.delete(automations);
    await db.delete(agentIssueCreationRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agentIntegrations);
    await db.delete(organizationSecrets);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records human chat creation separately from the initial work start", async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Chat creation analytics",
      urlKey: deriveOrganizationUrlKey("Chat creation analytics"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const created = await chatSvc.createWithInitialMessage(orgId, {
      issueCreationMode: "manual_approval",
      planMode: true,
      createdByUserId: "analytics-user",
      initialMessage: {
        role: "user",
        kind: "message",
        status: "completed",
        body: "Trace this new chat",
      },
      activity: {
        actorType: "user",
        actorId: "analytics-user",
      },
    });
    const events = await db.select().from(productAnalyticsEvents)
      .where(eq(productAnalyticsEvents.entityId, created.conversation.id));

    expect(events.map((event) => event.eventName).sort()).toEqual(["chat_created", "human_work_started"]);
    expect(events.find((event) => event.eventName === "chat_created")).toMatchObject({
      actorType: "human",
      actorId: "analytics-user",
      origin: "human",
      sourceTransition: "chat.initial_message.create",
      properties: {
        creation_path: "manual",
        initial_role: "user",
        plan_mode: true,
      },
    });
  });

  it("records empty and fork chat creation at their service boundaries", async () => {
    const orgId = randomUUID();
    const userId = "analytics-chat-boundary-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Chat boundary analytics",
      urlKey: deriveOrganizationUrlKey("Chat boundary analytics"),
      issuePrefix: `B${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const source = await chatSvc.create(orgId, {
      title: "Boundary source",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const answer = await chatSvc.addMessage(source.id, {
      orgId,
      role: "assistant",
      kind: "message",
      body: "Fork from this answer",
    });
    const child = await chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      sourceMessageId: answer.id,
      createdByUserId: userId,
    });

    const sourceEvents = await db.select().from(productAnalyticsEvents)
      .where(eq(productAnalyticsEvents.entityId, source.id));
    const childEvents = await db.select().from(productAnalyticsEvents)
      .where(eq(productAnalyticsEvents.entityId, child.id));
    expect(sourceEvents.filter((event) => event.eventName === "chat_created")).toMatchObject([
      { properties: { creation_path: "empty" } },
    ]);
    expect(childEvents.filter((event) => event.eventName === "chat_created")).toMatchObject([
      { properties: { creation_path: "fork", initial_role: "system" } },
    ]);
    expect(sourceEvents.filter((event) => event.eventName === "chat_created")).toHaveLength(1);
    expect(childEvents.filter((event) => event.eventName === "chat_created")).toHaveLength(1);
  });

  it("classifies automation and integration chat creation through the real service boundary", async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Non-human chat analytics",
      urlKey: deriveOrganizationUrlKey("Non-human chat analytics"),
      issuePrefix: `N${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const automation = await chatSvc.createWithInitialMessage(orgId, {
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: null,
      initialMessage: {
        role: "user",
        kind: "message",
        status: "completed",
        body: "Automation run input",
        structuredPayload: { eventType: "automation_run_input" },
      },
      activity: {
        actorType: "system",
        actorId: "automation-chat-output",
      },
    });
    const integration = await chatSvc.createWithInitialMessage(orgId, {
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: null,
      contextLinks: [{
        entityType: "agent",
        entityId: randomUUID(),
        metadata: { source: "agent_integration", provider: "feishu" },
      }],
      initialMessage: {
        role: "user",
        kind: "message",
        status: "completed",
        body: "Integration inbound message",
      },
      activity: {
        actorType: "system",
        actorId: "feishu-inbound",
      },
    });

    const events = await db.select().from(productAnalyticsEvents)
      .where(eq(productAnalyticsEvents.orgId, orgId));
    expect(events.filter((event) => event.entityId === automation.conversation.id)).toMatchObject([
      {
        eventName: "chat_created",
        actorType: "automation",
        origin: "automation",
        sourceTransition: "chat.automation.create",
        properties: { creation_path: "automation", initial_role: "user", plan_mode: false },
      },
    ]);
    expect(events.filter((event) => event.entityId === integration.conversation.id)).toMatchObject([
      {
        eventName: "chat_created",
        actorType: "system",
        origin: "system",
        sourceTransition: "chat.integration.create",
        properties: { creation_path: "integration", initial_role: "user", plan_mode: false },
      },
    ]);
  });

  async function createQueuedAnnotationFixture(input: {
    body?: string;
    sourceBody?: string;
    expectedGenerationId?: string | null;
  } = {}) {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const sourceBody = input.sourceBody ?? "Alpha selected quote omega";
    await db.insert(organizations).values({
      id: orgId,
      name: `Queue annotation ${orgId}`,
      urlKey: deriveOrganizationUrlKey(`Queue annotation ${orgId}`),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Queue annotation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const source = await insertChatAnnotationSource(orgId, conversationId, sourceBody);
    const selectedText = "selected quote";
    const start = sourceBody.indexOf(selectedText);
    const annotation = {
      id: randomUUID(),
      selectedText,
      comment: "Make this more concrete",
      sourceConversationId: conversationId,
      sourceMessageId: source.id,
      surface: "assistant_body" as const,
      sourceHash: hashChatAnnotationSource(sourceBody),
      start,
      end: start + selectedText.length,
      prefix: sourceBody.slice(Math.max(0, start - 80), start),
      suffix: sourceBody.slice(start + selectedText.length, start + selectedText.length + 80),
      attachmentIds: [],
    };
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: randomUUID(),
      expectedGenerationId: input.expectedGenerationId ?? null,
      payload: {
        body: input.body ?? "",
        inlineAnnotations: [annotation],
      },
      requestActor: boardQueueRequestActor(orgId),
    });
    return { orgId, conversationId, source, annotation, queued };
  }

  it("hydrates canonical queued annotations and preserves them across prose-only edits", async () => {
    const fixture = await createQueuedAnnotationFixture();

    expect(fixture.queued.payload.inlineAnnotations).toEqual([fixture.annotation]);
    expect(fixture.queued).toMatchObject({ annotationCount: 1 });
    expect(fixture.queued.payload).not.toHaveProperty("__rudderQueueAnnotationAssets");

    const edited = await chatSvc.updateQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: fixture.queued.id,
      version: fixture.queued.version,
      payload: { body: "Revise only the request prose" },
    });
    expect(edited.payload.inlineAnnotations).toEqual([fixture.annotation]);
    expect(edited).toMatchObject({ annotationCount: 1 });

    const replaced = await chatSvc.updateQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: fixture.queued.id,
      version: edited.version,
      payload: { body: "Remove the old quotation", inlineAnnotations: [] },
    });
    expect(replaced.payload.inlineAnnotations).toEqual([]);
    expect(replaced).toMatchObject({ annotationCount: 0 });
  });

  it("treats Agent, model, and effort as immutable server-owned queue admission snapshots", async () => {
    const fixture = await createQueuedAnnotationFixture({ body: "fixture" });
    const clientMutationId = randomUUID();
    const admittedAgentId = randomUUID();
    const created = await chatSvc.createQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      clientMutationId,
      runtimeSnapshotVersion: 1,
      payload: {
        body: "Run with this admitted runtime",
        agentId: admittedAgentId,
        model: "gpt-5.6-terra",
        effort: "xhigh",
      },
      requestActor: boardQueueRequestActor(fixture.orgId),
    });

    const replay = await (chatSvc as any).getQueuedMessageReplay({
      conversationId: fixture.conversationId,
      clientMutationId,
      payload: {
        body: "Run with this admitted runtime",
        agentId: randomUUID(),
        model: "gpt-5.5",
        effort: "low",
      },
    });
    expect(replay).toMatchObject({
      id: created.id,
      payload: {
        body: "Run with this admitted runtime",
        agentId: admittedAgentId,
        model: "gpt-5.6-terra",
        effort: "xhigh",
      },
    });

    const edited = await chatSvc.updateQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: created.id,
      version: created.version,
      payload: {
        body: "Edited prose keeps the admitted runtime",
        agentId: randomUUID(),
        model: "client-forged-model",
        effort: "client-forged-effort",
      },
    });
    expect(edited.payload).toMatchObject({
      body: "Edited prose keeps the admitted runtime",
      agentId: admittedAgentId,
      model: "gpt-5.6-terra",
      effort: "xhigh",
    });
  });

  it("materializes annotation-only queue work once and converges every message link", async () => {
    const fixture = await createQueuedAnnotationFixture();

    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "annotation-queue-worker",
      leaseMs: 30_000,
    });
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, fixture.orgId),
        eq(chatMessages.conversationId, fixture.conversationId),
        eq(chatMessages.role, "user"),
      ));
    const [generation] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, claim!.generationId));
    const activities = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.orgId, fixture.orgId),
        eq(activityLog.entityId, fixture.conversationId),
      ));

    expect(claim?.userMessageId).toBe(message?.id);
    expect(claim?.item).toMatchObject({
      sourceMessageId: message?.id,
      continuationMessageId: message?.id,
      deliveredMessageId: message?.id,
    });
    expect(generation).toMatchObject({
      status: "active",
      attemptEpoch: 0,
      controlOwnerToken: null,
      controlLeaseExpiresAt: null,
    });
    expect(chatInlineAnnotationsFromStructuredPayload(message?.structuredPayload))
      .toEqual([fixture.annotation]);
    expect(activities).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({
      messageId: message?.id,
      annotationCount: 1,
      annotationSourceMessageIds: [fixture.source.id],
    });
    expect(JSON.stringify(activities[0]?.details)).not.toContain(fixture.annotation.selectedText);
    expect(JSON.stringify(activities[0]?.details)).not.toContain(fixture.annotation.comment);
  });

  it("quarantines a stale annotated row and continues to the next valid Queue item", async () => {
    const fixture = await createQueuedAnnotationFixture();
    await db
      .update(chatMessages)
      .set({ supersededAt: new Date() })
      .where(and(
        eq(chatMessages.id, fixture.source.id),
        eq(chatMessages.orgId, fixture.orgId),
        eq(chatMessages.conversationId, fixture.conversationId),
      ));

    const valid = await chatSvc.createQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      clientMutationId: randomUUID(),
      payload: { body: "Continue with this valid queued request." },
      requestActor: boardQueueRequestActor(fixture.orgId),
    });
    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "stale-annotation-worker",
      leaseMs: 30_000,
    });
    const [stale] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, fixture.queued.id));

    expect(claim?.item.id).toBe(valid.id);
    expect(stale).toMatchObject({
      status: "failed_actionable",
      deliveryDisposition: "failed_actionable",
      reconciliationReason: "queued_message_validation_failed",
      lastDeliveryReason: "queued_message_validation_failed",
    });
    expect(await db.select().from(chatGenerations).where(eq(chatGenerations.orgId, fixture.orgId)))
      .toHaveLength(1);
    expect(await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, fixture.orgId),
        eq(chatMessages.conversationId, fixture.conversationId),
        eq(chatMessages.role, "user"),
      ))).toEqual([
        expect.objectContaining({
          id: claim?.userMessageId,
          body: "Continue with this valid queued request.",
        }),
      ]);
  });

  it("quarantines a cross-organization annotation during materialization", async () => {
    const targetOrgId = randomUUID();
    const targetConversationId = randomUUID();
    const sourceOrgId = randomUUID();
    const sourceConversationId = randomUUID();
    await db.insert(organizations).values([
      {
        id: targetOrgId,
        name: "Queue target organization",
        urlKey: deriveOrganizationUrlKey(`Queue target ${targetOrgId}`),
        issuePrefix: `T${targetOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: sourceOrgId,
        name: "Queue source organization",
        urlKey: deriveOrganizationUrlKey(`Queue source ${sourceOrgId}`),
        issuePrefix: `S${sourceOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values([
      {
        id: targetConversationId,
        orgId: targetOrgId,
        title: "Target queue",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: sourceConversationId,
        orgId: sourceOrgId,
        title: "Foreign source",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    const source = await insertChatAnnotationSource(
      sourceOrgId,
      sourceConversationId,
      "Alpha selected quote omega",
    );
    await db.insert(chatQueuedMessages).values({
      orgId: targetOrgId,
      conversationId: targetConversationId,
      clientMutationId: randomUUID(),
      position: 1,
      payload: {
        body: "",
        inlineAnnotations: [{
          id: randomUUID(),
          selectedText: "selected quote",
          comment: null,
          sourceConversationId: targetConversationId,
          sourceMessageId: source.id,
          surface: "assistant_body",
          sourceHash: hashChatAnnotationSource(source.body),
          start: 6,
          end: 20,
          prefix: "Alpha ",
          suffix: " omega",
          attachmentIds: [],
        }],
      },
      requestActor: boardQueueRequestActor(targetOrgId),
    });

    await expect(chatSvc.claimNextServerQueuedMessage({
      workerId: "cross-org-annotation-worker",
      leaseMs: 30_000,
    })).resolves.toBeNull();
    const [quarantined] = await db
      .select()
      .from(chatQueuedMessages)
      .where(and(
        eq(chatQueuedMessages.orgId, targetOrgId),
        eq(chatQueuedMessages.conversationId, targetConversationId),
      ));
    expect(quarantined).toMatchObject({
      status: "failed_actionable",
      deliveryDisposition: "failed_actionable",
      reconciliationReason: "queued_message_validation_failed",
    });
    expect(await db.select().from(chatGenerations).where(eq(chatGenerations.orgId, targetOrgId)))
      .toEqual([]);
    expect(await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, targetOrgId),
        eq(chatMessages.role, "user"),
      ))).toEqual([]);
  });

  it("preserves annotation-only feedback through native Steer retries", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Native annotation Steer",
      urlKey: deriveOrganizationUrlKey("Native annotation Steer"),
      issuePrefix: `N${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Native annotation Steer chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
      attemptEpoch: 1,
      controlVersion: 0,
      controlState: "ready",
    });
    const source = await insertChatAnnotationSource(
      orgId,
      conversationId,
      "Alpha selected quote omega",
    );
    const annotation = {
      id: randomUUID(),
      selectedText: "selected quote",
      comment: "Use this evidence",
      sourceConversationId: conversationId,
      sourceMessageId: source.id,
      surface: "assistant_body" as const,
      sourceHash: hashChatAnnotationSource(source.body),
      start: 6,
      end: 20,
      prefix: "Alpha ",
      suffix: " omega",
      attachmentIds: [],
    };
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: randomUUID(),
      expectedGenerationId: generationId,
      payload: { body: "", inlineAnnotations: [annotation] },
      requestActor: boardQueueRequestActor(orgId),
    });
    const steer = chatSteerMessageService(db);
    const request = {
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId: randomUUID(),
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user" as const, actorId: "board" },
    };
    const first = await steer.beginControlAction(request);
    const retry = await steer.beginControlAction(request);
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, orgId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "user"),
      ));

    expect(first.idempotent).toBe(false);
    expect(retry.idempotent).toBe(true);
    expect(chatInlineAnnotationsFromStructuredPayload(message?.structuredPayload)).toEqual([annotation]);
    expect(retry.item).toMatchObject({
      sourceMessageId: message?.id,
      continuationMessageId: message?.id,
      deliveredMessageId: message?.id,
    });
    expect(await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.role, "user")))).toHaveLength(1);
  });

  it("stages annotation files idempotently and binds one canonical attachment on claim retry", async () => {
    const fixture = await createQueuedAnnotationFixture({ body: "initial fixture" });
    await chatSvc.cancelQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: fixture.queued.id,
      version: fixture.queued.version,
    });
    const clientMutationId = randomUUID();
    const stagedAttachment = {
      provider: "local_disk",
      objectKey: `chat-queue-annotations/${fixture.conversationId}/${randomUUID()}`,
      contentType: "text/plain",
      byteSize: 12,
      sha256: "f".repeat(64),
      originalFilename: "evidence.txt",
      createdByAgentId: null,
      createdByUserId: "messenger-test-user",
    };
    const create = {
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      clientMutationId,
      payload: {
        body: "",
        inlineAnnotations: [fixture.annotation],
        model: "legacy-client-model",
        effort: null,
      },
      requestActor: boardQueueRequestActor(fixture.orgId),
      stagedAttachments: [stagedAttachment],
      attachmentFileIndexesByAnnotationId: new Map([[fixture.annotation.id, [0]]]),
    };
    const first = await (chatSvc as any).createQueuedMessageWithStagedAttachments(create);
    const duplicateObject = {
      ...stagedAttachment,
      objectKey: `chat-queue-annotations/${fixture.conversationId}/${randomUUID()}`,
    };
    const replay = await (chatSvc as any).createQueuedMessageWithStagedAttachments({
      ...create,
      runtimeSnapshotVersion: 1,
      payload: {
        ...create.payload,
        model: "gpt-5.6-terra",
        effort: "high",
      },
      idempotencyPayload: create.payload,
      stagedAttachments: [duplicateObject],
    });
    const [rawQueued] = await db
      .select()
      .from(chatQueuedMessages)
      .where(and(
        eq(chatQueuedMessages.orgId, fixture.orgId),
        eq(chatQueuedMessages.id, first.item.id),
      ));
    const stagedAssets = await db
      .select()
      .from(assets)
      .where(eq(assets.orgId, fixture.orgId));

    expect(first).toMatchObject({ accepted: true, cleanupAttachments: [] });
    expect(first.item.runtimeSnapshotVersion).toBeNull();
    expect(first.item).toMatchObject({ annotationCount: 1 });
    expect(first.item.payload).not.toHaveProperty("__rudderQueueAnnotationAssets");
    expect(first.item.payload.inlineAnnotations?.[0]?.attachmentIds).toEqual([]);
    expect(replay).toMatchObject({
      accepted: false,
      item: { id: first.item.id },
      cleanupAttachments: [{ objectKey: duplicateObject.objectKey }],
    });
    await expect((chatSvc as any).createQueuedMessageWithStagedAttachments({
      ...create,
      payload: {
        body: "A different request under the same mutation id",
        inlineAnnotations: [fixture.annotation],
      },
    })).rejects.toMatchObject({ status: 409 });
    expect(stagedAssets).toHaveLength(1);
    expect(rawQueued?.payload).toHaveProperty("__rudderQueueAnnotationAssets");

    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "annotation-file-worker",
      leaseMs: 30_000,
    });
    const released = await chatSvc.releaseServerQueuedMessageClaim({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
      reason: "retry_before_provider_start",
    });
    expect(released?.status).toBe("queued");
    const edited = await (chatSvc as any).updateQueuedMessageWithStagedAttachments({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: released!.id,
      version: released!.version,
      payload: { body: "Edited after materialization and safe release" },
      stagedAttachments: [],
      attachmentFileIndexesByAnnotationId: new Map(),
    });
    expect(edited.item.payload).toMatchObject({
      body: "Edited after materialization and safe release",
      inlineAnnotations: [
        expect.objectContaining({
          id: fixture.annotation.id,
          attachmentIds: [expect.any(String)],
        }),
      ],
    });
    await expect((chatSvc as any).updateQueuedMessageWithStagedAttachments({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: edited.item.id,
      version: edited.item.version,
      payload: {
        body: "Attempt to replace a sent snapshot",
        inlineAnnotations: edited.item.payload.inlineAnnotations,
      },
      stagedAttachments: [],
      attachmentFileIndexesByAnnotationId: new Map(),
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("immutable"),
    });
    const retriedClaim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "annotation-file-worker-retry",
      leaseMs: 30_000,
    });
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, fixture.orgId),
        eq(chatMessages.id, retriedClaim!.userMessageId),
      ));
    const messageAttachments = await db
      .select()
      .from(chatAttachments)
      .where(and(
        eq(chatAttachments.orgId, fixture.orgId),
        eq(chatAttachments.messageId, message!.id),
      ));
    const canonicalAnnotations = chatInlineAnnotationsFromStructuredPayload(message?.structuredPayload);
    const [materializedQueue] = await db
      .select()
      .from(chatQueuedMessages)
      .where(and(
        eq(chatQueuedMessages.orgId, fixture.orgId),
        eq(chatQueuedMessages.id, first.item.id),
      ));

    expect(retriedClaim?.userMessageId).toBe(claim?.userMessageId);
    expect(retriedClaim?.item.payload.body).toBe("Edited after materialization and safe release");
    expect(message?.body).toBe("Edited after materialization and safe release");
    expect(messageAttachments).toHaveLength(1);
    expect(canonicalAnnotations[0]?.attachmentIds).toEqual([messageAttachments[0]?.id]);
    expect(materializedQueue?.payload).not.toHaveProperty("__rudderQueueAnnotationAssets");
    expect((materializedQueue?.payload.inlineAnnotations as Array<{ attachmentIds: string[] }>)[0]?.attachmentIds)
      .toEqual([messageAttachments[0]?.id]);
    expect(await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.orgId, fixture.orgId), eq(chatMessages.role, "user"))))
      .toHaveLength(1);
  });

  it("replaces and cancels queued annotation files with explicit orphan cleanup", async () => {
    const fixture = await createQueuedAnnotationFixture({ body: "initial fixture" });
    await chatSvc.cancelQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: fixture.queued.id,
      version: fixture.queued.version,
    });
    const staged = (suffix: string, sha256: string) => ({
      provider: "local_disk",
      objectKey: `chat-queue-annotations/${fixture.conversationId}/${suffix}`,
      contentType: "text/plain",
      byteSize: 8,
      sha256,
      originalFilename: `${suffix}.txt`,
      createdByAgentId: null,
      createdByUserId: "messenger-test-user",
    });
    const firstAttachment = staged("first", "a".repeat(64));
    const created = await (chatSvc as any).createQueuedMessageWithStagedAttachments({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      clientMutationId: randomUUID(),
      payload: { body: "", inlineAnnotations: [fixture.annotation] },
      requestActor: boardQueueRequestActor(fixture.orgId),
      stagedAttachments: [firstAttachment],
      attachmentFileIndexesByAnnotationId: new Map([[fixture.annotation.id, [0]]]),
    });
    const replacementAttachment = staged("replacement", "b".repeat(64));
    const updated = await (chatSvc as any).updateQueuedMessageWithStagedAttachments({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: created.item.id,
      version: created.item.version,
      payload: { body: "Replacement", inlineAnnotations: [fixture.annotation] },
      stagedAttachments: [replacementAttachment],
      attachmentFileIndexesByAnnotationId: new Map([[fixture.annotation.id, [0]]]),
    });

    expect(updated.item.payload).not.toHaveProperty("__rudderQueueAnnotationAssets");
    expect(updated.cleanupAttachments).toEqual([
      expect.objectContaining({ objectKey: firstAttachment.objectKey, assetId: expect.any(String) }),
    ]);
    await (chatSvc as any).finalizeQueuedAnnotationAssetCleanup({
      orgId: fixture.orgId,
      assetIds: updated.cleanupAttachments.map((attachment: { assetId: string }) => attachment.assetId),
    });
    expect(await db.select().from(assets).where(eq(assets.orgId, fixture.orgId)))
      .toEqual([expect.objectContaining({ objectKey: replacementAttachment.objectKey })]);

    const cancelled = await (chatSvc as any).cancelQueuedMessageWithStagedAttachments({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: created.item.id,
      version: updated.item.version,
    });
    expect(cancelled.item.payload).not.toHaveProperty("__rudderQueueAnnotationAssets");
    expect(cancelled.cleanupAttachments).toEqual([
      expect.objectContaining({ objectKey: replacementAttachment.objectKey, assetId: expect.any(String) }),
    ]);
    await (chatSvc as any).finalizeQueuedAnnotationAssetCleanup({
      orgId: fixture.orgId,
      assetIds: cancelled.cleanupAttachments.map((attachment: { assetId: string }) => attachment.assetId),
    });
    expect(await db.select().from(assets).where(eq(assets.orgId, fixture.orgId))).toEqual([]);
  });

  it("preserves annotation files through fallback Steer and idempotent continuation retries", async () => {
    const fixture = await createQueuedAnnotationFixture({ body: "initial fixture" });
    await chatSvc.cancelQueuedMessage({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: fixture.queued.id,
      version: fixture.queued.version,
    });
    const generationId = randomUUID();
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      status: "stopped",
      attemptEpoch: 1,
      controlVersion: 0,
      controlState: "terminal",
      terminalReason: "stopped",
      completedAt: new Date(),
    });
    const created = await (chatSvc as any).createQueuedMessageWithStagedAttachments({
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      clientMutationId: randomUUID(),
      expectedGenerationId: generationId,
      payload: { body: "", inlineAnnotations: [fixture.annotation] },
      requestActor: boardQueueRequestActor(fixture.orgId),
      stagedAttachments: [{
        provider: "local_disk",
        objectKey: `chat-queue-annotations/${fixture.conversationId}/fallback.txt`,
        contentType: "text/plain",
        byteSize: 8,
        sha256: "c".repeat(64),
        originalFilename: "fallback.txt",
        createdByAgentId: null,
        createdByUserId: "messenger-test-user",
      }],
      attachmentFileIndexesByAnnotationId: new Map([[fixture.annotation.id, [0]]]),
    });
    const controlActionId = randomUUID();
    const steer = chatSteerMessageService(db);
    const request = {
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      itemId: created.item.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(fixture.orgId),
      actor: { actorType: "user" as const, actorId: "board" },
    };
    const first = await steer.beginControlAction(request);
    const replay = await steer.beginControlAction(request);
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, fixture.orgId),
        eq(chatMessages.role, "user"),
      ));
    const ownedAttachments = await db
      .select()
      .from(chatAttachments)
      .where(and(
        eq(chatAttachments.orgId, fixture.orgId),
        eq(chatAttachments.messageId, message!.id),
      ));

    expect(first).toMatchObject({
      idempotent: false,
      item: {
        status: "continuation_pending",
        sourceMessageId: message?.id,
        continuationMessageId: message?.id,
        deliveredMessageId: message?.id,
      },
    });
    expect(replay).toMatchObject({
      idempotent: true,
      item: {
        sourceMessageId: message?.id,
        continuationMessageId: message?.id,
        deliveredMessageId: message?.id,
      },
    });
    expect(ownedAttachments).toHaveLength(1);
    expect(chatInlineAnnotationsFromStructuredPayload(message?.structuredPayload)[0]?.attachmentIds)
      .toEqual([ownedAttachments[0]?.id]);
    expect(await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.orgId, fixture.orgId), eq(chatMessages.role, "user"))))
      .toHaveLength(1);
  });

  it("keeps queue snapshots read-only when a DB active generation has no local owner", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const queuedMessageId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Stale Generation Org",
      urlKey: deriveOrganizationUrlKey("Messenger Stale Generation Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Stale generation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
    });
    await db.insert(chatMessages).values({
      id: randomUUID(),
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "",
    });
    await db.insert(chatQueuedMessages).values({
      id: queuedMessageId,
      orgId,
      conversationId,
      position: 1,
      status: "queued",
      clientMutationId: "stale-generation-follow-up",
      expectedGenerationId: generationId,
      payload: { body: "Run this after recovery" },
    });

    const snapshot = await chatSvc.getQueueSnapshot(conversationId, null);

    expect(snapshot.activeGenerationId).toBeNull();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.id).toBe(queuedMessageId);
    expect(snapshot.items[0]?.payload.body).toBe("Run this after recovery");

    const [generation] = await db.select().from(chatGenerations).where(eq(chatGenerations.id, generationId));
    expect(generation).toMatchObject({
      status: "active",
      terminalReason: null,
    });
    expect(generation?.completedAt).toBeNull();

    const [message] = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    expect(message).toMatchObject({
      status: "streaming",
      body: "",
    });
  });

  it("does not overwrite a stopped chat generation with a later terminal status", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Terminal Race Org",
      urlKey: deriveOrganizationUrlKey("Messenger Terminal Race Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Terminal race chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
    });

    const stopped = await chatSvc.markGenerationTerminal(generationId, "stopped");
    const completed = await chatSvc.markGenerationTerminal(generationId, "completed");

    expect(stopped).toMatchObject({
      id: generationId,
      status: "stopped",
      terminalReason: "stopped",
    });
    expect(completed).toBeNull();

    const [generation] = await db.select().from(chatGenerations).where(eq(chatGenerations.id, generationId));
    expect(generation).toMatchObject({
      status: "stopped",
      terminalReason: "stopped",
    });
  });

  it("records a new Stop as an idempotent success when the generation is already stopped", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const controlActionId = randomUUID();
    const terminalAt = new Date("2026-07-20T14:00:00.000Z");
    const emptyBodyHash = hashChatGenerationBody("");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Idempotent Stop Org",
      urlKey: deriveOrganizationUrlKey("Messenger Idempotent Stop Org"),
      issuePrefix: `I${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Already stopped chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "stopped",
      attemptEpoch: 1,
      controlVersion: 1,
      controlState: "terminal",
      runtimeTerminalAt: terminalAt,
      completedAt: terminalAt,
    });

    const first = await chatSvc.generationProtocol.beginStopAction({
      orgId,
      conversationId,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 1,
      requestedRenderSeq: 0,
      requestedBodyHash: emptyBodyHash,
    });
    const replay = await chatSvc.generationProtocol.beginStopAction({
      orgId,
      conversationId,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 1,
      requestedRenderSeq: 0,
      requestedBodyHash: emptyBodyHash,
    });

    expect(first).toMatchObject({
      outcome: "already_terminal",
      idempotent: false,
      generation: { id: generationId, status: "stopped" },
      action: { id: controlActionId, localDisposition: "stopped" },
    });
    expect(replay).toMatchObject({
      outcome: "already_terminal",
      idempotent: true,
      action: { id: controlActionId },
    });
  });

  it("archives accepted-current Steer feedback when its generation becomes terminal", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const controlActionId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Accepted Steer Cleanup Org",
      urlKey: deriveOrganizationUrlKey("Messenger Accepted Steer Cleanup Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Accepted Steer cleanup chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "accepted-steer-cleanup",
      expectedGenerationId: generationId,
      payload: { body: "Use this feedback in the current turn" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const started = await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    });
    await chatSvc.resolveSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      status: "accepted_current",
      disposition: "accepted_current",
      providerDisposition: "acknowledged",
    });

    expect(started.generation?.id).toBe(generationId);
    expect(await chatSvc.listQueuedMessages(conversationId)).toEqual([]);
    await chatSvc.markGenerationTerminal(generationId, "completed");

    const [storedQueueItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, queued.id));
    const [storedAction] = await db
      .select()
      .from(chatControlActions)
      .where(eq(chatControlActions.id, controlActionId));
    expect(storedQueueItem).toMatchObject({
      status: "delivered",
      deliveryDisposition: "delivered",
    });
    expect(storedAction).toMatchObject({
      localDisposition: "delivered",
      providerDisposition: "acknowledged",
    });
    expect(await chatSvc.listQueuedMessages(conversationId)).toEqual([]);
  });

  it("materializes one durable user message for repeated native Steer handling", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const controlActionId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Visible Steer Org",
      urlKey: deriveOrganizationUrlKey("Messenger Visible Steer Org"),
      issuePrefix: `V${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Visible Steer chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
      attemptEpoch: 1,
      controlVersion: 0,
      controlState: "ready",
    });
    await db.insert(chatGenerationEvents).values({
      orgId,
      generationId,
      generationSeq: 1,
      attemptEpoch: 1,
      eventKind: "transcript",
      payload: {
        entry: {
          kind: "thinking",
          ts: "2026-07-21T08:00:00.000Z",
          text: "Reasoning before Steer",
        },
      },
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "visible-native-steer",
      expectedGenerationId: generationId,
      payload: { body: "Keep this operator feedback visible" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const steerMessages = chatSteerMessageService(db);
    const first = await steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });
    const retried = await steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });
    const messages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, conversationId));

    expect(first.idempotent).toBe(false);
    expect(retried.idempotent).toBe(true);
    expect(retried.action.id).toBe(first.action.id);
    expect(retried.item).toMatchObject({
      continuationMessageId: messages[0]?.id,
      sourceMessageId: messages[0]?.id,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      kind: "message",
      status: "completed",
      body: "Keep this operator feedback visible",
      structuredPayload: {
        source: "steer",
        targetGenerationId: generationId,
        afterTranscriptEntryCount: 1,
        generationSeq: 1,
        queueItemId: queued.id,
        controlActionId,
        deliveryDisposition: "pending",
      },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ action: "chat.message_added" });

    await chatSvc.resolveSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      status: "accepted_current",
      disposition: "accepted_current",
      providerDisposition: "acknowledged",
    });
    const [resolvedMessage] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messages[0]!.id));
    expect(resolvedMessage?.structuredPayload).toMatchObject({
      source: "steer",
      targetGenerationId: generationId,
      afterTranscriptEntryCount: 1,
      deliveryDisposition: "accepted_current",
    });
  });

  it("acknowledges a legacy stream queue item when its user message is durable, regardless of a later assistant failure", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const itemId = randomUUID();
    const sourceMessageId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger legacy delivery acknowledgement org",
      urlKey: deriveOrganizationUrlKey("Messenger legacy delivery acknowledgement org"),
      issuePrefix: `D${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Legacy delivery acknowledgement chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "dequeue_claimed",
      clientMutationId: "legacy-delivery-ack",
      payload: { body: "Persist this follow-up exactly once" },
    });
    await db.insert(chatMessages).values({
      id: sourceMessageId,
      orgId,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Persist this follow-up exactly once",
    });

    const acknowledged = await chatSvc.markQueuedMessageRunning({
      conversationId,
      itemId,
      sourceMessageId,
    });
    await chatSvc.markQueuedMessageDeliveryTerminal({
      conversationId,
      itemId,
      status: "failed",
    });

    expect(acknowledged).toMatchObject({
      status: "completed",
      sourceMessageId,
      deliveredMessageId: sourceMessageId,
    });
    const [stored] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, itemId));
    expect(stored).toMatchObject({ status: "completed", sourceMessageId, deliveredMessageId: sourceMessageId });
  });

  it("acknowledges server queue delivery before an assistant terminal outcome can change it", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger server delivery acknowledgement org",
      urlKey: deriveOrganizationUrlKey("Messenger server delivery acknowledgement org"),
      issuePrefix: `Q${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Server delivery acknowledgement chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "server-delivery-ack",
      payload: { body: "Prepare this continuation before the runtime finishes" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const claim = await chatSvc.claimNextServerQueuedMessage({ workerId: "delivery-ack-worker", leaseMs: 30_000 });

    const acknowledged = await chatSvc.acknowledgeServerQueuedMessageDelivery({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
    });
    const terminalCompletion = await chatSvc.completeServerQueuedMessageDelivery({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
      status: "failed",
      reason: "assistant_runtime_failed_after_delivery",
    });

    expect(acknowledged).toMatchObject({
      id: queued.id,
      status: "completed",
      deliveredMessageId: claim!.userMessageId,
    });
    expect(terminalCompletion).toBeNull();
    const [stored] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, queued.id));
    expect(stored).toMatchObject({ status: "completed", deliveredMessageId: claim!.userMessageId });
  });

  it("rolls back server queue acknowledgement when its linked control action belongs to another organization", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const conversationId = randomUUID();
    const foreignActionId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger server acknowledgement scope org",
        urlKey: deriveOrganizationUrlKey("Messenger server acknowledgement scope org"),
        issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger server acknowledgement scope other org",
        urlKey: deriveOrganizationUrlKey("Messenger server acknowledgement scope other org"),
        issuePrefix: `B${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Server acknowledgement scope chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatControlActions).values({
      id: foreignActionId,
      orgId: otherOrgId,
      actionKind: "steer",
      localDisposition: "pending",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "server-delivery-ack-cross-org-action",
      payload: { body: "Do not acknowledge a poisoned control action link" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "delivery-ack-scope-worker",
      leaseMs: 30_000,
    });
    await db
      .update(chatQueuedMessages)
      .set({
        deliveryIntent: "steer",
        controlActionId: foreignActionId,
      })
      .where(eq(chatQueuedMessages.id, queued.id));

    await expect(chatSvc.acknowledgeServerQueuedMessageDelivery({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
    })).rejects.toThrow();

    const [storedItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, queued.id));
    const [storedAction] = await db
      .select()
      .from(chatControlActions)
      .where(eq(chatControlActions.id, foreignActionId));
    expect(storedItem).toMatchObject({
      status: "dequeue_claimed",
      deliveryDisposition: null,
      deliveryLeaseToken: claim!.leaseToken,
      controlActionId: foreignActionId,
    });
    expect(storedAction).toMatchObject({
      orgId: otherOrgId,
      localDisposition: "pending",
      resolvedAt: null,
    });
  });

  it("claims an ordinary queued follow-up after an operator-stopped generation", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const stoppedGenerationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger stopped queue advancement org",
      urlKey: deriveOrganizationUrlKey("Messenger stopped queue advancement org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Stopped queue advancement chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: stoppedGenerationId,
      orgId,
      conversationId,
      status: "stopped",
      terminalReason: "operator_stop",
      completedAt: new Date(),
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "advance-after-operator-stop",
      payload: { body: "Start this as the next turn after Stop" },
      requestActor: boardQueueRequestActor(orgId),
    });

    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "stopped-generation-worker",
      leaseMs: 30_000,
    });

    expect(claim).toMatchObject({
      item: {
        id: queued.id,
        status: "dequeue_claimed",
      },
    });
    expect(claim?.generationId).not.toBe(stoppedGenerationId);
    const generations = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.conversationId, conversationId));
    expect(generations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: stoppedGenerationId,
        status: "stopped",
        terminalReason: "operator_stop",
      }),
      expect.objectContaining({
        id: claim?.generationId,
        status: "active",
      }),
    ]));
  });

  it("claims only the head Queue item when workers race after an operator Stop", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger stopped queue ordering org",
      urlKey: deriveOrganizationUrlKey("Messenger stopped queue ordering org"),
      issuePrefix: `O${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Stopped queue ordering chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: randomUUID(),
      orgId,
      conversationId,
      status: "stopped",
      terminalReason: "operator_stop",
      completedAt: new Date(),
    });
    const queuedItems = [];
    for (const [index, body] of [
      "First queued turn",
      "Second queued turn",
      "Third queued turn",
    ].entries()) {
      queuedItems.push(await chatSvc.createQueuedMessage({
        orgId,
        conversationId,
        clientMutationId: `ordered-after-stop-${index + 1}`,
        payload: { body },
        requestActor: boardQueueRequestActor(orgId),
      }));
    }

    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, index) => chatSvc.claimNextServerQueuedMessage({
        workerId: `ordering-worker-${index + 1}`,
        leaseMs: 30_000,
      })),
    );
    const successfulClaims = claims.filter((claim) => claim !== null);

    expect(successfulClaims).toHaveLength(1);
    expect(successfulClaims[0]?.item.id).toBe(queuedItems[0]?.id);
    expect(await chatSvc.listQueuedMessages(conversationId)).toMatchObject([
      { id: queuedItems[0]?.id, status: "dequeue_claimed" },
      { id: queuedItems[1]?.id, status: "queued" },
      { id: queuedItems[2]?.id, status: "queued" },
    ]);
  });

  it("does not leapfrog a locked head Queue item after an operator Stop", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger locked queue head org",
      urlKey: deriveOrganizationUrlKey("Messenger locked queue head org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Locked queue head chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: randomUUID(),
      orgId,
      conversationId,
      status: "stopped",
      terminalReason: "operator_stop",
      completedAt: new Date(),
    });
    const first = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "locked-head-first",
      payload: { body: "First queued turn" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const second = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "locked-head-second",
      payload: { body: "Second queued turn" },
      requestActor: boardQueueRequestActor(orgId),
    });

    let releaseHeadLock!: () => void;
    const headLockBarrier = new Promise<void>((resolve) => {
      releaseHeadLock = resolve;
    });
    let signalHeadLocked!: () => void;
    const headLocked = new Promise<void>((resolve) => {
      signalHeadLocked = resolve;
    });
    const lockedHeadTransaction = db.transaction(async (tx) => {
      await tx
        .select({ id: chatQueuedMessages.id })
        .from(chatQueuedMessages)
        .where(eq(chatQueuedMessages.id, first.id))
        .for("update");
      signalHeadLocked();
      await headLockBarrier;
    });
    await headLocked;

    const claimWhileHeadLocked = await chatSvc.claimNextServerQueuedMessage({
      workerId: "locked-head-worker",
      leaseMs: 30_000,
    });
    releaseHeadLock();
    await lockedHeadTransaction;

    expect(claimWhileHeadLocked).toBeNull();
    const claimAfterHeadUnlocked = await chatSvc.claimNextServerQueuedMessage({
      workerId: "unlocked-head-worker",
      leaseMs: 30_000,
    });
    expect(claimAfterHeadUnlocked?.item.id).toBe(first.id);
    expect(await chatSvc.listQueuedMessages(conversationId)).toMatchObject([
      { id: first.id, status: "dequeue_claimed" },
      { id: second.id, status: "queued" },
    ]);
  });

  it.each([
    { status: "failed", terminalReason: "runtime_failed" },
    { status: "aborted", terminalReason: "runtime_aborted" },
    { status: "interrupted_unverified", terminalReason: "runtime_interrupted" },
    { status: "control_lost", terminalReason: "runtime_control_lost" },
    { status: "stopped", terminalReason: "steer_fallback" },
  ] as const)("keeps an ordinary queued follow-up parked after a $status generation", async ({
    status,
    terminalReason,
  }) => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: `Messenger ${status} queue fence org`,
      urlKey: deriveOrganizationUrlKey(`Messenger ${status} queue fence org`),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: `${status} queue fence chat`,
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: randomUUID(),
      orgId,
      conversationId,
      status,
      terminalReason,
      completedAt: new Date(),
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: `park-after-${status}-generation`,
      payload: { body: `Keep this parked after ${status}` },
      requestActor: boardQueueRequestActor(orgId),
    });

    expect(await chatSvc.claimNextServerQueuedMessage({
      workerId: `${status}-generation-worker`,
      leaseMs: 30_000,
    })).toBeNull();
    expect(await chatSvc.listQueuedMessages(conversationId)).toMatchObject([
      {
        id: queued.id,
        status: "queued",
      },
    ]);
  });

  it("does not reconcile a live server delivery claim before its runtime control handle accepts it", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger live claim reconciliation fence org",
      urlKey: deriveOrganizationUrlKey("Messenger live claim reconciliation fence org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Live claim reconciliation fence chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "live-server-claim-before-runtime-acceptance",
      payload: { body: "Do not acknowledge before the runtime handle exists" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const claim = await chatSvc.claimNextServerQueuedMessage({ workerId: "live-claim-worker", leaseMs: 30_000 });

    expect(await chatSvc.listQueuedMessages(conversationId)).toMatchObject([
      { id: claim!.item.id, status: "dequeue_claimed" },
    ]);
    expect(await chatSvc.acknowledgeServerQueuedMessageDelivery({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
    })).toMatchObject({ id: claim!.item.id, status: "completed" });
  });

  it("routes an expired server claim through claim recovery instead of durable-delivery reconciliation", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger expired claim recovery fence org",
      urlKey: deriveOrganizationUrlKey("Messenger expired claim recovery fence org"),
      issuePrefix: `E${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Expired claim recovery fence chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "expired-server-claim-before-runtime-acceptance",
      payload: { body: "Recover this claim; do not infer runtime acceptance" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const claim = await chatSvc.claimNextServerQueuedMessage({ workerId: "expired-claim-worker", leaseMs: 30_000 });
    const recoveryNow = new Date(Date.now() + 60_000);

    expect(await chatSvc.recoverExpiredServerQueueClaims(recoveryNow)).toEqual({
      inspected: 1,
      requeued: 1,
      ambiguous: 0,
    });
    const [stored] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, claim!.item.id));
    expect(stored).toMatchObject({
      status: "queued",
      continuationGenerationId: null,
      deliveryLeaseToken: null,
      deliveredMessageId: claim!.userMessageId,
    });
  });

  it("reconciles a historical server failure only after its linked generation is terminal", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger terminal legacy server reconciliation org",
      urlKey: deriveOrganizationUrlKey("Messenger terminal legacy server reconciliation org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Terminal legacy server reconciliation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "terminal-server-failure-with-durable-user-message",
      payload: { body: "Repair this historical server delivery failure" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const claim = await chatSvc.claimNextServerQueuedMessage({ workerId: "terminal-legacy-worker", leaseMs: 30_000 });
    await chatSvc.markGenerationTerminal(claim!.generationId, "failed");
    await chatSvc.completeServerQueuedMessageDelivery({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
      status: "failed",
      reason: "legacy_terminal_failure_after_user_delivery",
    });

    expect(await chatSvc.listQueuedMessages(conversationId)).toEqual([]);
    const [stored] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, claim!.item.id));
    expect(stored).toMatchObject({
      status: "completed",
      continuationGenerationId: claim!.generationId,
      deliveryLeaseEpoch: claim!.leaseEpoch,
      deliveredMessageId: claim!.userMessageId,
    });
  });

  it("does not reconcile terminal evidence while an unacknowledged server claim still holds its lease", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger terminal-before-release fence org",
      urlKey: deriveOrganizationUrlKey("Messenger terminal-before-release fence org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Terminal-before-release fence chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "terminal-evidence-before-unacknowledged-claim-release",
      payload: { body: "Do not repair this until its claim is released" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const claim = await chatSvc.claimNextServerQueuedMessage({ workerId: "terminal-before-release-worker", leaseMs: 30_000 });
    await chatSvc.markGenerationTerminal(claim!.generationId, "failed");

    expect(await chatSvc.listQueuedMessages(conversationId)).toMatchObject([
      { id: claim!.item.id, status: "dequeue_claimed", deliveryLeaseToken: claim!.leaseToken },
    ]);
  });

  it("reconciles legacy abnormal delivery rows only when their delivered user message belongs to the same organization and conversation", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const conversationId = randomUUID();
    const otherConversationId = randomUUID();
    const repairableItemId = randomUUID();
    const unsafeItemId = randomUUID();
    const deliveredMessageId = randomUUID();
    const crossScopeMessageId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger legacy reconciliation org",
        urlKey: deriveOrganizationUrlKey("Messenger legacy reconciliation org"),
        issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger legacy reconciliation other org",
        urlKey: deriveOrganizationUrlKey("Messenger legacy reconciliation other org"),
        issuePrefix: `O${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values([
      { id: conversationId, orgId, title: "Reconciliation chat", issueCreationMode: "manual_approval", planMode: false },
      { id: otherConversationId, orgId: otherOrgId, title: "Other reconciliation chat", issueCreationMode: "manual_approval", planMode: false },
    ]);
    await db.insert(chatMessages).values([
      {
        id: deliveredMessageId,
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Already delivered follow-up",
      },
      {
        id: crossScopeMessageId,
        orgId: otherOrgId,
        conversationId: otherConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Wrong scope evidence",
      },
    ]);
    await db.insert(chatQueuedMessages).values([
      {
        id: repairableItemId,
        orgId,
        conversationId,
        position: 1,
        status: "failed_actionable",
        clientMutationId: "legacy-delivered-failed-row",
        payload: { body: "Already delivered follow-up" },
        sourceMessageId: deliveredMessageId,
        deliveredMessageId,
      },
      {
        id: unsafeItemId,
        orgId,
        conversationId,
        position: 2,
        status: "running",
        clientMutationId: "legacy-cross-scope-delivery-evidence",
        payload: { body: "Wrong scope evidence" },
        deliveredMessageId: crossScopeMessageId,
      },
    ]);

    expect(await chatSvc.listQueuedMessages(conversationId)).toHaveLength(1);
    const rows = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.conversationId, conversationId));
    expect(rows.find((row) => row.id === repairableItemId)).toMatchObject({
      status: "completed",
      deliveredMessageId,
      lastDeliveryReason: null,
    });
    expect(rows.find((row) => row.id === unsafeItemId)).toMatchObject({ status: "running" });
  });

  it("normalizes mixed-scope delivery evidence to the validated same-conversation user message", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const conversationId = randomUUID();
    const otherConversationId = randomUUID();
    const itemId = randomUUID();
    const validEvidenceId = randomUUID();
    const invalidEvidenceId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger mixed evidence reconciliation org",
        urlKey: deriveOrganizationUrlKey("Messenger mixed evidence reconciliation org"),
        issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger mixed evidence reconciliation other org",
        urlKey: deriveOrganizationUrlKey("Messenger mixed evidence reconciliation other org"),
        issuePrefix: `X${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values([
      { id: conversationId, orgId, title: "Mixed evidence reconciliation chat", issueCreationMode: "manual_approval", planMode: false },
      { id: otherConversationId, orgId: otherOrgId, title: "Other mixed evidence reconciliation chat", issueCreationMode: "manual_approval", planMode: false },
    ]);
    await db.insert(chatMessages).values([
      {
        id: validEvidenceId,
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Durably delivered in the correct chat",
      },
      {
        id: invalidEvidenceId,
        orgId: otherOrgId,
        conversationId: otherConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Wrong chat evidence",
      },
    ]);
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "failed_actionable",
      clientMutationId: "mixed-scope-delivery-evidence",
      payload: { body: "Durably delivered in the correct chat" },
      sourceMessageId: validEvidenceId,
      deliveredMessageId: invalidEvidenceId,
      continuationMessageId: invalidEvidenceId,
    });

    await chatSvc.listQueuedMessages(conversationId);

    const [stored] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, itemId));
    expect(stored).toMatchObject({
      status: "completed",
      sourceMessageId: validEvidenceId,
      deliveredMessageId: validEvidenceId,
      continuationMessageId: validEvidenceId,
    });
  });

  it("rolls back legacy delivery repair when its linked control action cannot be updated", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const actionId = randomUUID();
    const itemId = randomUUID();
    const evidenceId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger reconciliation transaction org",
      urlKey: deriveOrganizationUrlKey("Messenger reconciliation transaction org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Reconciliation transaction chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({ id: generationId, orgId, conversationId, status: "stopped" });
    await db.insert(chatControlActions).values({
      id: actionId,
      orgId,
      expectedGenerationId: generationId,
      actionKind: "steer",
      localDisposition: "failed_actionable",
      providerDisposition: "rejected",
    });
    await db.insert(chatMessages).values({
      id: evidenceId,
      orgId,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Durable delivery that needs atomic reconciliation",
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "failed_actionable",
      deliveryIntent: "steer",
      deliveryDisposition: "failed_actionable",
      controlActionId: actionId,
      clientMutationId: "reconciliation-must-be-atomic",
      payload: { body: "Durable delivery that needs atomic reconciliation" },
      sourceMessageId: evidenceId,
    });
    await db.execute(sql`
      create function reject_reconciled_control_action_update() returns trigger language plpgsql as $$
      begin
        raise exception 'control action update rejected for reconciliation test';
      end;
      $$
    `);
    await db.execute(sql`
      create trigger reject_reconciled_control_action_update
      before update on chat_control_actions
      for each row execute function reject_reconciled_control_action_update()
    `);

    try {
      await expect(chatSvc.listQueuedMessages(conversationId)).rejects.toThrow("Failed query");
    } finally {
      await db.execute(sql`drop trigger if exists reject_reconciled_control_action_update on chat_control_actions`);
      await db.execute(sql`drop function if exists reject_reconciled_control_action_update()`);
    }

    const [storedItem] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, itemId));
    const [storedAction] = await db.select().from(chatControlActions).where(eq(chatControlActions.id, actionId));
    expect(storedItem).toMatchObject({ status: "failed_actionable", deliveryDisposition: "failed_actionable" });
    expect(storedAction).toMatchObject({ localDisposition: "failed_actionable", providerDisposition: "rejected" });
  });

  it("rolls back legacy delivery repair when its linked control action belongs to another organization", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const conversationId = randomUUID();
    const actionId = randomUUID();
    const itemId = randomUUID();
    const evidenceId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger action scope reconciliation org",
        urlKey: deriveOrganizationUrlKey("Messenger action scope reconciliation org"),
        issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger action scope reconciliation other org",
        urlKey: deriveOrganizationUrlKey("Messenger action scope reconciliation other org"),
        issuePrefix: `Y${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Action scope reconciliation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatControlActions).values({
      id: actionId,
      orgId: otherOrgId,
      actionKind: "steer",
      localDisposition: "failed_actionable",
      providerDisposition: "rejected",
    });
    await db.insert(chatMessages).values({
      id: evidenceId,
      orgId,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Durable evidence must not repair across control action scopes",
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "failed_actionable",
      deliveryIntent: "steer",
      deliveryDisposition: "failed_actionable",
      controlActionId: actionId,
      clientMutationId: "reconciliation-action-scope-mismatch",
      payload: { body: "Durable evidence must not repair across control action scopes" },
      sourceMessageId: evidenceId,
    });

    expect(await chatSvc.listQueuedMessages(conversationId)).toMatchObject([
      { id: itemId, status: "failed_actionable", deliveryDisposition: "failed_actionable" },
    ]);

    const [storedItem] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, itemId));
    const [storedAction] = await db.select().from(chatControlActions).where(eq(chatControlActions.id, actionId));
    expect(storedItem).toMatchObject({ status: "failed_actionable", deliveryDisposition: "failed_actionable" });
    expect(storedAction).toMatchObject({ localDisposition: "failed_actionable", providerDisposition: "rejected" });
  });

  it("skips a poisoned legacy control-action link while global claim and recovery process valid work", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const conversationId = randomUUID();
    const actionId = randomUUID();
    const poisonItemId = randomUUID();
    const evidenceId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger poisoned reconciliation claim org",
        urlKey: deriveOrganizationUrlKey("Messenger poisoned reconciliation claim org"),
        issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger poisoned reconciliation claim other org",
        urlKey: deriveOrganizationUrlKey("Messenger poisoned reconciliation claim other org"),
        issuePrefix: `Z${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Poisoned reconciliation claim chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatControlActions).values({
      id: actionId,
      orgId: otherOrgId,
      actionKind: "steer",
      localDisposition: "failed_actionable",
      providerDisposition: "rejected",
    });
    await db.insert(chatMessages).values({
      id: evidenceId,
      orgId,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Poisoned legacy evidence must not halt queue delivery",
    });
    await db.insert(chatQueuedMessages).values({
      id: poisonItemId,
      orgId,
      conversationId,
      position: 1,
      status: "failed_actionable",
      deliveryIntent: "steer",
      deliveryDisposition: "failed_actionable",
      controlActionId: actionId,
      clientMutationId: "poisoned-legacy-control-action-link",
      payload: { body: "Poisoned legacy evidence must not halt queue delivery" },
      sourceMessageId: evidenceId,
    });
    const valid = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "valid-work-after-poisoned-legacy-row",
      payload: { body: "Claim and recover this valid queue item" },
      requestActor: boardQueueRequestActor(orgId),
    });

    const claim = await chatSvc.claimNextServerQueuedMessage({ workerId: "poisoned-row-worker", leaseMs: 30_000 });
    const recovery = await chatSvc.recoverExpiredServerQueueClaims(new Date(Date.now() + 60_000));

    expect(claim).toMatchObject({ item: { id: valid.id } });
    expect(recovery).toEqual({ inspected: 1, requeued: 1, ambiguous: 0 });
    const [poisoned] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, poisonItemId));
    expect(poisoned).toMatchObject({ status: "failed_actionable", deliveryDisposition: "failed_actionable" });
  });

  it("retries a confirmed pre-delivery Steer failure without resending durable delivered evidence", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const oldActionId = randomUUID();
    const retryActionId = randomUUID();
    const itemId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger retryable pre-delivery failure org",
      urlKey: deriveOrganizationUrlKey("Messenger retryable pre-delivery failure org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Retryable pre-delivery failure chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({ id: generationId, orgId, conversationId, status: "stopped" });
    await db.insert(chatControlActions).values({
      id: oldActionId,
      orgId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      actionKind: "steer",
      localDisposition: "failed_actionable",
      providerDisposition: "rejected",
      providerSentAt: new Date("2026-07-23T08:00:00.000Z"),
      lastError: "provider_rejected_before_delivery",
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "failed_actionable",
      deliveryIntent: "steer",
      deliveryDisposition: "failed_actionable",
      controlActionId: oldActionId,
      clientMutationId: "retry-confirmed-pre-delivery-failure",
      payload: { body: "Retry only because it was never delivered" },
      requestActor: boardQueueRequestActor(orgId),
      lastDeliveryReason: "provider_rejected_before_delivery",
    });

    const retried = await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId,
      controlActionId: retryActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
    });
    const idempotentRetry = await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId,
      controlActionId: retryActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
    });

    expect(retried).toMatchObject({
      idempotent: false,
      action: { id: retryActionId, providerDisposition: "not_sent" },
      item: { status: "continuation_pending", controlActionId: retryActionId },
    });
    expect(idempotentRetry).toMatchObject({ idempotent: true, action: { id: retryActionId } });
  });

  it("rebinds a confirmed pre-delivery failure to one fresh continuation action and message", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const oldActionId = randomUUID();
    const freshActionId = randomUUID();
    const itemId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger continuation retry org",
      urlKey: deriveOrganizationUrlKey("Messenger continuation retry org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Continuation retry chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatControlActions).values({
      id: oldActionId,
      orgId,
      actionKind: "steer",
      localDisposition: "failed_actionable",
      providerDisposition: "rejected",
      lastError: "provider_rejected_before_delivery",
      providerSentAt: new Date("2026-07-23T08:00:00.000Z"),
      providerEvidence: {
        attemptEpoch: 1,
        rejectionCode: "provider_rejected_before_delivery",
      },
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "failed_actionable",
      deliveryIntent: "steer",
      deliveryDisposition: "failed_actionable",
      controlActionId: oldActionId,
      clientMutationId: "continuation-retry-failed-actionable",
      payload: { body: "Retry this in the next generation" },
      requestActor: boardQueueRequestActor(orgId),
      lastDeliveryReason: "provider_rejected_before_delivery",
      providerEvidence: {
        attemptEpoch: 1,
        rejectionCode: "provider_rejected_before_delivery",
      },
    });
    const steerMessages = chatSteerMessageService(db);

    const first = await steerMessages.scheduleContinuation({
      orgId,
      conversationId,
      itemId,
      controlActionId: freshActionId,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });
    const duplicate = await steerMessages.scheduleContinuation({
      orgId,
      conversationId,
      itemId,
      controlActionId: freshActionId,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });

    expect(first).toMatchObject({
      idempotent: false,
      action: { id: freshActionId, localDisposition: "continuation_pending" },
      item: { id: itemId, status: "continuation_pending", controlActionId: freshActionId },
    });
    expect(duplicate).toMatchObject({
      idempotent: true,
      action: { id: freshActionId },
      item: { id: itemId, controlActionId: freshActionId },
    });
    const actions = await db.select().from(chatControlActions).where(eq(chatControlActions.orgId, orgId));
    const messages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    expect(actions).toHaveLength(2);
    expect(actions.find((action) => action.id === oldActionId)).toMatchObject({
      localDisposition: "failed_actionable",
      providerDisposition: "rejected",
      lastError: "provider_rejected_before_delivery",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.structuredPayload).toMatchObject({ controlActionId: freshActionId, queueItemId: itemId });
  });

  it("rebinds a confirmed pre-delivery failure to one fresh active-generation action and message", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const oldActionId = randomUUID();
    const freshActionId = randomUUID();
    const itemId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger active retry org",
      urlKey: deriveOrganizationUrlKey("Messenger active retry org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Active retry chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
      attemptEpoch: 1,
      controlVersion: 0,
      controlState: "ready",
    });
    await db.insert(chatControlActions).values({
      id: oldActionId,
      orgId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      actionKind: "steer",
      localDisposition: "failed_actionable",
      providerDisposition: "not_sent",
      lastError: "provider_io_failed_before_send",
      providerEvidence: {
        attemptEpoch: 1,
        failureStage: "before_provider_send",
      },
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "failed_actionable",
      deliveryIntent: "steer",
      deliveryDisposition: "failed_actionable",
      controlActionId: oldActionId,
      expectedGenerationId: generationId,
      clientMutationId: "active-retry-failed-actionable",
      payload: { body: "Retry this on the active generation" },
      requestActor: boardQueueRequestActor(orgId),
      lastDeliveryReason: "provider_io_failed_before_send",
      providerEvidence: {
        attemptEpoch: 1,
        failureStage: "before_provider_send",
      },
    });
    const steerMessages = chatSteerMessageService(db);
    const invoke = () => steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId,
      controlActionId: freshActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user" as const, actorId: "board" },
    });

    const first = await invoke();
    const duplicate = await invoke();

    expect(first).toMatchObject({
      idempotent: false,
      action: { id: freshActionId, localDisposition: "pending", providerDisposition: "not_sent" },
      item: { id: itemId, status: "steer_pending", controlActionId: freshActionId },
      generation: { id: generationId, controlVersion: 1 },
    });
    expect(duplicate).toMatchObject({
      idempotent: true,
      action: { id: freshActionId },
      item: { id: itemId, controlActionId: freshActionId },
    });
    const actions = await db.select().from(chatControlActions).where(eq(chatControlActions.orgId, orgId));
    const messages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    expect(actions).toHaveLength(2);
    expect(actions.find((action) => action.id === oldActionId)).toMatchObject({
      localDisposition: "failed_actionable",
      providerDisposition: "not_sent",
      lastError: "provider_io_failed_before_send",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.structuredPayload).toMatchObject({ controlActionId: freshActionId, queueItemId: itemId });
  });

  it("rejects unsafe failed-action retries without creating a fresh action or message", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const evidenceMessageId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger unsafe retry org",
        urlKey: deriveOrganizationUrlKey("Messenger unsafe retry org"),
        issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger unsafe retry other org",
        urlKey: deriveOrganizationUrlKey("Messenger unsafe retry other org"),
        issuePrefix: `X${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Unsafe retry chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({ id: generationId, orgId, conversationId, status: "stopped" });
    await db.insert(chatMessages).values({
      id: evidenceMessageId,
      orgId,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Already delivered evidence",
    });
    const unsafeCases = [
      {
        suffix: "durable-source",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: evidenceMessageId,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
      },
      {
        suffix: "durable-delivered",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: evidenceMessageId,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
      },
      {
        suffix: "durable-continuation",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: evidenceMessageId,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
      },
      {
        suffix: "acceptance-unknown",
        actionOrgId: orgId,
        localDisposition: "acceptance_unknown",
        providerDisposition: "sent",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
      },
      {
        suffix: "local-disposition-mismatch",
        actionOrgId: orgId,
        localDisposition: "acceptance_unknown",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
      },
      {
        suffix: "not-sent-with-send-timestamp",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "not_sent",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
      },
      {
        suffix: "acknowledged",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "acknowledged",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: new Date(),
        cancelledAt: null,
      },
      {
        suffix: "acknowledgement-timestamp",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: new Date(),
        cancelledAt: null,
      },
      {
        suffix: "queue-disposition-acknowledged",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
        deliveryDisposition: "accepted_current",
      },
      {
        suffix: "queue-disposition-missing",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
        deliveryDisposition: null,
      },
      {
        suffix: "queue-steered-at",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
        steeredAt: new Date(),
      },
      {
        suffix: "queue-same-turn-receipt",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
        itemProviderEvidence: { receipt: "same_turn" },
      },
      {
        suffix: "action-late-same-turn-ack",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
        actionProviderEvidence: { receipt: "late_same_turn_ack" },
      },
      {
        suffix: "cross-org",
        actionOrgId: otherOrgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: null,
      },
      {
        suffix: "cancelled",
        actionOrgId: orgId,
        localDisposition: "failed_actionable",
        providerDisposition: "rejected",
        sourceMessageId: null,
        deliveredMessageId: null,
        continuationMessageId: null,
        providerSentAt: new Date(),
        providerAcknowledgedAt: null,
        cancelledAt: new Date(),
      },
    ] as const;
    const itemIds: string[] = [];
    for (const [index, unsafe] of unsafeCases.entries()) {
      const actionId = randomUUID();
      const itemId = randomUUID();
      itemIds.push(itemId);
      await db.insert(chatControlActions).values({
        id: actionId,
        orgId: unsafe.actionOrgId,
        expectedGenerationId: generationId,
        actionKind: "steer",
        localDisposition: unsafe.localDisposition,
        providerDisposition: unsafe.providerDisposition,
        providerSentAt: unsafe.providerSentAt,
        providerAcknowledgedAt: unsafe.providerAcknowledgedAt,
        providerEvidence: "actionProviderEvidence" in unsafe ? unsafe.actionProviderEvidence : null,
      });
      await db.insert(chatQueuedMessages).values({
        id: itemId,
        orgId,
        conversationId,
        position: index + 1,
        status: "failed_actionable",
        deliveryIntent: "steer",
        deliveryDisposition: "deliveryDisposition" in unsafe
          ? unsafe.deliveryDisposition
          : "failed_actionable",
        controlActionId: actionId,
        expectedGenerationId: generationId,
        clientMutationId: `unsafe-retry-${unsafe.suffix}`,
        payload: { body: `Do not retry ${unsafe.suffix}` },
        sourceMessageId: unsafe.sourceMessageId,
        deliveredMessageId: unsafe.deliveredMessageId,
        continuationMessageId: unsafe.continuationMessageId,
        cancelledAt: unsafe.cancelledAt,
        steeredAt: "steeredAt" in unsafe ? unsafe.steeredAt : null,
        providerEvidence: "itemProviderEvidence" in unsafe ? unsafe.itemProviderEvidence : null,
      });
    }
    const missingActionItemId = randomUUID();
    itemIds.push(missingActionItemId);
    await db.insert(chatQueuedMessages).values({
      id: missingActionItemId,
      orgId,
      conversationId,
      position: unsafeCases.length + 1,
      status: "failed_actionable",
      deliveryIntent: "steer",
      deliveryDisposition: "failed_actionable",
      controlActionId: null,
      expectedGenerationId: generationId,
      clientMutationId: "unsafe-retry-missing-action",
      payload: { body: "Do not retry missing action" },
    });
    const steerMessages = chatSteerMessageService(db);

    for (const itemId of itemIds) {
      await expect(steerMessages.scheduleContinuation({
        orgId,
        conversationId,
        itemId,
        controlActionId: randomUUID(),
        requestActor: boardQueueRequestActor(orgId),
        actor: { actorType: "user", actorId: "board" },
      })).rejects.toMatchObject({ status: 409 });
    }

    const actions = await db.select().from(chatControlActions);
    const messages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    expect(actions).toHaveLength(unsafeCases.length);
    expect(messages).toHaveLength(1);
  });

  it("rejects queue-side acknowledgement evidence on active-generation failed-action retries", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger active acknowledgement fence org",
      urlKey: deriveOrganizationUrlKey("Messenger active acknowledgement fence org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Active acknowledgement fence chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
      attemptEpoch: 1,
      controlVersion: 0,
      controlState: "ready",
    });
    const unsafeCases = [
      {
        suffix: "queue-disposition-acknowledged",
        deliveryDisposition: "accepted_current",
        steeredAt: null,
        itemProviderEvidence: null,
        actionProviderEvidence: null,
      },
      {
        suffix: "queue-disposition-missing",
        deliveryDisposition: null,
        steeredAt: null,
        itemProviderEvidence: null,
        actionProviderEvidence: null,
      },
      {
        suffix: "queue-steered-at",
        deliveryDisposition: "failed_actionable",
        steeredAt: new Date(),
        itemProviderEvidence: null,
        actionProviderEvidence: null,
      },
      {
        suffix: "queue-same-turn-receipt",
        deliveryDisposition: "failed_actionable",
        steeredAt: null,
        itemProviderEvidence: { receipt: "same_turn" },
        actionProviderEvidence: null,
      },
      {
        suffix: "action-late-same-turn-ack",
        deliveryDisposition: "failed_actionable",
        steeredAt: null,
        itemProviderEvidence: null,
        actionProviderEvidence: { receipt: "late_same_turn_ack" },
      },
    ] as const;
    const itemIds: string[] = [];
    for (const [index, unsafe] of unsafeCases.entries()) {
      const actionId = randomUUID();
      const itemId = randomUUID();
      itemIds.push(itemId);
      await db.insert(chatControlActions).values({
        id: actionId,
        orgId,
        expectedGenerationId: generationId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 0,
        actionKind: "steer",
        localDisposition: "failed_actionable",
        providerDisposition: "not_sent",
        providerEvidence: unsafe.actionProviderEvidence,
      });
      await db.insert(chatQueuedMessages).values({
        id: itemId,
        orgId,
        conversationId,
        position: index + 1,
        status: "failed_actionable",
        deliveryIntent: "steer",
        deliveryDisposition: unsafe.deliveryDisposition,
        controlActionId: actionId,
        expectedGenerationId: generationId,
        clientMutationId: `active-acknowledgement-fence-${unsafe.suffix}`,
        payload: { body: `Do not retry ${unsafe.suffix}` },
        requestActor: boardQueueRequestActor(orgId),
        steeredAt: unsafe.steeredAt,
        providerEvidence: unsafe.itemProviderEvidence,
      });
    }
    const steerMessages = chatSteerMessageService(db);

    for (const itemId of itemIds) {
      await expect(steerMessages.beginControlAction({
        orgId,
        conversationId,
        itemId,
        controlActionId: randomUUID(),
        expectedGenerationId: generationId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 0,
        requestActor: boardQueueRequestActor(orgId),
        actor: { actorType: "user", actorId: "board" },
      })).rejects.toMatchObject({ status: 409 });
    }

    const actions = await db.select().from(chatControlActions).where(eq(chatControlActions.orgId, orgId));
    const messages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    const [generation] = await db.select().from(chatGenerations).where(eq(chatGenerations.id, generationId));
    expect(actions).toHaveLength(unsafeCases.length);
    expect(messages).toHaveLength(0);
    expect(generation?.controlVersion).toBe(0);
  });

  it("keeps cancelled Queue tombstones hidden and rejects every Steer path", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const nativeItemId = randomUUID();
    const continuationItemId = randomUUID();
    const cancelledAt = new Date("2026-07-20T09:52:46.951Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Cancelled Queue Steer Fence Org",
      urlKey: deriveOrganizationUrlKey("Messenger Cancelled Queue Steer Fence Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Cancelled Queue Steer fence chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
      attemptEpoch: 1,
      controlVersion: 0,
      controlState: "ready",
    });
    await db.insert(chatQueuedMessages).values([
      {
        id: nativeItemId,
        orgId,
        conversationId,
        position: 1,
        status: "queued",
        clientMutationId: "cancelled-native-steer-regression",
        expectedGenerationId: generationId,
        payload: { body: "Cancelled native Steer must never become visible" },
        requestActor: boardQueueRequestActor(orgId),
        cancelledAt,
      },
      {
        id: continuationItemId,
        orgId,
        conversationId,
        position: 2,
        status: "queued",
        clientMutationId: "cancelled-continuation-steer-regression",
        payload: { body: "Cancelled continuation Steer must never become visible" },
        requestActor: boardQueueRequestActor(orgId),
        cancelledAt,
      },
    ]);

    expect(await chatSvc.listQueuedMessages(conversationId)).toEqual([]);

    const steerMessages = chatSteerMessageService(db);
    await expect(steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId: nativeItemId,
      controlActionId: randomUUID(),
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    })).rejects.toMatchObject({ status: 409 });
    await expect(steerMessages.scheduleContinuation({
      orgId,
      conversationId,
      itemId: continuationItemId,
      controlActionId: randomUUID(),
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    })).rejects.toMatchObject({ status: 409 });

    expect(await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId))).toEqual([]);
    expect(await db.select().from(chatControlActions).where(eq(chatControlActions.orgId, orgId))).toEqual([]);
  });

  it("atomically reuses one action and user message for concurrent continuation Steer requests", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const firstActionId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Concurrent Steer Org",
      urlKey: deriveOrganizationUrlKey("Messenger Concurrent Steer Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Concurrent Steer chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "concurrent-continuation-steer",
      payload: { body: "Persist this concurrent Steer once" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const steerMessages = chatSteerMessageService(db);
    const invoke = (controlActionId: string) => steerMessages.scheduleContinuation({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user" as const, actorId: "board" },
    });
    const [first, sameId, differentId] = await Promise.all([
      invoke(firstActionId),
      invoke(firstActionId),
      invoke(randomUUID()),
    ]);
    const messages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    const actions = await db.select().from(chatControlActions).where(eq(chatControlActions.orgId, orgId));

    expect(new Set([first.action.id, sameId.action.id, differentId.action.id])).toHaveProperty("size", 1);
    expect(actions[0]?.id).toBe(first.action.id);
    expect(messages).toHaveLength(1);
    expect(actions).toHaveLength(1);
    expect(first.item.sourceMessageId).toBe(messages[0]?.id);
    expect(sameId.item.sourceMessageId).toBe(messages[0]?.id);
    expect(differentId.item.sourceMessageId).toBe(messages[0]?.id);
  });

  it("atomically schedules Steer as a continuation when Stop terminalizes first", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const controlActionId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Stop Steer Race Org",
      urlKey: deriveOrganizationUrlKey("Messenger Stop Steer Race Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Stop Steer race chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "stop-steer-race",
      expectedGenerationId: generationId,
      payload: { body: "Continue with this feedback after Stop" },
      requestActor: boardQueueRequestActor(orgId),
    });
    await chatSvc.markGenerationTerminal(generationId, "stopped");

    const scheduled = await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    });
    const retried = await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    });

    expect(scheduled).toMatchObject({
      idempotent: false,
      action: { localDisposition: "continuation_pending", providerDisposition: "not_sent" },
      item: { status: "continuation_pending", deliveryIntent: "steer" },
    });
    expect(retried).toMatchObject({
      idempotent: true,
      action: { id: controlActionId, localDisposition: "continuation_pending" },
      item: { id: queued.id, status: "continuation_pending" },
    });
    expect(retried.item.version).toBe(scheduled.item.version);

    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "continuation-worker-test",
      leaseMs: 30_000,
    });
    expect(claim).toMatchObject({
      item: {
        id: queued.id,
        status: "running_next",
        deliveryDisposition: "running_next",
      },
    });
    expect(claim?.generationId).toBeTruthy();
    expect(claim?.userMessageId).toBeTruthy();
    expect(await chatSvc.renewServerQueuedMessageClaim({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
      leaseMs: 30_000,
    })).toBe(true);
    const lateReceipt = await chatSvc.resolveSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      status: "accepted_current",
      disposition: "accepted_current",
      providerDisposition: "acknowledged",
      providerEvidence: { receipt: "late_same_turn_ack" },
    });
    expect(lateReceipt).toMatchObject({ applied: false, item: { status: "running_next" } });
    const completed = await chatSvc.completeServerQueuedMessageDelivery({
      itemId: claim!.item.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
      status: "completed",
    });
    expect(completed).toMatchObject({
      id: queued.id,
      status: "delivered",
      deliveryDisposition: "delivered",
    });
    expect(await chatSvc.listQueuedMessages(conversationId)).toEqual([]);
  });

  it("reuses the bound Steer action when another tab submits a new action id", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const firstControlActionId = randomUUID();
    const competingControlActionId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Steer Idempotency Org",
      urlKey: deriveOrganizationUrlKey("Messenger Steer Idempotency Org"),
      issuePrefix: `I${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Steer action idempotency chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "running",
      attemptEpoch: 1,
      controlVersion: 0,
      controlState: "ready",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "competing-steer-actions",
      expectedGenerationId: generationId,
      payload: { body: "Apply this feedback once" },
      requestActor: boardQueueRequestActor(orgId),
    });

    const first = await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId: firstControlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    });
    const competing = await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId: competingControlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    });

    expect(first).toMatchObject({
      idempotent: false,
      action: { id: firstControlActionId, localDisposition: "pending" },
      item: { status: "steer_pending", controlActionId: firstControlActionId },
    });
    expect(competing).toMatchObject({
      idempotent: true,
      action: { id: firstControlActionId, localDisposition: "pending" },
      item: { status: "steer_pending", controlActionId: firstControlActionId },
    });
    const actions = await db.select().from(chatControlActions);
    expect(actions.map((action) => action.id)).toEqual([firstControlActionId]);
    const [generation] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, generationId));
    expect(generation?.controlVersion).toBe(1);
  });

  it("moves pending Steer feedback to continuation when an unregistered attempt completes", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const controlActionId = randomUUID();
    const ownerToken = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Pending Steer Reconciliation Org",
      urlKey: deriveOrganizationUrlKey("Messenger Pending Steer Reconciliation Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Pending Steer reconciliation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
    });
    await chatSvc.beginGenerationControlAttempt({
      orgId,
      conversationId,
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "pending-steer-attempt-complete",
      expectedGenerationId: generationId,
      payload: { body: "Run this in a continuation if no handle registers" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const steerMessages = chatSteerMessageService(db);
    await steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });

    await chatSvc.markGenerationControlAttemptCompleted({
      generationId,
      attemptEpoch: 1,
      ownerToken,
    });

    const [storedQueueItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, queued.id));
    const [storedAction] = await db
      .select()
      .from(chatControlActions)
      .where(eq(chatControlActions.id, controlActionId));
    expect(storedQueueItem).toMatchObject({
      status: "continuation_pending",
      deliveryDisposition: "continuation_pending",
      reconciliationReason: "runtime_attempt_completed_without_steer_acceptance",
    });
    expect(storedAction).toMatchObject({
      localDisposition: "continuation_pending",
      providerDisposition: "not_sent",
      lastError: "runtime_attempt_completed_without_steer_acceptance",
    });
    const projectedMessages = await chatSvc.listMessages(conversationId, { includeTranscript: false });
    expect(projectedMessages.find((message) => message.body === queued.payload.body)?.structuredPayload)
      .toMatchObject({ source: "steer", deliveryDisposition: "continuation_pending" });
  });

  it("denies provider send when the owner lease expires or Stop wins the database fence", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const steerActionId = randomUUID();
    const expiredLeaseActionId = randomUUID();
    const ownerToken = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Stop First Provider Fence Org",
      urlKey: deriveOrganizationUrlKey("Messenger Stop First Provider Fence Org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Stop first provider fence chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
    });
    await chatSvc.beginGenerationControlAttempt({
      orgId,
      conversationId,
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
    });
    await chatSvc.markGenerationControlReady({
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
      providerThreadId: "thread-stop-first",
      providerTurnId: "turn-stop-first",
    });
    const visibleBody = "Visible before Stop";
    const visible = await chatSvc.generationProtocol.appendGenerationEvent({
      orgId,
      conversationId,
      generationId,
      attemptEpoch: 1,
      expectedOwnerToken: ownerToken,
      admission: "visible",
      eventKind: "assistant_delta",
      payload: { delta: visibleBody },
      bodyHash: hashChatGenerationBody(visibleBody),
    });
    const expiredLeaseFeedback = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "expired-lease-provider-fence",
      expectedGenerationId: generationId,
      payload: { body: "Do not send through an expired owner lease" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const steerMessages = chatSteerMessageService(db);
    await steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId: expiredLeaseFeedback.id,
      controlActionId: expiredLeaseActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });
    await db
      .update(chatGenerations)
      .set({ controlLeaseExpiresAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(chatGenerations.id, generationId));
    await expect(chatSvc.claimSteerProviderSend({
      orgId,
      controlActionId: expiredLeaseActionId,
    })).resolves.toMatchObject({
      sendDenied: true,
      reason: "generation_fence_changed_before_provider_send",
      action: { localDisposition: "continuation_pending", providerDisposition: "not_sent" },
      item: { status: "continuation_pending", deliveryDisposition: "continuation_pending" },
    });
    await chatSvc.markGenerationControlReady({
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
      providerThreadId: "thread-stop-first",
      providerTurnId: "turn-stop-first",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "stop-first-provider-fence",
      expectedGenerationId: generationId,
      payload: { body: "Apply this only after the stopped run" },
      requestActor: boardQueueRequestActor(orgId),
    });
    await steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId: steerActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 1,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });
    await chatSvc.generationProtocol.beginStopAction({
      orgId,
      conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 2,
      requestedRenderSeq: visible.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody(visibleBody),
    });

    const denied = await chatSvc.claimSteerProviderSend({ orgId, controlActionId: steerActionId });
    expect(denied).toMatchObject({
      sendDenied: true,
      reason: "stop_cutoff_won_before_provider_send",
      action: {
        localDisposition: "continuation_pending",
        providerDisposition: "not_sent",
      },
      item: {
        status: "continuation_pending",
        deliveryDisposition: "continuation_pending",
      },
    });

    const [generation] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, generationId));
    expect(generation).toMatchObject({
      status: "stop_requested",
      controlVersion: 3,
    });
    const projectedMessages = await chatSvc.listMessages(conversationId, { includeTranscript: false });
    expect(projectedMessages.find((message) => message.body === queued.payload.body)?.structuredPayload)
      .toMatchObject({ source: "steer", deliveryDisposition: "continuation_pending" });
  });

  it("never re-embeds a released fallback continuation into its old native transcript", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const oldGenerationId = randomUUID();
    const controlActionId = randomUUID();
    const ownerToken = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Released Continuation Projection Org",
      urlKey: deriveOrganizationUrlKey("Messenger Released Continuation Projection Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Released fallback continuation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: oldGenerationId,
      orgId,
      conversationId,
      status: "active",
    });
    await chatSvc.beginGenerationControlAttempt({
      orgId,
      conversationId,
      generationId: oldGenerationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
    });
    await chatSvc.markGenerationControlReady({
      generationId: oldGenerationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
      providerThreadId: "thread-released-continuation",
      providerTurnId: "turn-released-continuation",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "released-fallback-continuation",
      expectedGenerationId: oldGenerationId,
      payload: { body: "Keep this outside the old transcript" },
      requestActor: boardQueueRequestActor(orgId),
    });
    const steerMessages = chatSteerMessageService(db);
    await steerMessages.beginControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: oldGenerationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
      requestActor: boardQueueRequestActor(orgId),
      actor: { actorType: "user", actorId: "board" },
    });
    await db
      .update(chatGenerations)
      .set({ status: "stop_requested", stopRequestedAt: new Date() })
      .where(eq(chatGenerations.id, oldGenerationId));
    await expect(chatSvc.claimSteerProviderSend({ orgId, controlActionId })).resolves.toMatchObject({
      sendDenied: true,
      item: { status: "continuation_pending" },
    });
    await chatSvc.markGenerationTerminal(oldGenerationId, "stopped");

    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "released-continuation-worker",
      leaseMs: 30_000,
    });
    expect(claim?.item).toMatchObject({ id: queued.id, status: "running_next" });
    await chatSvc.beginGenerationControlAttempt({
      orgId,
      conversationId,
      generationId: claim!.generationId,
      attemptEpoch: 1,
      ownerToken: claim!.leaseToken,
      runtimeType: "codex_local",
    });
    const released = await chatSvc.releaseServerQueuedMessageClaim({
      itemId: queued.id,
      generationId: claim!.generationId,
      leaseToken: claim!.leaseToken,
      leaseEpoch: claim!.leaseEpoch,
      reason: "continuation_runtime_connection_lost",
    });
    expect(released).toMatchObject({
      status: "acceptance_unknown",
      deliveryDisposition: "acceptance_unknown",
      continuationGenerationId: null,
      dequeuedAt: expect.any(Date),
    });

    const projectedMessages = await chatSvc.listMessages(conversationId, { includeTranscript: false });
    expect(projectedMessages.find((message) => message.body === queued.payload.body)?.structuredPayload)
      .toMatchObject({ source: "steer", deliveryDisposition: "continuation_pending" });
  });

  it("preserves a sent Steer as acceptance unknown until a late provider ACK arrives", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const controlActionId = randomUUID();
    const ownerToken = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Late Steer ACK Org",
      urlKey: deriveOrganizationUrlKey("Messenger Late Steer ACK Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Late Steer ACK chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
    });
    await chatSvc.beginGenerationControlAttempt({
      orgId,
      conversationId,
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
    });
    await chatSvc.markGenerationControlReady({
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
      providerThreadId: "thread-late",
      providerTurnId: "turn-late",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "late-steer-ack",
      expectedGenerationId: generationId,
      payload: { body: "Apply this feedback to the active turn" },
      requestActor: boardQueueRequestActor(orgId),
    });
    await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    });
    await expect(chatSvc.claimSteerProviderSend({ orgId, controlActionId })).resolves.toMatchObject({
      providerDisposition: "sent",
    });

    await chatSvc.markGenerationControlAttemptCompleted({
      generationId,
      attemptEpoch: 1,
      ownerToken,
    });

    const [unknownItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, queued.id));
    const [unknownAction] = await db
      .select()
      .from(chatControlActions)
      .where(eq(chatControlActions.id, controlActionId));
    expect(unknownItem).toMatchObject({
      status: "acceptance_unknown",
      deliveryDisposition: "acceptance_unknown",
    });
    expect(unknownAction).toMatchObject({
      localDisposition: "acceptance_unknown",
      providerDisposition: "unverified",
    });

    const lateAcknowledgement = await chatSvc.resolveSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      status: "accepted_current",
      disposition: "accepted_current",
      providerDisposition: "acknowledged",
      providerThreadId: "thread-late",
      providerTurnId: "turn-late",
      providerEvidence: { receipt: "same_turn", late: true },
    });

    expect(lateAcknowledgement).toMatchObject({
      applied: true,
      item: {
        status: "accepted_current",
        deliveryDisposition: "accepted_current",
        providerThreadId: "thread-late",
        providerTurnId: "turn-late",
      },
      action: {
        localDisposition: "accepted_current",
        providerDisposition: "acknowledged",
      },
    });
    expect((await chatSvc.listQueuedMessages(conversationId))).toHaveLength(0);
  });

  it("releases a provider send claim that lost runtime ownership before provider I/O", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const controlActionId = randomUUID();
    const ownerToken = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Steer Claim Release Org",
      urlKey: deriveOrganizationUrlKey("Messenger Steer Claim Release Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Steer claim release chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
    });
    await chatSvc.beginGenerationControlAttempt({
      orgId,
      conversationId,
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
    });
    await chatSvc.markGenerationControlReady({
      generationId,
      attemptEpoch: 1,
      ownerToken,
      runtimeType: "codex_local",
      providerThreadId: "thread-release",
      providerTurnId: "turn-release",
    });
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: "release-steer-send-claim",
      expectedGenerationId: generationId,
      payload: { body: "Do not send this to the stale attempt" },
      requestActor: boardQueueRequestActor(orgId),
    });
    await chatSvc.beginSteerControlAction({
      orgId,
      conversationId,
      itemId: queued.id,
      controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    });
    await chatSvc.claimSteerProviderSend({ orgId, controlActionId });

    await expect(chatSvc.releaseSteerProviderSendClaim({
      orgId,
      controlActionId,
      reason: "runtime_owner_changed_before_provider_send",
    })).resolves.toMatchObject({
      localDisposition: "pending",
      providerDisposition: "not_sent",
      providerSentAt: null,
    });

    const [storedItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, queued.id));
    expect(storedItem).toMatchObject({
      status: "steer_pending",
      deliveryDisposition: "pending",
      reconciliationReason: "runtime_owner_changed_before_provider_send",
    });
  });

  it("claims eligible queue work beyond more than twenty-five active conversation heads", async () => {
    const orgId = randomUUID();
    const blockedConversationIds = Array.from({ length: 26 }, () => randomUUID());
    const actorlessConversationId = "00000000-0000-0000-0000-000000000201";
    const eligibleConversationId = "00000000-0000-0000-0000-000000000202";
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Queue Fairness Org",
      urlKey: deriveOrganizationUrlKey("Messenger Queue Fairness Org"),
      issuePrefix: `Q${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values(
      [...blockedConversationIds, actorlessConversationId, eligibleConversationId].map((conversationId, index) => ({
        id: conversationId,
        orgId,
        title: `Queue fairness ${index}`,
        issueCreationMode: "manual_approval" as const,
        planMode: false,
      })),
    );
    await db.insert(chatGenerations).values(blockedConversationIds.map((conversationId) => ({
      id: randomUUID(),
      orgId,
      conversationId,
      status: "running" as const,
    })));
    const blockedItems = blockedConversationIds.map((conversationId, index) => ({
      id: randomUUID(),
      orgId,
      conversationId,
      position: 1,
      status: "queued" as const,
      clientMutationId: `blocked-${index}`,
      payload: { body: `Blocked ${index}` },
      requestActor: boardQueueRequestActor(orgId),
    }));
    const actorlessItemId = "00000000-0000-0000-0000-000000000203";
    const eligibleItemId = "00000000-0000-0000-0000-000000000204";
    await db.insert(chatQueuedMessages).values([
      ...blockedItems,
      {
        id: actorlessItemId,
        orgId,
        conversationId: actorlessConversationId,
        position: 1,
        status: "queued" as const,
        clientMutationId: "actorless-before-eligible",
        payload: { body: "Must not be claimed without authorization evidence" },
      },
      {
        id: eligibleItemId,
        orgId,
        conversationId: eligibleConversationId,
        position: 1,
        status: "queued" as const,
        clientMutationId: "eligible-after-blocked-heads",
        payload: { body: "Eligible work" },
        requestActor: boardQueueRequestActor(orgId),
      },
    ]);

    const [actorlessBeforeClaim] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, actorlessItemId));
    expect(actorlessBeforeClaim).toMatchObject({ status: "queued", requestActor: null });

    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "fairness-worker",
      leaseMs: 30_000,
    });

    expect(claim?.item).toMatchObject({ id: eligibleItemId, conversationId: eligibleConversationId });
    const [actorlessItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, actorlessItemId));
    expect(actorlessItem).toMatchObject({ status: "queued", requestActor: null });
  });

  it("skips durably cancelled queue rows even if their status regresses to queued", async () => {
    const orgId = randomUUID();
    const cancelledConversationId = randomUUID();
    const eligibleConversationId = randomUUID();
    const cancelledItemId = randomUUID();
    const eligibleItemId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Cancel Fence Org",
      urlKey: deriveOrganizationUrlKey("Messenger Cancel Fence Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values([
      {
        id: cancelledConversationId,
        orgId,
        title: "Cancelled queue regression chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: eligibleConversationId,
        orgId,
        title: "Eligible queue chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    await db.insert(chatQueuedMessages).values([
      {
        id: cancelledItemId,
        orgId,
        conversationId: cancelledConversationId,
        position: 1,
        status: "queued",
        clientMutationId: "cancelled-status-regression",
        payload: { body: "This cancelled follow-up must never run" },
        requestActor: boardQueueRequestActor(orgId),
        cancelledAt: new Date("2026-07-20T09:52:46.951Z"),
      },
      {
        id: eligibleItemId,
        orgId,
        conversationId: eligibleConversationId,
        position: 2,
        status: "queued",
        clientMutationId: "eligible-after-cancelled-row",
        payload: { body: "This follow-up remains eligible" },
        requestActor: boardQueueRequestActor(orgId),
      },
    ]);

    const claim = await chatSvc.claimNextServerQueuedMessage({
      workerId: "cancel-fence-worker",
      leaseMs: 30_000,
    });

    expect(claim?.item.id).toBe(eligibleItemId);
    const [cancelledItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, cancelledItemId));
    expect(cancelledItem).toMatchObject({
      status: "queued",
      cancelledAt: new Date("2026-07-20T09:52:46.951Z"),
      deliveryAttempts: 0,
      continuationGenerationId: null,
    });
  });

  it("keeps durable cancellation terminal when a stale server claim is released", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const itemId = randomUUID();
    const leaseToken = randomUUID();
    const cancelledAt = new Date("2026-07-20T09:52:46.951Z");
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Cancelled Claim Release Org",
      urlKey: deriveOrganizationUrlKey("Messenger Cancelled Claim Release Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Cancelled server claim chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
      attemptEpoch: 0,
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "dequeue_claimed",
      clientMutationId: "cancelled-stale-server-claim",
      payload: { body: "This cancelled claim must not be requeued" },
      requestActor: boardQueueRequestActor(orgId),
      continuationGenerationId: generationId,
      deliveryLeaseToken: leaseToken,
      deliveryLeaseEpoch: 4,
      deliveryLeaseOwner: "stale-worker",
      deliveryLeaseExpiresAt: new Date(Date.now() + 30_000),
      cancelledAt,
    });

    const released = await chatSvc.releaseServerQueuedMessageClaim({
      itemId,
      generationId,
      leaseToken,
      leaseEpoch: 4,
      reason: "queued_continuation_completion_unconfirmed",
    });

    expect(released).toMatchObject({
      id: itemId,
      status: "cancelled",
      deliveryDisposition: "cancelled",
      cancelledAt,
      lastDeliveryReason: "operator_cancelled",
      deliveryLeaseToken: null,
      deliveryLeaseOwner: null,
      deliveryLeaseExpiresAt: null,
    });
  });

  it.each(["completed", "stopped"] as const)(
    "does not overwrite a %s generation when releasing its server queue claim",
    async (terminalStatus) => {
      const orgId = randomUUID();
      const conversationId = randomUUID();
      const generationId = randomUUID();
      const itemId = randomUUID();
      const leaseToken = randomUUID();
      const runtimeTerminalAt = new Date("2026-07-21T01:00:00.000Z");
      const completedAt = new Date("2026-07-21T01:00:01.000Z");
      const terminalReason = terminalStatus === "completed" ? "runtime_completed" : "operator_stop";

      await db.insert(organizations).values({
        id: orgId,
        name: `Messenger ${terminalStatus} Generation Fence Org`,
        urlKey: deriveOrganizationUrlKey(`Messenger ${terminalStatus} Generation Fence Org`),
        issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(chatConversations).values({
        id: conversationId,
        orgId,
        title: `${terminalStatus} generation release fence chat`,
        issueCreationMode: "manual_approval",
        planMode: false,
      });
      await db.insert(chatGenerations).values({
        id: generationId,
        orgId,
        conversationId,
        status: "active",
        attemptEpoch: 1,
      });
      await db.insert(chatQueuedMessages).values({
        id: itemId,
        orgId,
        conversationId,
        position: 1,
        status: "dequeue_claimed",
        clientMutationId: `terminal-generation-release-fence-${terminalStatus}`,
        payload: { body: "Release this claim without changing runtime evidence" },
        requestActor: boardQueueRequestActor(orgId),
        continuationGenerationId: generationId,
        deliveryLeaseToken: leaseToken,
        deliveryLeaseEpoch: 3,
        deliveryLeaseOwner: "release-fence-worker",
        deliveryLeaseExpiresAt: new Date(Date.now() + 30_000),
      });

      let allowTerminalCommit!: () => void;
      const terminalCommitBarrier = new Promise<void>((resolve) => {
        allowTerminalCommit = resolve;
      });
      let terminalWriteReady!: () => void;
      const terminalWriteStarted = new Promise<void>((resolve) => {
        terminalWriteReady = resolve;
      });
      const terminalWrite = db.transaction(async (tx) => {
        await tx
          .update(chatGenerations)
          .set({
            status: terminalStatus,
            terminalReason,
            controlState: "terminal",
            runtimeTerminalAt,
            completedAt,
          })
          .where(eq(chatGenerations.id, generationId));
        terminalWriteReady();
        await terminalCommitBarrier;
      });
      await terminalWriteStarted;

      const release = chatSvc.releaseServerQueuedMessageClaim({
        itemId,
        generationId,
        leaseToken,
        leaseEpoch: 3,
        reason: "queued_continuation_completion_unconfirmed",
      });
      while (true) {
        const lockWaiters = await db.execute(sql<{ waiting: boolean }>`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%update "chat_generations"%'
          ) as waiting
        `);
        if (lockWaiters[0]?.waiting) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      allowTerminalCommit();
      await terminalWrite;
      const released = await release;

      expect(released).toMatchObject({
        id: itemId,
        status: "failed_actionable",
        deliveryDisposition: "failed_actionable",
        continuationGenerationId: null,
        deliveryLeaseToken: null,
        deliveryLeaseOwner: null,
        deliveryLeaseExpiresAt: null,
        lastDeliveryReason: "queued_continuation_completion_unconfirmed",
      });
      const [generation] = await db
        .select()
        .from(chatGenerations)
        .where(eq(chatGenerations.id, generationId));
      expect(generation).toMatchObject({
        status: terminalStatus,
        terminalReason,
        controlState: "terminal",
        runtimeTerminalAt,
        completedAt,
      });
    },
  );

  it("still aborts a nonterminal generation when releasing its server queue claim", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const itemId = randomUUID();
    const leaseToken = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Active Generation Release Org",
      urlKey: deriveOrganizationUrlKey("Messenger Active Generation Release Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Active generation release chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
      attemptEpoch: 0,
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "dequeue_claimed",
      clientMutationId: "active-generation-release",
      payload: { body: "Requeue this unstarted continuation" },
      requestActor: boardQueueRequestActor(orgId),
      continuationGenerationId: generationId,
      deliveryLeaseToken: leaseToken,
      deliveryLeaseEpoch: 2,
      deliveryLeaseOwner: "active-release-worker",
      deliveryLeaseExpiresAt: new Date(Date.now() + 30_000),
    });

    const released = await chatSvc.releaseServerQueuedMessageClaim({
      itemId,
      generationId,
      leaseToken,
      leaseEpoch: 2,
      reason: "server_continuation_lease_expired",
    });

    expect(released).toMatchObject({
      id: itemId,
      status: "queued",
      deliveryDisposition: null,
      continuationGenerationId: null,
      deliveryLeaseToken: null,
      lastDeliveryReason: "server_continuation_lease_expired",
    });
    const [generation] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, generationId));
    expect(generation).toMatchObject({
      status: "aborted",
      terminalReason: "server_continuation_lease_expired",
      controlState: "terminal",
    });
    expect(generation?.runtimeTerminalAt).not.toBeNull();
    expect(generation?.completedAt).not.toBeNull();
  });

  it("does not abort a generation when a stale release loses the queue-item CAS", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const itemId = randomUUID();
    const leaseToken = randomUUID();
    const triggerSuffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const functionName = `rudder_test_delay_completion_${triggerSuffix}`;
    const triggerName = `rudder_test_delay_completion_trigger_${triggerSuffix}`;

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Queue CAS Org",
      urlKey: deriveOrganizationUrlKey("Messenger Queue CAS Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Queue completion and release race chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
      attemptEpoch: 0,
    });
    await db.insert(chatQueuedMessages).values({
      id: itemId,
      orgId,
      conversationId,
      position: 1,
      status: "dequeue_claimed",
      clientMutationId: "queue-completion-release-race",
      payload: { body: "Complete this continuation once" },
      requestActor: boardQueueRequestActor(orgId),
      continuationGenerationId: generationId,
      deliveryLeaseToken: leaseToken,
      deliveryLeaseEpoch: 1,
      deliveryLeaseOwner: "completion-worker",
      deliveryLeaseExpiresAt: new Date(Date.now() + 30_000),
    });

    await db.execute(sql.raw(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.status = 'completed' then
          perform pg_sleep(0.5);
        end if;
        return new;
      end;
      $$
    `));
    await db.execute(sql.raw(`
      create trigger ${triggerName}
      before update on chat_queued_messages
      for each row execute function ${functionName}()
    `));

    try {
      const completion = chatSvc.completeServerQueuedMessageDelivery({
        itemId,
        generationId,
        leaseToken,
        leaseEpoch: 1,
        status: "completed",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const release = chatSvc.releaseServerQueuedMessageClaim({
        itemId,
        generationId,
        leaseToken,
        leaseEpoch: 1,
        reason: "server_continuation_lease_expired",
      });
      const [completed, released] = await Promise.all([completion, release]);

      expect(completed).toMatchObject({ id: itemId, status: "completed" });
      expect(released).toBeNull();
      const [generation] = await db
        .select()
        .from(chatGenerations)
        .where(eq(chatGenerations.id, generationId));
      expect(generation).toMatchObject({
        status: "active",
        terminalReason: null,
        completedAt: null,
      });
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${triggerName} on chat_queued_messages`));
      await db.execute(sql.raw(`drop function if exists ${functionName}()`));
    }
  });

  it("keeps durable cancellation terminal when legacy claim recovery scans it", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const cancelledItemId = randomUUID();
    const eligibleItemId = randomUUID();
    const cancelledAt = new Date("2026-07-20T09:52:46.951Z");
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Legacy Cancel Fence Org",
      urlKey: deriveOrganizationUrlKey("Messenger Legacy Cancel Fence Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Legacy cancelled claim recovery chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatQueuedMessages).values([
      {
        id: cancelledItemId,
        orgId,
        conversationId,
        position: 1,
        status: "dequeue_claimed",
        clientMutationId: "legacy-cancelled-stale-claim",
        payload: { body: "This cancelled legacy claim must never run" },
        requestActor: boardQueueRequestActor(orgId),
        cancelledAt,
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        id: eligibleItemId,
        orgId,
        conversationId,
        position: 2,
        status: "queued",
        clientMutationId: "legacy-eligible-after-cancelled-claim",
        payload: { body: "This legacy follow-up remains eligible" },
        requestActor: boardQueueRequestActor(orgId),
      },
    ]);

    const claimed = await chatSvc.claimNextQueuedMessage(conversationId);

    expect(claimed?.id).toBe(eligibleItemId);
    const [cancelledItem] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, cancelledItemId));
    expect(cancelledItem).toMatchObject({
      status: "cancelled",
      deliveryDisposition: "cancelled",
      cancelledAt,
      lastDeliveryReason: "operator_cancelled",
      deliveryAttempts: 0,
    });
  });

  it("leaves stale server claims to server recovery when the legacy queue scans", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const serverItemId = randomUUID();
    const eligibleItemId = randomUUID();
    const leaseToken = randomUUID();
    const cancelledAt = new Date("2026-07-20T09:52:46.951Z");
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Server Claim Ownership Org",
      urlKey: deriveOrganizationUrlKey("Messenger Server Claim Ownership Org"),
      issuePrefix: `O${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Server claim recovery ownership chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "active",
      attemptEpoch: 0,
    });
    await db.insert(chatQueuedMessages).values([
      {
        id: serverItemId,
        orgId,
        conversationId,
        position: 1,
        status: "dequeue_claimed",
        clientMutationId: "cancelled-stale-server-claim-for-recovery",
        payload: { body: "Only server recovery may close this claim" },
        requestActor: boardQueueRequestActor(orgId),
        continuationGenerationId: generationId,
        deliveryLeaseToken: leaseToken,
        deliveryLeaseEpoch: 2,
        deliveryLeaseOwner: "expired-server-worker",
        deliveryLeaseExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
        cancelledAt,
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        id: eligibleItemId,
        orgId,
        conversationId,
        position: 2,
        status: "queued",
        clientMutationId: "legacy-eligible-beside-server-claim",
        payload: { body: "This legacy follow-up remains eligible" },
        requestActor: boardQueueRequestActor(orgId),
      },
    ]);

    const claimed = await chatSvc.claimNextQueuedMessage(conversationId);

    expect(claimed?.id).toBe(eligibleItemId);
    const [beforeServerRecovery] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, serverItemId));
    expect(beforeServerRecovery).toMatchObject({
      status: "dequeue_claimed",
      continuationGenerationId: generationId,
      deliveryLeaseToken: leaseToken,
      cancelledAt,
    });

    const recovered = await chatSvc.recoverExpiredServerQueueClaims();

    expect(recovered).toEqual({ inspected: 1, requeued: 0, ambiguous: 1 });
    const [afterServerRecovery] = await db
      .select()
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.id, serverItemId));
    expect(afterServerRecovery).toMatchObject({
      status: "cancelled",
      deliveryDisposition: "cancelled",
      continuationGenerationId: null,
      deliveryLeaseToken: null,
      lastDeliveryReason: "operator_cancelled",
    });
    const [generation] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, generationId));
    expect(generation).toMatchObject({
      status: "aborted",
      terminalReason: "operator_cancelled",
      controlState: "terminal",
    });
  });

  it("paginates Messenger thread summaries with stable cursors", async () => {
    const orgId = randomUUID();
    const userId = "board-user-thread-pagination";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Thread Pagination Org",
      urlKey: deriveOrganizationUrlKey("Messenger Thread Pagination Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const baseTime = Date.parse("2026-05-01T12:00:00.000Z");
    const conversationIds = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(chatConversations).values(
      conversationIds.map((conversationId, index) => {
        const activityAt = new Date(baseTime - index * 60_000);
        return {
          id: conversationId,
          orgId,
          title: `Pagination chat ${index + 1}`,
          summary: `Summary ${index + 1}`,
          issueCreationMode: "manual_approval" as const,
          planMode: false,
          createdByUserId: userId,
          lastMessageAt: activityAt,
          createdAt: activityAt,
          updatedAt: activityAt,
        };
      }),
    );

    const firstPage = await messengerSvc.listThreadSummaryPage(orgId, userId, { limit: 3 });
    const secondPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 3,
      cursor: firstPage.pageInfo.nextCursor,
    });

    expect(firstPage.items.map((item) => item.threadKey)).toEqual([
      `chat:${conversationIds[0]}`,
      `chat:${conversationIds[1]}`,
      `chat:${conversationIds[2]}`,
    ]);
    expect(firstPage.pageInfo).toMatchObject({ limit: 3, hasMore: true });
    expect(firstPage.pageInfo.nextCursor).toEqual(expect.any(String));
    expect(secondPage.items.map((item) => item.threadKey)).toEqual([
      `chat:${conversationIds[3]}`,
      `chat:${conversationIds[4]}`,
      `chat:${conversationIds[5]}`,
    ]);
    expect(secondPage.pageInfo).toEqual({ limit: 3, nextCursor: null, hasMore: false });
  });

  it("keeps latest-activity pagination stable across unread and processing chats", async () => {
    const orgId = randomUUID();
    const userId = "board-user-attention-pagination";
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Attention Pagination Org",
      urlKey: deriveOrganizationUrlKey("Messenger Attention Pagination Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const baseTime = Date.parse("2026-05-01T12:00:00.000Z");
    const conversationIds = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(chatConversations).values(
      conversationIds.map((conversationId, index) => {
        const activityAt = new Date(baseTime - index * 60_000);
        return {
          id: conversationId,
          orgId,
          title: `Attention pagination chat ${index + 1}`,
          summary: `Summary ${index + 1}`,
          issueCreationMode: "manual_approval" as const,
          planMode: false,
          createdByUserId: userId,
          lastMessageAt: activityAt,
          createdAt: activityAt,
          updatedAt: activityAt,
        };
      }),
    );
    await db.insert(chatConversationUserStates).values(
      conversationIds.map((conversationId, index) => ({
        orgId,
        conversationId,
        userId,
        lastReadAt: new Date(baseTime - index * 60_000),
      })),
    );
    const unreadConversationId = conversationIds[5]!;
    const processingConversationId = conversationIds[4]!;
    const unreadMessageAt = new Date(baseTime - 5 * 60_000 + 1_000);
    await db.insert(chatMessages).values({
      orgId,
      conversationId: unreadConversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Older activity still needs attention.",
      createdAt: unreadMessageAt,
      updatedAt: unreadMessageAt,
    });
    const generationId = randomUUID();
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId: processingConversationId,
      status: "running",
      startedAt: new Date(baseTime - 4 * 60_000),
    });

    const firstPage = await messengerSvc.listThreadSummaryPage(orgId, userId, { limit: 3 });
    const secondPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 3,
      cursor: firstPage.pageInfo.nextCursor,
    });

    expect(firstPage.items.map((item) => item.threadKey)).toEqual([
      `chat:${conversationIds[0]}`,
      `chat:${conversationIds[1]}`,
      `chat:${conversationIds[2]}`,
    ]);
    expect(secondPage.items[1]?.metadata).toMatchObject({ activeGenerationId: generationId });
    expect(secondPage.items[2]).toMatchObject({ unreadCount: 1, needsAttention: true });
    const allThreadKeys = [...firstPage.items, ...secondPage.items].map((item) => item.threadKey);
    expect(new Set(allThreadKeys).size).toBe(6);
    expect(allThreadKeys).toEqual(conversationIds.map((id) => `chat:${id}`));
  });

  it("keeps older pinned chats in the first Messenger thread summary page", async () => {
    const orgId = randomUUID();
    const userId = "board-user-pinned-pagination";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Pinned Pagination Org",
      urlKey: deriveOrganizationUrlKey("Messenger Pinned Pagination Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const baseTime = Date.parse("2026-05-02T12:00:00.000Z");
    const conversationIds = Array.from({ length: 45 }, () => randomUUID());
    await db.insert(chatConversations).values(
      conversationIds.map((conversationId, index) => {
        const activityAt = new Date(baseTime - index * 60_000);
        return {
          id: conversationId,
          orgId,
          title: `Pinned pagination chat ${String(index + 1).padStart(2, "0")}`,
          summary: `Summary ${index + 1}`,
          issueCreationMode: "manual_approval" as const,
          planMode: false,
          createdByUserId: userId,
          lastMessageAt: activityAt,
          createdAt: activityAt,
          updatedAt: activityAt,
        };
      }),
    );
    await chatSvc.setPinned(conversationIds[44]!, orgId, userId, true);

    const firstPage = await messengerSvc.listThreadSummaryPage(orgId, userId, { limit: 40 });
    const secondPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 40,
      cursor: firstPage.pageInfo.nextCursor,
    });

    expect(firstPage.items[0]).toMatchObject({
      threadKey: `chat:${conversationIds[44]}`,
      isPinned: true,
    });
    expect(firstPage.items.map((item) => item.threadKey)).toContain(`chat:${conversationIds[44]}`);
    expect(secondPage.items.map((item) => item.threadKey)).not.toContain(`chat:${conversationIds[44]}`);
  });

  it("marks Feishu-bound chats in Messenger thread summary metadata", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const integrationId = randomUUID();
    const secretId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Feishu Source Org",
      urlKey: deriveOrganizationUrlKey("Messenger Feishu Source Org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Feishu Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(organizationSecrets).values({
      id: secretId,
      orgId,
      name: "Feishu app credentials",
      provider: "local_encrypted",
    });
    await db.insert(agentIntegrations).values({
      id: integrationId,
      orgId,
      agentId,
      provider: "feishu",
      status: "active",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: secretId,
      externalAppId: "cli_a_feishu_app",
      externalBotOpenId: "ou_bot",
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Feishu chat oc_ddb65b7a99d57",
      issueCreationMode: "manual_approval",
      planMode: false,
      preferredAgentId: agentId,
      lastMessageAt: new Date("2026-06-23T08:00:00.000Z"),
    });
    await db.insert(agentIntegrationChatBindings).values({
      orgId,
      integrationId,
      conversationId,
      externalChatId: "oc_ddb65b7a99d57",
      externalChatType: "p2p",
    });

    const page = await messengerSvc.listThreadSummaryPage(orgId, "board-user-feishu", { limit: 5 });

    expect(page.items[0]).toMatchObject({
      threadKey: `chat:${conversationId}`,
      metadata: {
        source: "agent_integration",
        provider: "feishu",
        integrationId,
        externalChatId: "oc_ddb65b7a99d57",
        externalChatType: "p2p",
      },
    });
  });

  it("hydrates custom group entries outside the current Messenger thread summary page", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-groups";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Groups Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Groups Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const baseTime = Date.parse("2026-05-04T12:00:00.000Z");
    const conversationIds = Array.from({ length: 8 }, () => randomUUID());
    await db.insert(chatConversations).values(
      conversationIds.map((conversationId, index) => {
        const activityAt = new Date(baseTime - index * 60_000);
        return {
          id: conversationId,
          orgId,
          title: `Grouped chat ${index + 1}`,
          summary: `Summary ${index + 1}`,
          issueCreationMode: "manual_approval" as const,
          planMode: false,
          createdByUserId: userId,
          lastMessageAt: activityAt,
          createdAt: activityAt,
          updatedAt: activityAt,
        };
      }),
    );

    const firstPage = await messengerSvc.listThreadSummaryPage(orgId, userId, { limit: 3 });
    expect(firstPage.items.map((item) => item.threadKey)).not.toContain(`chat:${conversationIds[7]}`);

    const group = await messengerSvc.createCustomGroup(orgId, userId, "Deep work");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, group!.id, `chat:${conversationIds[7]}`);

    const customGroups = await messengerSvc.listCustomGroups(orgId, userId);
    expect(customGroups.groups).toHaveLength(1);
    expect(customGroups.groups[0]?.entries.map((entry) => entry.thread.threadKey)).toEqual([
      `chat:${conversationIds[7]}`,
    ]);
    expect(customGroups.groups[0]?.entries[0]?.thread.title).toBe("Grouped chat 8");
  });

  it("creates custom groups pinned by default and lists them before unpinned groups", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-pins";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Group Pins Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Group Pins Org"),
      issuePrefix: `GP${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const groupableConversationIds = [randomUUID(), randomUUID()];
    await db.insert(chatConversations).values(groupableConversationIds.map((id, index) => ({
      id,
      orgId,
      title: `Pinned test chat ${index + 1}`,
      issueCreationMode: "manual_approval" as const,
      planMode: false,
      createdByUserId: userId,
    })));
    const firstGroup = await messengerSvc.createCustomGroup(orgId, userId, "Later group");
    const pinnedGroup = await messengerSvc.createCustomGroup(orgId, userId, "Pinned group");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, firstGroup.id, `chat:${groupableConversationIds[0]}`);
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, pinnedGroup.id, `chat:${groupableConversationIds[1]}`);

    const updated = await messengerSvc.updateCustomGroup(orgId, userId, firstGroup!.id, { pinned: false });
    const customGroups = await messengerSvc.listCustomGroups(orgId, userId);

    expect(firstGroup?.pinnedAt).toBeInstanceOf(Date);
    expect(pinnedGroup?.pinnedAt).toBeInstanceOf(Date);
    expect(updated.pinnedAt).toBeNull();
    expect(customGroups.groups.map((group) => group.name)).toEqual(["Pinned group", "Later group"]);
    expect(customGroups.groups[0]?.pinnedAt).toBeInstanceOf(Date);
    expect(customGroups.groups[1]?.id).toBe(firstGroup!.id);
  });

  it("deletes custom groups when their final Messenger item moves out", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-empty-after-move";
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Empty Group Org",
      urlKey: deriveOrganizationUrlKey("Messenger Empty Group Org"),
      issuePrefix: `EG${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Move this Messenger item",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const sourceGroup = await messengerSvc.createCustomGroup(orgId, userId, "Source group");
    const targetGroup = await messengerSvc.createCustomGroup(orgId, userId, "Target group");
    const itemKey = `chat:${conversationId}`;
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, sourceGroup.id, itemKey);
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, targetGroup.id, itemKey);

    expect(await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.id, sourceGroup.id))).toHaveLength(0);
    expect((await messengerSvc.listCustomGroups(orgId, userId)).groups.map((group) => group.id)).toEqual([targetGroup.id]);

    await messengerSvc.removeThreadFromCustomGroups(orgId, userId, itemKey);
    expect(await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.id, targetGroup.id))).toHaveLength(0);
    expect((await messengerSvc.listCustomGroups(orgId, userId)).groups).toEqual([]);
  });

  it("removes deleted Chat and Issue memberships and dissolves their empty groups", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-source-delete";
    const conversationId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Deleted Source Group Org",
      urlKey: deriveOrganizationUrlKey("Messenger Deleted Source Group Org"),
      issuePrefix: `DS${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Delete this Chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Delete this Issue",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    });

    await messengerSvc.createCustomGroupWithEntries(
      orgId,
      userId,
      "Deleted Chat group",
      null,
      [`chat:${conversationId}`],
    );
    await messengerSvc.createCustomGroupWithEntries(
      orgId,
      userId,
      "Deleted Issue group",
      null,
      [`issue:${issueId}`],
    );
    await chatSvc.remove(conversationId);
    await issueSvc.remove(issueId);

    expect(await db.select().from(messengerCustomGroupEntries).where(eq(messengerCustomGroupEntries.orgId, orgId))).toEqual([]);
    expect(await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.orgId, orgId))).toEqual([]);
  });

  it("retains a directly created empty group after hydration", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-empty-create";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Empty Create Org",
      urlKey: deriveOrganizationUrlKey("Messenger Empty Create Org"),
      issuePrefix: `EC${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const group = await messengerSvc.createCustomGroup(orgId, userId, "Never populated");

    expect((await messengerSvc.listCustomGroups(orgId, userId)).groups).toMatchObject([{ id: group.id, entries: [] }]);
    expect(await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.id, group.id))).toHaveLength(1);
  });

  it("hydrates split issue custom group entries outside the current Messenger thread summary page", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-split-issues";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Split Issue Custom Groups Org",
      urlKey: deriveOrganizationUrlKey("Messenger Split Issue Custom Groups Org"),
      issuePrefix: `SI${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const baseTime = Date.parse("2026-05-04T12:00:00.000Z");
    const issueIds = Array.from({ length: 120 }, () => randomUUID());
    await db.insert(issues).values(
      issueIds.map((issueId, index) => {
        const activityAt = new Date(baseTime - index * 60_000);
        return {
          id: issueId,
          orgId,
          title: `Grouped split issue ${index + 1}`,
          status: "todo",
          priority: "medium",
          assigneeUserId: userId,
          createdAt: activityAt,
          updatedAt: activityAt,
        };
      }),
    );

    const oldIssueId = issueIds[119]!;
    const splitPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 40,
      splitIssues: true,
    });
    expect(splitPage.items.map((item) => item.threadKey)).not.toContain(`issue:${oldIssueId}`);

    const group = await messengerSvc.createCustomGroup(orgId, userId, "Issue deep work");
    await db.insert(messengerCustomGroupEntries).values({
      id: randomUUID(),
      orgId,
      userId,
      groupId: group!.id,
      threadKey: `issue:${oldIssueId}`,
      sortOrder: 0,
    });

    const customGroups = await messengerSvc.listCustomGroups(orgId, userId);
    expect(customGroups.groups).toHaveLength(1);
    expect(customGroups.groups[0]?.entries.map((entry) => entry.thread.threadKey)).toEqual([
      `issue:${oldIssueId}`,
    ]);
    expect(customGroups.groups[0]?.entries[0]?.thread.title).toBe("Grouped split issue 120");
    expect(customGroups.groups[0]?.entries[0]?.thread.metadata).toMatchObject({
      splitIssue: true,
      issueId: oldIssueId,
    });
  });

  it("creates a custom group with multiple Messenger thread entries atomically", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-merge";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Group Merge Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Group Merge Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversationIds = [randomUUID(), randomUUID()];
    const fillerConversationIds = Array.from({ length: 120 }, () => randomUUID());
    const issueId = randomUUID();
    await db.insert(chatConversations).values(
      [...conversationIds, ...fillerConversationIds].map((conversationId, index) => ({
        id: conversationId,
        orgId,
        title: index < conversationIds.length ? `Merged chat ${index + 1}` : `Newer filler chat ${index + 1}`,
        summary: `Summary ${index + 1}`,
        issueCreationMode: "manual_approval" as const,
        planMode: false,
        createdByUserId: userId,
        createdAt: new Date(Date.parse("2026-05-04T10:00:00.000Z") + index * 60_000),
        updatedAt: new Date(Date.parse("2026-05-04T10:00:00.000Z") + index * 60_000),
      })),
    );
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Merged issue",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    });
    await db.insert(approvals).values({
      id: randomUUID(),
      orgId,
      type: "chat_issue_creation",
      status: "pending",
      requestedByUserId: userId,
      createdAt: new Date("2026-05-04T09:00:00.000Z"),
      updatedAt: new Date("2026-05-04T09:00:00.000Z"),
      payload: {
        chatConversationId: conversationIds[0],
        proposedIssue: {
          title: "Grouped approval",
          description: "Synthetic approval thread should be groupable.",
          priority: "medium",
        },
      },
    });
    const firstPage = await messengerSvc.listThreadSummaryPage(orgId, userId, { limit: 100 });
    expect(firstPage.items.map((item) => item.threadKey)).not.toContain("approvals");

    const customGroups = await messengerSvc.createCustomGroupWithEntries(
      orgId,
      userId,
      "Merged group",
      "folder::amber",
      [`chat:${conversationIds[0]}`, `issue:${issueId}`, `chat:${conversationIds[1]}`, "issues", "approvals"],
    );

    expect(customGroups.groups).toHaveLength(1);
    expect(customGroups.groups[0]?.name).toBe("Merged group");
    expect(customGroups.groups[0]?.entries.map((entry) => entry.threadKey)).toEqual([
      `chat:${conversationIds[0]}`,
      `issue:${issueId}`,
      `chat:${conversationIds[1]}`,
      "issues",
      "approvals",
    ]);
    expect(customGroups.groups[0]?.entries.map((entry) => entry.thread.threadKey)).toEqual([
      `chat:${conversationIds[0]}`,
      `issue:${issueId}`,
      `chat:${conversationIds[1]}`,
      "issues",
      "approvals",
    ]);
  });

  it("lists Messenger thread titles for custom group title generation context", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-title-context";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Group Title Context Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Group Title Context Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversationId = randomUUID();
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Planning chat",
      summary: "Summary",
      issueCreationMode: "manual_approval" as const,
      planMode: false,
      createdByUserId: userId,
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      orgId,
      identifier: `${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}-14`,
      title: "Grouped issue title",
      description: "Issue title context.",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      updatedAt: new Date("2026-05-04T09:00:00.000Z"),
    });

    const titles = await messengerSvc.listThreadTitles(orgId, userId, [
      `chat:${conversationId}`,
      `issue:${issueId}`,
      "unknown:missing",
    ]);

    expect(titles).toEqual([
      "Planning chat",
      `${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}-14 · Grouped issue title`,
    ]);
  });

  it("rolls back custom group merge when any thread cannot be grouped", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-merge-rollback";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Group Merge Rollback Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Group Merge Rollback Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversationId = randomUUID();
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Rollback chat",
      summary: "Summary",
      issueCreationMode: "manual_approval" as const,
      planMode: false,
      createdByUserId: userId,
    });

    await expect(messengerSvc.createCustomGroupWithEntries(
      orgId,
      userId,
      "Should rollback",
      "folder::amber",
      [`chat:${conversationId}`, `unknown:${randomUUID()}`],
    )).rejects.toThrow(/Messenger thread not found/i);

    const customGroups = await messengerSvc.listCustomGroups(orgId, userId);
    expect(customGroups.groups).toEqual([]);
  });

  it("atomically reuses the group that acquires a loose Chat anchor", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-anchor-reuse";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Group Anchor Reuse Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Group Anchor Reuse Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversationId = randomUUID();
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Loose research",
      summary: "Summary",
      issueCreationMode: "manual_approval" as const,
      planMode: false,
      createdByUserId: userId,
    });
    const anchorItemKey = `chat:${conversationId}`;
    const left = await insertSavedViewFixture(orgId, userId, {
      target: {
        kind: "browser",
        tabId: "anchor-left",
        url: "https://example.test/left",
        viewInstanceId: "anchor-left",
      },
      title: "Left",
    });
    const right = await insertSavedViewFixture(orgId, userId, {
      target: {
        kind: "browser",
        tabId: "anchor-right",
        url: "https://example.test/right",
        viewInstanceId: "anchor-right",
      },
      title: "Right",
    });

    await Promise.all([
      messengerSvc.createCustomGroupWithEntries(
        orgId,
        userId,
        "Left group",
        null,
        [anchorItemKey, `saved-view:${left.id}`],
        anchorItemKey,
      ),
      messengerSvc.createCustomGroupWithEntries(
        orgId,
        userId,
        "Right group",
        null,
        [anchorItemKey, `saved-view:${right.id}`],
        anchorItemKey,
      ),
    ]);

    const customGroups = await messengerSvc.listCustomGroups(orgId, userId);
    expect(customGroups.groups).toHaveLength(1);
    expect(new Set(
      customGroups.groups[0]?.entries.map((entry) => entry.itemKey),
    )).toEqual(new Set([
      anchorItemKey,
      `saved-view:${left.id}`,
      `saved-view:${right.id}`,
    ]));
  });

  it("rejects a system-thread anchor for Saved View group creation", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-invalid-anchor";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Group Invalid Anchor Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Group Invalid Anchor Org"),
      issuePrefix: `I${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(messengerSvc.createCustomGroupWithEntries(
      orgId,
      userId,
      "Invalid anchor",
      null,
      ["approvals"],
      "approvals",
    )).rejects.toThrow(/anchor must be a Chat or Issue/i);
  });

  it("omits and prunes stale custom group entries during hydration", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-stale";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Custom Group Stale Org",
      urlKey: deriveOrganizationUrlKey("Messenger Custom Group Stale Org"),
      issuePrefix: `G${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const group = await messengerSvc.createCustomGroup(orgId, userId, "Archive");
    await db.insert(messengerCustomGroupEntries).values({
      orgId,
      userId,
      groupId: group!.id,
      threadKey: `chat:${randomUUID()}`,
      sortOrder: 0,
    });

    const customGroups = await messengerSvc.listCustomGroups(orgId, userId);
    const remainingEntries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.orgId, orgId));

    expect(customGroups.groups).toEqual([]);
    expect(remainingEntries).toHaveLength(0);
  });

  it("keeps dormant synthetic custom group entries when the row is temporarily empty", async () => {
    const orgId = randomUUID();
    const userId = "board-user-custom-group-dormant-synthetic";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Dormant Synthetic Group Org",
      urlKey: deriveOrganizationUrlKey("Messenger Dormant Synthetic Group Org"),
      issuePrefix: `DS${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const firstApprovalId = randomUUID();
    await db.insert(approvals).values({
      id: firstApprovalId,
      orgId,
      type: "chat_issue_creation",
      status: "pending",
      requestedByUserId: userId,
      payload: {
        proposedIssue: {
          title: "Dormant approval",
          description: "The approvals row should keep its group membership after clearing.",
          priority: "medium",
        },
      },
    });

    const customGroups = await messengerSvc.createCustomGroupWithEntries(
      orgId,
      userId,
      "Approval review",
      "folder::teal",
      ["approvals"],
    );
    expect(customGroups.groups[0]?.entries.map((entry) => entry.threadKey)).toEqual(["approvals"]);

    await db
      .update(approvals)
      .set({ status: "approved", updatedAt: new Date("2026-05-04T12:00:00.000Z") })
      .where(eq(approvals.id, firstApprovalId));

    const dormantGroups = await messengerSvc.listCustomGroups(orgId, userId);
    const dormantEntries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.orgId, orgId));

    expect(dormantGroups.groups[0]?.entries).toEqual([]);
    expect(dormantEntries.map((entry) => entry.threadKey)).toEqual(["approvals"]);

    await db.insert(approvals).values({
      id: randomUUID(),
      orgId,
      type: "chat_issue_creation",
      status: "pending",
      requestedByUserId: userId,
      payload: {
        proposedIssue: {
          title: "Restored approval",
          description: "The approvals row should reappear in the same group.",
          priority: "medium",
        },
      },
    });

    const restoredGroups = await messengerSvc.listCustomGroups(orgId, userId);
    expect(restoredGroups.groups[0]?.entries.map((entry) => entry.threadKey)).toEqual(["approvals"]);
    expect(restoredGroups.groups[0]?.entries[0]?.thread.title).toBe("Requests");
  });

  it("persists follows and includes followed plus assigned issues in the Messenger issues thread", async () => {
    const orgId = randomUUID();
    const userId = "board-user-1";
    const followedIssueId = randomUUID();
    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    const commentingAgentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Org",
      urlKey: deriveOrganizationUrlKey("Messenger Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: commentingAgentId,
      orgId,
      name: "Build Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: followedIssueId,
        orgId,
        title: "Followed issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: assignedIssueId,
        orgId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
      },
      {
        id: createdIssueId,
        orgId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
      },
      {
        id: unrelatedIssueId,
        orgId,
        title: "Unrelated issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const followedCommentBody = [
      "## Review Summary",
      "",
      "- render enough comment body to judge the issue update",
      "- preserve markdown for Messenger issue previews",
    ].join("\n");

    await issueSvc.followIssue(orgId, followedIssueId, userId);
    const followedComment = await issueSvc.addComment(followedIssueId, followedCommentBody, { agentId: commentingAgentId });
    expect(await issueSvc.isFollowedByUser(orgId, followedIssueId, userId)).toBe(true);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const itemIds = new Set(thread.detail.items.map((item) => item.issueId));
    const followedItem = thread.detail.items.find((item) => item.issueId === followedIssueId);
    const assignedItem = thread.detail.items.find((item) => item.issueId === assignedIssueId);
    const createdItem = thread.detail.items.find((item) => item.issueId === createdIssueId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(itemIds.has(followedIssueId)).toBe(true);
    expect(itemIds.has(assignedIssueId)).toBe(true);
    expect(itemIds.has(createdIssueId)).toBe(true);
    expect(itemIds.has(unrelatedIssueId)).toBe(false);
    expect(followedItem?.sourceCommentId).toBe(followedComment.id);
    expect(followedItem?.sourceCommentBody).toBe(followedCommentBody);
    expect(followedItem?.sourceCommentAuthorLabel).toBe("Build Agent");
    expect(followedItem?.metadata).toMatchObject({
      sourceCommentAuthorKind: "agent",
      sourceCommentByMe: false,
      sourceCommentAuthorLabel: "Build Agent",
    });
    expect(followedItem?.preview).toBe("Review Summary: render enough comment body to judge the issue update");
    expect(assignedItem?.metadata).toMatchObject({ assignedToMe: true, createdByMe: false });
    expect(assignedItem?.body).toContain("assigned to me");
    expect(createdItem?.metadata).toMatchObject({ assignedToMe: false, createdByMe: true });
    expect(issuesSummary?.preview).toBe("Followed issue — Review Summary: render enough comment body to judge the issue update");
  });

  it("surfaces a requester-only Agent-created issue notification as unread", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "board-user-agent-issue-notification";
    const otherUserId = "board-user-agent-issue-other";
    const issueId = randomUUID();
    const otherOrgIssueId = randomUUID();
    const agentId = randomUUID();
    const createdAt = new Date("2026-05-03T12:01:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger Agent Issue Org",
        urlKey: deriveOrganizationUrlKey("Messenger Agent Issue Org"),
        issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger Agent Issue Other Org",
        urlKey: deriveOrganizationUrlKey("Messenger Agent Issue Other Org"),
        issuePrefix: `B${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Issue Builder",
      role: "engineer",
      status: "active",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        orgId,
        title: "Agent-created issue",
        status: "todo",
        priority: "medium",
        identifier: "AIC-1",
        reviewerUserId: otherUserId,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: otherOrgIssueId,
        orgId: otherOrgId,
        title: "Other organization issue",
        status: "todo",
        priority: "medium",
        identifier: "BIO-1",
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "agent.issue_created_notification",
        entityType: "issue",
        entityId: issueId,
        details: {
          issueId,
          identifier: "AIC-1",
          title: "Agent-created issue",
          agentId,
          userId,
          source: "agent.issue_created_notification",
        },
        createdAt,
      },
      {
        orgId: otherOrgId,
        actorType: "agent",
        actorId: agentId,
        agentId: null,
        action: "agent.issue_created_notification",
        entityType: "issue",
        entityId: otherOrgIssueId,
        details: { userId },
        createdAt,
      },
    ]);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item).toMatchObject({
      issueId,
      preview: "Agent created issue",
    });
    expect(thread.detail.items.some((entry) => entry.issueId === otherOrgIssueId)).toBe(false);
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(1);

    const otherUserThread = await messengerSvc.getIssuesThread(orgId, otherUserId);
    const otherUserItem = otherUserThread.detail.items.find((entry) => entry.issueId === issueId);
    expect(otherUserItem).toMatchObject({ issueId });
    expect(otherUserItem?.preview).not.toBe("Agent created issue");
    expect(otherUserThread.detail.unreadCount).toBe(0);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, otherUserId)).resolves.toBe(0);

    await messengerSvc.setThreadRead(orgId, userId, `issue:${issueId}`, createdAt);
    const readThread = await messengerSvc.getIssuesThread(orgId, userId);
    expect(readThread.detail.unreadCount).toBe(0);
    expect(readThread.detail.needsAttention).toBe(false);
  });

  it("emits one requester notification when an Agent Issue request completes idempotently", async () => {
    const orgId = randomUUID();
    const userId = "board-user-agent-issue-service";
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const service = agentIssueCreationService(db);
    const requestInput = {
      orgId,
      requestedByUserId: userId,
      agentId,
      instruction: "Create the onboarding regression issue.",
      projectId: null,
      goalId: null,
      parentId: null,
      contextSnapshot: { source: "new-issue-dialog" },
      idempotencyKey: "agent-request-replay",
    } as const;

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Issue Service Org",
      urlKey: deriveOrganizationUrlKey("Agent Issue Service Org"),
      issuePrefix: `AIS${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Onboarding Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const first = await service.create(requestInput);
    const replay = await service.create(requestInput);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(first.needsAdmission).toBe(true);
    expect(replay.needsAdmission).toBe(true);
    expect(replay.request.id).toBe(first.request.id);

    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: {
        agentIssueCreationRequestId: first.request.id,
      },
    });
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Onboarding regression",
      status: "todo",
      priority: "medium",
      identifier: "AIS-1",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: first.request.id,
      originRunId: runId,
    });
    await service.update(orgId, first.request.id, { status: "running", runId }, { expectedStatuses: ["queued"] });
    await expect(service.create(requestInput)).resolves.toMatchObject({
      created: false,
      needsAdmission: false,
      request: { id: first.request.id, status: "running" },
    });

    const completed = await service.completeForCreatedIssue({
      orgId,
      agentId,
      runId,
      issueId,
    });
    const duplicateCompletion = await service.completeForCreatedIssue({
      orgId,
      agentId,
      runId,
      issueId,
    });
    const notifications = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.orgId, orgId),
        eq(activityLog.action, "agent.issue_created_notification"),
      ));

    expect(completed).toMatchObject({
      id: first.request.id,
      status: "succeeded",
      createdIssueId: issueId,
      requestedByUserId: userId,
    });
    expect(duplicateCompletion).toBeNull();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      entityId: issueId,
      details: expect.objectContaining({
        requestId: first.request.id,
        userId,
        source: "agent.issue_created_notification",
      }),
    });

    const failedRunId = randomUUID();
    const failedRequest = await service.create({
      ...requestInput,
      instruction: "Create the failed onboarding issue.",
      idempotencyKey: "agent-request-failure",
    });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      contextSnapshot: { agentIssueCreationRequestId: failedRequest.request.id },
    });
    await service.update(orgId, failedRequest.request.id, {
      status: "running",
      runId: failedRunId,
    }, { expectedStatuses: ["queued"] });
    const settledFailure = await service.settleForRun({
      orgId,
      agentId,
      runId: failedRunId,
      requestId: failedRequest.request.id,
      runStatus: "failed",
      error: "Agent process exited before creating the Issue",
    });

    expect(settledFailure).toMatchObject({
      id: failedRequest.request.id,
      status: "failed",
      error: "Agent process exited before creating the Issue",
    });
    await expect(service.create({
      ...requestInput,
      instruction: "Create the failed onboarding issue.",
      idempotencyKey: "agent-request-failure",
    })).rejects.toMatchObject({ status: 409 });
    const retriedFailure = await service.retry(orgId, failedRequest.request.id, userId);
    expect(retriedFailure).toMatchObject({
      id: failedRequest.request.id,
      status: "queued",
      idempotencyKey: "agent-request-failure",
      wakeupAttempt: 1,
      wakeupAttemptId: expect.any(String),
      wakeupRequestId: null,
      runId: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(retriedFailure.wakeupAttemptId).not.toBe(failedRequest.request.wakeupAttemptId);

    const delayedOriginalPost = await service.create({
      ...requestInput,
      instruction: "Create the failed onboarding issue.",
      idempotencyKey: "agent-request-failure",
    });
    expect(delayedOriginalPost).toMatchObject({
      created: false,
      needsAdmission: true,
      request: {
        id: failedRequest.request.id,
        idempotencyKey: "agent-request-failure",
        wakeupAttempt: 1,
        wakeupAttemptId: retriedFailure.wakeupAttemptId,
      },
    });
    const replayedRequests = await db
      .select({ id: agentIssueCreationRequests.id })
      .from(agentIssueCreationRequests)
      .where(and(
        eq(agentIssueCreationRequests.orgId, orgId),
        eq(agentIssueCreationRequests.requestedByUserId, userId),
        eq(agentIssueCreationRequests.idempotencyKey, "agent-request-failure"),
      ));
    const replayedRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.orgId, orgId),
        sql`${heartbeatRuns.contextSnapshot}->>'agentIssueCreationRequestId' = ${failedRequest.request.id}`,
      ));
    const replayedIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.orgId, orgId),
        eq(issues.originKind, "agent_issue_creation"),
        eq(issues.originId, failedRequest.request.id),
      ));
    expect(replayedRequests).toHaveLength(1);
    expect(replayedRuns).toHaveLength(1);
    expect(replayedIssues).toHaveLength(0);

    const isolatedRequest = await service.create({
      ...requestInput,
      instruction: "Create the isolated onboarding issue.",
      idempotencyKey: "agent-request-isolation",
    });
    const isolatedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: isolatedRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { agentIssueCreationRequestId: isolatedRequest.request.id },
    });
    await service.update(orgId, isolatedRequest.request.id, {
      status: "running",
      runId: isolatedRunId,
    }, { expectedStatuses: ["queued"] });

    expect(await service.completeForCreatedIssue({
      orgId,
      agentId,
      runId: randomUUID(),
      issueId,
      requestId: isolatedRequest.request.id,
    })).toBeNull();
    expect(await service.completeForCreatedIssue({
      orgId,
      agentId: randomUUID(),
      runId: isolatedRunId,
      issueId,
      requestId: isolatedRequest.request.id,
    })).toBeNull();
    expect(await service.settleForRun({
      orgId,
      agentId,
      runId: randomUUID(),
      requestId: isolatedRequest.request.id,
      runStatus: "failed",
      error: "wrong run must not settle the request",
    })).toBeNull();
    await expect(service.getById(orgId, isolatedRequest.request.id)).resolves.toMatchObject({
      status: "running",
      runId: isolatedRunId,
    });
    await expect(service.settleForRun({
      orgId,
      agentId,
      runId: isolatedRunId,
      requestId: isolatedRequest.request.id,
      runStatus: "failed",
      error: "isolated run failed",
    })).resolves.toMatchObject({
      id: isolatedRequest.request.id,
      status: "failed",
    });

    const mismatchedRequest = await service.create({
      ...requestInput,
      instruction: "Leave the mismatched origin request untouched.",
      idempotencyKey: "agent-request-mismatched-origin",
    });
    const mismatchedRunId = randomUUID();
    const mismatchedOriginRunId = randomUUID();
    const mismatchedIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: mismatchedRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { agentIssueCreationRequestId: mismatchedRequest.request.id },
    });
    await service.update(orgId, mismatchedRequest.request.id, {
      status: "running",
      runId: mismatchedRunId,
    }, { expectedStatuses: ["queued"] });
    await db.insert(issues).values({
      id: mismatchedIssueId,
      orgId,
      title: "Mismatched origin issue",
      status: "todo",
      priority: "medium",
      identifier: "AIS-4",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: mismatchedRequest.request.id,
      originRunId: mismatchedOriginRunId,
    });

    expect(await service.completeForCreatedIssue({
      orgId,
      agentId,
      runId: mismatchedRunId,
      issueId: mismatchedIssueId,
      requestId: mismatchedRequest.request.id,
    })).toBeNull();
    expect(await service.settleForRun({
      orgId,
      agentId,
      runId: mismatchedRunId,
      requestId: mismatchedRequest.request.id,
      runStatus: "failed",
      error: "mismatched origin must not fail the request",
    })).toBeNull();
    await expect(service.getById(orgId, mismatchedRequest.request.id)).resolves.toMatchObject({
      status: "running",
      runId: mismatchedRunId,
    });
    await db.delete(issues).where(eq(issues.id, mismatchedIssueId));

    const reconcileRequest = await service.create({
      ...requestInput,
      instruction: "Reconcile the issue created before terminal settlement.",
      idempotencyKey: "agent-request-terminal-reconciliation",
    });
    const reconcileRunId = randomUUID();
    const reconcileIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: reconcileRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      contextSnapshot: { agentIssueCreationRequestId: reconcileRequest.request.id },
    });
    await service.update(orgId, reconcileRequest.request.id, {
      status: "running",
      runId: reconcileRunId,
    }, { expectedStatuses: ["queued"] });
    await db.insert(issues).values({
      id: reconcileIssueId,
      orgId,
      title: "Reconciled onboarding issue",
      status: "todo",
      priority: "medium",
      identifier: "AIS-2",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: reconcileRequest.request.id,
      originRunId: reconcileRunId,
    });
    await expect(service.settleForRun({
      orgId,
      agentId,
      runId: reconcileRunId,
      requestId: reconcileRequest.request.id,
      runStatus: "failed",
      error: "terminal run reported failure after the Issue was created",
    })).resolves.toMatchObject({
      id: reconcileRequest.request.id,
      status: "succeeded",
      createdIssueId: reconcileIssueId,
      error: null,
    });

    const retryRequest = await service.create({
      ...requestInput,
      instruction: "Retry the requester notification after a transient failure.",
      idempotencyKey: "agent-request-notification-retry",
    });
    const retryRunId = randomUUID();
    const retryIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { agentIssueCreationRequestId: retryRequest.request.id },
    });
    await service.update(orgId, retryRequest.request.id, {
      status: "running",
      runId: retryRunId,
    }, { expectedStatuses: ["queued"] });
    await db.insert(issues).values({
      id: retryIssueId,
      orgId,
      title: "Notification retry issue",
      status: "todo",
      priority: "medium",
      identifier: "AIS-3",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: retryRequest.request.id,
      originRunId: retryRunId,
    });

    const firstClaim = service.completeForCreatedIssue({
      orgId,
      agentId,
      runId: retryRunId,
      issueId: retryIssueId,
      requestId: retryRequest.request.id,
    });
    const secondClaim = service.completeForCreatedIssue({
      orgId,
      agentId,
      runId: retryRunId,
      issueId: retryIssueId,
      requestId: retryRequest.request.id,
    });
    const claims = await Promise.all([firstClaim, secondClaim]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim?.status === "succeeded")).toHaveLength(1);

    const afterConcurrentClaims = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.issue_created_notification"));
    expect(afterConcurrentClaims.filter((entry) => (entry.details as Record<string, unknown> | null)?.requestId === retryRequest.request.id))
      .toHaveLength(1);

    expect(await service.completeForCreatedIssue({
      orgId,
      agentId,
      runId: retryRunId,
      issueId: retryIssueId,
      requestId: retryRequest.request.id,
    })).toBeNull();

    const deferredRequest = await service.create({
      ...requestInput,
      instruction: "Resume the deferred onboarding issue request.",
      idempotencyKey: "agent-request-deferred-terminal-context",
    });
    const deferredRunId = randomUUID();
    const deferredIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: deferredRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "timed_out",
      contextSnapshot: { agentIssueCreationRequestId: deferredRequest.request.id },
    });
    await service.update(orgId, deferredRequest.request.id, {
      status: "deferred",
    }, { expectedStatuses: ["queued"] });
    await db.insert(issues).values({
      id: deferredIssueId,
      orgId,
      title: "Deferred onboarding issue",
      status: "todo",
      priority: "medium",
      identifier: "AIS-5",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: deferredRequest.request.id,
      originRunId: deferredRunId,
    });
    await expect(service.settleForRun({
      orgId,
      agentId,
      runId: deferredRunId,
      runStatus: "timed_out",
      error: "the resumed run timed out after creating the Issue",
    })).resolves.toMatchObject({
      id: deferredRequest.request.id,
      status: "succeeded",
      runId: deferredRunId,
      createdIssueId: deferredIssueId,
    });
    await expect(service.getById(orgId, deferredRequest.request.id)).resolves.toMatchObject({
      status: "succeeded",
      runId: deferredRunId,
      createdIssueId: deferredIssueId,
    });

    for (const [terminalStatus, expectedRequestStatus] of [
      ["succeeded", "failed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["timed_out", "failed"],
    ] as const) {
      const terminalRequest = await service.create({
        ...requestInput,
        instruction: `Record the ${terminalStatus} Agent Issue request.`,
        idempotencyKey: `agent-request-terminal-${terminalStatus}`,
      });
      const terminalRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: terminalRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: terminalStatus,
        contextSnapshot: { agentIssueCreationRequestId: terminalRequest.request.id },
      });
      await service.update(orgId, terminalRequest.request.id, {
        status: "running",
        runId: terminalRunId,
      }, { expectedStatuses: ["queued"] });

      await expect(service.settleForRun({
        orgId,
        agentId,
        runId: terminalRunId,
        requestId: terminalRequest.request.id,
        runStatus: terminalStatus,
      })).resolves.toMatchObject({
        id: terminalRequest.request.id,
        status: expectedRequestStatus,
        runId: terminalRunId,
      });
    }

    const rollbackRequest = await service.create({
      ...requestInput,
      instruction: "Retry the requester notification after a rollback.",
      idempotencyKey: "agent-request-notification-rollback",
    });
    const rollbackRunId = randomUUID();
    const rollbackIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: rollbackRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { agentIssueCreationRequestId: rollbackRequest.request.id },
    });
    await service.update(orgId, rollbackRequest.request.id, {
      status: "running",
      runId: rollbackRunId,
    }, { expectedStatuses: ["queued"] });
    await db.insert(issues).values({
      id: rollbackIssueId,
      orgId,
      title: "Notification rollback issue",
      status: "todo",
      priority: "medium",
      identifier: "AIS-6",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: rollbackRequest.request.id,
      originRunId: rollbackRunId,
    });

    const failingDb = new Proxy(db as object, {
      get(target, property) {
        if (property === "transaction") {
          return (callback: (tx: unknown) => unknown) => (target as any).transaction(async (tx: any) => {
            const failingTransaction = new Proxy(tx, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === "insert") {
                  return (table: unknown) => {
                    if (table === activityLog) throw new Error("notification insert unavailable");
                    return transactionTarget.insert(table);
                  };
                }
                const value = Reflect.get(transactionTarget, transactionProperty);
                return typeof value === "function" ? value.bind(transactionTarget) : value;
              },
            });
            return callback(failingTransaction);
          });
        }
        if (property === "insert") {
          return (table: unknown) => {
            if (table === activityLog) throw new Error("notification insert unavailable");
            return (target as any).insert(table);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
    const failingService = agentIssueCreationService(failingDb);

    await expect(failingService.completeForCreatedIssue({
      orgId,
      agentId,
      runId: rollbackRunId,
      issueId: rollbackIssueId,
      requestId: rollbackRequest.request.id,
    })).resolves.toMatchObject({
      id: rollbackRequest.request.id,
      status: "succeeded",
      createdIssueId: rollbackIssueId,
    });
    await expect(service.getById(orgId, rollbackRequest.request.id)).resolves.toMatchObject({
      status: "succeeded",
      runId: rollbackRunId,
      createdIssueId: rollbackIssueId,
    });
    await expect(service.completeForCreatedIssue({
      orgId,
      agentId,
      runId: rollbackRunId,
      issueId: rollbackIssueId,
      requestId: rollbackRequest.request.id,
    })).resolves.toBeNull();
    const rollbackNotifications = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.orgId, orgId),
        eq(activityLog.action, "agent.issue_created_notification"),
      ));
    expect(rollbackNotifications.filter((entry) =>
      (entry.details as Record<string, unknown> | null)?.requestId === rollbackRequest.request.id,
    )).toHaveLength(1);
  });

  it("replays a persisted Agent Issue notification after terminal worker recovery", async () => {
    const orgId = randomUUID();
    const userId = "board-user-agent-issue-recovery";
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const completedAt = new Date("2026-05-03T13:01:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Issue Recovery Org",
      urlKey: deriveOrganizationUrlKey("Agent Issue Recovery Org"),
      issuePrefix: `AIR${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Recovery Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = agentIssueCreationService(db);
    const created = await service.create({
      orgId,
      requestedByUserId: userId,
      agentId,
      instruction: "Create the issue before the terminal worker restarts.",
      projectId: null,
      goalId: null,
      parentId: null,
      contextSnapshot: { source: "terminal-recovery-test" },
      idempotencyKey: "agent-issue-terminal-recovery",
    });
    expect(created.request.id).toBeDefined();

    // Model the crash boundary: request and Issue settlement committed, while
    // the durable terminal notification effect still awaits a worker.
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      finishedAt: completedAt,
      processExitedAt: completedAt,
      terminalEffectsPending: true,
      terminalEffectsJson: {
        version: 1,
        agentIssueCreationNotification: {
          orgId,
          agentId,
          runId,
          requestId: created.request.id,
          issueId,
        },
      },
      contextSnapshot: { agentIssueCreationRequestId: created.request.id },
      createdAt: completedAt,
      updatedAt: completedAt,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Recovered Agent-created issue",
      status: "todo",
      priority: "medium",
      identifier: "AIR-1",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: created.request.id,
      originRunId: runId,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    await db.update(agentIssueCreationRequests)
      .set({
        status: "succeeded",
        runId,
        createdIssueId: issueId,
        finishedAt: completedAt,
        error: null,
        updatedAt: completedAt,
      })
      .where(eq(agentIssueCreationRequests.id, created.request.id));

    const recovery = await heartbeatService(db).reapOrphanedRuns();
    expect(recovery).toEqual({ reaped: 1, runIds: [runId] });

    const recoveredRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(recoveredRun).toMatchObject({
      status: "failed",
      terminalEffectsPending: false,
      terminalEffectsJson: null,
      terminalEffectsClaimToken: null,
    });

    const notifications = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.orgId, orgId),
        eq(activityLog.action, "agent.issue_created_notification"),
      ));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      entityId: issueId,
      details: expect.objectContaining({
        requestId: created.request.id,
        userId,
        source: "agent.issue_created_notification",
      }),
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    expect(thread.detail.items.find((entry) => entry.issueId === issueId)).toMatchObject({
      issueId,
      preview: "Agent created issue",
    });
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
  });

  it("resolves persisted run linkage before snapshot fallback and handles the wakeup race", async () => {
    const orgId = randomUUID();
    const userId = "board-user-run-linkage";
    const agentId = randomUUID();
    const service = agentIssueCreationService(db);

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Issue Run Linkage Org",
      urlKey: deriveOrganizationUrlKey("Agent Issue Run Linkage Org"),
      issuePrefix: `ARL${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Run Linkage Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const persisted = await service.create({
      orgId,
      requestedByUserId: userId,
      agentId,
      instruction: "Create the persisted-run linkage issue.",
      projectId: null,
      goalId: null,
      parentId: null,
      contextSnapshot: { source: "run-linkage-test" },
      idempotencyKey: "persisted-run-linkage",
    });
    const persistedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: persistedRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { source: "runtime-before-context-hydration" },
    });
    await service.update(orgId, persisted.request.id, {
      status: "running",
      runId: persistedRunId,
    }, { expectedStatuses: ["queued"] });

    const mismatchedContext = await service.create({
      orgId,
      requestedByUserId: userId,
      agentId,
      instruction: "Create the request named by the mismatched run context.",
      projectId: null,
      goalId: null,
      parentId: null,
      contextSnapshot: { source: "run-linkage-test" },
      idempotencyKey: "persisted-run-linkage-mismatched-context",
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { agentIssueCreationRequestId: mismatchedContext.request.id } })
      .where(eq(heartbeatRuns.id, persistedRunId));

    await expect(service.resolveForRun(orgId, agentId, persistedRunId))
      .rejects.toMatchObject({ status: 409, message: "Agent Issue creation request does not match the active run" });
    await expect(service.settleForRun({
      orgId,
      agentId,
      runId: persistedRunId,
      runStatus: "failed",
      error: "mismatched context must not settle the persisted request",
    })).resolves.toBeNull();
    await expect(service.getById(orgId, persisted.request.id)).resolves.toMatchObject({
      status: "running",
      runId: persistedRunId,
    });

    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { source: "runtime-before-context-hydration" } })
      .where(eq(heartbeatRuns.id, persistedRunId));

    await expect(service.resolveForRun(orgId, agentId, persistedRunId)).resolves.toMatchObject({
      id: persisted.request.id,
      runId: persistedRunId,
      status: "running",
    });
    await expect(service.settleForRun({
      orgId,
      agentId,
      runId: persistedRunId,
      requestId: persisted.request.id,
      runStatus: "failed",
      error: "persisted run failed before issue creation",
    })).resolves.toMatchObject({
      id: persisted.request.id,
      status: "failed",
      runId: persistedRunId,
    });

    const race = await service.create({
      orgId,
      requestedByUserId: userId,
      agentId,
      instruction: "Create the issue during the wakeup linkage race.",
      projectId: null,
      goalId: null,
      parentId: null,
      contextSnapshot: { source: "run-linkage-test" },
      idempotencyKey: "run-linkage-wakeup-race",
    });
    const raceRunId = randomUUID();
    const raceIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: raceRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { agentIssueCreationRequestId: race.request.id },
    });
    await db.insert(issues).values({
      id: raceIssueId,
      orgId,
      title: "Wakeup linkage race issue",
      status: "todo",
      priority: "medium",
      identifier: "ARL-1",
      createdByAgentId: agentId,
      originKind: "agent_issue_creation",
      originId: race.request.id,
      originRunId: raceRunId,
    });

    await expect(service.completeForCreatedIssue({
      orgId,
      agentId,
      runId: raceRunId,
      issueId: raceIssueId,
      requestId: race.request.id,
    })).resolves.toMatchObject({
      id: race.request.id,
      status: "succeeded",
      runId: raceRunId,
      createdIssueId: raceIssueId,
    });
    await expect(service.getById(orgId, race.request.id)).resolves.toMatchObject({
      status: "succeeded",
      runId: raceRunId,
      createdIssueId: raceIssueId,
    });
  });

  it("can split tracked issue notifications into Messenger thread summaries", async () => {
    const orgId = randomUUID();
    const userId = "board-user-split-issues";
    const issueId = randomUUID();
    const issueRunId = randomUUID();
    const projectId = randomUUID();
    const assigneeAgentId = randomUUID();
    const chatId = randomUUID();
    const olderChatId = randomUUID();
    const issueUpdatedAt = new Date("2026-05-03T10:30:00.000Z");
    const chatUpdatedAt = new Date("2026-05-03T11:00:00.000Z");
    const olderChatUpdatedAt = new Date("2026-05-03T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Split Issues Org",
      urlKey: deriveOrganizationUrlKey("Messenger Split Issues Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Operator console",
      status: "in_progress",
      color: "#6d5dfc",
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      orgId,
      name: "Split Issue Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(chatConversations).values([
      {
        id: chatId,
        orgId,
        title: "Middle chat thread",
        summary: "This chat should sort between split issue rows and older chats.",
        issueCreationMode: "manual_approval",
        planMode: false,
        createdByUserId: userId,
        lastMessageAt: chatUpdatedAt,
        createdAt: chatUpdatedAt,
        updatedAt: chatUpdatedAt,
      },
      {
        id: olderChatId,
        orgId,
        title: "Older chat thread",
        summary: "This chat should sort after the split issue row.",
        issueCreationMode: "manual_approval",
        planMode: false,
        createdByUserId: userId,
        lastMessageAt: olderChatUpdatedAt,
        createdAt: olderChatUpdatedAt,
        updatedAt: olderChatUpdatedAt,
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: issueRunId,
      orgId,
      agentId: assigneeAgentId,
      invocationSource: "issue",
      status: "running",
      createdAt: issueUpdatedAt,
      updatedAt: issueUpdatedAt,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Split issue row",
      description: "Full split issue description for delayed Messenger previews.",
      status: "in_progress",
      priority: "medium",
      projectId,
      assigneeAgentId,
      assigneeUserId: userId,
      identifier: "SPL-1",
      executionRunId: issueRunId,
      createdAt: issueUpdatedAt,
      updatedAt: issueUpdatedAt,
    });

    const aggregateSummaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const splitSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const splitPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 10,
      splitIssues: true,
    });

    expect(aggregateSummaries.map((item) => item.threadKey)).toContain("issues");
    expect(splitSummaries.map((item) => item.threadKey)).not.toContain("issues");
    expect(splitSummaries.map((item) => item.threadKey)).toEqual([
      `chat:${chatId}`,
      `issue:${issueId}`,
      `chat:${olderChatId}`,
    ]);
    expect(splitPage.items.map((item) => item.threadKey)).toEqual(splitSummaries.map((item) => item.threadKey));
    expect(splitSummaries[1]).toMatchObject({
      threadKey: `issue:${issueId}`,
      kind: "issues",
      title: "SPL-1 · Split issue row",
      href: "/messenger/issues/SPL-1",
      unreadCount: 1,
      needsAttention: true,
      metadata: {
        splitIssue: true,
        issueId,
        issueIdentifier: "SPL-1",
        description: "Full split issue description for delayed Messenger previews.",
        projectId,
        projectName: "Operator console",
        projectColor: "#6d5dfc",
        assigneeAgentId,
        activeExecutionRunId: issueRunId,
        assignedToMe: true,
      },
    });

    const pinnedState = await messengerSvc.setThreadPinned(orgId, userId, `issue:${issueId}`, true);
    const pinnedSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });

    expect(pinnedState).toEqual({ threadKey: `issue:${issueId}`, pinned: true });
    expect(pinnedSummaries.map((item) => item.threadKey)).toEqual([
      `issue:${issueId}`,
      `chat:${chatId}`,
      `chat:${olderChatId}`,
    ]);
    expect(pinnedSummaries[0]?.isPinned).toBe(true);

    const firstPinnedPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 2,
      splitIssues: true,
    });
    const secondPinnedPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 2,
      splitIssues: true,
      cursor: firstPinnedPage.pageInfo.nextCursor,
    });

    expect(firstPinnedPage.items.map((item) => item.threadKey)).toEqual([
      `issue:${issueId}`,
      `chat:${chatId}`,
    ]);
    expect(secondPinnedPage.items.map((item) => item.threadKey)).toEqual([
      `chat:${olderChatId}`,
    ]);

    const firstSingleItemPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 1,
      splitIssues: true,
    });
    const secondSingleItemPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 1,
      splitIssues: true,
      cursor: firstSingleItemPage.pageInfo.nextCursor,
    });

    expect(firstSingleItemPage.items.map((item) => item.threadKey)).toEqual([`issue:${issueId}`]);
    expect(secondSingleItemPage.items.map((item) => item.threadKey)).toEqual([`chat:${chatId}`]);

    await chatSvc.setPinned(olderChatId, orgId, userId, true);
    const pinnedMixFirstPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 1,
      splitIssues: true,
    });
    const pinnedMixSecondPage = await messengerSvc.listThreadSummaryPage(orgId, userId, {
      limit: 1,
      splitIssues: true,
      cursor: pinnedMixFirstPage.pageInfo.nextCursor,
    });

    expect(pinnedMixFirstPage.items.map((item) => item.threadKey)).toEqual([`issue:${issueId}`]);
    expect(pinnedMixSecondPage.items.map((item) => item.threadKey)).toEqual([`chat:${olderChatId}`]);
  });

  it("clears split issue attention from the single issue read state", async () => {
    const orgId = randomUUID();
    const userId = "board-user-split-issue-read";
    const issueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    const issueUpdatedAt = new Date("2026-05-03T10:30:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Split Issue Read Org",
      urlKey: deriveOrganizationUrlKey("Messenger Split Issue Read Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: issueId,
        orgId,
        title: "Split issue read state",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        identifier: "SPL-READ-1",
        createdAt: issueUpdatedAt,
        updatedAt: issueUpdatedAt,
      },
      {
        id: unrelatedIssueId,
        orgId,
        title: "Unrelated split issue read state",
        status: "todo",
        priority: "medium",
        identifier: "SPL-READ-2",
        createdAt: issueUpdatedAt,
        updatedAt: issueUpdatedAt,
      },
    ]);

    const beforeReadSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const beforeReadIssue = beforeReadSummaries.find((item) => item.threadKey === `issue:${issueId}`);
    expect(beforeReadIssue?.unreadCount).toBe(1);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(1);

    const rejectedState = await messengerSvc.setThreadRead(orgId, userId, `issue:${unrelatedIssueId}`, issueUpdatedAt);
    expect(rejectedState).toBeNull();

    const state = await messengerSvc.setThreadRead(orgId, userId, `issue:${issueId}`, issueUpdatedAt);
    expect(state?.lastReadAt.toISOString()).toBe(issueUpdatedAt.toISOString());

    const afterReadSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const afterReadAggregateSummary = await messengerSvc.listThreadSummaries(orgId, userId);
    const afterReadIssue = afterReadSummaries.find((item) => item.threadKey === `issue:${issueId}`);
    const issuesSummary = afterReadAggregateSummary.find((item) => item.threadKey === "issues");

    expect(afterReadIssue?.unreadCount).toBe(0);
    expect(afterReadIssue?.needsAttention).toBe(false);
    expect(issuesSummary?.unreadCount).toBe(0);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(0);
  });

  it("advances stale split issue read watermarks to the issue's latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-stale-split-issue-read";
    const issueId = randomUUID();
    const openedAt = new Date("2026-05-03T10:29:00.000Z");
    const issueUpdatedAt = new Date("2026-05-03T10:30:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Stale Split Issue Read Org",
      urlKey: deriveOrganizationUrlKey("Messenger Stale Split Issue Read Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Stale split issue read state",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "SPL-STALE-1",
      createdAt: openedAt,
      updatedAt: issueUpdatedAt,
    });

    const state = await messengerSvc.setThreadRead(orgId, userId, `issue:${issueId}`, openedAt);
    expect(state?.lastReadAt.toISOString()).toBe(issueUpdatedAt.toISOString());

    const afterReadSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const afterReadIssue = afterReadSummaries.find((item) => item.threadKey === `issue:${issueId}`);

    expect(afterReadIssue?.unreadCount).toBe(0);
    expect(afterReadIssue?.needsAttention).toBe(false);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(0);
  });

  it("dismisses all Messenger unread threads for the board user", async () => {
    const orgId = randomUUID();
    const userId = "board-user-dismiss-unreads";
    const otherUserId = "board-user-dismiss-unreads-other";
    const conversationId = randomUUID();
    const issueId = randomUUID();
    const readAt = new Date("2026-05-03T10:00:00.000Z");
    const chatActivityAt = new Date("2026-05-03T10:05:00.000Z");
    const issueActivityAt = new Date("2026-05-03T10:10:00.000Z");
    const approvalActivityAt = new Date("2026-05-03T10:15:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Dismiss Unreads Org",
      urlKey: deriveOrganizationUrlKey("Messenger Dismiss Unreads Org"),
      issuePrefix: `D${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Dismiss unread chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      lastMessageAt: chatActivityAt,
      createdAt: readAt,
      updatedAt: chatActivityAt,
    });
    await db.insert(chatMessages).values({
      id: randomUUID(),
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Unread assistant reply",
      createdAt: chatActivityAt,
      updatedAt: chatActivityAt,
    });
    await chatSvc.markRead(conversationId, orgId, userId, readAt);
    await chatSvc.markRead(conversationId, orgId, otherUserId, readAt);

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Dismiss unread issue",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "DISMISS-1",
      createdAt: issueActivityAt,
      updatedAt: issueActivityAt,
    });
    await db.insert(approvals).values({
      id: randomUUID(),
      orgId,
      type: "chat_issue_creation",
      requestedByUserId: userId,
      status: "pending",
      payload: { proposedIssue: { title: "Dismiss approval unread" } },
      createdAt: approvalActivityAt,
      updatedAt: approvalActivityAt,
    });
    await messengerSvc.setThreadRead(orgId, userId, "approvals", readAt);

    const before = await messengerSvc.listThreadSummaries(orgId, userId);
    expect(before.find((item) => item.threadKey === `chat:${conversationId}`)?.unreadCount).toBe(1);
    expect(before.find((item) => item.threadKey === "issues")?.unreadCount).toBe(1);
    expect(before.find((item) => item.threadKey === "approvals")?.unreadCount).toBe(1);

    const result = await messengerSvc.dismissUnreadThreads(orgId, userId);
    expect(result.dismissedThreadKeys.sort()).toEqual([
      "approvals",
      `chat:${conversationId}`,
      "issues",
    ].sort());

    const after = await messengerSvc.listThreadSummaries(orgId, userId);
    expect(after.find((item) => item.threadKey === `chat:${conversationId}`)?.unreadCount).toBe(0);
    expect(after.find((item) => item.threadKey === "issues")?.unreadCount).toBe(0);
    expect(after.find((item) => item.threadKey === "approvals")?.unreadCount).toBe(0);

    const otherUserAfter = await messengerSvc.listThreadSummaries(orgId, otherUserId);
    expect(otherUserAfter.find((item) => item.threadKey === `chat:${conversationId}`)?.unreadCount).toBe(1);
  });

  it("allows followed or notified automation execution issues into Messenger while hiding unrelated automation issues", async () => {
    const orgId = randomUUID();
    const userId = "board-user-automation-follow";
    const followedAutomationIssueId = randomUUID();
    const notifiedAutomationIssueId = randomUUID();
    const hiddenAutomationIssueId = randomUUID();
    const createdAt = new Date("2026-05-03T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Automation Follow Org",
      urlKey: deriveOrganizationUrlKey("Messenger Automation Follow Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: followedAutomationIssueId,
        orgId,
        title: "Followed automation execution",
        status: "todo",
        priority: "medium",
        originKind: "automation_execution",
        originId: "automation-1",
        originRunId: "run-1",
        identifier: "AUT-1",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: notifiedAutomationIssueId,
        orgId,
        title: "Notified automation execution",
        status: "todo",
        priority: "medium",
        originKind: "automation_execution",
        originId: "automation-notified",
        originRunId: "run-notified",
        identifier: "AUT-2",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: hiddenAutomationIssueId,
        orgId,
        title: "Hidden automation execution",
        status: "todo",
        priority: "medium",
        originKind: "automation_execution",
        originId: "automation-2",
        originRunId: "run-2",
        identifier: "AUT-3",
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await issueSvc.followIssue(orgId, followedAutomationIssueId, userId);
    await db.insert(activityLog).values({
      orgId,
      actorType: "system",
      actorId: "automation-issue-notifier",
      action: "automation.issue_created_notification",
      entityType: "issue",
      entityId: notifiedAutomationIssueId,
      details: {
        issueId: notifiedAutomationIssueId,
        userId,
        source: "automation.issue_created_notification",
      },
      createdAt: new Date("2026-05-03T12:01:00.000Z"),
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const issueIds = new Set(thread.detail.items.map((item) => item.issueId));
    const notifiedItem = thread.detail.items.find((item) => item.issueId === notifiedAutomationIssueId);

    expect(issueIds.has(followedAutomationIssueId)).toBe(true);
    expect(issueIds.has(notifiedAutomationIssueId)).toBe(true);
    expect(issueIds.has(hiddenAutomationIssueId)).toBe(false);
    expect(notifiedItem).toMatchObject({
      issueId: notifiedAutomationIssueId,
      metadata: expect.objectContaining({
        followed: false,
      }),
      preview: "Automation created issue",
    });
    expect(thread.detail.unreadCount).toBe(2);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(2);
    const pinnedState = await messengerSvc.setThreadPinned(orgId, userId, `issue:${followedAutomationIssueId}`, true);
    expect(pinnedState).toEqual({ threadKey: `issue:${followedAutomationIssueId}`, pinned: true });
    const notifiedReadState = await messengerSvc.setThreadRead(
      orgId,
      userId,
      `issue:${notifiedAutomationIssueId}`,
      new Date("2026-05-03T12:00:00.000Z"),
    );
    expect(notifiedReadState?.lastReadAt.toISOString()).toBe("2026-05-03T12:01:00.000Z");
    const afterNotifiedRead = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const notifiedAfterRead = afterNotifiedRead.find((item) => item.threadKey === `issue:${notifiedAutomationIssueId}`);
    expect(notifiedAfterRead?.unreadCount).toBe(0);
    const notifiedPinnedState = await messengerSvc.setThreadPinned(orgId, userId, `issue:${notifiedAutomationIssueId}`, true);
    expect(notifiedPinnedState).toEqual({ threadKey: `issue:${notifiedAutomationIssueId}`, pinned: true });
    await expect(messengerSvc.setThreadPinned(orgId, userId, `issue:${hiddenAutomationIssueId}`, true)).resolves.toBeNull();
  });

  it("includes issue status transitions in Messenger issue update cards", async () => {
    const orgId = randomUUID();
    const userId = "board-user-status-transition";
    const issueId = randomUUID();
    const activityAt = new Date("2026-04-20T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Status Org",
      urlKey: deriveOrganizationUrlKey("Messenger Status Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Status transition issue",
      status: "in_review",
      priority: "medium",
      createdByUserId: userId,
      updatedAt: activityAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        status: "in_review",
        _previous: { status: "todo" },
      },
      createdAt: activityAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((entry) => entry.threadKey === "issues");

    expect(item?.preview).toBe("Status changed to in review");
    expect(item?.metadata).toMatchObject({
      status: "in_review",
      statusChange: { from: "todo", to: "in_review" },
    });
    expect(issuesSummary?.preview).toBe("Status transition issue — Status changed to in review");
  });

  it("summarizes issue goal updates in Messenger issue cards and thread summaries", async () => {
    const orgId = randomUUID();
    const userId = "board-user-goal-update";
    const issueId = randomUUID();
    const goalId = randomUUID();
    const previousGoalId = randomUUID();
    const activityAt = new Date("2026-04-20T10:30:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Goal Update Org",
      urlKey: deriveOrganizationUrlKey("Messenger Goal Update Org"),
      issuePrefix: `G${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Goal routing issue",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      updatedAt: activityAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        goalId,
        _references: { goal: { id: goalId, title: "Ignored goal reference" } },
        _previous: { goalId: previousGoalId },
      },
      createdAt: activityAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((entry) => entry.threadKey === "issues");

    expect(item?.preview).toBe("goal changed");
    expect(thread.summary.preview).toBe("Goal routing issue — goal changed");
    expect(issuesSummary?.preview).toBe("Goal routing issue — goal changed");
  });

  it("keeps status transition metadata on comment-backed issue update cards", async () => {
    const orgId = randomUUID();
    const userId = "board-user-comment-status";
    const issueId = randomUUID();
    const activityAt = new Date("2026-04-20T11:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Comment Status Org",
      urlKey: deriveOrganizationUrlKey("Messenger Comment Status Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Comment-backed status issue",
      status: "blocked",
      priority: "medium",
      createdByUserId: userId,
      updatedAt: activityAt,
    });

    const comment = await issueSvc.addComment(issueId, "Blocked on design review.", { authorAgentId: null });
    await db.update(issueComments).set({ createdAt: activityAt }).where(eq(issueComments.id, comment.id));

    await db.insert(activityLog).values({
      orgId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        status: "blocked",
        source: "comment",
        _previous: { status: "in_review" },
      },
      createdAt: activityAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.sourceCommentId).toBe(comment.id);
    expect(item?.sourceCommentBody).toBe("Blocked on design review.");
    expect(item?.sourceCommentAuthorLabel).toBe("System");
    expect(item?.preview).toBe("Blocked on design review.");
    expect(item?.metadata).toMatchObject({
      status: "blocked",
      statusChange: { from: "in_review", to: "blocked" },
      sourceCommentAuthorKind: "system",
      sourceCommentByMe: false,
      sourceCommentAuthorLabel: "System",
    });
  });

  it("preserves chat attachments when editing a user message into a new turn variant", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-edit-attachments";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Attachment Org",
      urlKey: deriveOrganizationUrlKey("Chat Attachment Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Attachment edit",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const original = await chatSvc.addUserChatMessage(conversationId, orgId, "Original message");
    await chatSvc.createAttachment({
      orgId,
      conversationId,
      messageId: original.id,
      provider: "local_disk",
      objectKey: `orgs/${orgId}/chats/${conversationId}/${randomUUID()}/image.png`,
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha256",
      originalFilename: "image.png",
      createdByAgentId: null,
      createdByUserId: userId,
    });

    const edited = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Edited message",
      original.id,
    );
    const messages = await chatSvc.listMessages(conversationId);
    const originalAfterEdit = messages.find((message) => message.id === original.id);
    const editedAfterEdit = messages.find((message) => message.id === edited.id);

    expect(originalAfterEdit?.supersededAt).toBeInstanceOf(Date);
    expect(originalAfterEdit?.attachments).toHaveLength(1);
    expect(edited.attachments).toHaveLength(1);
    expect(editedAfterEdit?.attachments).toHaveLength(1);
    expect(editedAfterEdit?.attachments[0]?.assetId).toBe(originalAfterEdit?.attachments[0]?.assetId);
    expect(editedAfterEdit?.attachments[0]?.contentPath).toBe(originalAfterEdit?.attachments[0]?.contentPath);
  });

  it("carries an immutable annotation snapshot across historical edits and rebinds attachment ids", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-edit-annotations";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Annotation Edit Org",
      urlKey: deriveOrganizationUrlKey("Chat Annotation Edit Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Annotation edit",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const sourceBody = "Original quote Replacement quote";
    const source = await insertChatAnnotationSource(
      orgId,
      conversationId,
      sourceBody,
    );
    const annotationId = randomUUID();
    const original = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Original annotated message",
      null,
      {
        structuredPayload: {
          inlineAnnotations: [{
            id: annotationId,
            surface: "assistant_body",
            selectedText: "Original quote",
            comment: "Original comment",
            sourceConversationId: conversationId,
            sourceMessageId: source.id,
            sourceHash: hashChatAnnotationSource(sourceBody),
            start: 0,
            end: "Original quote".length,
            prefix: "",
            suffix: "",
            attachmentIds: [],
          }],
        },
        structuredPayloadProvided: true,
      },
    );
    const originalAttachment = await chatSvc.createAttachment({
      orgId,
      conversationId,
      messageId: original.id,
      provider: "local_disk",
      objectKey: `orgs/${orgId}/chats/${conversationId}/${randomUUID()}/annotation.txt`,
      contentType: "text/plain",
      byteSize: 12,
      sha256: "sha256",
      originalFilename: "annotation.txt",
      createdByAgentId: null,
      createdByUserId: userId,
    });
    await db
      .update(chatMessages)
      .set({
        structuredPayload: {
          inlineAnnotations: [{
            ...chatInlineAnnotationsFromStructuredPayload(original.structuredPayload)[0]!,
            attachmentIds: [originalAttachment.id],
          }],
        },
      })
      .where(eq(chatMessages.id, original.id));

    const carried = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Carried annotation",
      original.id,
    );
    const carriedAnnotation = chatInlineAnnotationsFromStructuredPayload(
      carried.structuredPayload,
    )[0]!;
    expect(carriedAnnotation.id).toBe(annotationId);
    expect(carriedAnnotation.selectedText).toBe("Original quote");
    expect(carried.attachments).toHaveLength(1);
    expect(carriedAnnotation.attachmentIds).toEqual([carried.attachments[0]!.id]);
    expect(carriedAnnotation.attachmentIds).not.toEqual([originalAttachment.id]);

    const carriedSnapshot = chatInlineAnnotationsFromStructuredPayload(
      carried.structuredPayload,
    );
    const retried = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "",
      carried.id,
      {
        structuredPayloadProvided: true,
        structuredPayload: {
          inlineAnnotations: carriedSnapshot,
        },
      },
    );
    const retriedSnapshot = chatInlineAnnotationsFromStructuredPayload(
      retried.structuredPayload,
    );
    expect(retried.body).toBe("");
    expect(retriedSnapshot).toEqual([
      expect.objectContaining({
        id: annotationId,
        selectedText: "Original quote",
        comment: "Original comment",
        attachmentIds: [retried.attachments[0]!.id],
      }),
    ]);
    expect(retriedSnapshot[0]!.attachmentIds).not.toContain(carried.attachments[0]!.id);
    await db
      .update(chatMessages)
      .set({ supersededAt: new Date() })
      .where(eq(chatMessages.id, source.id));
    const unlocatableSourceRetry = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Carry the immutable snapshot even when its source is unavailable",
      retried.id,
    );
    const unlocatableSnapshot = chatInlineAnnotationsFromStructuredPayload(
      unlocatableSourceRetry.structuredPayload,
    );
    expect(unlocatableSnapshot).toEqual([
      expect.objectContaining({
        id: annotationId,
        selectedText: "Original quote",
        attachmentIds: [unlocatableSourceRetry.attachments[0]!.id],
      }),
    ]);

    await expect(chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Mutated annotation",
      unlocatableSourceRetry.id,
      {
        structuredPayloadProvided: true,
        structuredPayload: {
          inlineAnnotations: [{
            ...unlocatableSnapshot[0]!,
            comment: "Changed after send",
          }],
        },
      },
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("immutable"),
    });
    await expect(chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Dropped annotation",
      unlocatableSourceRetry.id,
      {
        structuredPayloadProvided: true,
        structuredPayload: { inlineAnnotations: [] },
      },
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("immutable"),
    });
    await expect(chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Added file",
      unlocatableSourceRetry.id,
      {
        structuredPayloadProvided: true,
        structuredPayload: {
          inlineAnnotations: unlocatableSnapshot,
        },
        attachments: [{
          provider: "local_disk",
          objectKey: `orgs/${orgId}/chats/${conversationId}/${randomUUID()}/extra.txt`,
          contentType: "text/plain",
          byteSize: 5,
          sha256: "extra-sha256",
          originalFilename: "extra.txt",
          createdByAgentId: null,
          createdByUserId: userId,
        }],
        attachmentFileIndexesByAnnotationId: new Map([[annotationId, [0]]]),
      },
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("immutable"),
    });

    const activeRows = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "user"),
        isNull(chatMessages.supersededAt),
      ));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.id).toBe(unlocatableSourceRetry.id);
  });

  it("rolls back an edit variant when an annotation attachment cannot be rebound", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-edit-annotation-rollback";
    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Annotation Rollback Org",
      urlKey: deriveOrganizationUrlKey("Chat Annotation Rollback Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Annotation rollback",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const sourceBody = "Quote";
    const source = await insertChatAnnotationSource(
      orgId,
      conversationId,
      sourceBody,
    );
    const original = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Original",
    );
    await db
      .update(chatMessages)
      .set({
        structuredPayload: {
          inlineAnnotations: [{
            id: randomUUID(),
            surface: "assistant_body",
            selectedText: "Quote",
            comment: null,
            sourceConversationId: conversationId,
            sourceMessageId: source.id,
            sourceHash: hashChatAnnotationSource(sourceBody),
            start: 0,
            end: 5,
            prefix: "",
            suffix: "",
            attachmentIds: [randomUUID()],
          }],
        },
      })
      .where(eq(chatMessages.id, original.id));

    await expect(chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Edited",
      original.id,
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/belong|rebound/),
    });

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === original.id)).toMatchObject({
      id: original.id,
      supersededAt: null,
      body: "Original",
    });
  });

  it("accepts the exact completed parent anchor in a Side Chat and binds its files to the child user message", async () => {
    const orgId = randomUUID();
    const parentConversationId = randomUUID();
    const sideConversationId = randomUUID();
    const annotationId = randomUUID();
    const sourceBody = "Parent response with selected guidance.";
    const selectedText = "selected guidance";
    const start = sourceBody.indexOf(selectedText);
    await db.insert(organizations).values({
      id: orgId,
      name: "Side Chat Annotation Org",
      urlKey: deriveOrganizationUrlKey("Side Chat Annotation Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: parentConversationId,
      orgId,
      title: "Parent annotation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "board-user-side-annotation",
    });
    const source = await insertChatAnnotationSource(
      orgId,
      parentConversationId,
      sourceBody,
    );
    await db.insert(chatConversations).values({
      id: sideConversationId,
      orgId,
      title: "Side annotation chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      forkedFromConversationId: parentConversationId,
      forkedFromMessageId: source.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "board-user-side-annotation",
    });
    const annotation = {
      id: annotationId,
      surface: "assistant_body" as const,
      selectedText,
      comment: "Use this parent context",
      sourceConversationId: parentConversationId,
      sourceMessageId: source.id,
      sourceHash: hashChatAnnotationSource(sourceBody),
      start,
      end: start + selectedText.length,
      prefix: sourceBody.slice(0, start),
      suffix: sourceBody.slice(start + selectedText.length),
      attachmentIds: [],
    };

    const childMessage = await chatSvc.addUserChatMessage(
      sideConversationId,
      orgId,
      "",
      null,
      {
        structuredPayloadProvided: true,
        structuredPayload: { inlineAnnotations: [annotation] },
        attachments: [{
          provider: "local_disk",
          objectKey: `side-chat-annotations/${sideConversationId}/context.txt`,
          contentType: "text/plain",
          byteSize: 7,
          sha256: "side-chat-annotation-sha256",
          originalFilename: "context.txt",
          createdByAgentId: null,
          createdByUserId: "board-user-side-annotation",
        }],
        attachmentFileIndexesByAnnotationId: new Map([[annotationId, [0]]]),
      },
    );

    expect(childMessage.body).toBe("");
    expect(childMessage.attachments).toHaveLength(1);
    expect(childMessage.attachments[0]).toMatchObject({
      conversationId: sideConversationId,
      messageId: childMessage.id,
    });
    expect(chatInlineAnnotationsFromStructuredPayload(childMessage.structuredPayload)).toEqual([
      expect.objectContaining({
        id: annotationId,
        sourceConversationId: parentConversationId,
        sourceMessageId: source.id,
        attachmentIds: [childMessage.attachments[0]!.id],
      }),
    ]);
  });

  it("rejects Side Chat annotation sources outside the exact completed owning parent anchor", async () => {
    const orgId = randomUUID();
    const foreignOrgId = randomUUID();
    const parentConversationId = randomUUID();
    const siblingConversationId = randomUUID();
    const foreignConversationId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Side Chat Lineage Org",
        urlKey: deriveOrganizationUrlKey("Side Chat Lineage Org"),
        issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: foreignOrgId,
        name: "Foreign Side Chat Lineage Org",
        urlKey: deriveOrganizationUrlKey("Foreign Side Chat Lineage Org"),
        issuePrefix: `F${foreignOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(chatConversations).values([
      {
        id: parentConversationId,
        orgId,
        title: "Parent lineage",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: siblingConversationId,
        orgId,
        title: "Sibling lineage",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: foreignConversationId,
        orgId: foreignOrgId,
        title: "Foreign lineage",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    const sourceBody = "Stable lineage source";
    const parentAnchor = await insertChatAnnotationSource(
      orgId,
      parentConversationId,
      sourceBody,
    );
    const arbitraryParentMessage = await insertChatAnnotationSource(
      orgId,
      parentConversationId,
      sourceBody,
    );
    const siblingSource = await insertChatAnnotationSource(
      orgId,
      siblingConversationId,
      sourceBody,
    );
    const foreignSource = await insertChatAnnotationSource(
      foreignOrgId,
      foreignConversationId,
      sourceBody,
    );
    const [stoppedSource, failedSource] = await db
      .insert(chatMessages)
      .values(["stopped", "failed"].map((status) => ({
        orgId,
        conversationId: parentConversationId,
        role: "assistant",
        kind: "message",
        status,
        body: sourceBody,
      })))
      .returning();

    const cases = [
      {
        label: "sibling",
        owningSource: parentAnchor,
        sourceConversationId: siblingConversationId,
        sourceMessage: siblingSource,
      },
      {
        label: "arbitrary",
        owningSource: parentAnchor,
        sourceConversationId: parentConversationId,
        sourceMessage: arbitraryParentMessage,
      },
      {
        label: "foreign",
        owningSource: parentAnchor,
        sourceConversationId: foreignConversationId,
        sourceMessage: foreignSource,
      },
      {
        label: "stopped",
        owningSource: stoppedSource!,
        sourceConversationId: parentConversationId,
        sourceMessage: stoppedSource!,
      },
      {
        label: "failed",
        owningSource: failedSource!,
        sourceConversationId: parentConversationId,
        sourceMessage: failedSource!,
      },
    ];
    for (const testCase of cases) {
      const sideConversationId = randomUUID();
      await db.insert(chatConversations).values({
        id: sideConversationId,
        orgId,
        title: `Rejected ${testCase.label} lineage`,
        conversationKind: "side_chat",
        sideChatState: "active",
        forkedFromConversationId: parentConversationId,
        forkedFromMessageId: testCase.owningSource.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      });
      await expect(chatInlineAnnotationService(db).prepare({
        orgId,
        conversationId: sideConversationId,
        uploadedFileCount: 0,
        annotations: [{
          id: randomUUID(),
          surface: "assistant_body",
          selectedText: sourceBody,
          comment: testCase.label,
          sourceConversationId: testCase.sourceConversationId,
          sourceMessageId: testCase.sourceMessage.id,
          sourceHash: hashChatAnnotationSource(sourceBody),
          start: 0,
          end: sourceBody.length,
          prefix: "",
          suffix: "",
          attachmentIds: [],
        }],
      })).rejects.toMatchObject({ status: 422 });
    }
  });

  it("revalidates a prepared annotation inside the message transaction before writing", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Annotation Transaction Org",
      urlKey: deriveOrganizationUrlKey("Chat Annotation Transaction Org"),
      issuePrefix: `V${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Annotation transaction",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "board-user-annotation-transaction",
    });
    const sourceBody = "Stable source";
    const source = await insertChatAnnotationSource(
      orgId,
      conversationId,
      sourceBody,
    );
    const prepared = await chatInlineAnnotationService(db).prepare({
      orgId,
      conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "assistant_body",
        selectedText: sourceBody,
        comment: null,
        sourceConversationId: conversationId,
        sourceMessageId: source.id,
        sourceHash: hashChatAnnotationSource(sourceBody),
        start: 0,
        end: sourceBody.length,
        prefix: "",
        suffix: "",
        attachmentIds: [],
      }],
    });
    await db.update(chatMessages)
      .set({ supersededAt: new Date() })
      .where(eq(chatMessages.id, source.id));

    await expect(chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "This must not persist",
      null,
      {
        structuredPayloadProvided: true,
        structuredPayload: { inlineAnnotations: prepared.annotations },
      },
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("remain visible"),
    });

    const userRows = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "user"),
      ));
    expect(userRows).toEqual([]);
  });

  it("atomically creates annotation assets, attachments, and canonical file bindings", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const annotationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Annotation Atomic Org",
      urlKey: deriveOrganizationUrlKey("Chat Annotation Atomic Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Annotation atomic attachment",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "board-user-annotation-atomic",
    });
    const sourceBody = "Quote";
    const source = await insertChatAnnotationSource(
      orgId,
      conversationId,
      sourceBody,
    );

    const created = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Review the quote",
      null,
      {
        structuredPayloadProvided: true,
        structuredPayload: {
          inlineAnnotations: [{
            id: annotationId,
            surface: "assistant_body",
            selectedText: "Quote",
            comment: null,
            sourceConversationId: conversationId,
            sourceMessageId: source.id,
            sourceHash: hashChatAnnotationSource(sourceBody),
            start: 0,
            end: 5,
            prefix: "",
            suffix: "",
            attachmentIds: [],
          }],
        },
        attachments: [{
          provider: "local_disk",
          objectKey: `chat-annotation/${randomUUID()}/context.txt`,
          contentType: "text/plain",
          byteSize: 7,
          sha256: "atomic-sha256",
          originalFilename: "context.txt",
          createdByAgentId: null,
          createdByUserId: "board-user-annotation-atomic",
        }],
        attachmentFileIndexesByAnnotationId: new Map([[annotationId, [0]]]),
      },
    );

    expect(created.attachments).toHaveLength(1);
    expect(chatInlineAnnotationsFromStructuredPayload(created.structuredPayload)).toEqual([
      expect.objectContaining({
        id: annotationId,
        attachmentIds: [created.attachments[0]!.id],
      }),
    ]);
    expect(await db.select().from(assets).where(eq(assets.orgId, orgId))).toHaveLength(1);
    expect(await db.select().from(chatAttachments).where(
      eq(chatAttachments.messageId, created.id),
    )).toHaveLength(1);
  });

  it("rolls back message and attachment rows when an annotation file binding cannot commit", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const annotationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Annotation Atomic Rollback Org",
      urlKey: deriveOrganizationUrlKey("Chat Annotation Atomic Rollback Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Annotation atomic rollback",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "board-user-annotation-rollback",
    });

    await expect(chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Review the quote",
      null,
      {
        structuredPayloadProvided: true,
        structuredPayload: {
          inlineAnnotations: [{
            id: annotationId,
            surface: "assistant_body",
            selectedText: "Quote",
            comment: null,
            sourceConversationId: conversationId,
            sourceMessageId: randomUUID(),
            sourceHash: "a".repeat(64),
            start: 0,
            end: 5,
            prefix: "",
            suffix: "",
            attachmentIds: [],
          }],
        },
        attachments: [{
          provider: "local_disk",
          objectKey: `chat-annotation/${randomUUID()}/context.txt`,
          contentType: "text/plain",
          byteSize: 7,
          sha256: "atomic-sha256",
          originalFilename: "context.txt",
          createdByAgentId: null,
          createdByUserId: "board-user-annotation-rollback",
        }],
        attachmentFileIndexesByAnnotationId: new Map([[annotationId, [1]]]),
      },
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("does not match an uploaded file"),
    });

    expect(await db.select().from(chatMessages).where(
      eq(chatMessages.conversationId, conversationId),
    )).toEqual([]);
    expect(await db.select().from(assets).where(eq(assets.orgId, orgId))).toEqual([]);
    expect(await db.select().from(chatAttachments).where(
      eq(chatAttachments.conversationId, conversationId),
    )).toEqual([]);
  });

  it("can list chat messages without hydrating full persisted transcripts", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-light-messages";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Lightweight Messages Org",
      urlKey: deriveOrganizationUrlKey("Chat Lightweight Messages Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Transcript payload",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const message = await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Done",
      transcript: [
        { kind: "stdout", ts: "2026-03-26T08:00:00.000Z", text: "large output" },
        { kind: "result", ts: "2026-03-26T08:01:30.000Z", text: "done", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, subtype: "success", isError: false, errors: [] },
      ],
    });

    const [lightweight] = await chatSvc.listMessages(conversationId, { includeTranscript: false });
    const transcript = await chatSvc.getMessageTranscript(conversationId, message.id);

    expect(lightweight?.transcript).toBeUndefined();
    expect(lightweight?.transcriptSummary).toEqual({
      entryCount: 2,
      startedAt: "2026-03-26T08:00:00.000Z",
      endedAt: "2026-03-26T08:01:30.000Z",
    });
    expect(lightweight?.structuredPayload).toBeNull();
    expect(transcript?.transcript).toHaveLength(2);
  });

  it("hydrates generation-ledger transcripts without embedding them in chat messages", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Generation Ledger Transcript Org",
      urlKey: deriveOrganizationUrlKey("Generation Ledger Transcript Org"),
      issuePrefix: `E${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Generation ledger transcript",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "stopped",
      acceptedThroughSeq: 2,
    });
    const assistantMessage = await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Final reply",
    });
    const entries = [
      {
        kind: "thinking",
        ts: "2026-07-23T08:00:00.000Z",
        text: "Inspecting production evidence",
      },
      {
        kind: "tool_call",
        ts: "2026-07-23T08:00:30.000Z",
        name: "read_file",
        input: { path: "/tmp/example" },
      },
      {
        kind: "result",
        ts: "2026-07-23T08:01:00.000Z",
        text: "Done",
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ] satisfies Array<Record<string, unknown>>;
    await db.insert(chatGenerationEvents).values([
      ...entries.map((entry, index) => ({
        orgId,
        generationId,
        generationSeq: index + 1,
        attemptEpoch: 1,
        eventKind: "transcript" as const,
        payload: { entry },
        assistantMessageId: assistantMessage.id,
      })),
      {
        orgId,
        generationId,
        generationSeq: entries.length + 1,
        attemptEpoch: 1,
        eventKind: "runtime_output" as const,
        payload: { body: "Final reply" },
        assistantMessageId: assistantMessage.id,
      },
    ]);

    const messages = await chatSvc.listMessages(conversationId);
    const [lightweight] = await chatSvc.listMessages(conversationId, { includeTranscript: false });
    const transcript = await chatSvc.getMessageTranscript(conversationId, assistantMessage.id);
    const hydrated = messages.find((message) => message.id === assistantMessage.id);

    expect(lightweight?.transcript).toBeUndefined();
    expect(lightweight?.transcriptSummary).toEqual({
      entryCount: 2,
      startedAt: "2026-07-23T08:00:00.000Z",
      endedAt: "2026-07-23T08:00:30.000Z",
    });
    const expectedTranscript = [
      {
        ...entries[0],
        generationId,
        generationSeqStart: 1,
        generationSeqEnd: 1,
      },
      entries[1],
    ];
    expect(hydrated?.transcript).toEqual(expectedTranscript);
    expect(transcript?.transcript).toEqual(expectedTranscript);
  });

  it("lists only the latest five eligible user messages for title generation", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Title Source Org",
      urlKey: deriveOrganizationUrlKey("Chat Title Source Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Title source",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const startedAt = new Date("2026-07-21T08:00:00.000Z").getTime();
    await db.insert(chatMessages).values([
      ...Array.from({ length: 7 }, (_, index) => ({
        id: randomUUID(),
        orgId,
        conversationId,
        role: "user" as const,
        kind: "message" as const,
        body: `User request ${index + 1}`,
        createdAt: new Date(startedAt + index * 1_000),
        updatedAt: new Date(startedAt + index * 1_000),
      })),
      {
        id: randomUUID(),
        orgId,
        conversationId,
        role: "assistant",
        kind: "message",
        body: "Assistant noise",
        createdAt: new Date(startedAt + 8_000),
        updatedAt: new Date(startedAt + 8_000),
      },
      {
        id: randomUUID(),
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        body: "   ",
        createdAt: new Date(startedAt + 9_000),
        updatedAt: new Date(startedAt + 9_000),
      },
      {
        id: randomUUID(),
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        body: "\t\n",
        createdAt: new Date(startedAt + 9_500),
        updatedAt: new Date(startedAt + 9_500),
      },
      {
        id: randomUUID(),
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        body: "\u3000",
        createdAt: new Date(startedAt + 9_600),
        updatedAt: new Date(startedAt + 9_600),
      },
      {
        id: randomUUID(),
        orgId,
        conversationId,
        role: "user",
        kind: "system_event",
        body: "User event noise",
        createdAt: new Date(startedAt + 10_000),
        updatedAt: new Date(startedAt + 10_000),
      },
      {
        id: randomUUID(),
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        body: "Superseded user noise",
        supersededAt: new Date(startedAt + 12_000),
        createdAt: new Date(startedAt + 11_000),
        updatedAt: new Date(startedAt + 12_000),
      },
    ]);

    const messages = await chatSvc.listRecentUserMessages(conversationId, 5);

    expect(messages.map((message) => message.body)).toEqual([
      "User request 3",
      "User request 4",
      "User request 5",
      "User request 6",
      "User request 7",
    ]);
  });

  it("hydrates the generation that owns a persisted assistant message", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    const unrelatedConversationId = randomUUID();
    const unrelatedGenerationId = randomUUID();
    const operatorStopGenerationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Generation Projection Org",
      urlKey: deriveOrganizationUrlKey("Chat Generation Projection Org"),
      issuePrefix: `G${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Generation projection",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatConversations).values({
      id: unrelatedConversationId,
      orgId,
      title: "Unrelated generation projection",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "stop_requested",
      terminalReason: "steer_fallback",
      acceptedThroughSeq: 1,
    });
    await db.insert(chatGenerations).values({
      id: operatorStopGenerationId,
      orgId,
      conversationId,
      status: "stopped",
      terminalReason: "operator_stop",
    });
    await db.insert(chatGenerations).values({
      id: unrelatedGenerationId,
      orgId,
      conversationId: unrelatedConversationId,
      status: "stopped",
      terminalReason: "operator_stop",
    });
    const assistantMessage = await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Final reply",
    });
    await db.insert(chatGenerationEvents).values([
      {
        orgId,
        generationId,
        generationSeq: 1,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: {
          entry: {
            kind: "thinking",
            ts: "2026-07-21T08:00:00.000Z",
            text: "Reasoning around native Steer",
          },
        },
        assistantMessageId: assistantMessage.id,
      },
      {
        orgId,
        generationId,
        generationSeq: 2,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: {
          entry: {
            kind: "thinking",
            ts: "2026-07-21T08:00:01.000Z",
            text: "Reasoning after the Steer cutoff",
          },
        },
        assistantMessageId: assistantMessage.id,
      },
      {
        orgId,
        generationId,
        generationSeq: 3,
        attemptEpoch: 1,
        eventKind: "runtime_output",
        payload: { body: "Final reply" },
        assistantMessageId: assistantMessage.id,
      },
    ]);
    await chatSvc.generationProtocol.recordRuntimeTerminal({
      orgId,
      conversationId,
      generationId,
      expectedAttemptEpoch: 1,
      finalStatus: "interrupted_unverified",
      terminalReason: "runtime_interrupted",
    });
    const operatorStoppedMessage = await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "stopped",
      body: "Operator stopped this response.",
    });
    await db.insert(chatGenerationEvents).values({
      orgId,
      generationId: operatorStopGenerationId,
      generationSeq: 1,
      attemptEpoch: 1,
      eventKind: "runtime_output",
      payload: { body: "Operator stopped this response." },
      assistantMessageId: operatorStoppedMessage.id,
    });
    await db.insert(chatGenerationEvents).values({
      orgId,
      generationId: unrelatedGenerationId,
      generationSeq: 99,
      attemptEpoch: 1,
      eventKind: "runtime_output",
      payload: { body: "Wrong conversation" },
      assistantMessageId: assistantMessage.id,
    });
    await chatSvc.addMessage(conversationId, {
      orgId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Native feedback",
      structuredPayload: {
        source: "steer",
        targetGenerationId: generationId,
        afterTranscriptEntryCount: 1,
        generationSeq: 2,
        deliveryDisposition: "accepted_current",
      },
    });

    const messages = await chatSvc.listMessages(conversationId, { includeTranscript: false });
    const hydratedAssistant = messages.find((message) => message.id === assistantMessage.id) as
      | (typeof assistantMessage & { generationId?: string | null; generationTerminalReason?: string | null })
      | undefined;

    expect(hydratedAssistant?.generationId).toBe(generationId);
    expect(hydratedAssistant?.generationTerminalReason).toBe("steer_fallback_unverified");
    expect(messages.find((message) => message.id === operatorStoppedMessage.id))
      .toMatchObject({ generationTerminalReason: "operator_stop", status: "stopped" });
    expect(hydratedAssistant?.transcript).toEqual([
      expect.objectContaining({ kind: "thinking", text: "Reasoning around native Steer" }),
    ]);
    expect(JSON.stringify(hydratedAssistant?.transcript)).not.toContain("Reasoning after the Steer cutoff");
  });

  it("does not mark a chat unread until an incoming message has visible content", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-visible-unread";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Visible Unread Org",
      urlKey: deriveOrganizationUrlKey("Chat Visible Unread Org"),
      issuePrefix: `V${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Visible unread chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    await chatSvc.markRead(conversationId, orgId, userId, new Date("2026-05-01T00:00:00.000Z"));
    const placeholder = await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "",
    });

    const [afterPlaceholder] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterPlaceholder?.unreadCount).toBe(0);
    expect(afterPlaceholder?.needsAttention).toBe(false);
    expect(afterPlaceholder?.lastMessageAt).toBeNull();

    const visible = await chatSvc.updateMessage(conversationId, placeholder.id, {
      status: "streaming",
      body: "First visible assistant token",
    });
    expect(visible?.createdAt.getTime()).toBeGreaterThan(placeholder.createdAt.getTime());

    const [afterVisibleContent] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterVisibleContent?.unreadCount).toBe(1);
    expect(afterVisibleContent?.needsAttention).toBe(true);
    expect(afterVisibleContent?.latestReplyPreview).toBe("First visible assistant token");

    await chatSvc.markRead(conversationId, orgId, userId, new Date("2999-01-01T00:00:00.000Z"));
    await chatSvc.updateMessage(conversationId, placeholder.id, { status: "completed" });

    const [afterStatusOnlyUpdate] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterStatusOnlyUpdate?.unreadCount).toBe(0);
    expect(afterStatusOnlyUpdate?.needsAttention).toBe(false);
  });

  it("surfaces agent-authored chat messages as unread incoming replies", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const agentId = randomUUID();
    const userId = "board-user-agent-direct-chat";

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Direct Chat Org",
      urlKey: deriveOrganizationUrlKey("Agent Direct Chat Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "general",
      status: "idle",
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Agent direct chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    await chatSvc.markRead(conversationId, orgId, userId, new Date("2026-05-01T00:00:00.000Z"));
    await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Agent completed the requested handoff.",
      replyingAgentId: agentId,
    });

    const [afterAgentMessage] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterAgentMessage?.latestReplyPreview).toBe("Agent completed the requested handoff.");
    expect(afterAgentMessage?.unreadCount).toBe(1);
    expect(afterAgentMessage?.isUnread).toBe(true);
    expect(afterAgentMessage?.needsAttention).toBe(true);
  });

  it("does not mark Feishu-bound chats unread in Messenger summaries", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const agentId = randomUUID();
    const secretId = randomUUID();
    const integrationId = randomUUID();
    const approvalId = randomUUID();
    const userId = "board-user-feishu-unread";

    await db.insert(organizations).values({
      id: orgId,
      name: "Feishu Unread Org",
      urlKey: deriveOrganizationUrlKey("Feishu Unread Org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Feishu Agent",
      role: "general",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(organizationSecrets).values({
      id: secretId,
      orgId,
      name: "Feishu credential",
      provider: "local_encrypted",
    });
    await db.insert(agentIntegrations).values({
      id: integrationId,
      orgId,
      agentId,
      provider: "feishu",
      status: "active",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: secretId,
      externalAppId: "cli_a_feishu_app_unread",
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "hi, what skill do you have?",
      issueCreationMode: "manual_approval",
      planMode: false,
      preferredAgentId: agentId,
      lastMessageAt: new Date("2026-06-24T07:42:00.000Z"),
      createdAt: new Date("2026-06-24T07:40:00.000Z"),
      updatedAt: new Date("2026-06-24T07:42:00.000Z"),
    });
    await db.insert(agentIntegrationChatBindings).values({
      orgId,
      integrationId,
      conversationId,
      externalChatId: "oc_feishu_unread",
      externalChatType: "p2p",
    });

    await chatSvc.markRead(conversationId, orgId, userId, new Date("2026-06-24T07:41:00.000Z"));
    await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "I'm the CMO agent.",
      replyingAgentId: agentId,
    });

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const chatSummary = summaries.find((item) => item.threadKey === `chat:${conversationId}`);
    const [conversation] = await chatSvc.list(orgId, { status: "active" }, userId);

    expect(chatSummary?.metadata).toMatchObject({
      source: "agent_integration",
      provider: "feishu",
    });
    expect(chatSummary?.unreadCount).toBe(0);
    expect(chatSummary?.needsAttention).toBe(false);
    expect(conversation?.mutability).toBe("external_bound_chat");
    expect(conversation?.unreadCount).toBe(0);
    expect(conversation?.isUnread).toBe(false);
    expect(conversation?.needsAttention).toBe(false);

    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_issue_creation",
      requestedByUserId: userId,
      status: "pending",
      payload: { proposedIssue: { title: "Do not badge Feishu" } },
      createdAt: new Date("2026-06-24T07:43:00.000Z"),
      updatedAt: new Date("2026-06-24T07:43:00.000Z"),
    });
    await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "issue_proposal",
      status: "completed",
      body: "",
      approvalId,
      replyingAgentId: agentId,
    });

    const summariesAfterApproval = await messengerSvc.listThreadSummaries(orgId, userId);
    const chatSummaryAfterApproval = summariesAfterApproval.find((item) => item.threadKey === `chat:${conversationId}`);
    const [conversationAfterApproval] = await chatSvc.list(orgId, { status: "active" }, userId);

    expect(chatSummaryAfterApproval?.unreadCount).toBe(0);
    expect(chatSummaryAfterApproval?.needsAttention).toBe(false);
    expect(conversationAfterApproval?.unreadCount).toBe(0);
    expect(conversationAfterApproval?.isUnread).toBe(false);
    expect(conversationAfterApproval?.needsAttention).toBe(false);
  });

  it("hydrates deterministic latest user previews and user message counts", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-latest-question-preview";
    const sharedTimestamp = new Date("2026-05-01T12:00:00.000Z");
    const olderUserMessageId = "00000000-0000-4000-8000-000000000001";
    const newerUserMessageId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Latest User Preview Org",
      urlKey: deriveOrganizationUrlKey("Chat Latest User Preview Org"),
      issuePrefix: `Q${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Latest question preview",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
      lastMessageAt: sharedTimestamp,
      createdAt: sharedTimestamp,
      updatedAt: sharedTimestamp,
    });

    await db.insert(chatMessages).values([
      {
        id: olderUserMessageId,
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        body: "Older user question with the same timestamp",
        createdAt: sharedTimestamp,
        updatedAt: sharedTimestamp,
      },
      {
        id: newerUserMessageId,
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        body: "Newer user question with the same timestamp",
        createdAt: sharedTimestamp,
        updatedAt: sharedTimestamp,
      },
      {
        orgId,
        conversationId,
        role: "assistant",
        kind: "message",
        body: "Assistant reply is still separately available",
        createdAt: new Date("2026-05-01T12:01:00.000Z"),
        updatedAt: new Date("2026-05-01T12:01:00.000Z"),
      },
    ]);

    const [conversation] = await chatSvc.list(orgId, { status: "active" }, userId);

    expect(conversation?.userMessageCount).toBe(2);
    expect(conversation?.latestUserMessagePreview).toBe("Newer user question with the same timestamp");
    expect(conversation?.latestReplyPreview).toBe("Assistant reply is still separately available");
  });

  it("does not replace a manually renamed chat title with an async generated title", async () => {
    const orgId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Manual Rename Org",
      urlKey: deriveOrganizationUrlKey("Chat Manual Rename Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversation = await chatSvc.create(orgId, {
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: null,
    });
    expect(conversation?.title).toBe("New chat");

    await chatSvc.updateDefaultTitle(conversation!.id, "Plan the release checklist");
    await chatSvc.update(conversation!.id, { title: "Manual release name" });

    const replaced = await chatSvc.replaceSystemGeneratedTitle(
      conversation!.id,
      "Plan the release checklist",
      "AI release plan",
    );
    expect(replaced).toBeNull();

    const stored = await chatSvc.getById(conversation!.id);
    expect(stored?.title).toBe("Manual release name");
  });

  it("includes the latest user message preview in Messenger chat thread summaries", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-chat-summary-user-preview";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Summary User Preview Org",
      urlKey: deriveOrganizationUrlKey("Chat Summary User Preview Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "New chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
      lastMessageAt: new Date("2026-05-01T12:01:00.000Z"),
      createdAt: new Date("2026-05-01T12:00:00.000Z"),
      updatedAt: new Date("2026-05-01T12:01:00.000Z"),
    });
    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId,
        role: "user",
        kind: "message",
        body: "Plan the launch checklist from this chat",
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
        updatedAt: new Date("2026-05-01T12:00:00.000Z"),
      },
      {
        orgId,
        conversationId,
        role: "assistant",
        kind: "message",
        body: "Assistant reply should stay a preview only",
        createdAt: new Date("2026-05-01T12:01:00.000Z"),
        updatedAt: new Date("2026-05-01T12:01:00.000Z"),
      },
    ]);

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const chatSummary = summaries.find((summary) => summary.threadKey === `chat:${conversationId}`);

    expect(chatSummary?.title).toBe("New chat");
    expect(chatSummary?.preview).toBe("Assistant reply should stay a preview only");
    expect(chatSummary?.metadata?.latestUserMessagePreview).toBe("Plan the launch checklist from this chat");
  });

  it("can mark a read chat unread by rewinding to the latest visible incoming message", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-mark-unread";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Mark Unread Org",
      urlKey: deriveOrganizationUrlKey("Chat Mark Unread Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Mark unread chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    await chatSvc.addUserChatMessage(conversationId, orgId, "User messages are not unread work.");
    await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Incoming assistant reply",
    });
    await chatSvc.markRead(conversationId, orgId, userId, new Date("2999-01-01T00:00:00.000Z"));

    const [afterRead] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterRead?.unreadCount).toBe(0);

    await chatSvc.markUnread(conversationId, orgId, userId);

    const [afterUnread] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterUnread?.unreadCount).toBe(1);
    expect(afterUnread?.isUnread).toBe(true);
    expect(afterUnread?.needsAttention).toBe(true);
  });

  it("clears chat attention after the current issue proposal approval is resolved", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-resolved-proposal-attention";
    const revisionApprovalId = randomUUID();
    const currentApprovalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Resolved Proposal Attention Org",
      urlKey: deriveOrganizationUrlKey("Chat Resolved Proposal Attention Org"),
      issuePrefix: `CP${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversation = await chatSvc.create(orgId, {
      title: "Resolve proposal attention",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    await db.insert(approvals).values([
      {
        id: revisionApprovalId,
        orgId,
        type: "chat_issue_creation",
        status: "revision_requested",
        requestedByUserId: userId,
        decisionNote: "Add architecture details.",
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Initial proposal",
            description: "Needs more detail.",
            priority: "medium",
            assigneeUnassignedReason: "The owner is still under review.",
          },
        },
      },
      {
        id: currentApprovalId,
        orgId,
        type: "chat_issue_creation",
        status: "pending",
        requestedByUserId: userId,
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Detailed proposal",
            description: "Includes architecture and rollout details.",
            priority: "medium",
            assigneeUnassignedReason: "The owner is still under review.",
          },
        },
      },
    ]);
    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId: conversation!.id,
        role: "assistant",
        kind: "issue_proposal",
        body: "Initial proposal",
        approvalId: revisionApprovalId,
      },
      {
        orgId,
        conversationId: conversation!.id,
        role: "assistant",
        kind: "issue_proposal",
        body: "Detailed proposal",
        approvalId: currentApprovalId,
      },
    ]);
    await chatSvc.markRead(conversation!.id, orgId, userId, new Date("2999-01-01T00:00:00.000Z"));

    const [withPendingApproval] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(withPendingApproval?.unreadCount).toBe(0);
    expect(withPendingApproval?.needsAttention).toBe(true);

    await db
      .update(approvals)
      .set({
        status: "approved",
        decidedByUserId: userId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, currentApprovalId));

    const [afterCurrentApprovalResolved] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterCurrentApprovalResolved?.unreadCount).toBe(0);
    expect(afterCurrentApprovalResolved?.needsAttention).toBe(false);
  });

  it("searches chat conversations by title, summary, and message body without leaking organizations", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const titleChatId = randomUUID();
    const messageChatId = randomUUID();
    const summaryChatId = randomUUID();
    const otherOrgChatId = randomUUID();
    const userId = "board-user-chat-search";
    const olderAt = new Date("2026-05-01T10:00:00.000Z");
    const newerAt = new Date("2026-05-01T11:00:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Chat Search Org",
        urlKey: deriveOrganizationUrlKey("Chat Search Org"),
        issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Chat Search Org",
        urlKey: deriveOrganizationUrlKey("Other Chat Search Org"),
        issuePrefix: `O${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(chatConversations).values([
      {
        id: titleChatId,
        orgId,
        title: "Launch-token planning",
        status: "active",
        lastMessageAt: olderAt,
        createdAt: olderAt,
        updatedAt: olderAt,
      },
      {
        id: messageChatId,
        orgId,
        title: "Message body only",
        status: "active",
        lastMessageAt: newerAt,
        createdAt: newerAt,
        updatedAt: newerAt,
      },
      {
        id: summaryChatId,
        orgId,
        title: "Summary only",
        summary: "Retains the launch-token deployment summary",
        status: "resolved",
        lastMessageAt: new Date("2026-05-01T09:00:00.000Z"),
      },
      {
        id: otherOrgChatId,
        orgId: otherOrgId,
        title: "Launch-token private chat",
        status: "active",
        lastMessageAt: newerAt,
      },
    ]);

    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId: messageChatId,
        role: "user",
        kind: "message",
        body: "The only match is the launch-token buried in a user message.",
        createdAt: newerAt,
        updatedAt: newerAt,
      },
      {
        orgId,
        conversationId: messageChatId,
        role: "assistant",
        kind: "message",
        body: "A second launch-token mention should not duplicate the conversation.",
        createdAt: new Date("2026-05-01T11:01:00.000Z"),
        updatedAt: new Date("2026-05-01T11:01:00.000Z"),
      },
      {
        orgId: otherOrgId,
        conversationId: otherOrgChatId,
        role: "assistant",
        kind: "message",
        body: "launch-token from another org",
        createdAt: newerAt,
        updatedAt: newerAt,
      },
    ]);

    const results = await chatSvc.list(orgId, { status: "all", q: "launch-token" }, userId);
    const ids = results.map((conversation) => conversation.id);

    expect(ids).toEqual([messageChatId, titleChatId, summaryChatId]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(otherOrgChatId);
    expect(results.find((conversation) => conversation.id === titleChatId)?.searchPreview).toBe("Launch-token planning");
    expect(results.find((conversation) => conversation.id === summaryChatId)?.searchPreview).toBe("Retains the launch-token deployment summary");
    expect(results.find((conversation) => conversation.id === messageChatId)?.searchPreview).toContain("launch-token");
  });

  it("filters project chats before applying the list limit", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const projectId = randomUUID();
    const targetChatId = randomUUID();
    const archivedTargetChatId = randomUUID();
    const otherOrgChatId = randomUUID();
    const oldAt = new Date("2026-01-01T00:00:00.000Z");
    const newerAt = new Date("2026-07-16T00:00:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Project Chat Filter Org",
        urlKey: deriveOrganizationUrlKey("Project Chat Filter Org"),
        issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Project Chat Filter Other Org",
        urlKey: deriveOrganizationUrlKey("Project Chat Filter Other Org"),
        issuePrefix: `O${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Long-running project",
      status: "planned",
    });

    const unrelatedChats = Array.from({ length: 41 }, (_, index) => ({
      id: randomUUID(),
      orgId,
      title: `New unrelated chat ${index + 1}`,
      status: "active",
      lastMessageAt: new Date(newerAt.getTime() + index * 1_000),
      createdAt: newerAt,
      updatedAt: newerAt,
    }));
    await db.insert(chatConversations).values([
      {
        id: targetChatId,
        orgId,
        title: "Older project chat",
        status: "active",
        lastMessageAt: oldAt,
        createdAt: oldAt,
        updatedAt: oldAt,
      },
      {
        id: archivedTargetChatId,
        orgId,
        title: "Archived project chat",
        status: "archived",
        lastMessageAt: new Date(newerAt.getTime() + 100_000),
        createdAt: newerAt,
        updatedAt: newerAt,
      },
      {
        id: otherOrgChatId,
        orgId: otherOrgId,
        title: "Other organization project chat",
        status: "active",
        lastMessageAt: new Date(newerAt.getTime() + 200_000),
        createdAt: newerAt,
        updatedAt: newerAt,
      },
      ...unrelatedChats,
    ]);
    await db.insert(chatContextLinks).values([
      {
        orgId,
        conversationId: targetChatId,
        entityType: "project",
        entityId: projectId,
      },
      {
        orgId,
        conversationId: archivedTargetChatId,
        entityType: "project",
        entityId: projectId,
      },
      {
        orgId: otherOrgId,
        conversationId: otherOrgChatId,
        entityType: "project",
        entityId: projectId,
      },
    ]);

    const results = await chatSvc.list(orgId, {
      status: "active",
      projectId,
      limit: 5,
    }, "project-filter-user");

    expect(results.map((conversation) => conversation.id)).toEqual([targetChatId]);
  });

  it("preserves explicit approved chat issue proposal assignees", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const userId = "board-user-approval";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Approval Assignee Org",
      urlKey: deriveOrganizationUrlKey("Chat Approval Assignee Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Selected Engineer",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const conversation = await chatSvc.create(orgId, {
      title: "Plan selected work",
      preferredAgentId: agentId,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const approval = await db
      .insert(approvals)
      .values({
        orgId,
        type: "chat_issue_creation",
        status: "approved",
        requestedByUserId: userId,
        decisionNote: "Keep execution behind a feature flag.",
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Implement selected work",
            description: "The chat-selected agent should receive this approved issue.",
            priority: "medium",
            assigneeAgentId: agentId,
            reviewerAgentId: agentId,
          },
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    const issue = await chatSvc.applyApprovedApproval(approval, userId);
    const persistedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        reviewerAgentId: issues.reviewerAgentId,
        description: issues.description,
      })
      .from(issues)
      .where(eq(issues.id, (issue as { id: string }).id))
      .then((rows) => rows[0]);
    const feedbackMessage = await db
      .select({ body: chatMessages.body, structuredPayload: chatMessages.structuredPayload })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversation!.id))
      .then((rows) => rows.find((row) => row.structuredPayload?.eventType === "approval_feedback"));

    expect(issue).toMatchObject({
      title: "Implement selected work",
      assigneeAgentId: agentId,
      reviewerAgentId: agentId,
      createdByUserId: userId,
    });
    expect(persistedIssue?.assigneeAgentId).toBe(agentId);
    expect(persistedIssue?.reviewerAgentId).toBe(agentId);
    expect(persistedIssue?.description).toContain("## Approval feedback");
    expect(persistedIssue?.description).toContain("Keep execution behind a feature flag.");
    expect(feedbackMessage?.body).toContain("Approved with execution feedback:");
    expect(feedbackMessage?.body).toContain("Keep execution behind a feature flag.");
  });

  it("preserves explicitly unassigned approved chat issue proposals", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const userId = "board-user-explicit-unassigned-approval";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Explicit Unassigned Org",
      urlKey: deriveOrganizationUrlKey("Chat Explicit Unassigned Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Selected Engineer",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const conversation = await chatSvc.create(orgId, {
      title: "Plan unassigned work",
      preferredAgentId: agentId,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const approval = await db
      .insert(approvals)
      .values({
        orgId,
        type: "chat_issue_creation",
        status: "approved",
        requestedByUserId: userId,
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Clarify selected work",
            description: "The operator explicitly left this proposal unassigned.",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            assigneeUnassignedReason: "The operator intentionally deferred ownership.",
          },
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    const issue = await chatSvc.applyApprovedApproval(approval, userId);
    const persistedIssue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId })
      .from(issues)
      .where(eq(issues.id, (issue as { id: string }).id))
      .then((rows) => rows[0]);

    expect(issue).toMatchObject({
      title: "Clarify selected work",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: userId,
    });
    expect(persistedIssue?.assigneeAgentId).toBeNull();
    expect(persistedIssue?.assigneeUserId).toBeNull();
  });

  it("writes a plan document only after approving a plan-mode chat issue proposal", async () => {
    const orgId = randomUUID();
    const userId = "board-user-plan-approval";

    await db.insert(organizations).values({
      id: orgId,
      name: "Plan Approval Org",
      urlKey: deriveOrganizationUrlKey("Plan Approval Org " + orgId),
      issuePrefix: `PA${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversation = await chatSvc.create(orgId, {
      title: "Plan before issue creation",
      issueCreationMode: "manual_approval",
      planMode: true,
      createdByUserId: userId,
    });

    const approval = await db
      .insert(approvals)
      .values({
        orgId,
        type: "chat_issue_creation",
        status: "approved",
        requestedByUserId: userId,
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Implement planned work",
            description: "Create the issue only after approval.",
            priority: "high",
            assigneeUnassignedReason: "Plan mode should leave ownership to operator review.",
          },
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    const issue = await chatSvc.applyApprovedApproval(approval, userId);
    const persistedPlanRows = await db
      .select({ id: issueDocuments.id })
      .from(issueDocuments)
      .where(eq(issueDocuments.issueId, (issue as { id: string }).id));

    expect(issue).toMatchObject({
      title: "Implement planned work",
      createdByUserId: userId,
    });
    expect(persistedPlanRows).toEqual([]);
  });

  it("includes reviewer issues in Messenger attention when they are in review", async () => {
    const orgId = randomUUID();
    const userId = "board-user-reviewer";
    const reviewerIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    const reviewRequestedAt = new Date("2026-04-10T14:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Reviewer Org",
      urlKey: deriveOrganizationUrlKey("Messenger Reviewer Org"),
      issuePrefix: `V${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: reviewerIssueId,
        orgId,
        title: "Reviewer issue",
        status: "in_review",
        priority: "medium",
        reviewerUserId: userId,
        createdAt: reviewRequestedAt,
        updatedAt: reviewRequestedAt,
      },
      {
        id: unrelatedIssueId,
        orgId,
        title: "Unrelated review issue",
        status: "in_review",
        priority: "medium",
        createdAt: reviewRequestedAt,
        updatedAt: reviewRequestedAt,
      },
    ]);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");
    const item = thread.detail.items.find((entry) => entry.issueId === reviewerIssueId);

    expect(thread.detail.items.map((entry) => entry.issueId)).toEqual([reviewerIssueId]);
    expect(item?.metadata).toMatchObject({ reviewerForMe: true, assignedToMe: false, createdByMe: false });
    expect(item?.body).toContain("review requested");
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(reviewRequestedAt.toISOString());
    expect(issuesSummary?.latestActivityAt?.toISOString()).toBe(reviewRequestedAt.toISOString());
  });

  it("does not treat pre-review reviewer issues as review attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-pre-reviewer";
    const issueId = randomUUID();
    const updatedAt = new Date("2026-04-10T14:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Pre Review Org",
      urlKey: deriveOrganizationUrlKey("Messenger Pre Review Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Reviewer issue before review",
      status: "todo",
      priority: "medium",
      reviewerUserId: userId,
      createdAt: updatedAt,
      updatedAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.metadata).toMatchObject({ reviewerForMe: false });
    expect(item?.body).not.toContain("review requested");
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
  });

  it("does not count self-authored issue activity as Messenger attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-self-activity";
    const createdIssueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Self Activity Org",
      urlKey: deriveOrganizationUrlKey("Messenger Self Activity Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: createdIssueId,
      orgId,
      title: "Self-created issue",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt,
      updatedAt: createdAt,
    });

    await issueSvc.addComment(createdIssueId, "I already handled this", { userId });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const splitSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");
    const splitIssueSummary = splitSummaries.find((item) => item.threadKey === `issue:${createdIssueId}`);

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([createdIssueId]);
    expect(thread.detail.items[0]?.preview).toBeNull();
    expect(thread.detail.items[0]?.body).not.toContain("I already handled this");
    expect(thread.detail.items[0]?.sourceCommentId).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentAuthorLabel).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentBody).toBeNull();
    expect(thread.detail.items[0]?.metadata).not.toHaveProperty("sourceCommentAuthorKind");
    expect(thread.detail.items[0]?.metadata).not.toHaveProperty("sourceCommentByMe");
    expect(thread.detail.items[0]?.metadata).not.toHaveProperty("sourceCommentAuthorLabel");
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(thread.summary.latestActivityAt).not.toBeNull();
    expect(thread.summary.preview).toContain("Self-created issue");
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(splitIssueSummary?.unreadCount).toBe(0);
    expect(splitIssueSummary?.needsAttention).toBe(false);
    expect(issuesSummary?.latestActivityAt).not.toBeNull();
    expect(issuesSummary?.preview).toContain("Self-created issue");
  });

  it("uses the latest non-self issue comment for Messenger issue previews", async () => {
    const orgId = randomUUID();
    const userId = "board-user-self-latest-comment";
    const agentId = randomUUID();
    const issueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Non Self Comment Org",
      urlKey: deriveOrganizationUrlKey("Messenger Non Self Comment Org"),
      issuePrefix: `N${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Build Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Created issue with comments",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt,
      updatedAt: createdAt,
    });

    const agentComment = await issueSvc.addComment(issueId, "Agent-visible update", { agentId });
    await issueSvc.addComment(issueId, "My later note should stay out of Messenger", { userId });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const splitSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const issuesSummary = summaries.find((entry) => entry.threadKey === "issues");
    const splitIssueSummary = splitSummaries.find((entry) => entry.threadKey === `issue:${issueId}`);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.sourceCommentId).toBe(agentComment.id);
    expect(item?.sourceCommentBody).toBe("Agent-visible update");
    expect(item?.sourceCommentAuthorLabel).toBe("Build Agent");
    expect(item?.body).toContain("Agent-visible update");
    expect(item?.body).not.toContain("My later note should stay out of Messenger");
    expect(thread.summary.preview).toBe("Created issue with comments — Agent-visible update");
    expect(issuesSummary?.preview).toBe("Created issue with comments — Agent-visible update");
    expect(splitIssueSummary?.href).toBe(`/messenger/issues/${item?.issueIdentifier ?? issueId}#comment-${agentComment.id}`);
  });

  it("includes the issue title in completion previews for unread Messenger issue notifications", async () => {
    const orgId = randomUUID();
    const userId = "board-user-completion-preview";
    const issueId = randomUUID();
    const completedAt = new Date("2026-04-10T15:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Completion Preview Org",
      urlKey: deriveOrganizationUrlKey("Messenger Completion Preview Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Explain completed notification",
      status: "done",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "CMP-41",
      createdAt: completedAt,
      updatedAt: completedAt,
      completedAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "agent",
      actorId: "completion-agent",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "done", identifier: "CMP-41", _previous: { status: "in_progress" } },
      createdAt: completedAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.preview).toBe("Completed");
    expect(thread.summary.preview).toBe("CMP-41 · Explain completed notification — Completed");
    expect(issuesSummary?.preview).toBe("CMP-41 · Explain completed notification — Completed");
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(1);

    await messengerSvc.setThreadRead(orgId, userId, "issues", completedAt);

    const readThread = await messengerSvc.getIssuesThread(orgId, userId);
    const readSummaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const readIssuesSummary = readSummaries.find((entry) => entry.threadKey === "issues");
    expect(readThread.detail.unreadCount).toBe(0);
    expect(readThread.detail.needsAttention).toBe(false);
    expect(readThread.summary.latestActivityAt?.toISOString()).toBe(completedAt.toISOString());
    expect(readThread.summary.preview).toBe("CMP-41 · Explain completed notification — Completed");
    expect(readIssuesSummary?.unreadCount).toBe(0);
    expect(readIssuesSummary?.latestActivityAt?.toISOString()).toBe(completedAt.toISOString());
    expect(readIssuesSummary?.preview).toBe("CMP-41 · Explain completed notification — Completed");
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(0);
  });

  it("clears Messenger issue attention when the client submits a stale issue read watermark", async () => {
    const orgId = randomUUID();
    const userId = "board-user-stale-issue-read";
    const issueId = randomUUID();
    const openedAt = new Date("2026-04-10T14:59:00.000Z");
    const completedAt = new Date("2026-04-10T15:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Stale Issue Read Org",
      urlKey: deriveOrganizationUrlKey("Messenger Stale Issue Read Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Clear stale issue read badge",
      status: "done",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "STL-7",
      createdAt: openedAt,
      updatedAt: completedAt,
      completedAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "agent",
      actorId: "stale-read-agent",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "done", identifier: "STL-7", _previous: { status: "in_progress" } },
      createdAt: completedAt,
    });

    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(1);

    const state = await messengerSvc.setThreadRead(orgId, userId, "issues", openedAt);
    expect(state?.lastReadAt.toISOString()).toBe(completedAt.toISOString());

    const readThread = await messengerSvc.getIssuesThread(orgId, userId);
    const readSummaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const readIssuesSummary = readSummaries.find((entry) => entry.threadKey === "issues");

    expect(readThread.detail.unreadCount).toBe(0);
    expect(readIssuesSummary?.unreadCount).toBe(0);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(0);
  });

  it("keeps the original issue attention when title and description-only updates occur", async () => {
    const orgId = randomUUID();
    const userId = "board-user-content-only";
    const issueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Description Update Org",
      urlKey: deriveOrganizationUrlKey("Messenger Description Update Org"),
      issuePrefix: `D${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Title and description-only update issue",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "DSC-1",
      createdAt,
      updatedAt: createdAt,
    });

    const updatedIssue = await issueSvc.update(issueId, {
      title: "Renamed issue",
      description: "New description",
    });
    expect(updatedIssue?.updatedAt.getTime()).toBeGreaterThan(createdAt.getTime());

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.metadata).toMatchObject({ assignedToMe: true });
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(createdAt.toISOString());
    expect(thread.summary.preview).toContain("Renamed issue");
    expect(issuesSummary?.unreadCount).toBe(1);
    expect(issuesSummary?.needsAttention).toBe(true);
    expect(issuesSummary?.latestActivityAt?.toISOString()).toBe(createdAt.toISOString());
    expect(issuesSummary?.preview).toContain("Renamed issue");
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(1);
  });

  it("keeps ignoring legacy title and description-only activity as Messenger attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-legacy-content-only";
    const issueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");
    const updatedAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Legacy Content Update Org",
      urlKey: deriveOrganizationUrlKey("Messenger Legacy Content Update Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Legacy content-only update issue",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "LGC-1",
      createdAt,
      updatedAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "agent",
      actorId: "legacy-content-agent",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        title: "Edited title",
        description: "Edited description",
        identifier: "LGC-1",
        _previous: { title: "Original title", description: "Original description" },
      },
      createdAt: new Date(updatedAt.getTime() + 1_000),
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(0);
  });

  it("does not re-notify a read issue after a title and description-only update", async () => {
    const orgId = randomUUID();
    const userId = "board-user-read-content-only";
    const issueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");
    const readAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Read Content Update Org",
      urlKey: deriveOrganizationUrlKey("Messenger Read Content Update Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Open issue before read",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
      createdAt,
      updatedAt: createdAt,
    });

    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(1);

    const state = await messengerSvc.setThreadRead(orgId, userId, `issue:${issueId}`, readAt);
    expect(state?.lastReadAt.toISOString()).toBe(readAt.toISOString());
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(0);

    const updatedIssue = await issueSvc.update(issueId, {
      title: "Open issue after read",
      description: "Content changed without a new Messenger notification.",
    });
    expect(updatedIssue?.updatedAt.getTime()).toBeGreaterThan(readAt.getTime());

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const splitSummaries = await messengerSvc.listThreadSummaries(orgId, userId, { splitIssues: true });
    const issuesSummary = summaries.find((entry) => entry.threadKey === "issues");
    const issueSummary = splitSummaries.find((entry) => entry.threadKey === `issue:${issueId}`);

    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(issueSummary?.unreadCount).toBe(0);
    expect(issueSummary?.needsAttention).toBe(false);
    await expect(messengerSvc.countUnreadIssueThreadEntries(orgId, userId)).resolves.toBe(0);
  });

  it("does not count self-authored issue status updates as Messenger attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-self-status";
    const issueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");
    const updatedAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Self Status Org",
      urlKey: deriveOrganizationUrlKey("Messenger Self Status Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Self-updated status issue",
      status: "in_review",
      priority: "medium",
      createdByUserId: userId,
      createdAt,
      updatedAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "user",
      actorId: userId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "in_review", _previous: { status: "todo" } },
      createdAt: updatedAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([issueId]);
    expect(thread.detail.items[0]?.preview).toBe("Status changed to in review");
    expect(thread.detail.items[0]?.sourceCommentId).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentAuthorLabel).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentBody).toBeNull();
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(updatedAt.toISOString());
    expect(thread.summary.preview).toBe("Self-updated status issue — Status changed to in review");
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(issuesSummary?.latestActivityAt?.toISOString()).toBe(updatedAt.toISOString());
    expect(issuesSummary?.preview).toBe("Self-updated status issue — Status changed to in review");
  });

  it("keeps the Messenger issues summary aligned to the latest visible issue while unread stays attention-based", async () => {
    const orgId = randomUUID();
    const userId = "board-user-summary-display";
    const olderIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const olderActivityAt = new Date("2026-04-10T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Summary Display Org",
      urlKey: deriveOrganizationUrlKey("Messenger Summary Display Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        orgId,
        title: "Older assigned attention issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerIssueId,
        orgId,
        title: "Newer visible self update",
        status: "in_review",
        priority: "medium",
        createdByUserId: userId,
        createdAt: olderActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    await db.insert(activityLog).values({
      orgId,
      actorType: "user",
      actorId: userId,
      action: "issue.updated",
      entityType: "issue",
      entityId: newerIssueId,
      details: { status: "in_review", _previous: { status: "todo" } },
      createdAt: newerActivityAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([olderIssueId, newerIssueId]);
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(thread.summary.preview).toBe("Newer visible self update — Status changed to in review");
    expect(issuesSummary?.unreadCount).toBe(1);
    expect(issuesSummary?.needsAttention).toBe(true);
    expect(issuesSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(issuesSummary?.preview).toBe("Newer visible self update — Status changed to in review");
  });

  it("returns Messenger issue detail items in chronological order while keeping the summary pinned to latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-order";
    const olderIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const olderActivityAt = new Date("2026-04-10T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-10T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Order Org",
      urlKey: deriveOrganizationUrlKey("Messenger Order Org"),
      issuePrefix: `O${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        orgId,
        title: "Older issue update",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerIssueId,
        orgId,
        title: "Newer issue update",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([olderIssueId, newerIssueId]);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(issuesSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
  });

  it("paginates Messenger issue detail items by latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-issue-page";
    const olderIssueId = randomUUID();
    const middleIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const olderActivityAt = new Date("2026-04-10T09:00:00.000Z");
    const middleActivityAt = new Date("2026-04-10T10:00:00.000Z");
    const newerActivityAt = new Date("2026-04-10T11:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Issue Page Org",
      urlKey: deriveOrganizationUrlKey("Messenger Issue Page Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        orgId,
        title: "Older paginated issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: middleIssueId,
        orgId,
        title: "Middle paginated issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: middleActivityAt,
        updatedAt: middleActivityAt,
      },
      {
        id: newerIssueId,
        orgId,
        title: "Newer paginated issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    const firstPage = await messengerSvc.getIssuesThread(orgId, userId, { limit: 2 });

    expect(firstPage.detail.items.map((item) => item.issueId)).toEqual([middleIssueId, newerIssueId]);
    expect(firstPage.detail.pageInfo).toEqual({
      limit: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(firstPage.summary.subtitle).toBe("3 tracked issues");
    expect(firstPage.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());

    const secondPage = await messengerSvc.getIssuesThread(orgId, userId, {
      limit: 2,
      cursor: firstPage.detail.pageInfo?.nextCursor,
    });

    expect(secondPage.detail.items.map((item) => item.issueId)).toEqual([olderIssueId]);
    expect(secondPage.detail.pageInfo).toEqual({
      limit: 2,
      hasMore: false,
      nextCursor: null,
    });
    expect(secondPage.summary.subtitle).toBe("3 tracked issues");
    expect(secondPage.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
  });

  it("uses stable issue pagination cursors when the cursor issue changes activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-issue-page-stale";
    const olderIssueId = randomUUID();
    const middleIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const olderActivityAt = new Date("2026-04-10T09:00:00.000Z");
    const middleActivityAt = new Date("2026-04-10T10:00:00.000Z");
    const newerActivityAt = new Date("2026-04-10T11:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Issue Stable Cursor Org",
      urlKey: deriveOrganizationUrlKey("Messenger Issue Stable Cursor Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        orgId,
        title: "Older stable cursor issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: middleIssueId,
        orgId,
        title: "Middle stable cursor issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: middleActivityAt,
        updatedAt: middleActivityAt,
      },
      {
        id: newerIssueId,
        orgId,
        title: "Newer stable cursor issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    const firstPage = await messengerSvc.getIssuesThread(orgId, userId, { limit: 1 });
    expect(firstPage.detail.items.map((item) => item.issueId)).toEqual([newerIssueId]);

    await db
      .update(issues)
      .set({ updatedAt: new Date("2026-04-10T12:00:00.000Z") })
      .where(eq(issues.id, newerIssueId));

    const secondPage = await messengerSvc.getIssuesThread(orgId, userId, {
      limit: 2,
      cursor: firstPage.detail.pageInfo?.nextCursor,
    });

    expect(secondPage.detail.items.map((item) => item.issueId)).toEqual([olderIssueId, middleIssueId]);
    expect(secondPage.detail.items.map((item) => item.issueId)).not.toContain(newerIssueId);
    expect(secondPage.detail.pageInfo).toEqual({
      limit: 2,
      hasMore: false,
      nextCursor: null,
    });
  });

  it("rejects malformed Messenger issue cursors instead of restarting from page one", async () => {
    const orgId = randomUUID();
    const userId = "board-user-issue-page-invalid";
    const issueId = randomUUID();
    const activityAt = new Date("2026-04-10T09:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Issue Invalid Cursor Org",
      urlKey: deriveOrganizationUrlKey("Messenger Issue Invalid Cursor Org"),
      issuePrefix: `I${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Invalid cursor issue",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
      createdAt: activityAt,
      updatedAt: activityAt,
    });

    await expect(messengerSvc.getIssuesThread(orgId, userId, { cursor: "not-a-cursor" })).rejects.toMatchObject({
      status: 409,
      message: "Messenger issues cursor is invalid or expired",
    });
  });

  it("returns Messenger approval detail items in chronological order while keeping the summary pinned to latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-approvals";
    const olderApprovalId = randomUUID();
    const newerApprovalId = randomUUID();
    const olderActivityAt = new Date("2026-04-11T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-11T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Approvals Org",
      urlKey: deriveOrganizationUrlKey("Messenger Approvals Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(approvals).values([
      {
        id: olderApprovalId,
        orgId,
        type: "hire_agent",
        status: "approved",
        requestedByUserId: userId,
        payload: { name: "Older approval" },
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerApprovalId,
        orgId,
        type: "hire_agent",
        status: "approved",
        requestedByUserId: userId,
        payload: { name: "Newer approval" },
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    const thread = await messengerSvc.getApprovalsThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const approvalsSummary = summaries.find((item) => item.threadKey === "approvals");

    expect(thread.detail.items.map((item) => item.id)).toEqual([olderApprovalId, newerApprovalId]);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(approvalsSummary).toBeUndefined();
  });

  it("summarizes approvals from latest comments without hydrating the detail thread", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "board-user-approval-summary-only";
    const pendingApprovalId = randomUUID();
    const approvedApprovalId = randomUUID();
    const otherOrgApprovalId = randomUUID();
    const pendingUpdatedAt = new Date("2026-04-11T11:00:00.000Z");
    const approvedUpdatedAt = new Date("2026-04-11T12:00:00.000Z");
    const latestCommentAt = new Date("2026-04-11T13:00:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger Approval Summary Only Org",
        urlKey: deriveOrganizationUrlKey("Messenger Approval Summary Only Org"),
        issuePrefix: `AS${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Approval Summary Org",
        urlKey: deriveOrganizationUrlKey("Other Approval Summary Org"),
        issuePrefix: `OA${otherOrgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(approvals).values([
      {
        id: pendingApprovalId,
        orgId,
        type: "chat_issue_creation",
        status: "pending",
        requestedByUserId: userId,
        payload: {
          proposedIssue: {
            title: "Pending approval",
            description: "Needs review.",
            priority: "medium",
            assigneeUnassignedReason: "The owner is still under review.",
          },
        },
        createdAt: new Date("2026-04-11T10:00:00.000Z"),
        updatedAt: pendingUpdatedAt,
      },
      {
        id: approvedApprovalId,
        orgId,
        type: "hire_agent",
        status: "approved",
        requestedByUserId: userId,
        payload: { name: "Approved later" },
        createdAt: approvedUpdatedAt,
        updatedAt: approvedUpdatedAt,
      },
      {
        id: otherOrgApprovalId,
        orgId: otherOrgId,
        type: "hire_agent",
        status: "pending",
        requestedByUserId: userId,
        payload: { name: "Other org approval" },
        createdAt: latestCommentAt,
        updatedAt: latestCommentAt,
      },
    ]);
    await db.insert(approvalComments).values([
      {
        orgId,
        approvalId: pendingApprovalId,
        body: "Older approval comment should not drive the summary preview.",
        createdAt: new Date("2026-04-11T10:45:00.000Z"),
      },
      {
        orgId,
        approvalId: pendingApprovalId,
        body: "Latest approval comment drives the summary preview.",
        createdAt: latestCommentAt,
      },
      {
        orgId: otherOrgId,
        approvalId: otherOrgApprovalId,
        body: "Other org comment should not drive this summary.",
        createdAt: new Date("2026-04-11T14:00:00.000Z"),
      },
    ]);
    await messengerSvc.setThreadRead(orgId, userId, "approvals", new Date("2026-04-11T10:30:00.000Z"));

    const thread = await messengerSvc.getApprovalsThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const approvalsSummary = summaries.find((item) => item.threadKey === "approvals");

    expect(thread.detail.items.map((item) => item.id)).toEqual([approvedApprovalId, pendingApprovalId]);
    expect(thread.detail.items.map((item) => item.id)).not.toContain(otherOrgApprovalId);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(latestCommentAt.toISOString());
    expect(thread.summary.preview).toBe("Latest approval comment drives the summary preview.");
    expect(thread.summary.unreadCount).toBe(1);
    expect(approvalsSummary?.subtitle).toBe("1 request");
    expect(approvalsSummary?.latestActivityAt?.toISOString()).toBe(latestCommentAt.toISOString());
    expect(approvalsSummary?.preview).toBe("Latest approval comment drives the summary preview.");
    expect(approvalsSummary?.unreadCount).toBe(1);
  });

  it("summarizes chat issue approvals without exposing raw payload ids", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-approval-summary";
    const chatId = randomUUID();
    const projectId = randomUUID();
    const assigneeUserId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Approval Summary Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Approval Summary Org"),
      issuePrefix: `CA${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_issue_creation",
      status: "pending",
      requestedByUserId: userId,
      payload: {
        chatConversationId: chatId,
        proposedIssue: {
          title: "Fix approval review copy",
          description: "## Scope\nRender Markdown and readable assignee labels.",
          priority: "medium",
          projectId,
          assigneeUserId,
        },
      },
    });

    const thread = await messengerSvc.getApprovalsThread(orgId, userId);
    const item = thread.detail.items.find((approvalItem) => approvalItem.id === approvalId);

    expect(item?.title).toBe("Review proposed issue");
    expect(item?.preview).toContain("Fix approval review copy");
    expect(item?.preview).not.toContain(chatId);
    expect(item?.preview).not.toContain(projectId);
    expect(item?.preview).not.toContain(assigneeUserId);
  });

  it("preserves the requesting agent identity for approvals after the agent is terminated", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Terminated Approval Requester Org",
      urlKey: deriveOrganizationUrlKey("Messenger Terminated Approval Requester Org"),
      issuePrefix: `TA${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Historical Requester",
      role: "engineer",
      icon: "bot",
      status: "terminated",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_issue_creation",
      status: "pending",
      requestedByAgentId: agentId,
      payload: {
        proposedIssue: {
          title: "Preserve requester identity",
          description: "Historical approvals keep their initiating agent visible.",
          priority: "medium",
          assigneeUnassignedReason: "Routing will be selected during review.",
        },
      },
    });
    const thread = await messengerSvc.getApprovalsThread(orgId, "board-user");
    const item = thread.detail.items.find((approvalItem) => approvalItem.id === approvalId);

    expect(item?.requesterAgent).toEqual({
      id: agentId,
      name: "Historical Requester",
      icon: "bot",
      role: "engineer",
    });
  });

  it("resolves chat proposal requester identity from the payload for legacy approvals", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    const invalidApprovalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Legacy Chat Approval Requester Org",
      urlKey: deriveOrganizationUrlKey("Messenger Legacy Chat Approval Requester Org"),
      issuePrefix: `LC${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Proposal Agent",
      role: "engineer",
      icon: "bot",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_issue_creation",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        proposedByAgentId: agentId,
        proposedIssue: {
          title: "Restore legacy requester identity",
          description: "Chat approvals retain their proposing agent in the payload.",
          priority: "medium",
          assigneeUnassignedReason: "Routing will be selected during review.",
        },
      },
    });
    await db.insert(approvals).values({
      id: invalidApprovalId,
      orgId,
      type: "chat_issue_creation",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        proposedByAgentId: "not-a-uuid",
        proposedIssue: {
          title: "Ignore invalid requester identity",
          description: "Malformed historical attribution must not break Messenger.",
          priority: "low",
          assigneeUnassignedReason: "Local regression test.",
        },
      },
    });

    const thread = await messengerSvc.getApprovalsThread(orgId, "board-user");
    const item = thread.detail.items.find((approvalItem) => approvalItem.id === approvalId);

    expect(item?.requesterAgent).toEqual({
      id: agentId,
      name: "Chat Proposal Agent",
      icon: "bot",
      role: "engineer",
    });
    expect(thread.detail.items.find((approvalItem) => approvalItem.id === invalidApprovalId)?.requesterAgent).toBeNull();
  });

  it("returns Messenger failed-run detail items in chronological order while keeping the summary pinned to latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-failed-runs";
    const agentId = randomUUID();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const olderActivityAt = new Date("2026-04-12T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Failed Runs Org",
      urlKey: deriveOrganizationUrlKey("Messenger Failed Runs Org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Failure bot",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "failed",
        error: "Older run failed",
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "failed",
        error: "Newer run failed",
        errorCode: "chat_result_missing_sentinel",
        resultJson: {
          userMessage: "The assistant finished without a final Rudder reply. Rudder saved the attempt and transcript; retry when ready.",
        },
        contextSnapshot: {
          issueId: randomUUID(),
          resumeFromRunId: "source-run-id",
          resumeSessionDisplayId: "private-display-id",
          resumeSessionParams: {
            sessionId: "nested-private-session",
            cwd: "/nested/private/cwd",
            workspaceId: "private-workspace",
            repoUrl: "https://private.example/repo.git",
            repoRef: "private-ref",
          },
        },
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);
    await messengerSvc.setThreadRead(orgId, userId, "failed-runs", new Date("2026-04-12T10:00:00.000Z"));

    const thread = await messengerSvc.getSystemThread(orgId, userId, "failed-runs");
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const failedRunsSummary = summaries.find((item) => item.threadKey === "failed-runs");

    expect(thread.detail.items.map((item) => item.id)).toEqual([olderRunId, newerRunId]);
    expect(thread.detail.items[0]?.actions).toContainEqual({
      label: "Retry",
      href: `/agent-runs/${olderRunId}/retry`,
      method: "POST",
    });
    expect(thread.detail.items[1]?.preview).toBe(
      "The assistant finished without a final Rudder reply. Rudder saved the attempt and transcript; retry when ready.",
    );
    expect(thread.summary.unreadCount).toBe(1);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(failedRunsSummary?.preview).toBe(
      "The assistant finished without a final Rudder reply. Rudder saved the attempt and transcript; retry when ready.",
    );
    expect(failedRunsSummary?.unreadCount).toBe(1);
    expect(failedRunsSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(thread.detail.items[0]?.origin).toEqual(expect.objectContaining({
      runId: olderRunId,
      scene: "heartbeat",
      sourceState: "legacy_unknown",
      source: { kind: "unavailable", state: "legacy_unknown" },
    }));
    expect(thread.detail.items[1]?.origin).toEqual(expect.objectContaining({
      runId: newerRunId,
      scene: "issue",
      targetId: null,
      conversationId: null,
      messageId: null,
      issueId: null,
      automationRunId: null,
      automationId: null,
      wakeupRequestId: null,
      sourceState: "source_unavailable",
      source: { kind: "unavailable", state: "source_unavailable" },
    }));
    expect(thread.detail.items[1]?.metadata).not.toHaveProperty("contextSnapshot");
    expect(thread.detail.items[1]).not.toHaveProperty("run");
    expect(JSON.stringify(thread.detail.items[1])).not.toMatch(
      /contextSnapshot|resumeFromRunId|source-run-id|private-display-id|nested-private-session|nested\/private\/cwd|private-workspace|private\.example|private-ref/,
    );
  });

  it("shows Agent Issue failure context and only gives the requester the Agent Issue retry action", async () => {
    const orgId = randomUUID();
    const userId = "agent-issue-requester";
    const otherUserId = "agent-issue-observer";
    const agentId = randomUUID();
    const requestId = randomUUID();
    const runId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Agent Issue Failure Org",
      urlKey: deriveOrganizationUrlKey("Messenger Agent Issue Failure Org"),
      issuePrefix: `AF${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Issue Builder",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "failed",
      error: "Agent process exited before creating the Issue",
      contextSnapshot: { agentIssueCreationRequestId: requestId },
    });
    await db.insert(agentIssueCreationRequests).values({
      id: requestId,
      orgId,
      requestedByUserId: userId,
      agentId,
      instruction: "Create a reliability follow-up.",
      idempotencyKey: "agent-issue-failure-messenger",
      runId,
      status: "failed",
      error: "Agent process exited before creating the Issue",
    });

    const requesterThread = await messengerSvc.getSystemThread(orgId, userId, "failed-runs");
    const requesterItem = requesterThread.detail.items[0]!;
    expect(requesterItem.title).toContain("Agent Issue creation failed");
    expect(requesterItem.body).toContain("Agent Issue creation failed");
    expect(requesterItem.actions.map((action) => action.label)).toContain("Retry Agent Issue");
    expect(requesterItem.actions.map((action) => action.label)).not.toContain("Retry");
    expect(requesterItem.actions).toContainEqual({
      label: "Retry Agent Issue",
      href: `/orgs/${orgId}/agent-issue-creation-requests/${requestId}/retry`,
      method: "POST",
    });

    const observerThread = await messengerSvc.getSystemThread(orgId, otherUserId, "failed-runs");
    const observerItem = observerThread.detail.items[0]!;
    expect(observerItem.actions.map((action) => action.label)).not.toContain("Retry Agent Issue");
    expect(observerItem.actions.map((action) => action.label)).not.toContain("Retry");
  });

  it("surfaces runless and successful-without-Issue Agent requests only to their requester", async () => {
    const orgId = randomUUID();
    const userId = "agent-issue-requester-without-run";
    const otherUserId = "agent-issue-observer-without-run";
    const agentId = randomUUID();
    const requestId = randomUUID();
    const successfulRequestId = randomUUID();
    const successfulRunId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Issue Request Visibility Org",
      urlKey: deriveOrganizationUrlKey("Agent Issue Request Visibility Org"),
      issuePrefix: `ARV${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Request Visibility Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: successfulRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { agentIssueCreationRequestId: successfulRequestId },
    });
    await db.insert(agentIssueCreationRequests).values([
      {
        id: requestId,
        orgId,
        requestedByUserId: userId,
        agentId,
        instruction: "Create the runless failure issue.",
        idempotencyKey: "runless-agent-issue-failure",
        status: "failed",
        error: "Agent wakeup was not accepted",
      },
      {
        id: successfulRequestId,
        orgId,
        requestedByUserId: userId,
        agentId,
        instruction: "Create an issue but do not create one.",
        idempotencyKey: "successful-without-issue",
        runId: successfulRunId,
        status: "running",
      },
    ]);

    const settled = await agentIssueCreationService(db).settleForRun({
      orgId,
      agentId,
      runId: successfulRunId,
      requestId: successfulRequestId,
      runStatus: "succeeded",
    });
    expect(settled).toMatchObject({
      id: successfulRequestId,
      status: "failed",
      error: "Agent run completed without creating an Issue",
    });

    const requesterThread = await messengerSvc.getSystemThread(orgId, userId, "failed-runs");
    expect(requesterThread.detail.items).toHaveLength(2);
    expect(requesterThread.detail.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([requestId, successfulRequestId]),
    );
    for (const item of requesterThread.detail.items) {
      expect(item.actions).toContainEqual({
        label: "Retry Agent Issue",
        href: `/orgs/${orgId}/agent-issue-creation-requests/${item.id}/retry`,
        method: "POST",
      });
    }

    const observerThread = await messengerSvc.getSystemThread(orgId, otherUserId, "failed-runs");
    expect(observerThread.detail.items).toHaveLength(0);
    await expect(agentIssueCreationService(db).listForRequester(orgId, userId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requestId }),
        expect.objectContaining({ id: successfulRequestId }),
      ]),
    );
  });

  it("normalizes and organization-safely hydrates failed Chat, Heartbeat, Issue, Review, and Automation origins", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const issueId = randomUUID();
    const reviewIssueId = randomUUID();
    const crossOrgIssueId = randomUUID();
    const deletedIssueId = randomUUID();
    const automationId = randomUUID();
    const automationRunId = randomUUID();
    const heartbeatWakeupRequestId = randomUUID();
    const crossOrgWakeupRequestId = randomUUID();
    const runIds = {
      chat: randomUUID(),
      heartbeat: randomUUID(),
      heartbeatCrossOrg: randomUUID(),
      issue: randomUUID(),
      review: randomUUID(),
      automation: randomUUID(),
      deleted: randomUUID(),
      crossOrg: randomUUID(),
      legacy: randomUUID(),
    };

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger Run Origins Org",
        urlKey: deriveOrganizationUrlKey("Messenger Run Origins Org"),
        issuePrefix: `RO${orgId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Messenger Run Origins Other Org",
        urlKey: deriveOrganizationUrlKey("Messenger Run Origins Other Org"),
        issuePrefix: `RX${otherOrgId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Origin bot",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Investigate deploy failure",
    });
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      body: "Deployment failed.",
    });
    await db.insert(issues).values([
      {
        id: issueId,
        orgId,
        title: "Repair the deployment",
        identifier: `RO-${Math.floor(Math.random() * 100_000)}`,
        status: "blocked",
      },
      {
        id: reviewIssueId,
        orgId,
        title: "Review the repair",
        identifier: `RO-${Math.floor(Math.random() * 100_000) + 100_000}`,
        status: "in_review",
      },
      {
        id: crossOrgIssueId,
        orgId: otherOrgId,
        title: "Private other-organization issue",
        identifier: `RX-${Math.floor(Math.random() * 100_000)}`,
        status: "todo",
      },
    ]);
    await db.insert(automations).values({
      id: automationId,
      orgId,
      title: "Nightly deployment check",
      assigneeAgentId: agentId,
    });
    await db.insert(automationRuns).values({
      id: automationRunId,
      orgId,
      automationId,
      source: "schedule",
      status: "failed",
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: heartbeatWakeupRequestId,
        orgId,
        agentId,
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        status: "failed",
      },
      {
        id: crossOrgWakeupRequestId,
        orgId: otherOrgId,
        agentId,
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        status: "failed",
      },
    ]);

    const baseTime = new Date("2026-07-20T08:00:00.000Z").getTime();
    const at = (index: number) => new Date(baseTime + index * 60_000);
    await db.insert(heartbeatRuns).values([
      {
        id: runIds.chat,
        orgId,
        agentId,
        invocationSource: "chat",
        triggerDetail: "chat_assistant_reply_stream",
        chatConversationId: conversationId,
        status: "failed",
        contextSnapshot: { scene: "chat", assistantMessageId: messageId, credentials: "private-chat-secret" },
        createdAt: at(0),
        updatedAt: at(0),
      },
      {
        id: runIds.heartbeat,
        orgId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        wakeupRequestId: heartbeatWakeupRequestId,
        status: "failed",
        contextSnapshot: { workspacePath: "/private/heartbeat/workspace" },
        createdAt: at(1),
        updatedAt: at(1),
      },
      {
        id: runIds.issue,
        orgId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: {
          issueId,
          commentId: randomUUID(),
          wakeReason: "issue_commented",
          wakeSource: "issue.comment",
          apiKey: "private-issue-key",
        },
        createdAt: at(2),
        updatedAt: at(2),
      },
      {
        id: runIds.review,
        orgId,
        agentId,
        invocationSource: "review",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { issueId: reviewIssueId, triggerKind: "review_routing" },
        createdAt: at(3),
        updatedAt: at(3),
      },
      {
        id: runIds.automation,
        orgId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { automationId, automationRunId, triggerKind: "schedule" },
        createdAt: at(4),
        updatedAt: at(4),
      },
      {
        id: runIds.deleted,
        orgId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { issueId: deletedIssueId },
        createdAt: at(5),
        updatedAt: at(5),
      },
      {
        id: runIds.crossOrg,
        orgId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { issueId: crossOrgIssueId },
        createdAt: at(6),
        updatedAt: at(6),
      },
      {
        id: runIds.heartbeatCrossOrg,
        orgId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { scene: "heartbeat", wakeupRequestId: crossOrgWakeupRequestId },
        createdAt: at(7),
        updatedAt: at(7),
      },
      {
        id: runIds.legacy,
        orgId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: null,
        status: "failed",
        contextSnapshot: { cwd: "/private/legacy/workspace", token: "private-legacy-token" },
        createdAt: at(8),
        updatedAt: at(8),
      },
    ]);

    const thread = await messengerSvc.getSystemThread(orgId, "run-origin-user", "failed-runs");
    const items = new Map(thread.detail.items.map((item) => [item.id, item]));

    expect(items.get(runIds.chat)?.origin).toEqual(expect.objectContaining({
      scene: "chat",
      conversationId,
      messageId,
      targetLabel: "Investigate deploy failure",
      sourceState: "available",
      source: {
        kind: "chat",
        title: "Investigate deploy failure",
        href: `/messenger/chat/${conversationId}?messageId=${messageId}`,
      },
    }));
    expect(items.get(runIds.chat)?.actions).toContainEqual({
      label: "Open chat message",
      href: `/messenger/chat/${conversationId}?messageId=${messageId}`,
      method: "GET",
    });
    expect(items.get(runIds.heartbeat)?.origin).toEqual(expect.objectContaining({
      scene: "heartbeat",
      triggerKind: "timer",
      wakeupRequestId: heartbeatWakeupRequestId,
      targetLabel: "Timer self-check",
      sourceState: "available",
      source: {
        kind: "heartbeat",
        agent: {
          id: agentId,
          name: "Origin bot",
          icon: null,
          role: "engineer",
          status: "active",
          title: null,
        },
        href: `/agents/${agentId}`,
      },
    }));
    expect(items.get(runIds.heartbeat)?.actions).toContainEqual({
      label: "Open agent",
      href: `/agents/${agentId}`,
      method: "GET",
    });
    expect(items.get(runIds.issue)?.origin).toEqual(expect.objectContaining({
      scene: "issue",
      issueId,
      targetLabel: expect.stringContaining("Repair the deployment"),
      targetStatus: "blocked",
      sourceState: "available",
      source: expect.objectContaining({
        kind: "issue",
        identifier: expect.stringMatching(/^RO-/),
        title: "Repair the deployment",
        status: "blocked",
        href: expect.stringMatching(/^\/issues\/RO-/),
      }),
    }));
    expect(items.get(runIds.issue)?.actions.map((action) => action.label)).toEqual(["Retry", "Open issue", "Open run"]);
    expect(items.get(runIds.review)?.origin).toEqual(expect.objectContaining({
      scene: "review",
      issueId: reviewIssueId,
      targetLabel: expect.stringContaining("Review the repair"),
      sourceState: "available",
      source: expect.objectContaining({
        kind: "review",
        identifier: expect.stringMatching(/^RO-/),
        title: "Review the repair",
        status: "in_review",
        href: expect.stringMatching(/^\/issues\/RO-/),
      }),
    }));
    expect(items.get(runIds.review)?.actions.map((action) => action.label)).toEqual(["Retry", "Open review", "Open run"]);
    expect(items.get(runIds.automation)?.origin).toEqual(expect.objectContaining({
      scene: "automation",
      automationId,
      automationRunId,
      targetLabel: "Nightly deployment check",
      sourceState: "available",
      source: expect.objectContaining({
        kind: "automation",
        title: "Nightly deployment check",
        status: "active",
        href: `/automations/${automationId}`,
      }),
    }));
    expect(items.get(runIds.automation)?.actions.map((action) => action.label)).toEqual(["Retry", "Open automation", "Open run"]);
    expect(items.get(runIds.deleted)?.origin).toEqual(expect.objectContaining({
      scene: "issue",
      targetId: null,
      conversationId: null,
      messageId: null,
      issueId: null,
      automationRunId: null,
      automationId: null,
      wakeupRequestId: null,
      targetLabel: null,
      sourceState: "source_unavailable",
      source: { kind: "unavailable", state: "source_unavailable" },
    }));
    expect(items.get(runIds.crossOrg)?.origin).toEqual(expect.objectContaining({
      scene: "issue",
      targetId: null,
      conversationId: null,
      messageId: null,
      issueId: null,
      automationRunId: null,
      automationId: null,
      wakeupRequestId: null,
      targetLabel: null,
      sourceState: "source_unavailable",
      source: { kind: "unavailable", state: "source_unavailable" },
    }));
    expect(items.get(runIds.crossOrg)?.actions.map((action) => action.label)).toEqual(["Retry", "Open run"]);
    expect(items.get(runIds.heartbeatCrossOrg)?.origin).toEqual(expect.objectContaining({
      scene: "heartbeat",
      targetId: null,
      conversationId: null,
      messageId: null,
      issueId: null,
      automationRunId: null,
      automationId: null,
      wakeupRequestId: null,
      sourceState: "source_unavailable",
      source: { kind: "unavailable", state: "source_unavailable" },
    }));
    expect(items.get(runIds.heartbeatCrossOrg)?.actions.map((action) => action.label)).toEqual(["Retry", "Open run"]);
    expect(items.get(runIds.legacy)?.origin).toEqual(expect.objectContaining({
      scene: "heartbeat",
      targetId: null,
      conversationId: null,
      messageId: null,
      issueId: null,
      automationRunId: null,
      automationId: null,
      wakeupRequestId: null,
      targetLabel: null,
      sourceState: "legacy_unknown",
      source: { kind: "unavailable", state: "legacy_unknown" },
    }));
    expect(JSON.stringify(thread.detail.items)).not.toMatch(
      /contextSnapshot|private-chat-secret|private\/heartbeat\/workspace|private-issue-key|private\/legacy\/workspace|private-legacy-token|Private other-organization issue/,
    );
  });

  it("summarizes pending join requests without loading the detail thread", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "board-user-join-requests";
    const olderRequestId = randomUUID();
    const newerRequestId = randomUUID();
    const resolvedRequestId = randomUUID();
    const otherOrgRequestId = randomUUID();
    const olderInviteId = randomUUID();
    const newerInviteId = randomUUID();
    const resolvedInviteId = randomUUID();
    const otherOrgInviteId = randomUUID();
    const activeChatId = randomUUID();
    const olderActivityAt = new Date("2026-04-12T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger Join Requests Org",
        urlKey: deriveOrganizationUrlKey("Messenger Join Requests Org"),
        issuePrefix: `J${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Join Requests Org",
        urlKey: deriveOrganizationUrlKey("Other Join Requests Org"),
        issuePrefix: `O${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(invites).values([
      {
        id: olderInviteId,
        orgId,
        tokenHash: `hash-${olderInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
      {
        id: newerInviteId,
        orgId,
        tokenHash: `hash-${newerInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
      {
        id: resolvedInviteId,
        orgId,
        tokenHash: `hash-${resolvedInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
      {
        id: otherOrgInviteId,
        orgId: otherOrgId,
        tokenHash: `hash-${otherOrgInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
    ]);
    await db.insert(joinRequests).values([
      {
        id: olderRequestId,
        inviteId: olderInviteId,
        orgId,
        requestType: "agent",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "older@example.com",
        agentName: "Older request",
        capabilities: "Older request capabilities",
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerRequestId,
        inviteId: newerInviteId,
        orgId,
        requestType: "agent",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "newer@example.com",
        agentName: "Newer request",
        capabilities: "Newer request capabilities",
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
      {
        id: resolvedRequestId,
        inviteId: resolvedInviteId,
        orgId,
        requestType: "agent",
        status: "approved",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "resolved@example.com",
        agentName: "Resolved request",
        capabilities: "Resolved request should not appear",
        createdAt: new Date("2026-04-12T13:00:00.000Z"),
        updatedAt: new Date("2026-04-12T13:00:00.000Z"),
      },
      {
        id: otherOrgRequestId,
        inviteId: otherOrgInviteId,
        orgId: otherOrgId,
        requestType: "agent",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "other@example.com",
        agentName: "Other org request",
        capabilities: "Other org request should not appear",
        createdAt: new Date("2026-04-12T14:00:00.000Z"),
        updatedAt: new Date("2026-04-12T14:00:00.000Z"),
      },
    ]);
    await db.insert(chatConversations).values({
      id: activeChatId,
      orgId,
      title: "Older active chat",
      status: "active",
      lastMessageAt: olderActivityAt,
      createdAt: olderActivityAt,
      updatedAt: olderActivityAt,
    });
    await messengerSvc.setThreadRead(orgId, userId, "join-requests", new Date("2026-04-12T10:00:00.000Z"));

    const thread = await messengerSvc.getSystemThread(orgId, userId, "join-requests");
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const joinRequestsSummary = summaries.find((item) => item.threadKey === "join-requests");

    expect(thread.detail.items.map((item) => item.id)).toEqual([newerRequestId, olderRequestId]);
    expect(thread.summary.unreadCount).toBe(1);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(joinRequestsSummary?.subtitle).toBe("2 items");
    expect(joinRequestsSummary?.preview).toBe("Newer request capabilities");
    expect(joinRequestsSummary?.unreadCount).toBe(1);
    expect(joinRequestsSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(summaries[0]?.threadKey).toBe("join-requests");
    expect(thread.detail.items.map((item) => item.id)).not.toContain(resolvedRequestId);
    expect(thread.detail.items.map((item) => item.id)).not.toContain(otherOrgRequestId);
  });

  it("excludes archived chats from Messenger thread summaries", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-archive";
    const activeChatId = randomUUID();
    const archivedChatId = randomUUID();
    const activeActivityAt = new Date("2026-04-12T12:00:00.000Z");
    const archivedActivityAt = new Date("2026-04-12T13:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Archived Chats Org",
      urlKey: deriveOrganizationUrlKey("Messenger Archived Chats Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(chatConversations).values([
      {
        id: activeChatId,
        orgId,
        title: "Active chat",
        status: "active",
        lastMessageAt: activeActivityAt,
        createdAt: activeActivityAt,
        updatedAt: activeActivityAt,
      },
      {
        id: archivedChatId,
        orgId,
        title: "Archived chat",
        status: "archived",
        lastMessageAt: archivedActivityAt,
        createdAt: archivedActivityAt,
        updatedAt: archivedActivityAt,
      },
    ]);

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);

    expect(summaries.map((item) => item.threadKey)).toContain(`chat:${activeChatId}`);
    expect(summaries.map((item) => item.threadKey)).not.toContain(`chat:${archivedChatId}`);
  });

  it("formats markdown headings in chat thread previews", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-preview";
    const chatId = randomUUID();
    const agentId = randomUUID();
    const activityAt = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Preview Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Preview Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Asher",
      role: "general",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(chatConversations).values({
      id: chatId,
      orgId,
      title: "Chat preview",
      status: "active",
      preferredAgentId: agentId,
      lastMessageAt: activityAt,
      createdAt: activityAt,
      updatedAt: activityAt,
    });

    await db.insert(chatMessages).values({
      orgId,
      conversationId: chatId,
      role: "assistant",
      kind: "message",
      body: "## 需求\n把 Agent 的处理流程规范化",
      createdAt: activityAt,
      updatedAt: activityAt,
    });

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const chatSummary = summaries.find((item) => item.threadKey === `chat:${chatId}`);

    expect(chatSummary?.preview).toBe("需求: 把 Agent 的处理流程规范化");
    expect(chatSummary?.subtitle).toBe("需求: 把 Agent 的处理流程规范化");
    expect(chatSummary?.metadata).toMatchObject({
      preferredAgentId: agentId,
    });
  });

  it("keeps pending chat approvals attention in Messenger thread summaries when chat is read", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-pending-approval-summary";
    const chatId = randomUUID();
    const approvalId = randomUUID();
    const activityAt = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Approval Attention Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Approval Attention Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(chatConversations).values({
      id: chatId,
      orgId,
      title: "Read chat with pending approval",
      status: "active",
      lastMessageAt: activityAt,
      createdAt: activityAt,
      updatedAt: activityAt,
    });
    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_issue_creation",
      requestedByUserId: userId,
      status: "pending",
      payload: { proposedIssue: { title: "Needs approval" } },
      createdAt: activityAt,
      updatedAt: activityAt,
    });
    await db.insert(chatMessages).values({
      orgId,
      conversationId: chatId,
      role: "assistant",
      kind: "approval_request",
      body: "Please approve this issue proposal.",
      approvalId,
      createdAt: activityAt,
      updatedAt: activityAt,
    });
    await chatSvc.markRead(chatId, orgId, userId, new Date("2026-04-12T13:00:00.000Z"));

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const chatSummary = summaries.find((item) => item.threadKey === `chat:${chatId}`);

    expect(chatSummary?.unreadCount).toBe(0);
    expect(chatSummary?.needsAttention).toBe(true);
  });

  it("hides empty synthetic threads for a brand-new organization", async () => {
    const orgId = randomUUID();
    const userId = "board-user-empty";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Empty Org",
      urlKey: deriveOrganizationUrlKey("Messenger Empty Org"),
      issuePrefix: `E${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);

    expect(summaries).toEqual([]);
  });

  it("includes chat pinned state in Messenger thread summaries", async () => {
    const orgId = randomUUID();
    const userId = "board-user-pinned-summary";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Pinned Summary Org",
      urlKey: deriveOrganizationUrlKey("Messenger Pinned Summary Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const pinnedConversation = await chatSvc.create(orgId, {
      title: "Pinned from summary",
      summary: "Pinned status should travel with /messenger/threads.",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const unpinnedConversation = await chatSvc.create(orgId, {
      title: "Unpinned from summary",
      summary: "This one should remain recent only.",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    await chatSvc.setPinned(pinnedConversation.id, orgId, userId, true);
    await db
      .update(chatConversations)
      .set({
        lastMessageAt: new Date("2026-05-03T12:00:00.000Z"),
        updatedAt: new Date("2026-05-03T12:00:00.000Z"),
      })
      .where(eq(chatConversations.id, unpinnedConversation.id));

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);

    expect(summaries.map((item) => item.threadKey).slice(0, 2)).toEqual([
      `chat:${pinnedConversation.id}`,
      `chat:${unpinnedConversation.id}`,
    ]);
    expect(summaries.find((item) => item.threadKey === `chat:${pinnedConversation.id}`)?.isPinned).toBe(true);
    expect(summaries.find((item) => item.threadKey === `chat:${unpinnedConversation.id}`)?.isPinned).toBe(false);
  });

  it("creates new fork family groups with the leaf icon", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork-leaf-icon";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork Leaf Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork Leaf Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const source = await chatSvc.create(orgId, {
      title: "Leaf fork topic",
      modelOverride: "gpt-5.6-terra",
      effortOverride: "xhigh",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const answer = await chatSvc.addMessage(source.id, {
      orgId,
      role: "assistant",
      kind: "message",
      body: "Branch here",
    });

    const child = await chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      sourceMessageId: answer.id,
      title: null,
      createdByUserId: userId,
    });

    const groups = await messengerSvc.listCustomGroups(orgId, userId);
    expect(child).toMatchObject({
      title: "Leaf fork topic (2)",
      modelOverride: null,
      effortOverride: null,
    });
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]?.name).toBe("Leaf fork topic");
    expect(groups.groups[0]?.icon).toBe(MESSENGER_FORK_GROUP_DEFAULT_ICON);
    expect(groups.groups[0]?.entries.map((entry) => entry.threadKey)).toEqual([
      `chat:${source.id}`,
      `chat:${child.id}`,
    ]);
  });

  it("allocates Codex-style numbered titles across concurrent and nested forks", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork-numbering";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork Numbering Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork Numbering Org"),
      issuePrefix: `N${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const source = await chatSvc.create(orgId, {
      title: "Numbered fork topic",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const [firstFork, secondFork] = await Promise.all([
      chatSvc.forkConversation({
        sourceConversationId: source.id,
        orgId,
        userId,
        createdByUserId: userId,
      }),
      chatSvc.forkConversation({
        sourceConversationId: source.id,
        orgId,
        userId,
        createdByUserId: userId,
      }),
    ]);
    expect([firstFork.title, secondFork.title].sort()).toEqual([
      "Numbered fork topic (2)",
      "Numbered fork topic (3)",
    ]);

    const nestedSource = firstFork.title.endsWith("(2)") ? firstFork : secondFork;
    const nestedFork = await chatSvc.forkConversation({
      sourceConversationId: nestedSource.id,
      orgId,
      userId,
      createdByUserId: userId,
    });

    expect(nestedFork.title).toBe("Numbered fork topic (4)");
    expect(nestedFork.forkRootConversationId).toBe(source.id);
  });

  it("preserves a manually renamed numeric suffix when forking again", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork-manual-numeric-title";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork Manual Numeric Title Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork Manual Numeric Title Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const source = await chatSvc.create(orgId, {
      title: "Plan",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const firstFork = await chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      createdByUserId: userId,
    });
    await chatSvc.update(firstFork.id, { title: "Plan (2026)" });

    const nestedFork = await chatSvc.forkConversation({
      sourceConversationId: firstFork.id,
      orgId,
      userId,
      createdByUserId: userId,
    });

    expect(nestedFork.title).toBe("Plan (2026) (2)");
  });

  it("keeps nested numbering stable when the base title requires truncation", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork-long-title";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork Long Title Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork Long Title Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const longTitle = "L".repeat(200);
    const source = await chatSvc.create(orgId, {
      title: longTitle,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    let latestFork = source;
    for (let index = 2; index <= 10; index += 1) {
      latestFork = await chatSvc.forkConversation({
        sourceConversationId: source.id,
        orgId,
        userId,
        createdByUserId: userId,
      });
    }
    expect(latestFork.title).toBe(`${"L".repeat(195)} (10)`);

    const nestedFork = await chatSvc.forkConversation({
      sourceConversationId: latestFork.id,
      orgId,
      userId,
      createdByUserId: userId,
    });

    expect(nestedFork.title).toBe(`${"L".repeat(195)} (11)`);
  });

  it("forks a chat from a middle message and keeps the fork family in one custom group", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork";
    const projectId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork Org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Forked context project",
      status: "planned",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Autumn",
      role: "operator_assistant",
      status: "idle",
    });

    const source = await chatSvc.create(orgId, {
      title: "Original fork topic",
      summary: "Try several angles without polluting context.",
      issueCreationMode: "manual_approval",
      planMode: true,
      createdByUserId: userId,
      contextLinks: [{ entityType: "project", entityId: projectId }],
    });
    await chatSvc.addMessage(source.id, {
      orgId,
      role: "user",
      kind: "message",
      body: "First question",
    });
    const firstAnswer = await chatSvc.addMessage(source.id, {
      orgId,
      role: "assistant",
      kind: "message",
      body: "First answer",
      replyingAgentId: agentId,
    });
    await chatSvc.addMessage(source.id, {
      orgId,
      role: "user",
      kind: "message",
      body: "Later source-only turn",
    });

    const manualGroup = await messengerSvc.createCustomGroup(orgId, userId, "Manual research group", "rocket::teal");
    await db.insert(messengerCustomGroupEntries).values({
      id: randomUUID(),
      orgId,
      userId,
      groupId: manualGroup!.id,
      threadKey: `chat:${source.id}`,
      sortOrder: 0,
    });

    const child = await chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      sourceMessageId: firstAnswer.id,
      title: "Alternative angle",
      createdByUserId: userId,
    });

    const childMessages = await chatSvc.listMessages(child.id, { includeTranscript: false });
    expect(child).toMatchObject({
      title: "Alternative angle",
      forkedFromConversationId: source.id,
      forkedFromMessageId: firstAnswer.id,
      forkRootConversationId: source.id,
      planMode: true,
    });
    expect(child.lastMessageAt?.getTime()).toBeGreaterThan(firstAnswer.createdAt.getTime());
    expect(child.contextLinks.map((link) => [link.entityType, link.entityId])).toEqual([["project", projectId]]);
    expect(childMessages.map((message) => message.body)).toEqual([
      "First question",
      "First answer",
      expect.stringContaining("Forked from"),
    ]);
    expect(childMessages[2]?.body).toContain("at message.");
    expect(childMessages[2]?.body).not.toContain(firstAnswer.id);
    expect(childMessages[2]?.structuredPayload).toMatchObject({
      eventType: "chat_fork",
      sourceConversationId: source.id,
      sourceConversationTitle: "Original fork topic",
      sourceMessageId: firstAnswer.id,
      forkRootConversationId: source.id,
    });
    expect(childMessages[1]?.replyingAgentId).toBe(agentId);
    expect(childMessages.map((message) => message.body).join("\n")).not.toContain("Later source-only turn");

    const grandchild = await chatSvc.forkConversation({
      sourceConversationId: child.id,
      orgId,
      userId,
      sourceMessageId: null,
      title: "Third angle",
      createdByUserId: userId,
    });

    const groups = await messengerSvc.listCustomGroups(orgId, userId);
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]?.name).toBe("Manual research group");
    expect(groups.groups[0]?.icon).toBe("rocket::teal");
    expect(groups.groups[0]?.entries.map((entry) => entry.threadKey)).toEqual([
      `chat:${source.id}`,
      `chat:${child.id}`,
      `chat:${grandchild.id}`,
    ]);
    expect(grandchild.forkRootConversationId).toBe(source.id);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId, { limit: 10, splitIssues: true });
    expect(summaries[0]?.threadKey).toBe(`chat:${grandchild.id}`);
    expect(summaries[1]?.threadKey).toBe(`chat:${child.id}`);
  });

  it("re-owns runtime-neutral inline visuals across forks without duplicating backing bytes", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-inline-visual-fork";
    const agentId = randomUUID();
    const sha256 = "d".repeat(64);

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Inline Visual Fork Org",
      urlKey: deriveOrganizationUrlKey("Messenger Inline Visual Fork Org"),
      issuePrefix: `I${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Visual Agent",
      role: "operator_assistant",
      status: "idle",
    });
    const source = await chatSvc.create(orgId, {
      title: "Inline visual fork",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const sourceMessage = await chatSvc.addMessage(source.id, {
      orgId,
      role: "assistant",
      kind: "message",
      body: 'Capacity\n::rudder-inline-vis{slot="0"}',
      replyingAgentId: agentId,
    });
    const [asset] = await db.insert(assets).values({
      orgId,
      provider: "local",
      objectKey: `inline-visual-fork-${randomUUID()}`,
      contentType: "text/html",
      byteSize: 42,
      sha256,
      originalFilename: "inline-visual-1.html",
      createdByAgentId: agentId,
    }).returning();
    const [sourceAttachment] = await db.insert(chatAttachments).values({
      orgId,
      conversationId: source.id,
      messageId: sourceMessage.id,
      assetId: asset!.id,
    }).returning();
    await chatSvc.updateMessageInternalInlineVisuals(source.id, sourceMessage.id, {
      inlineVisualsV1: [{
        version: 1,
        slot: 0,
        file: "inline-visual-1.html",
        status: "ready",
        attachmentId: sourceAttachment!.id,
        contentType: "text/html",
        byteSize: 42,
        sha256,
      }],
    });

    const child = await chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      sourceMessageId: sourceMessage.id,
      createdByUserId: userId,
    });
    const childMessages = await chatSvc.listMessages(child.id, { includeTranscript: false });
    const copiedMessage = childMessages.find((message) => message.role === "assistant")!;
    const copiedMapping = (copiedMessage.structuredPayload as {
      inlineVisualsV1?: Array<{ status: string; attachmentId?: string }>;
    } | null)?.inlineVisualsV1?.[0];
    const copiedAttachment = copiedMessage.attachments[0]!;

    expect(copiedMessage.body).toBe(sourceMessage.body);
    expect(copiedMapping).toMatchObject({
      status: "ready",
      attachmentId: copiedAttachment.id,
    });
    expect(copiedAttachment.id).not.toBe(sourceAttachment!.id);
    expect(copiedAttachment.messageId).toBe(copiedMessage.id);
    expect(copiedAttachment.assetId).toBe(asset!.id);

    expect(await chatSvc.removeAttachment(copiedAttachment.id)).toMatchObject({ assetDeleted: false });
    expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toHaveLength(1);
    expect(await chatSvc.removeAttachment(sourceAttachment!.id)).toMatchObject({ assetDeleted: true });
    expect(await db.select().from(assets).where(eq(assets.id, asset!.id))).toHaveLength(0);
  });

  it("two-pass forks preserve safe payload, omit Run transcript provenance, and re-own annotation sources and files", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-annotation-fork";
    const annotationId = randomUUID();
    const processAnnotationId = randomUUID();
    const processGenerationId = randomUUID();
    const sourceBody = "Fork this selected answer safely.";
    const processSource = "检查 fork process evidence";
    const processTs = "2026-07-23T01:00:00.500Z";
    const selectedText = "selected answer";
    const selectedStart = sourceBody.indexOf(selectedText);
    const sourceAt = new Date("2026-07-23T01:00:00.000Z");
    const userAt = new Date("2026-07-23T01:00:01.000Z");
    const forkAt = new Date("2026-07-23T01:00:02.000Z");
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Annotation Fork Org",
      urlKey: deriveOrganizationUrlKey("Messenger Annotation Fork Org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const sourceConversation = await chatSvc.create(orgId, {
      title: "Annotation fork",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const [sourceAssistant] = await db
      .insert(chatMessages)
      .values({
        orgId,
        conversationId: sourceConversation.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: sourceBody,
        structuredPayload: {
          durableContext: { kind: "safe", version: 1 },
          __chatTranscript: [{
            kind: "thinking",
            ts: processTs,
            text: processSource,
            generationId: processGenerationId,
            generationSeqStart: 1,
            generationSeqEnd: 1,
          }],
        },
        createdAt: sourceAt,
        updatedAt: sourceAt,
      })
      .returning();
    await db.insert(chatGenerations).values({
      id: processGenerationId,
      orgId,
      conversationId: sourceConversation.id,
      status: "completed",
      completedAt: userAt,
    });
    await db.insert(chatGenerationEvents).values({
      orgId,
      generationId: processGenerationId,
      generationSeq: 1,
      attemptEpoch: 1,
      eventKind: "transcript",
      payload: {
        entry: {
          kind: "thinking",
          ts: processTs,
          text: processSource,
        },
      },
      assistantMessageId: sourceAssistant!.id,
    });
    const annotatedUser = await chatSvc.addUserChatMessage(
      sourceConversation.id,
      orgId,
      "Keep the exact quote",
      null,
      {
        structuredPayloadProvided: true,
        structuredPayload: {
          durableContext: { preserved: true },
          inlineAnnotations: [
            {
              id: annotationId,
              surface: "assistant_body",
              selectedText,
              comment: "Fork with this evidence",
              sourceConversationId: sourceConversation.id,
              sourceMessageId: sourceAssistant!.id,
              sourceHash: hashChatAnnotationSource(sourceBody),
              start: selectedStart,
              end: selectedStart + selectedText.length,
              prefix: sourceBody.slice(0, selectedStart),
              suffix: sourceBody.slice(selectedStart + selectedText.length),
              attachmentIds: [],
            },
            {
              id: processAnnotationId,
              surface: "process_transcript",
              transcriptKind: "thinking",
              selectedText: processSource,
              comment: "Keep process evidence",
              sourceConversationId: sourceConversation.id,
              sourceMessageId: sourceAssistant!.id,
              sourceHash: hashChatAnnotationSource(processSource),
              generationId: processGenerationId,
              generationSeqStart: 1,
              generationSeqEnd: 1,
              start: 0,
              end: processSource.length,
              prefix: "",
              suffix: "",
              attachmentIds: [],
            },
          ],
        },
        attachments: [{
          provider: "local_disk",
          objectKey: `fork-annotations/${sourceConversation.id}/evidence.txt`,
          contentType: "text/plain",
          byteSize: 8,
          sha256: "fork-annotation-sha256",
          originalFilename: "evidence.txt",
          createdByAgentId: null,
          createdByUserId: userId,
        }],
        attachmentFileIndexesByAnnotationId: new Map([[annotationId, [0]]]),
      },
    );
    await db
      .update(chatMessages)
      .set({ createdAt: userAt, updatedAt: userAt })
      .where(eq(chatMessages.id, annotatedUser.id));
    const [forkPoint] = await db
      .insert(chatMessages)
      .values({
        orgId,
        conversationId: sourceConversation.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Fork point response",
        createdAt: forkAt,
        updatedAt: forkAt,
      })
      .returning();

    const child = await chatSvc.forkConversation({
      sourceConversationId: sourceConversation.id,
      orgId,
      userId,
      sourceMessageId: forkPoint!.id,
      createdByUserId: userId,
    });
    const childMessages = await chatSvc.listMessages(child.id, { includeTranscript: false });
    const copiedSource = childMessages.find((message) => message.body === sourceBody)!;
    const copiedUser = childMessages.find((message) => message.body === "Keep the exact quote")!;
    const copiedAnnotations = chatInlineAnnotationsFromStructuredPayload(
      copiedUser.structuredPayload,
    );

    expect(copiedSource.id).not.toBe(sourceAssistant!.id);
    expect(copiedSource.structuredPayload).toMatchObject({
      durableContext: { kind: "safe", version: 1 },
    });
    expect(copiedUser.structuredPayload).toMatchObject({
      durableContext: { preserved: true },
    });
    expect(copiedAnnotations).toEqual([
      expect.objectContaining({
        id: annotationId,
        sourceConversationId: child.id,
        sourceMessageId: copiedSource.id,
        attachmentIds: [copiedUser.attachments[0]!.id],
      }),
      expect.objectContaining({
        id: processAnnotationId,
        sourceConversationId: child.id,
        sourceMessageId: copiedSource.id,
        generationId: processGenerationId,
        attachmentIds: [],
      }),
    ]);
    expect(copiedSource).toMatchObject({ generationId: null });
    const copiedSourceRow = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, copiedSource.id))
      .then((rows) => rows[0]!);
    expect(copiedSourceRow.structuredPayload).not.toHaveProperty("__chatTranscript");
    expect(copiedUser.attachments[0]).toMatchObject({
      conversationId: child.id,
      messageId: copiedUser.id,
      assetId: annotatedUser.attachments[0]!.assetId,
    });
    expect(copiedUser.attachments[0]!.id).not.toBe(annotatedUser.attachments[0]!.id);
  });

  it("rejects a fork when a copied annotation points outside the copied message range", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-annotation-fork-range";
    const sourceConversationId = randomUUID();
    const earlierAssistantId = randomUUID();
    const corruptedUserId = randomUUID();
    const forkPointId = randomUUID();
    const laterAssistantId = randomUUID();
    const sourceBody = "Later answer outside the fork range";
    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Annotation Fork Range Org",
      urlKey: deriveOrganizationUrlKey("Messenger Annotation Fork Range Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: sourceConversationId,
      orgId,
      title: "Annotation fork range",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    await db.insert(chatMessages).values([
      {
        id: earlierAssistantId,
        orgId,
        conversationId: sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Earlier source",
        createdAt: new Date("2026-07-23T02:00:00.000Z"),
        updatedAt: new Date("2026-07-23T02:00:00.000Z"),
      },
      {
        id: corruptedUserId,
        orgId,
        conversationId: sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Corrupted future annotation",
        structuredPayload: {
          inlineAnnotations: [{
            id: randomUUID(),
            surface: "assistant_body",
            selectedText: sourceBody,
            comment: null,
            sourceConversationId,
            sourceMessageId: laterAssistantId,
            sourceHash: hashChatAnnotationSource(sourceBody),
            start: 0,
            end: sourceBody.length,
            prefix: "",
            suffix: "",
            attachmentIds: [],
          }],
        },
        createdAt: new Date("2026-07-23T02:00:01.000Z"),
        updatedAt: new Date("2026-07-23T02:00:01.000Z"),
      },
      {
        id: forkPointId,
        orgId,
        conversationId: sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Fork here",
        createdAt: new Date("2026-07-23T02:00:02.000Z"),
        updatedAt: new Date("2026-07-23T02:00:02.000Z"),
      },
      {
        id: laterAssistantId,
        orgId,
        conversationId: sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: sourceBody,
        createdAt: new Date("2026-07-23T02:00:03.000Z"),
        updatedAt: new Date("2026-07-23T02:00:03.000Z"),
      },
    ]);

    await expect(chatSvc.forkConversation({
      sourceConversationId,
      orgId,
      userId,
      sourceMessageId: forkPointId,
      createdByUserId: userId,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("outside"),
    });
    expect(await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.forkedFromConversationId, sourceConversationId)))
      .toEqual([]);
  });

  it("rejects message-level forks from user messages", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork-user-message";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork User Message Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork User Message Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const source = await chatSvc.create(orgId, {
      title: "User message fork guard",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const userMessage = await chatSvc.addMessage(source.id, {
      orgId,
      role: "user",
      kind: "message",
      body: "Do not fork from this user prompt",
    });

    await expect(chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      sourceMessageId: userMessage.id,
      createdByUserId: userId,
    })).rejects.toMatchObject({
      status: 422,
      message: "Fork source message must be an assistant response",
    });
  });

  it("rejects message-level forks from non-message assistant records", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork-assistant-record";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork Assistant Record Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork Assistant Record Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const source = await chatSvc.create(orgId, {
      title: "Assistant record fork guard",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const askUserRecord = await chatSvc.addMessage(source.id, {
      orgId,
      role: "assistant",
      kind: "ask_user",
      body: "Need operator input",
    });

    await expect(chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      sourceMessageId: askUserRecord.id,
      createdByUserId: userId,
    })).rejects.toMatchObject({
      status: 422,
      message: "Fork source message must be an assistant response",
    });
  });

  it("does not copy later source messages when their IDs sort before the fork point", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-fork-order";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Fork Ordering Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Fork Ordering Org"),
      issuePrefix: `O${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const source = await chatSvc.create(orgId, {
      title: "Fork ordering guard",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const beforeAt = new Date("2026-06-23T01:00:00.000Z");
    const forkAt = new Date("2026-06-23T01:00:01.000Z");
    const laterAt = forkAt;
    const forkMessageId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const laterMessageId = "00000000-0000-4000-8000-000000000001";

    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId: source.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Earlier setup",
        createdAt: beforeAt,
        updatedAt: beforeAt,
      },
      {
        id: forkMessageId,
        orgId,
        conversationId: source.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Fork point answer",
        createdAt: forkAt,
        updatedAt: forkAt,
      },
      {
        id: laterMessageId,
        orgId,
        conversationId: source.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Later turn with lexically earlier id",
        createdAt: laterAt,
        updatedAt: laterAt,
      },
    ]);

    const child = await chatSvc.forkConversation({
      sourceConversationId: source.id,
      orgId,
      userId,
      sourceMessageId: forkMessageId,
      createdByUserId: userId,
    });

    const childMessages = await chatSvc.listMessages(child.id, { includeTranscript: false });
    expect(childMessages.map((message) => message.body)).toEqual([
      "Earlier setup",
      "Fork point answer",
      expect.stringContaining("Forked from"),
    ]);
    expect(childMessages[2]?.body).toContain("at message.");
    expect(childMessages[2]?.body).not.toContain(forkMessageId);
    expect(childMessages.map((message) => message.body).join("\n")).not.toContain("Later turn with lexically earlier id");
  });

  it("persists Messenger synthetic thread read state", async () => {
    const orgId = randomUUID();
    const userId = "board-user-2";
    const readAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Org Read State",
      urlKey: deriveOrganizationUrlKey("Messenger Org Read State"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const state = await messengerSvc.setThreadRead(orgId, userId, "issues", readAt);
    expect(state?.lastReadAt.toISOString()).toBe(readAt.toISOString());

    const persisted = await messengerSvc.getThreadState(orgId, userId, "issues");
    expect(persisted?.lastReadAt.toISOString()).toBe(readAt.toISOString());
  });

  it("keeps distinct instances of one resource and makes instance and mutation retries idempotent", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-instance-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Instances Org",
      urlKey: deriveOrganizationUrlKey("Saved View Instances Org"),
      issuePrefix: "SVI",
    });
    const group = await messengerSvc.createCustomGroup(orgId, userId, "References");
    const mutationOne = randomUUID();
    const first = await savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/guide.md", viewInstanceId: "file-view-1" },
      title: "Guide one",
      clientMutationId: mutationOne,
      placement: { kind: "group", groupId: group.id },
    });
    const activityAfterFirst = await db.select().from(activityLog).where(eq(activityLog.entityId, first.savedView.id));
    const retriedByMutation = await savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/guide.md", viewInstanceId: "file-view-1" },
      title: "Guide one",
      clientMutationId: mutationOne,
      placement: { kind: "group", groupId: group.id },
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, first.savedView.id)))
      .toHaveLength(activityAfterFirst.length);
    const mutationTwo = randomUUID();
    const retriedByFreshMutation = await savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/guide.md", viewInstanceId: "file-view-1" },
      title: "Guide one",
      clientMutationId: mutationTwo,
      placement: { kind: "group", groupId: group.id },
    });
    expect(retriedByFreshMutation.savedView.id).toBe(first.savedView.id);
    expect(retriedByFreshMutation.savedView.updatedAt).toEqual(first.savedView.updatedAt);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, first.savedView.id)))
      .toHaveLength(activityAfterFirst.length);
    expect(await db.select().from(messengerSavedViewMutations).where(eq(
      messengerSavedViewMutations.savedViewId,
      first.savedView.id,
    ))).toHaveLength(2);
    const updatedByFreshMutation = await savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/guide.md", viewInstanceId: "file-view-1" },
      title: "Guide one renamed",
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: group.id },
    });
    expect(updatedByFreshMutation.savedView).toMatchObject({
      id: first.savedView.id,
      title: "Guide one renamed",
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, first.savedView.id)))
      .toHaveLength(activityAfterFirst.length + 1);
    const second = await savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/guide.md", viewInstanceId: "file-view-2" },
      title: "Guide two",
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: group.id },
    });

    expect(retriedByMutation.savedView.id).toBe(first.savedView.id);
    expect(second.savedView.id).not.toBe(first.savedView.id);
    expect(first.savedView).toMatchObject({
      instanceId: "file-view-1",
      canonicalResourceKey: "library-file:docs/guide.md",
      resourceKey: "view-instance:file-view-1",
    });
    expect(await db.select().from(messengerSavedViews)).toHaveLength(2);
    expect(await db.select().from(messengerCustomGroupEntries)).toHaveLength(2);

    const otherGroup = await messengerSvc.createCustomGroup(orgId, userId, "Other references");
    await expect(savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/guide.md", viewInstanceId: "file-view-1" },
      title: "Conflicting placement",
      clientMutationId: mutationOne,
      placement: { kind: "group", groupId: otherGroup.id },
    })).rejects.toMatchObject({ status: 409 });
    await expect(savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/other.md", viewInstanceId: "file-view-1" },
      title: "Conflicting target",
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: group.id },
    })).rejects.toMatchObject({ status: 409 });
    await expect(savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/other.md", viewInstanceId: "file-view-other" },
      title: "Conflicting mutation",
      clientMutationId: mutationOne,
      placement: { kind: "group", groupId: group.id },
    })).rejects.toMatchObject({ status: 409 });
    await expect(savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "docs/other.md", viewInstanceId: "fresh-mutation-other" },
      title: "Conflicting fresh mutation replay",
      clientMutationId: mutationTwo,
      placement: { kind: "group", groupId: group.id },
    })).rejects.toMatchObject({ status: 409 });
  });

  it("encodes opaque local app canonical identity without delimiter collisions", () => {
    const first = messengerSavedViewCanonicalResourceKey({
      kind: "local_app",
      desktopInstallationId: "desktop:a",
      appPublicId: "app",
      localBindingId: "binding",
      viewInstanceId: "local-view-a",
    });
    const second = messengerSavedViewCanonicalResourceKey({
      kind: "local_app",
      desktopInstallationId: "desktop",
      appPublicId: "a:app",
      localBindingId: "binding",
      viewInstanceId: "local-view-b",
    });
    expect(first).not.toBe(second);
  });

  it("atomically creates or reuses anchor groups for Chat and Issue hosts", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-anchor-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Anchors Org",
      urlKey: deriveOrganizationUrlKey("Saved View Anchors Org"),
      issuePrefix: "SVA",
    });
    const conversationId = randomUUID();
    const issueId = randomUUID();
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Launch research",
      createdByUserId: userId,
    });
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Ship launch",
      createdByUserId: userId,
    });

    const chatInput = {
      target: { kind: "browser" as const, tabId: "research", url: "https://example.test/research", viewInstanceId: "browser-research" },
      title: "Research page",
      clientMutationId: randomUUID(),
      placement: { kind: "anchor" as const, anchor: { kind: "chat" as const, conversationId } },
    };
    const concurrent = await Promise.all([
      savedViewsSvc.keep(orgId, userId, chatInput),
      savedViewsSvc.keep(orgId, userId, chatInput),
    ]);
    expect(new Set(concurrent.map((result) => result.savedView.id)).size).toBe(1);
    expect(new Set(concurrent.map((result) => result.group.id)).size).toBe(1);
    const chatGroup = concurrent[0]!.group;
    expect(chatGroup.name).toBe("Launch research");
    expect((await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.id, chatGroup.id)))[0]?.pinnedAt).toBeNull();
    expect((await db.select().from(messengerCustomGroupEntries).where(eq(messengerCustomGroupEntries.groupId, chatGroup.id)))
      .map((entry) => entry.threadKey)).toEqual([`chat:${conversationId}`, `saved-view:${concurrent[0]!.savedView.id}`]);

    const issueResult = await savedViewsSvc.keep(orgId, userId, {
      target: { kind: "automation", automationId: randomUUID(), viewInstanceId: "automation-view-1" },
      title: "Launch automation",
      clientMutationId: randomUUID(),
      placement: { kind: "anchor", anchor: { kind: "issue", issueId } },
    });
    expect(issueResult.group.name).toBe("Ship launch");
    expect((await db.select().from(messengerCustomGroupEntries).where(eq(messengerCustomGroupEntries.groupId, issueResult.group.id)))
      .map((entry) => entry.threadKey)).toEqual([`issue:${issueId}`, `saved-view:${issueResult.savedView.id}`]);

    const existing = await messengerSvc.createCustomGroup(orgId, userId, "Existing host group");
    const groupedConversationId = randomUUID();
    await db.insert(chatConversations).values({ id: groupedConversationId, orgId, title: "Grouped", createdByUserId: userId });
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, existing.id, `chat:${groupedConversationId}`);
    const grouped = await savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_directory", directoryPath: "plans", viewInstanceId: "plans-view" },
      title: "Plans",
      clientMutationId: randomUUID(),
      placement: { kind: "anchor", anchor: { kind: "chat", conversationId: groupedConversationId } },
    });
    expect(grouped.group.id).toBe(existing.id);
  });

  it("keeps, restores, and idempotently replays an exact loose Saved View without group membership", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-loose-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Loose Saved Views Org",
      urlKey: deriveOrganizationUrlKey("Loose Saved Views Org"),
      issuePrefix: "LSV",
    });
    const clientMutationId = randomUUID();
    const input = {
      target: {
        kind: "library_file" as const,
        filePath: "notes/loose.md",
        viewInstanceId: "loose-library-view",
      },
      title: "Loose notes",
      clientMutationId,
      placement: { kind: "loose" as const },
    };

    const first = await savedViewsSvc.keep(orgId, userId, input);
    expect(first.group).toBeNull();
    expect(await db.select().from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.threadKey, `saved-view:${first.savedView.id}`))).toEqual([]);

    const replay = await savedViewsSvc.keep(orgId, userId, input);
    expect(replay).toEqual(first);
    expect((await db.select().from(messengerSavedViewMutations)
      .where(eq(messengerSavedViewMutations.clientMutationId, clientMutationId)))[0]).toMatchObject({
      savedViewId: first.savedView.id,
      groupId: null,
    });

    await expect(savedViewsSvc.keep(orgId, userId, {
      ...input,
      title: "Conflicting loose replay",
    })).rejects.toMatchObject({ status: 409 });

    await db.update(messengerSavedViews)
      .set({ hiddenAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(messengerSavedViews.id, first.savedView.id));
    const restored = await savedViewsSvc.keep(orgId, userId, {
      ...input,
      clientMutationId: randomUUID(),
      title: "Restored loose notes",
    });
    expect(restored).toMatchObject({
      savedView: { id: first.savedView.id, title: "Restored loose notes", hiddenAt: null },
      group: null,
    });
  });

  it("moves a grouped Saved View to loose placement with a fresh mutation receipt", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-loose-conflict-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Loose Conflict Org",
      urlKey: deriveOrganizationUrlKey("Loose Conflict Org"),
      issuePrefix: "LCO",
    });
    const group = await messengerSvc.createCustomGroup(orgId, userId, "Pinned");
    const target = {
      kind: "automation" as const,
      automationId: randomUUID(),
      viewInstanceId: "grouped-to-loose",
    };
    const grouped = await savedViewsSvc.keep(orgId, userId, {
      target,
      title: "Grouped automation",
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: group.id },
    });

    const moved = await savedViewsSvc.keep(orgId, userId, {
      target,
      title: "Grouped automation",
      clientMutationId: randomUUID(),
      placement: { kind: "loose" },
    });
    expect(moved).toMatchObject({
      savedView: { id: grouped.savedView.id, title: "Grouped automation" },
      group: null,
    });
    expect(await db.select().from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.threadKey, `saved-view:${grouped.savedView.id}`))).toEqual([]);
    expect((await db.select().from(messengerSavedViewMutations)
      .where(eq(messengerSavedViewMutations.savedViewId, grouped.savedView.id)))
      .some((receipt) => receipt.groupId === null)).toBe(true);
  });

  it("leaves Saved Views loose when membership or their containing group is removed", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-loosen-removal-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Loose Removal Org",
      urlKey: deriveOrganizationUrlKey("Loose Removal Org"),
      issuePrefix: "LRO",
    });
    const savedView = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "automation", automationId: randomUUID(), viewInstanceId: "loosen-removal" },
      title: "Keep this view",
    });

    const firstGroup = await messengerSvc.createCustomGroup(orgId, userId, "First");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, firstGroup.id, `saved-view:${savedView.id}`);
    await expect(messengerSvc.removeThreadFromCustomGroups(
      orgId,
      userId,
      `saved-view:${savedView.id}`,
    )).resolves.toEqual({ itemKey: `saved-view:${savedView.id}` });
    await expect(savedViewsSvc.get(orgId, userId, savedView.id)).resolves.toMatchObject({ id: savedView.id });

    const secondGroup = await messengerSvc.createCustomGroup(orgId, userId, "Second");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, secondGroup.id, `saved-view:${savedView.id}`);
    await expect(messengerSvc.separateCustomGroup(orgId, userId, secondGroup.id))
      .resolves.toMatchObject({ id: secondGroup.id });
    await expect(savedViewsSvc.get(orgId, userId, savedView.id)).resolves.toMatchObject({ id: savedView.id });

    const thirdGroup = await messengerSvc.createCustomGroup(orgId, userId, "Third");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, thirdGroup.id, `saved-view:${savedView.id}`);
    await expect(messengerSvc.deleteCustomGroup(orgId, userId, thirdGroup.id))
      .resolves.toMatchObject({ id: thirdGroup.id });
    await expect(savedViewsSvc.get(orgId, userId, savedView.id)).resolves.toMatchObject({ id: savedView.id });
    expect(await db.select().from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.threadKey, `saved-view:${savedView.id}`))).toEqual([]);
    const removalEvidence = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, savedView.id),
        eq(activityLog.action, "messenger.saved_view_group_removed"),
      ));
    expect(removalEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orgId,
        actorType: "user",
        actorId: userId,
        entityType: "messenger_saved_view",
        entityId: savedView.id,
        details: expect.objectContaining({
          itemKey: `saved-view:${savedView.id}`,
          groupId: firstGroup.id,
          source: "item_remove",
        }),
      }),
      expect.objectContaining({
        orgId,
        actorType: "user",
        actorId: userId,
        entityType: "messenger_saved_view",
        entityId: savedView.id,
        details: expect.objectContaining({
          itemKey: `saved-view:${savedView.id}`,
          groupId: secondGroup.id,
          source: "group_separate",
        }),
      }),
      expect.objectContaining({
        orgId,
        actorType: "user",
        actorId: userId,
        entityType: "messenger_saved_view",
        entityId: savedView.id,
        details: expect.objectContaining({
          itemKey: `saved-view:${savedView.id}`,
          groupId: thirdGroup.id,
          source: "group_delete",
        }),
      }),
    ]));
  });

  it("rolls back missing or cross-organization anchors and allows Saved Views to become loose", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "saved-view-protected-group-user";
    await db.insert(organizations).values([
      { id: orgId, name: "Protected Group Org", urlKey: deriveOrganizationUrlKey("Protected Group Org"), issuePrefix: "PGO" },
      { id: otherOrgId, name: "Other Protected Group Org", urlKey: deriveOrganizationUrlKey("Other Protected Group Org"), issuePrefix: "OPG" },
    ]);
    const foreignChatId = randomUUID();
    await db.insert(chatConversations).values({ id: foreignChatId, orgId: otherOrgId, title: "Foreign", createdByUserId: userId });
    const invalidInput = {
      target: { kind: "library_file" as const, filePath: "private.md", viewInstanceId: "private-view" },
      title: "Private",
      clientMutationId: randomUUID(),
      placement: { kind: "anchor" as const, anchor: { kind: "chat" as const, conversationId: foreignChatId } },
    };
    await expect(savedViewsSvc.keep(orgId, userId, invalidInput)).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(messengerSavedViews)).toEqual([]);
    expect(await db.select().from(messengerCustomGroups)).toEqual([]);

    const group = await messengerSvc.createCustomGroup(orgId, userId, "Protected");
    const kept = await savedViewsSvc.keep(orgId, userId, {
      target: {
        kind: "local_app",
        desktopInstallationId: "desktop-1",
        appPublicId: "com.example.app",
        localBindingId: "binding-1",
        viewInstanceId: "local-app-view",
      },
      title: "Local app",
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: group.id },
    });
    expect(kept.savedView.targetPayload).toEqual({
      kind: "local_app",
      desktopInstallationId: "desktop-1",
      appPublicId: "com.example.app",
      localBindingId: "binding-1",
      viewInstanceId: "local-app-view",
    });
    const invalidVisibilityPatch = { hidden: true } as unknown as Parameters<typeof savedViewsSvc.update>[3];
    await expect(savedViewsSvc.update(
      orgId,
      userId,
      kept.savedView.id,
      invalidVisibilityPatch,
    )).rejects.toMatchObject({ status: 400 });
    await expect(savedViewsSvc.get(orgId, userId, kept.savedView.id)).resolves.toMatchObject({ hiddenAt: null });
    await expect(messengerSvc.removeThreadFromCustomGroups(
      orgId,
      userId,
      `saved-view:${kept.savedView.id}`,
    )).resolves.toEqual({ itemKey: `saved-view:${kept.savedView.id}` });
    expect(await db.select().from(messengerCustomGroupEntries).where(eq(messengerCustomGroupEntries.groupId, group.id))).toHaveLength(0);
    await expect(savedViewsSvc.get(orgId, userId, kept.savedView.id)).resolves.toMatchObject({ id: kept.savedView.id });
    expect(await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.id, group.id))).toHaveLength(0);
    await savedViewsSvc.remove(orgId, userId, kept.savedView.id);
  });

  it("persists, updates, restores, and isolates Messenger Saved Views by instance identity", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "saved-view-user";
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Saved Views Org",
        urlKey: deriveOrganizationUrlKey("Saved Views Org"),
        issuePrefix: `V${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
      {
        id: otherOrgId,
        name: "Other Saved Views Org",
        urlKey: deriveOrganizationUrlKey("Other Saved Views Org"),
        issuePrefix: `W${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
    ]);

    const firstBrowser = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "browser", tabId: "tab-a", url: "https://example.test/shared", viewInstanceId: "tab-a" },
      title: "First browser",
    });
    const repeatedTab = await savedViewsSvc.update(orgId, userId, firstBrowser.id, {
      target: { kind: "browser", tabId: "tab-a", url: "https://example.test/updated", viewInstanceId: "tab-a" },
      title: "Updated browser",
    });
    const sameUrlDifferentTab = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "browser", tabId: "tab-b", url: "https://example.test/updated", viewInstanceId: "tab-b" },
      title: "Second browser",
    });
    expect(repeatedTab.id).toBe(firstBrowser.id);
    expect(repeatedTab.targetPayload).toMatchObject({ tabId: "tab-a", url: "https://example.test/updated" });
    expect(sameUrlDifferentTab.id).not.toBe(firstBrowser.id);

    const automationId = randomUUID();
    const automation = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "automation", automationId, viewInstanceId: "automation-view" },
      title: "Missing automation remains saved",
    });
    const group = await messengerSvc.createCustomGroup(orgId, userId, "Saved tools");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, group.id, `saved-view:${automation.id}`);
    const membershipBeforeHide = await db.select().from(messengerCustomGroupEntries);
    expect(membershipBeforeHide).toHaveLength(1);

    await db.update(messengerSavedViews)
      .set({ hiddenAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(messengerSavedViews.id, automation.id));
    expect((await savedViewsSvc.list(orgId, userId, { visibility: "hidden" })).items.map((view) => view.id)).toEqual([automation.id]);
    expect((await savedViewsSvc.list(orgId, userId, { visibility: "visible" })).items.map((view) => view.id)).not.toContain(automation.id);
    expect((await messengerSvc.listCustomGroups(orgId, userId)).groups[0]?.entries).toEqual([]);
    expect(await db.select().from(messengerCustomGroupEntries)).toHaveLength(1);
    const restored = await savedViewsSvc.update(orgId, userId, automation.id, {
      hidden: false,
      title: "Restored missing automation",
    });
    expect(restored.id).toBe(automation.id);
    expect(restored.hiddenAt).toBeNull();
    const restoredEntry = (await messengerSvc.listCustomGroups(orgId, userId)).groups[0]?.entries[0];
    expect(restoredEntry).toMatchObject({
      itemKey: `saved-view:${automation.id}`,
      item: { type: "saved_view", title: "Restored missing automation" },
    });
    expect(restoredEntry).not.toHaveProperty("threadKey");
    expect(restoredEntry).not.toHaveProperty("thread");

    const metadataUpdated = await savedViewsSvc.update(orgId, userId, automation.id, {
      subtitle: "Metadata remains editable",
    });
    expect(metadataUpdated.subtitle).toBe("Metadata remains editable");

    await expect(savedViewsSvc.update(orgId, userId, automation.id, {
      target: { kind: "automation", automationId: randomUUID(), viewInstanceId: "different-automation-view" },
    })).rejects.toMatchObject({ status: 400 });

    await expect(savedViewsSvc.get(orgId, "another-user", automation.id)).rejects.toMatchObject({ status: 404 });
    await expect(savedViewsSvc.get(otherOrgId, userId, automation.id)).rejects.toMatchObject({ status: 404 });
    expect((await savedViewsSvc.list(orgId, "another-user", { visibility: "all" })).items).toEqual([]);

    const savedViewActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityType, "messenger_saved_view"));
    expect(savedViewActivity.length).toBeGreaterThanOrEqual(3);
    expect(new Set(savedViewActivity.map((event) => event.actorId))).toEqual(new Set([userId]));

    await savedViewsSvc.remove(orgId, userId, automation.id);
    expect(await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.id, group.id))).toEqual([]);
  });

  it("pins only owner-scoped Local App Saved Views to the Primary Rail", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "local-app-pin-user";
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Local App Pins Org",
        urlKey: deriveOrganizationUrlKey("Local App Pins Org"),
        issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
      {
        id: otherOrgId,
        name: "Other Local App Pins Org",
        urlKey: deriveOrganizationUrlKey("Other Local App Pins Org"),
        issuePrefix: `Q${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
    ]);
    const localApp = await insertSavedViewFixture(orgId, userId, {
      target: {
        kind: "local_app",
        desktopInstallationId: "desktop-a",
        appPublicId: "public-a",
        localBindingId: "binding-a",
        viewInstanceId: "local-app-view-a",
      },
      title: "Pinned dashboard",
    });
    const browser = await insertSavedViewFixture(orgId, userId, {
      target: {
        kind: "browser",
        tabId: "tab-a",
        url: "https://example.test",
        viewInstanceId: "browser-view-a",
      },
      title: "Browser",
    });

    const pinned = await savedViewsSvc.update(orgId, userId, localApp.id, { primaryRailPinned: true });
    expect(pinned.primaryRailPinnedAt).toBeInstanceOf(Date);
    expect((await db.select().from(activityLog).where(
      eq(activityLog.entityId, localApp.id),
    )).some((event) => (
      (event.details as { primaryRailPinned?: boolean } | null)?.primaryRailPinned === true
    ))).toBe(true);
    expect((await savedViewsSvc.list(orgId, userId, { primaryRailPinned: true })).items).toMatchObject([
      { id: localApp.id, title: "Pinned dashboard" },
    ]);
    expect((await savedViewsSvc.list(orgId, "other-user", { primaryRailPinned: true })).items).toEqual([]);
    expect((await savedViewsSvc.list(otherOrgId, userId, { primaryRailPinned: true })).items).toEqual([]);
    await expect(savedViewsSvc.update(orgId, userId, browser.id, { primaryRailPinned: true }))
      .rejects.toMatchObject({ status: 400 });

    await db.insert(messengerSavedViews).values(Array.from({ length: 99 }, (_, index) => {
      const viewInstanceId = `pinned-limit-view-${index}`;
      const target = {
        kind: "local_app" as const,
        desktopInstallationId: "desktop-a",
        appPublicId: `public-limit-${index}`,
        localBindingId: `binding-limit-${index}`,
        viewInstanceId,
      };
      return {
        orgId,
        userId,
        targetKind: target.kind,
        targetPayload: target,
        resourceKey: messengerSavedViewResourceKey(target),
        instanceId: viewInstanceId,
        canonicalResourceKey: messengerSavedViewCanonicalResourceKey(target),
        title: `Pinned limit ${index}`,
        sortOrder: index + 2,
        primaryRailPinnedAt: new Date(),
      };
    }));
    await expect(savedViewsSvc.update(
      orgId,
      userId,
      localApp.id,
      { primaryRailPinned: true },
    )).resolves.toMatchObject({ id: localApp.id });
    const overLimit = await insertSavedViewFixture(orgId, userId, {
      target: {
        kind: "local_app",
        desktopInstallationId: "desktop-a",
        appPublicId: "public-over-limit",
        localBindingId: "binding-over-limit",
        viewInstanceId: "local-app-over-limit",
      },
      title: "Over pin limit",
    });
    await expect(savedViewsSvc.update(
      orgId,
      userId,
      overLimit.id,
      { primaryRailPinned: true },
    )).rejects.toMatchObject({ status: 400 });

    const unpinned = await savedViewsSvc.update(orgId, userId, localApp.id, { primaryRailPinned: false });
    expect(unpinned.primaryRailPinnedAt).toBeNull();
    expect((await db.select().from(activityLog).where(
      eq(activityLog.entityId, localApp.id),
    )).some((event) => (
      (event.details as { primaryRailPinned?: boolean } | null)?.primaryRailPinned === false
    ))).toBe(true);
    const remainingPins = await savedViewsSvc.list(
      orgId,
      userId,
      { primaryRailPinned: true, limit: 100 },
    );
    expect(remainingPins.items).toHaveLength(99);
    expect(remainingPins.items.some((view) => view.id === localApp.id)).toBe(false);
  });

  it("reorders Saved Views and transactionally removes their group membership and empty group", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-order-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Order Org",
      urlKey: deriveOrganizationUrlKey("Saved View Order Org"),
      issuePrefix: `O${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const first = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "library_file", filePath: "missing/first.md", viewInstanceId: "missing-first" },
      title: "First stale file",
    });
    const second = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "library_directory", directoryPath: "missing/directory", viewInstanceId: "missing-directory" },
      title: "Missing directory",
    });
    const third = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "library_entry", entryId: randomUUID(), path: "missing/entry.md", viewInstanceId: "missing-entry" },
      title: "Missing library entry",
    });

    const reordered = await savedViewsSvc.reorder(orgId, userId, [third.id, first.id]);
    expect(reordered.items.map((view) => view.id)).toEqual([third.id, first.id, second.id]);
    expect(reordered.items.map((view) => view.sortOrder)).toEqual([0, 1, 2]);

    const group = await messengerSvc.createCustomGroup(orgId, userId, "Library");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, group.id, `saved-view:${first.id}`);
    expect(await db.select().from(messengerCustomGroupEntries)).toHaveLength(1);
    const deleted = await savedViewsSvc.remove(orgId, userId, first.id);
    expect(deleted.id).toBe(first.id);
    expect(await db.select().from(messengerCustomGroupEntries)).toHaveLength(0);
    expect(await db.select().from(messengerCustomGroups).where(eq(messengerCustomGroups.id, group.id))).toEqual([]);
    await expect(savedViewsSvc.get(orgId, userId, first.id)).rejects.toMatchObject({ status: 404 });
  });

  it("updates and restores every Library Saved View without changing instance identity", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-library-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Library Identity Org",
      urlKey: deriveOrganizationUrlKey("Saved View Library Identity Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const documentId = randomUUID();
    const entryId = randomUUID();
    const cases = [
      {
        initial: { kind: "library_document" as const, documentId, viewInstanceId: "library-document-view" },
        repeated: { kind: "library_document" as const, documentId, viewInstanceId: "library-document-view" },
      },
      {
        initial: { kind: "library_entry" as const, entryId, path: "docs/old-name.md", viewInstanceId: "library-entry-view" },
        repeated: { kind: "library_entry" as const, entryId, path: "docs/new-name.md", viewInstanceId: "library-entry-view" },
      },
      {
        initial: { kind: "library_file" as const, filePath: "workspace/missing.md", viewInstanceId: "library-file-view" },
        repeated: { kind: "library_file" as const, filePath: "workspace/missing.md", viewInstanceId: "library-file-view" },
      },
      {
        initial: { kind: "library_directory" as const, directoryPath: "workspace/missing", viewInstanceId: "library-directory-view" },
        repeated: { kind: "library_directory" as const, directoryPath: "workspace/missing", viewInstanceId: "library-directory-view" },
      },
    ];

    for (const [index, targetCase] of cases.entries()) {
      const created = await insertSavedViewFixture(orgId, userId, {
        target: targetCase.initial,
        title: `Library target ${index}`,
        subtitle: "Initial metadata",
      });
      const originalSortOrder = created.sortOrder;
      const repeated = await savedViewsSvc.update(orgId, userId, created.id, {
        target: targetCase.repeated,
        title: `Updated library target ${index}`,
        subtitle: "Updated metadata",
      });
      expect(repeated.id).toBe(created.id);
      expect(repeated.targetPayload).toEqual(targetCase.repeated);
      expect(repeated).toMatchObject({
        sortOrder: originalSortOrder,
        title: `Updated library target ${index}`,
        subtitle: "Updated metadata",
      });

      await db.update(messengerSavedViews)
        .set({ hiddenAt: new Date("2026-01-01T00:00:00.000Z") })
        .where(eq(messengerSavedViews.id, created.id));
      const restored = await savedViewsSvc.update(orgId, userId, created.id, {
        hidden: false,
        title: `Restored library target ${index}`,
      });
      expect(restored).toMatchObject({
        id: created.id,
        hiddenAt: null,
        sortOrder: originalSortOrder,
        title: `Restored library target ${index}`,
      });
    }

    expect((await savedViewsSvc.list(orgId, userId, { visibility: "hidden" })).items).toEqual([]);
    expect((await savedViewsSvc.list(orgId, userId)).items.map((view) => view.targetKind)).toEqual([
      "library_document",
      "library_entry",
      "library_file",
      "library_directory",
    ]);
  });

  it("serializes concurrent Saved View Keeps with stable instance identity and unique ordering", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-concurrency-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Concurrency Org",
      urlKey: deriveOrganizationUrlKey("Saved View Concurrency Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const group = await messengerSvc.createCustomGroup(orgId, userId, "Concurrent Keeps");
    const distinct = await Promise.all(Array.from({ length: 12 }, (_, index) => savedViewsSvc.keep(orgId, userId, {
      target: { kind: "browser", tabId: `concurrent-${index}`, url: `https://example.test/${index}`, viewInstanceId: `concurrent-${index}` },
      title: `Concurrent ${index}`,
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: group.id },
    })));
    expect(new Set(distinct.map((result) => result.savedView.sortOrder)).size).toBe(12);

    const sameTarget = await Promise.all(Array.from({ length: 8 }, (_, index) => savedViewsSvc.keep(orgId, userId, {
      target: { kind: "browser", tabId: "same-live-tab", url: `https://example.test/same/${index}`, viewInstanceId: "same-live-tab" },
      title: `Same target ${index}`,
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: group.id },
    })));
    expect(new Set(sameTarget.map((result) => result.savedView.id)).size).toBe(1);
    const sameId = sameTarget[0]!.savedView.id;
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, sameId))).map((event) => event.action);
    expect(actions.filter((action) => action === "messenger.saved_view_created")).toHaveLength(1);
    expect(actions.filter((action) => action === "messenger.saved_view_updated")).toHaveLength(7);
  });

  it("keeps hidden fixed and grouped Saved View slots stationary during reorder", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-hidden-slot-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Hidden Slots Org",
      urlKey: deriveOrganizationUrlKey("Saved View Hidden Slots Org"),
      issuePrefix: `H${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const orderedViews = [];
    for (const tabId of ["a", "b", "c", "d"]) {
      orderedViews.push(await insertSavedViewFixture(orgId, userId, {
        target: { kind: "browser", tabId, url: `https://example.test/${tabId}`, viewInstanceId: `ordered-${tabId}` },
        title: tabId.toUpperCase(),
      }));
    }
    const [a, b, c, d] = orderedViews as [typeof orderedViews[number], typeof orderedViews[number], typeof orderedViews[number], typeof orderedViews[number]];
    await db.update(messengerSavedViews)
      .set({ hiddenAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(messengerSavedViews.id, b.id));
    await savedViewsSvc.reorder(orgId, userId, [d.id, c.id, a.id]);
    const hiddenPlacement = await db.select().from(messengerSavedViews).where(eq(messengerSavedViews.id, b.id));
    expect(hiddenPlacement[0]?.sortOrder).toBe(1);
    await savedViewsSvc.update(orgId, userId, b.id, { hidden: false });
    expect((await savedViewsSvc.list(orgId, userId)).items.map((view) => view.title)).toEqual(["D", "B", "C", "A"]);

    const group = await messengerSvc.createCustomGroupWithEntries(orgId, userId, "Saved order", null, [
      `saved-view:${a.id}`,
      `saved-view:${b.id}`,
      `saved-view:${c.id}`,
    ]);
    const groupId = group.groups[0]!.id;
    await db.update(messengerSavedViews)
      .set({ hiddenAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(eq(messengerSavedViews.id, b.id));
    await messengerSvc.reorderCustomGroupEntries(orgId, userId, groupId, [
      `saved-view:${c.id}`,
      `saved-view:${a.id}`,
    ]);
    const hiddenGroupPlacement = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.threadKey, `saved-view:${b.id}`));
    expect(hiddenGroupPlacement[0]?.sortOrder).toBe(1);
    await savedViewsSvc.update(orgId, userId, b.id, { hidden: false });
    expect((await messengerSvc.listCustomGroups(orgId, userId)).groups[0]?.entries.map((entry) => entry.item.title)).toEqual([
      "C", "B", "A",
    ]);

    const placementActions = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityType, "messenger_saved_view"));
    expect(placementActions.some((event) => event.action === "messenger.saved_view_group_assigned")).toBe(true);
    expect(placementActions.some((event) => event.action === "messenger.saved_view_group_reordered")).toBe(true);

    const reorderActivityCount = placementActions.filter((event) => (
      event.action === "messenger.saved_view_group_reordered"
    )).length;
    await messengerSvc.reorderCustomGroupEntries(orgId, userId, groupId, [
      `saved-view:${c.id}`,
      `saved-view:${b.id}`,
      `saved-view:${a.id}`,
    ]);
    const noOpReorderActivityCount = (await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "messenger.saved_view_group_reordered"))).length;
    expect(noOpReorderActivityCount).toBe(reorderActivityCount);
  });

  it("serializes Saved View deletion against group assignment without leaving orphan membership", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-delete-assign-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Delete Assign Org",
      urlKey: deriveOrganizationUrlKey("Saved View Delete Assign Org"),
      issuePrefix: `DA${orgId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    const savedView = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "browser", tabId: "delete-assign", url: "https://example.test/delete-assign", viewInstanceId: "delete-assign" },
      title: "Delete assign race",
    });
    const group = await messengerSvc.createCustomGroup(orgId, userId, "Race group");

    await Promise.allSettled([
      savedViewsSvc.remove(orgId, userId, savedView.id),
      messengerSvc.assignThreadToCustomGroup(orgId, userId, group.id, `saved-view:${savedView.id}`),
    ]);

    expect(await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.threadKey, `saved-view:${savedView.id}`))).toEqual([]);
    await expect(savedViewsSvc.get(orgId, userId, savedView.id)).rejects.toMatchObject({ status: 404 });
  });

  it("serializes concurrent mixed Saved View and thread assignments into unique stable group slots", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-mixed-placement-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Mixed Placement Org",
      urlKey: deriveOrganizationUrlKey("Saved View Mixed Placement Org"),
      issuePrefix: `MP${orgId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    const savedViews = [];
    for (const index of Array.from({ length: 6 }, (_, value) => value)) {
      savedViews.push(await insertSavedViewFixture(orgId, userId, {
        target: { kind: "browser", tabId: `mixed-${index}`, url: `https://example.test/mixed/${index}`, viewInstanceId: `mixed-${index}` },
        title: `Mixed saved ${index}`,
      }));
    }
    const conversationIds = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(chatConversations).values(conversationIds.map((id, index) => ({
      id,
      orgId,
      title: `Mixed chat ${index}`,
      issueCreationMode: "manual_approval" as const,
      planMode: false,
      createdByUserId: userId,
    })));
    const group = await messengerSvc.createCustomGroup(orgId, userId, "Mixed group");
    const itemKeys = [
      ...savedViews.map((savedView) => `saved-view:${savedView.id}`),
      ...conversationIds.map((id) => `chat:${id}`),
    ];

    await Promise.all(itemKeys.map((itemKey) => (
      messengerSvc.assignThreadToCustomGroup(orgId, userId, group.id, itemKey)
    )));

    const firstRead = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, group.id))
      .orderBy(messengerCustomGroupEntries.sortOrder);
    const secondRead = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, group.id))
      .orderBy(messengerCustomGroupEntries.sortOrder);
    expect(firstRead).toHaveLength(itemKeys.length);
    expect(firstRead.map((entry) => entry.sortOrder)).toEqual(itemKeys.map((_, index) => index));
    expect(secondRead.map((entry) => entry.id)).toEqual(firstRead.map((entry) => entry.id));
  });

  it("audits Saved membership removed by group deletion and omits no-op removal evidence", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-removal-audit-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Removal Audit Org",
      urlKey: deriveOrganizationUrlKey("Saved View Removal Audit Org"),
      issuePrefix: `RA${orgId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    const grouped = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "automation", automationId: randomUUID(), viewInstanceId: "grouped-removal" },
      title: "Grouped removal audit",
    });
    const ungrouped = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "automation", automationId: randomUUID(), viewInstanceId: "ungrouped-removal" },
      title: "Ungrouped no-op",
    });
    const group = await messengerSvc.createCustomGroup(orgId, userId, "Delete audit group");
    await messengerSvc.assignThreadToCustomGroup(orgId, userId, group.id, `saved-view:${grouped.id}`);

    await expect(messengerSvc.deleteCustomGroup(orgId, userId, group.id)).resolves.toMatchObject({ id: group.id });
    const groupedRemovalEvents = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, grouped.id));
    expect(groupedRemovalEvents.filter((event) => event.action === "messenger.saved_view_group_removed"))
      .toEqual([
        expect.objectContaining({
          orgId,
          actorType: "user",
          actorId: userId,
          entityType: "messenger_saved_view",
          entityId: grouped.id,
          details: expect.objectContaining({
            itemKey: `saved-view:${grouped.id}`,
            groupId: group.id,
            source: "group_delete",
          }),
        }),
      ]);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.action, "messenger.custom_group_removed"),
      eq(activityLog.entityId, group.id),
    ))).toMatchObject([{
      orgId,
      actorType: "user",
      actorId: userId,
      entityType: "messenger_custom_group",
      entityId: group.id,
      details: { source: "group_delete" },
    }]);
    await expect(savedViewsSvc.get(orgId, userId, grouped.id)).resolves.toMatchObject({ id: grouped.id });

    await expect(messengerSvc.removeThreadFromCustomGroups(
      orgId,
      userId,
      `saved-view:${ungrouped.id}`,
    )).resolves.toEqual({ itemKey: `saved-view:${ungrouped.id}` });
    const missingSavedViewId = randomUUID();
    await expect(messengerSvc.removeThreadFromCustomGroups(
      orgId,
      userId,
      `saved-view:${missingSavedViewId}`,
    )).rejects.toMatchObject({ status: 404 });
    const noOpRemovalEvents = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, ungrouped.id));
    expect(noOpRemovalEvents.some((event) => event.action === "messenger.saved_view_group_removed")).toBe(false);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, missingSavedViewId))).toEqual([]);
  });

  it("bounds Saved View pages and reports production-shaped pagination", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-page-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Pagination Org",
      urlKey: deriveOrganizationUrlKey("Saved View Pagination Org"),
      issuePrefix: `G${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(messengerSavedViews).values(Array.from({ length: 125 }, (_, index) => ({
      orgId,
      userId,
      targetKind: "browser" as const,
      targetPayload: { kind: "browser" as const, tabId: `page-${index}`, url: `https://example.test/page/${index}`, viewInstanceId: `page-${index}` },
      resourceKey: `view-instance:page-${index}`,
      instanceId: `page-${index}`,
      canonicalResourceKey: `browser:page-${index}`,
      title: `Page ${index.toString().padStart(3, "0")}`,
      sortOrder: index,
    })));

    const first = await savedViewsSvc.list(orgId, userId);
    expect(first.items).toHaveLength(50);
    expect(first.pageInfo).toEqual({ limit: 50, offset: 0, total: 125, hasMore: true, nextOffset: 50 });
    const second = await savedViewsSvc.list(orgId, userId, { limit: 100, offset: 50 });
    expect(second.items).toHaveLength(75);
    expect(second.pageInfo).toEqual({ limit: 100, offset: 50, total: 125, hasMore: false, nextOffset: null });
  });

  it("rejects malformed ids and noncanonical Library paths before database predicates", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-validation-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Validation Org",
      urlKey: deriveOrganizationUrlKey("Saved View Validation Org"),
      issuePrefix: `N${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await expect(savedViewsSvc.get(orgId, userId, "not-a-uuid")).rejects.toMatchObject({ status: 400 });
    await expect(messengerSvc.assignThreadToCustomGroup(orgId, userId, randomUUID(), "saved-view:not-a-uuid"))
      .rejects.toMatchObject({ status: 400 });
    await expect(messengerSvc.reorderCustomGroupEntries(orgId, userId, randomUUID(), ["chat:duplicate", "chat:duplicate"]))
      .rejects.toMatchObject({ status: 400 });
    await expect(savedViewsSvc.keep(orgId, userId, {
      target: { kind: "library_file", filePath: "/absolute/path.md", viewInstanceId: "invalid-path" },
      title: "Invalid",
      clientMutationId: randomUUID(),
      placement: { kind: "group", groupId: randomUUID() },
    })).rejects.toMatchObject({ status: 400 });
    const root = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "library_directory", directoryPath: "", viewInstanceId: "library-root" },
      title: "Library root",
    });
    expect(root.canonicalResourceKey).toBe("library-directory:");
  });

  it("rolls back Saved View and placement mutations when their activity evidence cannot commit", async () => {
    const orgId = randomUUID();
    const userId = "saved-view-atomicity-user";
    await db.insert(organizations).values({
      id: orgId,
      name: "Saved View Atomicity Org",
      urlKey: deriveOrganizationUrlKey("Saved View Atomicity Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const existing = await insertSavedViewFixture(orgId, userId, {
      target: { kind: "browser", tabId: "atomic-existing", url: "https://example.test/existing", viewInstanceId: "atomic-existing" },
      title: "Existing",
    });
    const group = await messengerSvc.createCustomGroup(orgId, userId, "Atomic group");

    await db.execute(sql.raw(`
      create or replace function fail_saved_view_activity_for_test() returns trigger as $$
      begin
        if new.action like 'messenger.saved_view_%' then
          raise exception 'forced Saved View activity failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
    `));
    await db.execute(sql.raw(`
      create trigger fail_saved_view_activity_for_test_trigger
      before insert on activity_log
      for each row execute function fail_saved_view_activity_for_test();
    `));
    try {
      await expect(savedViewsSvc.keep(orgId, userId, {
        target: { kind: "browser", tabId: "atomic-new", url: "https://example.test/new", viewInstanceId: "atomic-new" },
        title: "Must roll back",
        clientMutationId: randomUUID(),
        placement: { kind: "group", groupId: group.id },
      })).rejects.toThrow();
      expect((await savedViewsSvc.list(orgId, userId, { visibility: "all" })).pageInfo.total).toBe(1);

      await expect(messengerSvc.assignThreadToCustomGroup(
        orgId,
        userId,
        group.id,
        `saved-view:${existing.id}`,
      )).rejects.toThrow();
      expect(await db.select().from(messengerCustomGroupEntries)).toEqual([]);
    } finally {
      await db.execute(sql.raw("drop trigger if exists fail_saved_view_activity_for_test_trigger on activity_log"));
      await db.execute(sql.raw("drop function if exists fail_saved_view_activity_for_test()"));
    }
  });
});
