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
