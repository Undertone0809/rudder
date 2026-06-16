import {
  activityLog,
  agents,
  applyPendingMigrations,
  chatContextLinks,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  issues,
  organizations,
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
    await db.delete(chatContextLinks);
    await db.delete(chatConversations);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(issues);
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
});
