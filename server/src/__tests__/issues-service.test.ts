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
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
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
    await db.delete(activityLog);
    await db.delete(issues);
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
});
