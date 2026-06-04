import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  assets,
  applyPendingMigrations,
  organizations,
  createDb,
  ensurePostgresDatabase,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
  organizationMemberships,
  projects,
  projectWorkspaces,
} from "@rudderhq/db";
import { buildAgentMentionHref, deriveOrganizationUrlKey } from "@rudderhq/shared";
import { issueService } from "../services/issues.ts";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-issues-service-"));
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

describe("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = issueService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(organizationMemberships);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(labels);
    await db.delete(assets);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        orgId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        orgId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        orgId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        orgId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        orgId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        orgId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        orgId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      orgId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(orgId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        orgId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        orgId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(orgId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("finds issues by comment text when using server-side q search", async () => {
    const orgId = randomUUID();
    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Comment Search Org",
      urlKey: deriveOrganizationUrlKey("Comment Search Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        orgId,
        title: "Unrelated title",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        orgId,
        title: "Another issue",
        status: "todo",
        priority: "medium",
      },
    ]);
    await db.insert(issueComments).values({
      id: randomUUID(),
      orgId,
      issueId: matchedIssueId,
      authorUserId: "local-board",
      body: "Only this comment mentions frobnicator-search-token.",
    });

    const result = await svc.list(orgId, { q: "frobnicator-search-token" });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
    expect(result[0]?.searchMatch).toMatchObject({
      field: "comment",
      snippet: "Only this comment mentions frobnicator-search-token.",
    });
  });

  it("ignores invalid project mention ids when resolving mentioned projects", async () => {
    const orgId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Mention Org",
      urlKey: deriveOrganizationUrlKey("Mention Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Mentioned Project",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Mention examples",
      status: "todo",
      priority: "medium",
      description: [
        "Inline example: `[@Project](project://id)`",
        `Real mention: [@Mentioned](project://${projectId})`,
      ].join("\n"),
    });

    await expect(svc.findMentionedProjectIds(issueId)).resolves.toEqual([projectId]);
  });


  it("treats agent mention links as render-only references when resolving agent wake mentions", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Mention Org",
      urlKey: deriveOrganizationUrlKey("Agent Mention Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Wesley",
      role: "reviewer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(svc.findMentionedAgents(orgId, "@Wesley please check this")).resolves.toEqual([agentId]);
    await expect(
      svc.findMentionedAgents(orgId, `Render-only reference: [Wesley](${buildAgentMentionHref(agentId, "code")})`),
    ).resolves.toEqual([]);
  });
  it("persists and filters reviewer principals", async () => {
    const orgId = randomUUID();
    const reviewerAgentId = randomUUID();
    const reviewerUserId = "reviewer-user";

    await db.insert(organizations).values({
      id: orgId,
      name: "Reviewer Org",
      urlKey: deriveOrganizationUrlKey("Reviewer Org"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: reviewerAgentId,
      orgId,
      name: "Reviewer Agent",
      role: "reviewer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(organizationMemberships).values({
      orgId,
      principalType: "user",
      principalId: reviewerUserId,
      status: "active",
      membershipRole: "member",
    });

    const agentReviewed = await svc.create(orgId, {
      title: "Agent reviewed issue",
      status: "todo",
      priority: "medium",
      reviewerAgentId,
    });
    const userReviewed = await svc.create(orgId, {
      title: "User reviewed issue",
      status: "todo",
      priority: "medium",
      reviewerUserId,
    });

    expect(agentReviewed.reviewerAgentId).toBe(reviewerAgentId);
    expect(agentReviewed.reviewerUserId).toBeNull();
    expect(userReviewed.reviewerUserId).toBe(reviewerUserId);

    await expect(svc.create(orgId, {
      title: "Invalid reviewer issue",
      status: "todo",
      priority: "medium",
      reviewerAgentId,
      reviewerUserId,
    })).rejects.toThrow(/one reviewer/i);

    expect((await svc.list(orgId, { reviewerAgentId })).map((issue) => issue.id)).toEqual([agentReviewed.id]);
    expect((await svc.list(orgId, { reviewerUserId })).map((issue) => issue.id)).toEqual([userReviewed.id]);
  });

  it("can exclude blocked reviewer rows after the reviewer confirms operator handoff", async () => {
    const orgId = randomUUID();
    const reviewerAgentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Reviewer Handoff Org",
      urlKey: deriveOrganizationUrlKey("Reviewer Handoff Org"),
      issuePrefix: `H${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: reviewerAgentId,
      orgId,
      name: "Reviewer Agent",
      role: "reviewer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const pendingIssueId = randomUUID();
    const confirmedIssueId = randomUUID();
    const reblockedIssueId = randomUUID();
    const resumedByCommentIssueId = randomUUID();
    const resumedByPriorityIssueId = randomUUID();
    const reviewerCommentIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: pendingIssueId,
        orgId,
        title: "Pending blocked review",
        status: "blocked",
        priority: "medium",
        reviewerAgentId,
      },
      {
        id: confirmedIssueId,
        orgId,
        title: "Confirmed blocked review",
        status: "blocked",
        priority: "medium",
        reviewerAgentId,
      },
      {
        id: reblockedIssueId,
        orgId,
        title: "Reblocked after an older decision",
        status: "blocked",
        priority: "medium",
        reviewerAgentId,
      },
      {
        id: resumedByCommentIssueId,
        orgId,
        title: "Confirmed review resumed by operator comment",
        status: "blocked",
        priority: "medium",
        reviewerAgentId,
      },
      {
        id: resumedByPriorityIssueId,
        orgId,
        title: "Confirmed review resumed by priority change",
        status: "blocked",
        priority: "high",
        reviewerAgentId,
      },
      {
        id: reviewerCommentIssueId,
        orgId,
        title: "Confirmed review with reviewer-only follow-up",
        status: "blocked",
        priority: "medium",
        reviewerAgentId,
      },
    ]);

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: confirmedIssueId,
        agentId: reviewerAgentId,
        details: { status: "blocked" },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: confirmedIssueId,
        agentId: reviewerAgentId,
        details: { decision: "blocked", outcome: "human_handoff", operatorActionRequired: true },
        createdAt: new Date("2026-05-01T00:01:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: reblockedIssueId,
        agentId: reviewerAgentId,
        details: { decision: "blocked", outcome: "human_handoff", operatorActionRequired: true },
        createdAt: new Date("2026-05-01T00:02:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: reblockedIssueId,
        agentId: reviewerAgentId,
        details: { status: "blocked" },
        createdAt: new Date("2026-05-01T00:03:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: resumedByCommentIssueId,
        agentId: reviewerAgentId,
        details: { decision: "blocked", outcome: "human_handoff", operatorActionRequired: true },
        createdAt: new Date("2026-05-01T00:04:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: resumedByCommentIssueId,
        details: { bodySnippet: "Access granted; please review again." },
        createdAt: new Date("2026-05-01T00:05:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: resumedByPriorityIssueId,
        agentId: reviewerAgentId,
        details: { decision: "blocked", outcome: "human_handoff", operatorActionRequired: true },
        createdAt: new Date("2026-05-01T00:06:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.updated",
        entityType: "issue",
        entityId: resumedByPriorityIssueId,
        details: { priority: "high", _previous: { priority: "medium" } },
        createdAt: new Date("2026-05-01T00:07:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: reviewerCommentIssueId,
        agentId: reviewerAgentId,
        details: { decision: "blocked", outcome: "human_handoff", operatorActionRequired: true },
        createdAt: new Date("2026-05-01T00:08:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: reviewerAgentId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: reviewerCommentIssueId,
        agentId: reviewerAgentId,
        details: { bodySnippet: "Still waiting on the same external access." },
        createdAt: new Date("2026-05-01T00:09:00.000Z"),
      },
    ]);

    const rows = await svc.list(orgId, {
      reviewerAgentId,
      status: "in_review,blocked",
      excludeReviewerConfirmedBlockedHandoff: true,
    });
    const rowIds = new Set(rows.map((issue) => issue.id));

    expect(rowIds.has(pendingIssueId)).toBe(true);
    expect(rowIds.has(confirmedIssueId)).toBe(false);
    expect(rowIds.has(reblockedIssueId)).toBe(true);
    expect(rowIds.has(resumedByCommentIssueId)).toBe(true);
    expect(rowIds.has(resumedByPriorityIssueId)).toBe(true);
    expect(rowIds.has(reviewerCommentIssueId)).toBe(false);
  });

  it("clears reviewer and preserves reviewer when update omits reviewer fields", async () => {
    const orgId = randomUUID();
    const reviewerAgentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Reviewer Update Org",
      urlKey: deriveOrganizationUrlKey("Reviewer Update Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: reviewerAgentId,
      orgId,
      name: "Reviewer Agent",
      role: "reviewer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const created = await svc.create(orgId, {
      title: "Reviewer update issue",
      status: "todo",
      priority: "medium",
      reviewerAgentId,
    });

    const priorityUpdate = await svc.update(created.id, { priority: "high" });
    expect(priorityUpdate?.reviewerAgentId).toBe(reviewerAgentId);

    const cleared = await svc.update(created.id, { reviewerAgentId: null });
    expect(cleared?.reviewerAgentId).toBeNull();
    expect(cleared?.reviewerUserId).toBeNull();
  });

  it("requires agent-created issues to select labels once an organization has five labels", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const labelIds = Array.from({ length: 5 }, () => randomUUID());

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Label Required Org",
      urlKey: deriveOrganizationUrlKey("Agent Label Required Org"),
      issuePrefix: `L${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Issue Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(labels).values(
      labelIds.map((id, index) => ({
        id,
        orgId,
        name: `Label ${index + 1}`,
        color: "#2563eb",
      })),
    );

    await expect(svc.create(orgId, {
      title: "Unlabeled agent issue",
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "agent_issue_label_required",
        labelCount: 5,
      }),
    });

    const created = await svc.create(orgId, {
      title: "Labeled agent issue",
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
      labelIds: [labelIds[0]!],
    });

    expect(created.labelIds).toEqual([labelIds[0]]);
  });

  it("allows unlabeled agent-created issues below five labels and inherits parent defaults for sub-issues", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const labelIds = Array.from({ length: 5 }, () => randomUUID());

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Label Inherit Org",
      urlKey: deriveOrganizationUrlKey("Agent Label Inherit Org"),
      issuePrefix: `I${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Issue Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Parent Project",
      status: "in_progress",
    });
    await db.insert(labels).values(
      labelIds.slice(0, 4).map((id, index) => ({
        id,
        orgId,
        name: `Label ${index + 1}`,
        color: "#2563eb",
      })),
    );

    const beforeThreshold = await svc.create(orgId, {
      title: "Allowed unlabeled agent issue",
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
    });
    expect(beforeThreshold.labelIds).toEqual([]);

    await db.insert(labels).values({
      id: labelIds[4]!,
      orgId,
      name: "Label 5",
      color: "#2563eb",
    });
    const parent = await svc.create(orgId, {
      title: "Parent issue",
      status: "todo",
      priority: "medium",
      projectId,
      labelIds: [labelIds[1]!],
    });

    const child = await svc.create(orgId, {
      title: "Child issue",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      createdByAgentId: agentId,
    });

    expect(child.labelIds).toEqual([labelIds[1]]);
    expect(child.projectId).toBe(projectId);
    await expect(
      db.select().from(issueLabels).where(eq(issueLabels.issueId, child.id)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, child.id))
        .then((rows) => rows[0]?.projectId ?? null),
    ).resolves.toBe(projectId);
  });

  it("rejects workspace ids from another project when inheriting a parent project", async () => {
    const orgId = randomUUID();
    const parentProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const otherProjectWorkspaceId = randomUUID();
    const otherExecutionWorkspaceId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Inherited Workspace Boundary Org",
      urlKey: deriveOrganizationUrlKey("Inherited Workspace Boundary Org"),
      issuePrefix: `W${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values([
      {
        id: parentProjectId,
        orgId,
        name: "Parent Project",
        status: "in_progress",
      },
      {
        id: otherProjectId,
        orgId,
        name: "Other Project",
        status: "in_progress",
      },
    ]);
    await db.insert(projectWorkspaces).values({
      id: otherProjectWorkspaceId,
      orgId,
      projectId: otherProjectId,
      name: "Other workspace",
      sourceType: "local_path",
      cwd: "/tmp/rudder-other-workspace",
    });
    await db.insert(executionWorkspaces).values({
      id: otherExecutionWorkspaceId,
      orgId,
      projectId: otherProjectId,
      projectWorkspaceId: otherProjectWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Other execution workspace",
    });

    const parent = await svc.create(orgId, {
      title: "Parent issue",
      status: "todo",
      priority: "medium",
      projectId: parentProjectId,
    });

    await expect(
      svc.create(orgId, {
        title: "Child issue with foreign project workspace",
        status: "todo",
        priority: "medium",
        parentId: parent.id,
        projectWorkspaceId: otherProjectWorkspaceId,
      }),
    ).rejects.toThrow("Project workspace must belong to the selected project");

    await expect(
      svc.create(orgId, {
        title: "Child issue with foreign execution workspace",
        status: "todo",
        priority: "medium",
        parentId: parent.id,
        executionWorkspaceId: otherExecutionWorkspaceId,
      }),
    ).rejects.toThrow("Execution workspace must belong to the selected project");
  });

  it("rejects parent issue relationships outside the organization or through descendants", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Parent Boundary Org",
        urlKey: deriveOrganizationUrlKey("Parent Boundary Org"),
        issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Parent Org",
        urlKey: deriveOrganizationUrlKey("Other Parent Org"),
        issuePrefix: `Q${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    const parent = await svc.create(orgId, {
      title: "Parent",
      status: "todo",
      priority: "medium",
    });
    const child = await svc.create(orgId, {
      title: "Child",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
    });
    const otherOrgIssue = await svc.create(otherOrgId, {
      title: "Other org issue",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.create(orgId, {
        title: "Cross-org child",
        status: "todo",
        priority: "medium",
        parentId: otherOrgIssue.id,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Parent issue must belong to the same organization",
    });

    await expect(svc.update(parent.id, { parentId: child.id })).rejects.toMatchObject({
      status: 422,
      message: "Issue parent cannot be one of its descendants",
    });

    await expect(svc.update(child.id, { parentId: child.id })).rejects.toMatchObject({
      status: 422,
      message: "Issue cannot be its own parent",
    });
  });

  it("rejects direct goal links outside the organization", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Goal Boundary Org",
        urlKey: deriveOrganizationUrlKey("Goal Boundary Org"),
        issuePrefix: `G${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Goal Org",
        urlKey: deriveOrganizationUrlKey("Other Goal Org"),
        issuePrefix: `H${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    const [externalGoal] = await db
      .insert(goals)
      .values({
        orgId: otherOrgId,
        title: "External goal",
        level: "organization",
        status: "active",
      })
      .returning();

    await expect(svc.create(orgId, {
      title: "Cross-org goal",
      status: "todo",
      priority: "medium",
      goalId: externalGoal!.id,
    })).rejects.toMatchObject({
      status: 422,
      message: "Goal must belong to same organization",
    });

    const issue = await svc.create(orgId, {
      title: "Local issue",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.update(issue.id, { goalId: externalGoal!.id })).rejects.toMatchObject({
      status: 422,
      message: "Goal must belong to same organization",
    });
  });

  it("persists an explicit goal clear for projectless issues with a default organization goal", async () => {
    const orgId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Goal Clear Org",
      urlKey: deriveOrganizationUrlKey("Goal Clear Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const [defaultGoal] = await db
      .insert(goals)
      .values({
        orgId,
        title: "Default organization goal",
        level: "organization",
        status: "active",
      })
      .returning();

    const issue = await svc.create(orgId, {
      title: "Projectless issue",
      status: "todo",
      priority: "medium",
    });

    expect(issue.goalId).toBe(defaultGoal!.id);

    const updated = await svc.update(issue.id, { goalId: null });

    expect(updated?.goalId).toBeNull();

    const descriptionOnlyUpdate = await svc.update(issue.id, {
      description: "Description-only edits must not restore the default goal.",
    });
    expect(descriptionOnlyUpdate?.goalId).toBeNull();

    const noProjectUpdate = await svc.update(issue.id, { projectId: null });
    expect(noProjectUpdate?.goalId).toBeNull();

    const persisted = await svc.getById(issue.id);
    expect(persisted?.goalId).toBeNull();
  });

  it("rejects reviewers outside the organization or inactive membership", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const reviewerAgentId = randomUUID();
    const reviewerUserId = "inactive-reviewer";

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Reviewer Boundary Org",
        urlKey: deriveOrganizationUrlKey("Reviewer Boundary Org"),
        issuePrefix: `B${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Reviewer Org",
        urlKey: deriveOrganizationUrlKey("Other Reviewer Org"),
        issuePrefix: `O${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: reviewerAgentId,
      orgId: otherOrgId,
      name: "External Reviewer",
      role: "reviewer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(organizationMemberships).values({
      orgId,
      principalType: "user",
      principalId: reviewerUserId,
      status: "suspended",
      membershipRole: "member",
    });

    await expect(svc.create(orgId, {
      title: "Cross org reviewer",
      status: "todo",
      priority: "medium",
      reviewerAgentId,
    })).rejects.toThrow(/Reviewer must belong to same organization/i);

    await expect(svc.create(orgId, {
      title: "Inactive reviewer",
      status: "todo",
      priority: "medium",
      reviewerUserId,
    })).rejects.toThrow(/Reviewer user not found/i);
  });

  it("lists only issue-level attachments", async () => {
    const orgId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Attachment semantics",
      status: "todo",
      priority: "medium",
    });

    await svc.createAttachment({
      issueId,
      usage: "issue",
      provider: "local_disk",
      objectKey: "issues/issue-level.pdf",
      contentType: "application/pdf",
      byteSize: 12,
      sha256: "sha256-issue",
      originalFilename: "issue-level.pdf",
    });
    await svc.createAttachment({
      issueId,
      usage: "comment_inline",
      provider: "local_disk",
      objectKey: "issues/comment-inline.png",
      contentType: "image/png",
      byteSize: 14,
      sha256: "sha256-comment",
      originalFilename: "comment-inline.png",
    });

    const attachments = await svc.listAttachments(issueId);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      usage: "issue",
      originalFilename: "issue-level.pdf",
    });
  });

  it("clears execution lock fields when releasing an in-progress issue", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Owner",
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
      invocationSource: "automation",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Execution lock handoff",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
      startedAt: new Date(),
    });

    const released = await svc.release(issueId, agentId, runId);
    expect(released).not.toBeNull();
    expect(released?.status).toBe("todo");
    expect(released?.assigneeAgentId).toBeNull();
    expect(released?.checkoutRunId).toBeNull();
    expect(released?.executionRunId).toBeNull();
    expect(released?.executionAgentNameKey).toBeNull();
    expect(released?.executionLockedAt).toBeNull();
  });

  it("clears stale execution lock on assignee change so reassigned agent can checkout", async () => {
    const orgId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const oldRunId = randomUUID();
    const newRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        orgId,
        name: "PreviousOwner",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAgentId,
        orgId,
        name: "NewOwner",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: oldRunId,
        orgId,
        agentId: oldAgentId,
        invocationSource: "automation",
        status: "queued",
      },
      {
        id: newRunId,
        orgId,
        agentId: newAgentId,
        invocationSource: "automation",
        status: "queued",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Reassignment lock cleanup",
      status: "todo",
      priority: "high",
      assigneeAgentId: oldAgentId,
      createdByAgentId: oldAgentId,
      executionRunId: oldRunId,
      executionAgentNameKey: "previousowner",
      executionLockedAt: new Date(),
    });

    const reassigned = await svc.update(issueId, { assigneeAgentId: newAgentId, assigneeUserId: null });
    expect(reassigned).not.toBeNull();
    expect(reassigned?.assigneeAgentId).toBe(newAgentId);
    expect(reassigned?.checkoutRunId).toBeNull();
    expect(reassigned?.executionRunId).toBeNull();
    expect(reassigned?.executionAgentNameKey).toBeNull();
    expect(reassigned?.executionLockedAt).toBeNull();

    const checkedOut = await svc.checkout(issueId, newAgentId, ["todo", "backlog", "blocked"], newRunId);
    expect(checkedOut.assigneeAgentId).toBe(newAgentId);
    expect(checkedOut.status).toBe("in_progress");
    expect(checkedOut.checkoutRunId).toBe(newRunId);
    expect(checkedOut.executionRunId).toBe(newRunId);
  });

  it("adopts a stale checkout lock for the same assignee when the prior run is terminal", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const staleRunId = randomUUID();
    const resumedRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Owner",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        orgId,
        agentId,
        invocationSource: "automation",
        status: "failed",
      },
      {
        id: resumedRunId,
        orgId,
        agentId,
        invocationSource: "automation",
        status: "queued",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Resume after stale lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
      startedAt: new Date(),
    });

    const ownership = await svc.assertCheckoutOwner(issueId, agentId, resumedRunId);
    expect(ownership).toMatchObject({
      assigneeAgentId: agentId,
      checkoutRunId: resumedRunId,
      executionRunId: resumedRunId,
      adoptedFromRunId: staleRunId,
    });

    const updated = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(updated).toEqual({
      checkoutRunId: resumedRunId,
      executionRunId: resumedRunId,
    });
  });

  it("rejects release when a different run tries to release the checkout lock", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const checkoutRunId = randomUUID();
    const otherRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Owner",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: checkoutRunId,
        orgId,
        agentId,
        invocationSource: "automation",
        status: "running",
      },
      {
        id: otherRunId,
        orgId,
        agentId,
        invocationSource: "automation",
        status: "running",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Release ownership",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
      executionLockedAt: new Date(),
      startedAt: new Date(),
    });

    await expect(svc.release(issueId, agentId, otherRunId)).rejects.toThrow(/Only checkout run can release issue/i);
  });

  it("defaults execution workspace settings from project policy without an instance flag gate", async () => {
    const orgId = randomUUID();
    const projectId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Org",
      urlKey: deriveOrganizationUrlKey("Workspace Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Execution Policy Project",
      status: "planned",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
      },
    });

    const created = await svc.create(orgId, {
      title: "Workspace-aware issue",
      status: "todo",
      priority: "medium",
      projectId,
    });

    expect(created.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" });
  });

  it("preserves explicit execution workspace fields on issue updates", async () => {
    const orgId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Update Org",
      urlKey: deriveOrganizationUrlKey("Workspace Update Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const created = await svc.create(orgId, {
      title: "Workspace update issue",
      status: "todo",
      priority: "medium",
    });

    const updated = await svc.update(created.id, {
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(updated?.executionWorkspacePreference).toBe("isolated_workspace");
    expect(updated?.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" });
  });

  it("persists manual board order inside a status lane", async () => {
    const orgId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const movedIssueId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Manual Order Org",
      urlKey: deriveOrganizationUrlKey("Manual Order Org"),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: firstIssueId,
        orgId,
        title: "First issue",
        status: "todo",
        priority: "medium",
        boardOrder: 1000,
      },
      {
        id: secondIssueId,
        orgId,
        title: "Second issue",
        status: "todo",
        priority: "medium",
        boardOrder: 2000,
      },
      {
        id: movedIssueId,
        orgId,
        title: "Moved issue",
        status: "todo",
        priority: "medium",
        boardOrder: 3000,
      },
    ]);

    const result = await svc.reorder(orgId, {
      issueId: movedIssueId,
      targetStatus: "todo",
      previousIssueId: firstIssueId,
      nextIssueId: secondIssueId,
    });

    expect(result?.issue.id).toBe(movedIssueId);
    expect(result?.issue.boardOrder).toBe(2000);
    expect(result?.previousBoardOrder).toBe(3000);

    const ordered = await db
      .select({ id: issues.id, boardOrder: issues.boardOrder })
      .from(issues)
      .where(eq(issues.orgId, orgId))
      .orderBy(issues.boardOrder);

    expect(ordered).toEqual([
      { id: firstIssueId, boardOrder: 1000 },
      { id: movedIssueId, boardOrder: 2000 },
      { id: secondIssueId, boardOrder: 3000 },
    ]);
  });
});
