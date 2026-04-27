import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  applyPendingMigrations,
  agents,
  approvalComments,
  approvals,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issueFollows,
  issueComments,
  issues,
  messengerThreadUserStates,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { issueService } from "../services/issues.ts";
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

async function startTempDatabase() {
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
  let issueSvc!: ReturnType<typeof issueService>;
  let messengerSvc!: ReturnType<typeof messengerService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    issueSvc = issueService(db);
    messengerSvc = messengerService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueFollows);
    await db.delete(messengerThreadUserStates);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(issueComments);
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

  it("persists follows and includes followed plus assigned issues in the Messenger issues thread", async () => {
    const orgId = randomUUID();
    const userId = "board-user-1";
    const followedIssueId = randomUUID();
    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Org",
      urlKey: deriveOrganizationUrlKey("Messenger Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

    await issueSvc.followIssue(orgId, followedIssueId, userId);
    await issueSvc.addComment(followedIssueId, "Followed issue needs review", {});
    expect(await issueSvc.isFollowedByUser(orgId, followedIssueId, userId)).toBe(true);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const itemIds = new Set(thread.detail.items.map((item) => item.issueId));
    const assignedItem = thread.detail.items.find((item) => item.issueId === assignedIssueId);
    const createdItem = thread.detail.items.find((item) => item.issueId === createdIssueId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(itemIds.has(followedIssueId)).toBe(true);
    expect(itemIds.has(assignedIssueId)).toBe(true);
    expect(itemIds.has(createdIssueId)).toBe(true);
    expect(itemIds.has(unrelatedIssueId)).toBe(false);
    expect(assignedItem?.metadata).toMatchObject({ assignedToMe: true, createdByMe: false });
    expect(assignedItem?.body).toContain("assigned to me");
    expect(createdItem?.metadata).toMatchObject({ assignedToMe: false, createdByMe: true });
    expect(issuesSummary?.preview).toBe("Followed issue needs review");
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
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([createdIssueId]);
    expect(thread.detail.items[0]?.preview).toBe("I already handled this");
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(thread.summary.latestActivityAt).toBeNull();
    expect(thread.summary.preview).toBe("Cross-issue activity feed");
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(issuesSummary?.latestActivityAt).toBeNull();
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
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(thread.summary.latestActivityAt).toBeNull();
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(issuesSummary?.latestActivityAt).toBeNull();
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
    expect(approvalsSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
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
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    const thread = await messengerSvc.getSystemThread(orgId, userId, "failed-runs");
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const failedRunsSummary = summaries.find((item) => item.threadKey === "failed-runs");

    expect(thread.detail.items.map((item) => item.id)).toEqual([olderRunId, newerRunId]);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(failedRunsSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
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
});
