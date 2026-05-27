import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  applyPendingMigrations,
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issueComments,
  issueReadStates,
  issues,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { sidebarBadgeService } from "../services/sidebar-badges.ts";

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
  return process.env.RUDDER_SIDEBAR_BADGES_TEST_DATABASE_URL?.trim() || null;
}

async function startTempDatabase() {
  const externalDatabaseUrl = getExternalDatabaseUrl();
  if (externalDatabaseUrl) {
    await applyPendingMigrations(externalDatabaseUrl);
    return { connectionString: externalDatabaseUrl, dataDir: "", instance: null };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-sidebar-badges-"));
  const dataDir = path.join(tempDir, "pgdata");
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
  return { connectionString, dataDir: tempDir, instance };
}

describe("sidebarBadgeService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof sidebarBadgeService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = sidebarBadgeService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatMessages);
    await db.delete(chatConversationUserStates);
    await db.delete(chatConversations);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issueReadStates);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function createOrg(name: string) {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(name),
      issuePrefix: name.replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    return orgId;
  }

  async function createAgent(orgId: string, name: string, status = "active") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name,
      role: "engineer",
      status,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("counts unread touched issues without hydrating issue rows", async () => {
    const orgId = await createOrg("Sidebar Issues");
    const otherOrgId = await createOrg("Other Sidebar Issues");
    const userId = "board-user";
    const issueId = randomUUID();
    const selfOnlyIssueId = randomUUID();
    const readCleanIssueId = randomUUID();
    const selfResolvedIssueId = randomUUID();
    const createdByMeIssueId = randomUUID();
    const reviewerIssueId = randomUUID();
    const readStateOnlyIssueId = randomUUID();
    const commentOnlyIssueId = randomUUID();
    const hiddenIssueId = randomUUID();
    const automationIssueId = randomUUID();
    const otherOrgIssueId = randomUUID();
    const readAt = new Date("2026-05-01T10:00:00.000Z");
    const unreadAt = new Date("2026-05-01T11:00:00.000Z");
    const rereadAt = new Date("2026-05-01T12:00:00.000Z");

    await db.insert(issues).values([
      {
        id: issueId,
        orgId,
        title: "Unread assigned issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: selfOnlyIssueId,
        orgId,
        title: "Self comment only",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: readCleanIssueId,
        orgId,
        title: "Read clean issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: selfResolvedIssueId,
        orgId,
        title: "Self resolved issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: createdByMeIssueId,
        orgId,
        title: "Created by me issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: reviewerIssueId,
        orgId,
        title: "Reviewer issue",
        status: "in_review",
        priority: "medium",
        reviewerUserId: userId,
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: readStateOnlyIssueId,
        orgId,
        title: "Read-state touched issue",
        status: "todo",
        priority: "medium",
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: commentOnlyIssueId,
        orgId,
        title: "Comment touched issue",
        status: "todo",
        priority: "medium",
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: hiddenIssueId,
        orgId,
        title: "Hidden issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        hiddenAt: readAt,
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: automationIssueId,
        orgId,
        title: "Automation execution",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        originKind: "automation_execution",
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: otherOrgIssueId,
        orgId: otherOrgId,
        title: "Other organization issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: readAt,
        updatedAt: readAt,
      },
    ]);

    await db.insert(issueReadStates).values([
      { orgId, issueId, userId, lastReadAt: readAt },
      { orgId, issueId: selfOnlyIssueId, userId, lastReadAt: readAt },
      { orgId, issueId: readCleanIssueId, userId, lastReadAt: rereadAt },
      { orgId, issueId: selfResolvedIssueId, userId, lastReadAt: readAt },
      { orgId, issueId: readStateOnlyIssueId, userId, lastReadAt: readAt },
      { orgId, issueId: automationIssueId, userId, lastReadAt: readAt },
      { orgId: otherOrgId, issueId: otherOrgIssueId, userId, lastReadAt: readAt },
    ]);

    await db.insert(issueComments).values([
      { orgId, issueId, body: "external update", createdAt: unreadAt },
      { orgId, issueId: selfOnlyIssueId, authorUserId: userId, body: "my update", createdAt: unreadAt },
      { orgId, issueId: readCleanIssueId, body: "external update already read", createdAt: unreadAt },
      { orgId, issueId: selfResolvedIssueId, body: "external update before my reply", createdAt: unreadAt },
      { orgId, issueId: selfResolvedIssueId, authorUserId: userId, body: "my later reply", createdAt: rereadAt },
      { orgId, issueId: createdByMeIssueId, body: "external update for creator", createdAt: unreadAt },
      { orgId, issueId: reviewerIssueId, body: "external update for reviewer", createdAt: unreadAt },
      { orgId, issueId: readStateOnlyIssueId, body: "external update for read-state touch", createdAt: unreadAt },
      { orgId, issueId: commentOnlyIssueId, authorUserId: userId, body: "my earlier comment", createdAt: readAt },
      { orgId, issueId: commentOnlyIssueId, body: "external update for comment touch", createdAt: unreadAt },
      { orgId, issueId: hiddenIssueId, body: "hidden issue update", createdAt: unreadAt },
      { orgId, issueId: automationIssueId, body: "automation update", createdAt: unreadAt },
      { orgId: otherOrgId, issueId: otherOrgIssueId, body: "other org update", createdAt: unreadAt },
    ]);

    await expect(svc.countUnreadTouchedIssues(orgId, userId)).resolves.toBe(5);
  });

  it("counts active chat attention while preserving first-read state creation", async () => {
    const orgId = await createOrg("Sidebar Chats");
    const otherOrgId = await createOrg("Other Sidebar Chats");
    const userId = "board-user";
    const conversationId = randomUUID();
    const pendingConversationId = randomUUID();
    const quietConversationId = randomUUID();
    const resolvedConversationId = randomUUID();
    const otherOrgConversationId = randomUUID();
    const dirtyApprovalConversationId = randomUUID();
    const firstMessageAt = new Date("2026-05-01T10:00:00.000Z");
    const unreadMessageAt = new Date("2026-05-01T11:00:00.000Z");
    const approvalId = randomUUID();
    const otherOrgApprovalId = randomUUID();
    const dirtyApprovalId = randomUUID();

    await db.insert(chatConversations).values([
      {
        id: conversationId,
        orgId,
        title: "Unread chat",
        status: "active",
        issueCreationMode: "manual_approval",
        lastMessageAt: firstMessageAt,
        updatedAt: firstMessageAt,
      },
      {
        id: pendingConversationId,
        orgId,
        title: "Pending proposal chat",
        status: "active",
        issueCreationMode: "manual_approval",
        lastMessageAt: firstMessageAt,
        updatedAt: firstMessageAt,
      },
      {
        id: quietConversationId,
        orgId,
        title: "Quiet chat",
        status: "active",
        issueCreationMode: "manual_approval",
        lastMessageAt: firstMessageAt,
        updatedAt: firstMessageAt,
      },
      {
        id: resolvedConversationId,
        orgId,
        title: "Resolved pending proposal chat",
        status: "resolved",
        issueCreationMode: "manual_approval",
        lastMessageAt: firstMessageAt,
        updatedAt: firstMessageAt,
        resolvedAt: firstMessageAt,
      },
      {
        id: otherOrgConversationId,
        orgId: otherOrgId,
        title: "Other org pending proposal chat",
        status: "active",
        issueCreationMode: "manual_approval",
        lastMessageAt: firstMessageAt,
        updatedAt: firstMessageAt,
      },
      {
        id: dirtyApprovalConversationId,
        orgId,
        title: "Cross-org approval reference",
        status: "active",
        issueCreationMode: "manual_approval",
        lastMessageAt: firstMessageAt,
        updatedAt: firstMessageAt,
      },
    ]);
    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId,
        role: "assistant",
        kind: "message",
        body: "initial response",
        createdAt: firstMessageAt,
      },
      {
        orgId,
        conversationId: quietConversationId,
        role: "assistant",
        kind: "message",
        body: "already read response",
        createdAt: firstMessageAt,
      },
    ]);
    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "issue_proposal",
      status: "pending",
      payload: {},
    });
    await db.insert(approvals).values([
      {
        id: otherOrgApprovalId,
        orgId: otherOrgId,
        type: "issue_proposal",
        status: "pending",
        payload: {},
      },
      {
        id: dirtyApprovalId,
        orgId: otherOrgId,
        type: "issue_proposal",
        status: "pending",
        payload: {},
      },
    ]);
    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId: pendingConversationId,
        role: "assistant",
        kind: "issue_proposal",
        body: "",
        approvalId,
        createdAt: firstMessageAt,
      },
      {
        orgId,
        conversationId: resolvedConversationId,
        role: "assistant",
        kind: "issue_proposal",
        body: "",
        approvalId,
        createdAt: firstMessageAt,
      },
      {
        orgId: otherOrgId,
        conversationId: otherOrgConversationId,
        role: "assistant",
        kind: "issue_proposal",
        body: "",
        approvalId: otherOrgApprovalId,
        createdAt: firstMessageAt,
      },
      {
        orgId,
        conversationId: dirtyApprovalConversationId,
        role: "assistant",
        kind: "issue_proposal",
        body: "",
        approvalId: dirtyApprovalId,
        createdAt: firstMessageAt,
      },
    ]);

    await expect(svc.countActiveChatAttention(orgId, userId)).resolves.toBe(1);
    const state = await db
      .select()
      .from(chatConversationUserStates)
      .where(eq(chatConversationUserStates.conversationId, conversationId))
      .then((rows) => rows[0]);
    expect(state?.lastReadAt.toISOString()).toBe(firstMessageAt.toISOString());

    await db.insert(chatMessages).values({
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      body: "new response",
      createdAt: unreadMessageAt,
    });

    await expect(svc.countActiveChatAttention(orgId, userId)).resolves.toBe(2);
  });

  it("builds badges from base counts and counts failed latest runs for active agents only", async () => {
    const orgId = await createOrg("Sidebar Runs");
    const agentId = await createAgent(orgId, "Failing Agent");
    const recoveredAgentId = await createAgent(orgId, "Recovered Agent");
    const terminatedAgentId = await createAgent(orgId, "Terminated Agent", "terminated");

    await db.insert(approvals).values({
      orgId,
      type: "issue_proposal",
      status: "pending",
      payload: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        orgId,
        agentId,
        status: "failed",
        createdAt: new Date("2026-05-01T10:00:00.000Z"),
      },
      {
        orgId,
        agentId: recoveredAgentId,
        status: "failed",
        createdAt: new Date("2026-05-01T09:00:00.000Z"),
      },
      {
        orgId,
        agentId: recoveredAgentId,
        status: "succeeded",
        createdAt: new Date("2026-05-01T11:00:00.000Z"),
      },
      {
        orgId,
        agentId: terminatedAgentId,
        status: "failed",
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
      },
    ]);

    const base = await svc.getBaseCounts(orgId);
    expect(base).toEqual({ approvals: 1, failedRuns: 1 });
    expect(svc.fromCounts(base, {
      joinRequests: 2,
      unreadTouchedIssues: 3,
      chatAttention: 4,
      alerts: 5,
    })).toEqual({
      inbox: 16,
      approvals: 1,
      failedRuns: 1,
      joinRequests: 2,
      unreadTouchedIssues: 3,
      chatAttention: 4,
      alerts: 5,
    });
  });
});
