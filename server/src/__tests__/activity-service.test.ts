import {
  activityLog,
  agents,
  applyPendingMigrations,
  approvalComments,
  approvals,
  chatContextLinks,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  issueComments,
  issues,
  operatorProfiles,
  organizations,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityService } from "../services/activity.ts";

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
  const externalConnectionString = process.env.RUDDER_ACTIVITY_SERVICE_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-activity-service-"));
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

describe("activityService.forIssue", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof activityService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = activityService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(chatMessages);
    await db.delete(chatContextLinks);
    await db.delete(chatConversations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(operatorProfiles);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("includes issue-relevant chat events without pulling unrelated chat noise", async () => {
    const orgId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const linkedConversationId = randomUUID();
    const contextLinkedConversationId = randomUUID();
    const convertedConversationId = randomUUID();
    const unrelatedConversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: issueId,
        orgId,
        title: "Issue under test",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        orgId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(chatConversations).values([
      {
        id: linkedConversationId,
        orgId,
        title: "Discuss the issue",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: contextLinkedConversationId,
        orgId,
        title: "Support thread",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: convertedConversationId,
        orgId,
        title: "Escalation chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: unrelatedConversationId,
        orgId,
        title: "Unrelated chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);

    await db.insert(chatContextLinks).values([
      { orgId, conversationId: linkedConversationId, entityType: "issue", entityId: issueId },
      { orgId, conversationId: contextLinkedConversationId, entityType: "issue", entityId: issueId },
      { orgId, conversationId: convertedConversationId, entityType: "issue", entityId: issueId },
      { orgId, conversationId: unrelatedConversationId, entityType: "issue", entityId: otherIssueId },
    ]);

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.created",
        entityType: "issue",
        entityId: issueId,
        details: { title: "Issue under test" },
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "chat.created",
        entityType: "chat",
        entityId: linkedConversationId,
        details: { title: "Discuss the issue", contextLinkCount: 1 },
        createdAt: new Date("2026-04-01T10:05:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "chat.context_linked",
        entityType: "chat",
        entityId: contextLinkedConversationId,
        details: { entityType: "issue", entityId: issueId },
        createdAt: new Date("2026-04-01T10:10:00.000Z"),
      },
      {
        orgId,
        actorType: "system",
        actorId: "chat-assistant",
        action: "chat.created",
        entityType: "chat",
        entityId: convertedConversationId,
        details: { title: "Escalation chat", contextLinkCount: 0 },
        createdAt: new Date("2026-04-01T10:12:00.000Z"),
      },
      {
        orgId,
        actorType: "system",
        actorId: "chat-assistant",
        action: "chat.issue_converted",
        entityType: "chat",
        entityId: convertedConversationId,
        details: { issueId, issueIdentifier: "RST-42" },
        createdAt: new Date("2026-04-01T10:15:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "chat.created",
        entityType: "chat",
        entityId: unrelatedConversationId,
        details: { title: "Unrelated chat", contextLinkCount: 1 },
        createdAt: new Date("2026-04-01T10:20:00.000Z"),
      },
    ]);

    const result = await svc.forIssue(issueId);

    expect(result.map((event) => `${event.action}:${event.entityId}`)).toEqual([
      `chat.issue_converted:${convertedConversationId}`,
      `chat.context_linked:${contextLinkedConversationId}`,
      `chat.created:${linkedConversationId}`,
      `issue.created:${issueId}`,
    ]);

    expect(result.find((event) => event.action === "chat.issue_converted")?.details).toMatchObject({
      issueId,
      issueIdentifier: "RST-42",
      conversationTitle: "Escalation chat",
    });
    expect(result.find((event) => event.action === "chat.created")?.details).toMatchObject({
      conversationTitle: "Discuss the issue",
    });
    expect(result.some((event) => event.entityId === unrelatedConversationId)).toBe(false);
  });

  it("filters title and description-only issue updates from issue activity", async () => {
    const orgId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Issue under test",
      status: "todo",
      priority: "medium",
    });

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: {
          title: "Renamed issue",
          description: "Edited description",
          _previous: { title: "Issue under test", description: "Initial description" },
        },
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "in_progress", _previous: { status: "todo" } },
        createdAt: new Date("2026-04-01T10:05:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: issueId,
        details: { key: "plan", title: "Plan" },
        createdAt: new Date("2026-04-01T10:10:00.000Z"),
      },
    ]);

    const result = await svc.forIssue(issueId);

    expect(result).toHaveLength(1);
    expect(result[0]?.details).toMatchObject({ status: "in_progress" });

    const orgActivity = await svc.list({ orgId });
    expect(orgActivity.map((event) => event.action)).toEqual(["issue.document_updated", "issue.updated"]);
    expect(orgActivity[1]?.details).toMatchObject({ status: "in_progress" });
  });

  it("filters organization activity by user and agent principals", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Wesley",
      role: "engineer",
    });

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "user",
        actorId: "user-1",
        action: "project.updated",
        entityType: "project",
        entityId: "project-user",
        details: { title: "User event" },
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: "issue-agent",
        details: { title: "Agent event" },
        createdAt: new Date("2026-04-01T10:01:00.000Z"),
      },
      {
        orgId,
        actorType: "system",
        actorId: "heartbeat",
        agentId,
        action: "heartbeat.invoked",
        entityType: "heartbeat_run",
        entityId: "run-agent",
        details: { title: "Agent-associated system event" },
        createdAt: new Date("2026-04-01T10:02:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: agentId,
        action: "agent.updated",
        entityType: "agent",
        entityId: agentId,
        details: { title: "Agent actor event without association column" },
        createdAt: new Date("2026-04-01T10:03:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "user-2",
        action: "project.updated",
        entityType: "project",
        entityId: "project-other",
        details: { title: "Other user event" },
        createdAt: new Date("2026-04-01T10:04:00.000Z"),
      },
    ]);

    await expect(svc.list({ orgId, userId: "user-1" })).resolves.toMatchObject([
      {
        actorType: "user",
        actorId: "user-1",
        entityId: "project-user",
      },
    ]);

    const agentEvents = await svc.list({ orgId, agentId });

    expect(agentEvents.map((event) => event.entityId)).toEqual([
      agentId,
      "run-agent",
      "issue-agent",
    ]);
  });

  it("paginates organization activity by a stable cursor", async () => {
    const orgId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "system",
        actorId: "test",
        action: "activity.oldest",
        entityType: "project",
        entityId: "project-oldest",
        details: { title: "Oldest event" },
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
      {
        orgId,
        actorType: "system",
        actorId: "test",
        action: "activity.middle",
        entityType: "project",
        entityId: "project-middle",
        details: { title: "Middle event" },
        createdAt: new Date("2026-04-01T10:01:00.000Z"),
      },
      {
        orgId,
        actorType: "system",
        actorId: "test",
        action: "activity.newest",
        entityType: "project",
        entityId: "project-newest",
        details: { title: "Newest event" },
        createdAt: new Date("2026-04-01T10:02:00.000Z"),
      },
    ]);

    const firstPage = await svc.listPage({ orgId, limit: 2 });

    expect(firstPage.items.map((event) => event.action)).toEqual([
      "activity.newest",
      "activity.middle",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await svc.listPage({
      orgId,
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items.map((event) => event.action)).toEqual(["activity.oldest"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("uses activity id as a cursor tiebreaker for events with the same timestamp", async () => {
    const orgId = randomUUID();
    const createdAt = new Date("2026-04-01T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        id: "00000000-0000-4000-8000-000000000001",
        orgId,
        actorType: "system",
        actorId: "test",
        action: "activity.same_timestamp_oldest",
        entityType: "project",
        entityId: "project-oldest",
        details: { title: "Oldest same-timestamp event" },
        createdAt,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        orgId,
        actorType: "system",
        actorId: "test",
        action: "activity.same_timestamp_middle",
        entityType: "project",
        entityId: "project-middle",
        details: { title: "Middle same-timestamp event" },
        createdAt,
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        orgId,
        actorType: "system",
        actorId: "test",
        action: "activity.same_timestamp_newest",
        entityType: "project",
        entityId: "project-newest",
        details: { title: "Newest same-timestamp event" },
        createdAt,
      },
    ]);

    const firstPage = await svc.listPage({ orgId, limit: 2 });
    expect(firstPage.items.map((event) => event.action)).toEqual([
      "activity.same_timestamp_newest",
      "activity.same_timestamp_middle",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await svc.listPage({
      orgId,
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items.map((event) => event.action)).toEqual([
      "activity.same_timestamp_oldest",
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("does not skip rows with sub-millisecond timestamp differences", async () => {
    const orgId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.execute(sql`
      insert into activity_log
        (id, org_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      values
        (
          '00000000-0000-4000-8000-000000000001',
          ${orgId},
          'system',
          'test',
          'activity.same_millisecond_oldest',
          'project',
          'project-oldest',
          '{"title":"Oldest microsecond event"}'::jsonb,
          '2026-04-01T10:00:00.000100Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000002',
          ${orgId},
          'system',
          'test',
          'activity.same_millisecond_middle',
          'project',
          'project-middle',
          '{"title":"Middle microsecond event"}'::jsonb,
          '2026-04-01T10:00:00.000500Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000003',
          ${orgId},
          'system',
          'test',
          'activity.same_millisecond_newest',
          'project',
          'project-newest',
          '{"title":"Newest microsecond event"}'::jsonb,
          '2026-04-01T10:00:00.000900Z'::timestamptz
        )
    `);

    const firstPage = await svc.listPage({ orgId, limit: 2 });
    expect(firstPage.items.map((event) => event.action)).toEqual([
      "activity.same_millisecond_newest",
      "activity.same_millisecond_middle",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await svc.listPage({
      orgId,
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items.map((event) => event.action)).toEqual([
      "activity.same_millisecond_oldest",
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("fills organization activity pages after excluding low-signal issue updates", async () => {
    const orgId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      identifier: "RST-370",
      title: "Visible activity should fill the page",
      status: "todo",
      priority: "medium",
    });

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { title: "Renamed issue", _previous: { title: "Old title" } },
        createdAt: new Date("2026-04-01T10:03:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "project.updated",
        entityType: "project",
        entityId: "project-visible-newer",
        details: { title: "Visible newer event" },
        createdAt: new Date("2026-04-01T10:02:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "project.updated",
        entityType: "project",
        entityId: "project-visible-older",
        details: { title: "Visible older event" },
        createdAt: new Date("2026-04-01T10:01:00.000Z"),
      },
    ]);

    const page = await svc.listPage({ orgId, limit: 2 });

    expect(page.items.map((event) => event.entityId)).toEqual([
      "project-visible-newer",
      "project-visible-older",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("adds issue identifiers and titles to organization activity pages", async () => {
    const orgId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      identifier: "RST-369",
      title: "Keep activity rows self contained",
      status: "todo",
      priority: "medium",
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "user",
      actorId: "board",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      details: { commentId: "comment-1" },
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });

    const page = await svc.listPage({ orgId, limit: 1 });

    expect(page.items[0]?.details).toMatchObject({
      commentId: "comment-1",
      identifier: "RST-369",
      issueIdentifier: "RST-369",
      title: "Keep activity rows self contained",
      issueTitle: "Keep activity rows self contained",
    });
  });

  it("does not overwrite existing activity detail titles while adding issue details", async () => {
    const orgId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      identifier: "RST-371",
      title: "Canonical issue title",
      status: "todo",
      priority: "medium",
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "user",
      actorId: "board",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        identifier: "LEGACY-1",
        title: "Original activity detail title",
      },
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
    });

    const page = await svc.listPage({ orgId, limit: 1 });

    expect(page.items[0]?.details).toMatchObject({
      identifier: "LEGACY-1",
      title: "Original activity detail title",
      issueIdentifier: "RST-371",
      issueTitle: "Canonical issue title",
    });
  });

  it("builds a user activity ledger with merged ordering, filters, pagination, and privacy exclusions", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "user-1";
    const issueId = randomUUID();
    const otherOrgIssueId = randomUUID();
    const conversationId = randomUUID();
    const approvalId = randomUUID();
    const agentId = randomUUID();

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Rudder",
        urlKey: deriveOrganizationUrlKey("Rudder"),
        issuePrefix: "RST",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other",
        urlKey: deriveOrganizationUrlKey("Other"),
        issuePrefix: "OTH",
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(operatorProfiles).values({
      userId,
      nickname: "Zeeland",
      preferences: {},
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Wesley",
      role: "engineer",
      status: "running",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: issueId,
        orgId,
        identifier: "RST-693",
        title: "Implement user activity ledger",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: otherOrgIssueId,
        orgId: otherOrgId,
        identifier: "OTH-1",
        title: "Other org issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Ledger planning",
      createdByUserId: userId,
      preferredAgentId: agentId,
      primaryIssueId: issueId,
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId,
        role: "user",
        body: "Please implement the user activity ledger with source evidence.",
        replyingAgentId: agentId,
        createdAt: new Date("2026-06-18T01:00:00.000Z"),
      },
      {
        orgId,
        conversationId,
        role: "user",
        body: "Superseded message should not be exposed.",
        replyingAgentId: agentId,
        supersededAt: new Date("2026-06-18T01:05:00.000Z"),
        createdAt: new Date("2026-06-18T01:04:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values([
      {
        orgId,
        issueId,
        authorUserId: userId,
        body: "Please include provenance and safe excerpts.",
        createdAt: new Date("2026-06-18T02:00:00.000Z"),
      },
      {
        orgId,
        issueId,
        authorUserId: userId,
        body: "Deleted comment should not be exposed.",
        deletedAt: new Date("2026-06-18T02:30:00.000Z"),
        createdAt: new Date("2026-06-18T02:20:00.000Z"),
      },
      {
        orgId: otherOrgId,
        issueId: otherOrgIssueId,
        authorUserId: userId,
        body: "Other org comment should not leak.",
        createdAt: new Date("2026-06-18T02:10:00.000Z"),
      },
    ]);

    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "command",
      requestedByAgentId: agentId,
      status: "approved",
      payload: {},
    });

    await db.insert(approvalComments).values({
      orgId,
      approvalId,
      authorUserId: userId,
      body: "Approved with the narrower Phase 1 scope.",
      createdAt: new Date("2026-06-18T03:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "user",
        actorId: userId,
        action: "issue.created",
        entityType: "issue",
        entityId: issueId,
        agentId,
        details: { title: "Implement user activity ledger" },
        createdAt: new Date("2026-06-18T04:00:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: userId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        details: { commentId: "duplicate-comment-activity" },
        createdAt: new Date("2026-06-18T02:00:01.000Z"),
      },
      {
        orgId: otherOrgId,
        actorType: "user",
        actorId: userId,
        action: "issue.created",
        entityType: "issue",
        entityId: otherOrgIssueId,
        details: { title: "Other org issue" },
        createdAt: new Date("2026-06-18T04:30:00.000Z"),
      },
    ]);

    const firstPage = await svc.listUserActivityLedger({
      orgId,
      userId,
      since: new Date("2026-06-18T00:00:00.000Z"),
      until: new Date("2026-06-19T00:00:00.000Z"),
      limit: 3,
    });

    expect(firstPage.items.map((item) => item.kind)).toEqual([
      "activity_event",
      "approval_comment",
      "issue_comment",
    ]);
    expect(firstPage.items[0]).toMatchObject({
      userId,
      actor: { type: "user", id: userId, displayName: "Zeeland" },
      source: {
        provenance: {
          table: "activity_log",
          orgId,
        },
      },
    });
    expect(firstPage.items.map((item) => item.excerpt).join("\n")).not.toContain("Deleted comment");
    expect(firstPage.items.map((item) => item.excerpt).join("\n")).not.toContain("Other org");
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await svc.listUserActivityLedger({
      orgId,
      userId,
      since: new Date("2026-06-18T00:00:00.000Z"),
      until: new Date("2026-06-19T00:00:00.000Z"),
      limit: 3,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items.map((item) => item.kind)).toEqual(["chat_message"]);
    expect(secondPage.nextCursor).toBeNull();

    const chatOnly = await svc.listUserActivityLedger({
      orgId,
      userId,
      include: ["chat"],
      agentId,
      issueId,
      limit: 10,
    });

    expect(chatOnly.items).toHaveLength(1);
    expect(chatOnly.items[0]).toMatchObject({
      kind: "chat_message",
      excerpt: "Please implement the user activity ledger with source evidence.",
      source: {
        type: "chat",
        provenance: {
          table: "chat_messages",
          orgId,
        },
      },
    });
  });

  it("filters user approval comments by project through approval payload issue links", async () => {
    const orgId = randomUUID();
    const userId = "user-1";
    const targetProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const targetIssueId = randomUUID();
    const otherIssueId = randomUUID();
    const targetApprovalId = randomUUID();
    const directProjectApprovalId = randomUUID();
    const otherProjectApprovalId = randomUUID();
    const unscopedApprovalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values([
      {
        id: targetProjectId,
        orgId,
        name: "Target project",
        status: "in_progress",
      },
      {
        id: otherProjectId,
        orgId,
        name: "Other project",
        status: "in_progress",
      },
    ]);

    await db.insert(issues).values([
      {
        id: targetIssueId,
        orgId,
        projectId: targetProjectId,
        identifier: "RST-1",
        title: "Target project issue",
        status: "todo",
        priority: "high",
      },
      {
        id: otherIssueId,
        orgId,
        projectId: otherProjectId,
        identifier: "RST-2",
        title: "Other project issue",
        status: "todo",
        priority: "high",
      },
    ]);

    await db.insert(approvals).values([
      {
        id: targetApprovalId,
        orgId,
        type: "command",
        status: "approved",
        payload: { issueIds: [targetIssueId] },
      },
      {
        id: directProjectApprovalId,
        orgId,
        type: "command",
        status: "approved",
        payload: { projectId: targetProjectId },
      },
      {
        id: otherProjectApprovalId,
        orgId,
        type: "command",
        status: "approved",
        payload: { primaryIssueId: otherIssueId },
      },
      {
        id: unscopedApprovalId,
        orgId,
        type: "command",
        status: "approved",
        payload: {},
      },
    ]);

    await db.insert(approvalComments).values([
      {
        orgId,
        approvalId: targetApprovalId,
        authorUserId: userId,
        body: "Target project approval via linked issue.",
        createdAt: new Date("2026-06-18T03:00:00.000Z"),
      },
      {
        orgId,
        approvalId: directProjectApprovalId,
        authorUserId: userId,
        body: "Target project approval via direct project payload.",
        createdAt: new Date("2026-06-18T03:05:00.000Z"),
      },
      {
        orgId,
        approvalId: otherProjectApprovalId,
        authorUserId: userId,
        body: "Other project approval should not appear.",
        createdAt: new Date("2026-06-18T03:10:00.000Z"),
      },
      {
        orgId,
        approvalId: unscopedApprovalId,
        authorUserId: userId,
        body: "Unscoped approval should not appear.",
        createdAt: new Date("2026-06-18T03:15:00.000Z"),
      },
    ]);

    const result = await svc.listUserActivityLedger({
      orgId,
      userId,
      include: ["approvals"],
      projectId: targetProjectId,
      limit: 10,
    });

    expect(result.items.map((item) => item.metadata?.approvalId)).toEqual([
      directProjectApprovalId,
      targetApprovalId,
    ]);
    expect(result.items.map((item) => item.excerpt).join("\n")).not.toContain("Other project");
    expect(result.items.map((item) => item.excerpt).join("\n")).not.toContain("Unscoped approval");
  });

  it("filters user approval activity events by approval project links and requested agent", async () => {
    const orgId = randomUUID();
    const userId = "user-1";
    const targetProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const targetIssueId = randomUUID();
    const otherIssueId = randomUUID();
    const requestedAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const linkedIssueApprovalId = randomUUID();
    const directProjectApprovalId = randomUUID();
    const otherProjectApprovalId = randomUUID();
    const unscopedApprovalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values([
      {
        id: targetProjectId,
        orgId,
        name: "Target project",
        status: "in_progress",
      },
      {
        id: otherProjectId,
        orgId,
        name: "Other project",
        status: "in_progress",
      },
    ]);

    await db.insert(agents).values([
      {
        id: requestedAgentId,
        orgId,
        name: "Wesley",
        role: "engineer",
        status: "running",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        orgId,
        name: "Holden",
        role: "reviewer",
        status: "running",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values([
      {
        id: targetIssueId,
        orgId,
        projectId: targetProjectId,
        identifier: "RST-1",
        title: "Target project issue",
        status: "todo",
        priority: "high",
      },
      {
        id: otherIssueId,
        orgId,
        projectId: otherProjectId,
        identifier: "RST-2",
        title: "Other project issue",
        status: "todo",
        priority: "high",
      },
    ]);

    await db.insert(approvals).values([
      {
        id: linkedIssueApprovalId,
        orgId,
        type: "command",
        requestedByAgentId,
        status: "approved",
        payload: { issueIds: [targetIssueId] },
      },
      {
        id: directProjectApprovalId,
        orgId,
        type: "command",
        requestedByAgentId,
        status: "rejected",
        payload: { projectId: targetProjectId },
      },
      {
        id: otherProjectApprovalId,
        orgId,
        type: "command",
        requestedByAgentId: otherAgentId,
        status: "approved",
        payload: { primaryIssueId: otherIssueId },
      },
      {
        id: unscopedApprovalId,
        orgId,
        type: "command",
        requestedByAgentId,
        status: "approved",
        payload: {},
      },
    ]);

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "user",
        actorId: userId,
        action: "approval.approved",
        entityType: "approval",
        entityId: linkedIssueApprovalId,
        details: { note: "Approved target approval linked through issueIds." },
        createdAt: new Date("2026-06-18T04:00:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: userId,
        action: "approval.rejected",
        entityType: "approval",
        entityId: directProjectApprovalId,
        details: { note: "Rejected direct target project approval." },
        createdAt: new Date("2026-06-18T04:05:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: userId,
        action: "approval.approved",
        entityType: "approval",
        entityId: otherProjectApprovalId,
        details: { note: "Other project approval should not appear." },
        createdAt: new Date("2026-06-18T04:10:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: userId,
        action: "approval.approved",
        entityType: "approval",
        entityId: unscopedApprovalId,
        details: { note: "Unscoped approval should not appear." },
        createdAt: new Date("2026-06-18T04:15:00.000Z"),
      },
    ]);

    const projectResult = await svc.listUserActivityLedger({
      orgId,
      userId,
      include: ["approvals"],
      projectId: targetProjectId,
      limit: 10,
    });

    expect(projectResult.items.map((item) => item.metadata?.entityId)).toEqual([
      directProjectApprovalId,
      linkedIssueApprovalId,
    ]);
    expect(projectResult.items.map((item) => item.excerpt).join("\n")).not.toContain("Other project");
    expect(projectResult.items.map((item) => item.excerpt).join("\n")).not.toContain("Unscoped approval");

    const agentResult = await svc.listUserActivityLedger({
      orgId,
      userId,
      include: ["activity", "approvals"],
      agentId: requestedAgentId,
      limit: 10,
    });

    expect(agentResult.items.map((item) => item.metadata?.entityId)).toEqual([
      unscopedApprovalId,
      directProjectApprovalId,
      linkedIssueApprovalId,
    ]);
    expect(agentResult.items.map((item) => item.excerpt).join("\n")).not.toContain("Other project");
    expect(agentResult.items[0]?.related).toEqual(expect.arrayContaining([
      { type: "agent", id: requestedAgentId },
      { type: "approval", id: unscopedApprovalId, label: "command" },
    ]));
  });
});
