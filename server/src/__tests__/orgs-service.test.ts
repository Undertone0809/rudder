import { resolveOrganizationStorageKey } from "@rudderhq/agent-runtime-utils";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  applyPendingMigrations,
  budgetPolicies,
  costMonthlySpendRollups,
  createDb,
  documentRevisions,
  documents,
  ensurePostgresDatabase,
  executionWorkspaces,
  heartbeatRuns,
  issueBlockAuditAttempts,
  issueDocuments,
  issues,
  labels,
  organizationSkills,
  organizations,
  projectWorkspaces,
  projects,
  requests,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import {
  resolveOrganizationRoot,
  resolveOrganizationWorkspaceRoot,
} from "../home-paths.js";
import { agentService } from "../services/agents.js";
import { issueService } from "../services/issues.js";
import { organizationService } from "../services/orgs.js";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-orgs-service-"));
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

describe("organization service", () => {
  let db!: ReturnType<typeof createDb>;
  let agentSvc!: ReturnType<typeof agentService>;
  let orgSvc!: ReturnType<typeof organizationService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let rudderHome = "";
  let connectionString = "";
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  beforeAll(async () => {
    rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-orgs-service-home-"));
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const started = await startTempDatabase();
    connectionString = started.connectionString;
    db = createDb(started.connectionString);
    agentSvc = agentService(db);
    orgSvc = organizationService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueBlockAuditAttempts);
    await db.delete(requests);
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentConfigRevisions);
    await db.delete(organizationSkills);
    await db.delete(budgetPolicies);
    await db.delete(costMonthlySpendRollups);
    await db.delete(agents);
    await db.delete(organizations);
    if (rudderHome) {
      fs.rmSync(path.join(rudderHome, "instances"), { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    if (rudderHome) {
      fs.rmSync(rudderHome, { recursive: true, force: true });
    }
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
  });

  it("preserves the existing managed instructions workspace when a legacy agent is renamed", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const originalName = "CTO";
    const renamedName = "Ella";
    const originalWorkspaceKey = buildAgentWorkspaceKey(originalName, agentId);
    const managedInstructionsRoot = path.join(
      resolveOrganizationWorkspaceRoot(orgId),
      "agents",
      originalWorkspaceKey,
      "instructions",
    );

    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Key Backfill",
      urlKey: deriveOrganizationUrlKey("Workspace Key Backfill"),
      issuePrefix: "WKB",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: originalName,
      workspaceKey: null,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: managedInstructionsRoot,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: path.join(managedInstructionsRoot, "AGENTS.md"),
      },
      runtimeConfig: {},
      permissions: {},
    });

    await agentSvc.update(agentId, { name: renamedName });

    const stored = await db
      .select({
        name: agents.name,
        workspaceKey: agents.workspaceKey,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    expect(stored).toEqual({
      name: renamedName,
      workspaceKey: originalWorkspaceKey,
    });

    const internal = await agentSvc.getInternalById(agentId);
    expect(internal?.workspaceKey).toBe(originalWorkspaceKey);

    const publicAgent = await agentSvc.getById(agentId);
    expect(publicAgent).not.toHaveProperty("workspaceKey");
  });

  it("removes organizations that still have non-cascading org-scoped child records", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const documentRevisionId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const workspaceOperationId = randomUUID();
    const runtimeServiceId = randomUUID();
    const heartbeatRunId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Round-trip Validation Test",
      urlKey: deriveOrganizationUrlKey("Round-trip Validation Test"),
      issuePrefix: "RTV",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Verifier",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(costMonthlySpendRollups).values({
      id: randomUUID(),
      orgId,
      scopeType: "organization",
      scopeId: orgId,
      monthStart: new Date("2026-04-01T00:00:00.000Z"),
      spendCents: 123,
    });

    await db.insert(agentConfigRevisions).values({
      id: randomUUID(),
      orgId,
      agentId,
      createdByUserId: "tester",
      source: "patch",
      changedKeys: ["runtimeConfig"],
      beforeConfig: { runtimeConfig: {} },
      afterConfig: { runtimeConfig: { mode: "seeded" } },
    });

    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      orgId,
      agentId,
      invocationSource: "manual",
      status: "succeeded",
      startedAt: new Date("2026-04-25T12:00:00.000Z"),
      finishedAt: new Date("2026-04-25T12:00:01.000Z"),
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      orgId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: heartbeatRunId,
      action: "heartbeat.completed",
      entityType: "heartbeat_run",
      entityId: heartbeatRunId,
      details: { status: "succeeded" },
    });

    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Portability",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      orgId,
      projectId,
      name: "Main workspace",
      sourceType: "local_path",
      cwd: "/tmp/rudder-portability",
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      projectId,
      projectWorkspaceId,
      title: "Validate import round-trip",
      status: "todo",
      priority: "medium",
    });

    const requestId = randomUUID();
    await db.insert(requests).values({
      id: requestId,
      orgId,
      kind: "assistance",
      subtype: "blocked",
      issueId,
      requestedByAgentId: agentId,
      originRunId: heartbeatRunId,
      assigneeAgentId: agentId,
      blockerFingerprint: "environment:desktop-disconnected",
      title: "Desktop connection required",
      prompt: "Reconnect the local Desktop runtime.",
    });

    await db.insert(issueBlockAuditAttempts).values({
      orgId,
      issueId,
      requestId,
      runId: heartbeatRunId,
      rootRunId: heartbeatRunId,
      agentId,
      continuationKind: "initial",
      failureClass: "environment",
      blockerFingerprint: "environment:desktop-disconnected",
      attemptNumber: 1,
      requiredAttempts: 3,
      statusBefore: "in_progress",
      statusAfter: "in_progress",
      blockerReason: "Desktop is not connected",
      requestedAction: "Reconnect Desktop",
    });

    await db.insert(documents).values({
      id: documentId,
      orgId,
      title: "Runbook",
      latestBody: "# Runbook",
      latestRevisionId: documentRevisionId,
      latestRevisionNumber: 1,
    });

    await db.insert(documentRevisions).values({
      id: documentRevisionId,
      orgId,
      documentId,
      revisionNumber: 1,
      body: "# Runbook",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      orgId,
      issueId,
      documentId,
      key: "runbook",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      orgId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "branch",
      strategyType: "reuse",
      name: "Exec workspace",
    });

    await db.insert(workspaceOperations).values({
      id: workspaceOperationId,
      orgId,
      executionWorkspaceId,
      phase: "setup",
      status: "running",
    });

    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      orgId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      issueId,
      scopeType: "workspace",
      serviceName: "preview",
      status: "running",
      lifecycle: "ephemeral",
      provider: "local",
    });

    await db.insert(organizationSkills).values({
      id: randomUUID(),
      orgId,
      key: `organization/${orgId}/portability-check`,
      slug: "portability-check",
      name: "Portability Check",
      markdown: "# Portability Check",
      sourceType: "catalog",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [],
    });

    await db.insert(budgetPolicies).values({
      id: randomUUID(),
      orgId,
      scopeType: "organization",
      scopeId: orgId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 5000,
    });

    const legacyProjectsRoot = path.join(rudderHome, "instances", "test-instance", "projects", orgId);
    fs.mkdirSync(resolveOrganizationWorkspaceRoot(orgId), { recursive: true });
    fs.mkdirSync(legacyProjectsRoot, { recursive: true });

    const removed = await orgSvc.remove(orgId);
    expect(removed?.id).toBe(orgId);

    const remaining = await orgSvc.getById(orgId);
    expect(remaining).toBeNull();
    expect(fs.existsSync(resolveOrganizationRoot(orgId))).toBe(false);
    expect(fs.existsSync(legacyProjectsRoot)).toBe(false);
  });

  it("removes an agent with block audit attempts without deleting the durable request", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const requestId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Agent Removal Audit",
      urlKey: deriveOrganizationUrlKey("Agent Removal Audit"),
      issuePrefix: "ARA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Audited Agent",
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
      title: "Exercise agent removal",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "manual",
      status: "succeeded",
      startedAt: new Date("2026-08-11T01:00:00.000Z"),
      finishedAt: new Date("2026-08-11T01:00:01.000Z"),
    });
    await db.insert(requests).values({
      id: requestId,
      orgId,
      kind: "assistance",
      subtype: "blocked",
      issueId,
      requestedByAgentId: agentId,
      originRunId: runId,
      assigneeAgentId: agentId,
      blockerFingerprint: "tool:browser-unavailable",
      title: "Browser access required",
      prompt: "Restore browser access.",
    });
    await db.insert(issueBlockAuditAttempts).values({
      orgId,
      issueId,
      requestId,
      runId,
      rootRunId: runId,
      agentId,
      continuationKind: "initial",
      failureClass: "tool",
      blockerFingerprint: "tool:browser-unavailable",
      attemptNumber: 1,
      requiredAttempts: 3,
      statusBefore: "in_progress",
      statusAfter: "in_progress",
      blockerReason: "Browser unavailable",
      requestedAction: "Restore browser access",
    });

    await expect(agentSvc.remove(agentId)).resolves.toMatchObject({ id: agentId });

    expect(await db.select().from(issueBlockAuditAttempts)).toEqual([]);
    const [remainingRequest] = await db.select().from(requests).where(eq(requests.id, requestId));
    expect(remainingRequest).toMatchObject({
      id: requestId,
      requestedByAgentId: null,
      assigneeAgentId: null,
      originRunId: null,
    });
  });

  it("creates default issue labels for newly created organizations", async () => {
    const created = await orgSvc.create({
      name: "Default Label Org",
      requireBoardApprovalForNewAgents: false,
    });

    const createdLabels = await db
      .select({
        name: labels.name,
        color: labels.color,
      })
      .from(labels)
      .where(eq(labels.orgId, created.id))
      .orderBy(asc(labels.name));

    expect(createdLabels).toEqual([
      { name: "Bug", color: "#ef4444" },
      { name: "Feature", color: "#a855f7" },
      { name: "UI", color: "#06b6d4" },
    ]);
  });

  it("does not seed organization-level chat runtime defaults from the first chat-capable agent", async () => {
    const createdOrg = await orgSvc.create({
      name: "Explicit Agent Chat Org",
      requireBoardApprovalForNewAgents: false,
    });

    await agentSvc.create(createdOrg.id, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      capabilities: null,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: "codex",
        promptTemplate: "You are the CEO.",
        bootstrapPromptTemplate: "Bootstrap the org.",
        instructionsBundleMode: "managed",
        instructionsFilePath: "/tmp/ceo/AGENTS.md",
        instructionsRootPath: "/tmp/ceo",
        instructionsEntryFile: "AGENTS.md",
        rudderSkillSync: { desiredSkills: ["organization/org/build-advisor"] },
        paperclipSkillSync: { desiredSkills: ["organization/org/build-advisor"] },
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
      metadata: null,
    });

    const reloaded = await orgSvc.getById(createdOrg.id);
    expect(reloaded).not.toHaveProperty("defaultChatAgentRuntimeType");
    expect(reloaded).not.toHaveProperty("defaultChatAgentRuntimeConfig");
  });

  it("auto-assigns distinct personal names when agent creation omits them", async () => {
    const createdOrg = await orgSvc.create({
      name: "Auto Name Org",
      requireBoardApprovalForNewAgents: false,
    });

    const ceo = await agentSvc.create(createdOrg.id, {
      role: "ceo",
      title: "Chief Executive Officer",
      status: "idle",
      capabilities: null,
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
      metadata: null,
    });

    const engineer = await agentSvc.create(createdOrg.id, {
      role: "engineer",
      title: "Software Engineer",
      status: "idle",
      capabilities: null,
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
      metadata: null,
    });

    expect(ceo.name).toBeTruthy();
    expect(engineer.name).toBeTruthy();
    expect(ceo.name).not.toBe("CEO");
    expect(engineer.name).not.toBe("Engineer");
    expect(engineer.name).not.toBe(ceo.name);
  });

  it("bootstraps the fixed org workspace root and ignores legacy workspace config payloads", async () => {
    const previousHome = process.env.RUDDER_HOME;
    const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
    const rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-org-service-home-"));

    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    try {
      const created = await orgSvc.create({
        name: "Workspace Org",
        requireBoardApprovalForNewAgents: false,
        workspace: {
          sourceType: "git_repo",
          cwd: "/tmp/rudder-shared-workspace",
          repoUrl: "https://github.com/acme/shared-repo",
          repoRef: "main",
          defaultRef: "main",
        },
      });

      expect(created.workspace).toBeNull();
      expect(resolveOrganizationWorkspaceRoot(created.id)).toBe(
        path.join(
          rudderHome,
          "instances",
          "test-instance",
          "organizations",
          resolveOrganizationStorageKey(created.id),
          "workspaces",
        ),
      );
      expect(fs.existsSync(resolveOrganizationWorkspaceRoot(created.id))).toBe(true);

      const updated = await orgSvc.update(created.id, {
        workspace: null,
      });
      expect(updated?.workspace).toBeNull();

      const reloaded = await orgSvc.getById(created.id);
      expect(reloaded?.workspace).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
      fs.rmSync(rudderHome, { recursive: true, force: true });
    }
  });

  it("does not backfill labels for organizations created before the default seeding path", async () => {
    const orgId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Legacy Org",
      urlKey: deriveOrganizationUrlKey("Legacy Org"),
      issuePrefix: "LEG",
      requireBoardApprovalForNewAgents: false,
    });

    const organization = await orgSvc.getById(orgId);
    expect(organization?.id).toBe(orgId);

    const createdLabels = await db
      .select({ id: labels.id })
      .from(labels)
      .where(eq(labels.orgId, orgId));

    expect(createdLabels).toEqual([]);
  });

  it("preserves digits, allocates generated conflicts, and rejects explicit conflicts", async () => {
    const first = await orgSvc.create({ name: "R6" });
    const second = await orgSvc.create({ name: "R7" });
    const generatedConflict = await orgSvc.create({ name: "R6" });
    const normalized = await orgSvc.create({ name: "Lowercase key", issuePrefix: "  l9  " });

    expect(first.issuePrefix).toBe("R6");
    expect(second.issuePrefix).toBe("R7");
    expect(generatedConflict.issuePrefix).toBe("R62");
    expect(generatedConflict.urlKey).toBe("r6-2");
    expect(normalized.issuePrefix).toBe("L9");

    await expect(orgSvc.create({ name: "Another org", issuePrefix: "R6" }))
      .rejects.toMatchObject({ status: 409, message: 'Issue key "R6" is already in use. Choose another key.' });
    await expect(orgSvc.create({ name: "Invalid key", issuePrefix: "6R" }))
      .rejects.toMatchObject({ status: 422 });
    await expect(orgSvc.update(first.id, { issuePrefix: "not-valid" }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("serializes concurrent generated organization keys without surfacing a conflict", async () => {
    const competingDb = createDb(connectionString);
    const competingOrgSvc = organizationService(competingDb);

    const created = await Promise.all([
      orgSvc.create({ name: "Parallel R6" }),
      competingOrgSvc.create({ name: "Parallel R6" }),
    ]);

    expect(created.map((organization) => organization.issuePrefix).sort()).toEqual(["PAR", "PAR2"]);
    expect(created.map((organization) => organization.urlKey).sort()).toEqual([
      "parallel-r6",
      "parallel-r6-2",
    ]);
  });

  it("keeps URL keys, current Issue Keys, and aliases unambiguous across organizations", async () => {
    const canonical = await orgSvc.create({ name: "Acme" });
    expect(canonical.urlKey).toBe("acme");
    await expect(orgSvc.create({ name: "Conflicting key", issuePrefix: "ACME" }))
      .rejects.toMatchObject({ status: 409 });

    const routeHolder = await orgSvc.create({ name: "Route Holder", issuePrefix: "NOVA" });
    await expect(orgSvc.update(routeHolder.id, { issuePrefix: "ACME" }))
      .rejects.toMatchObject({ status: 409 });
    const urlCollision = await orgSvc.create({ name: "Nova", issuePrefix: "NV2" });
    expect(urlCollision.urlKey).toBe("nova-2");

    await orgSvc.update(routeHolder.id, { issuePrefix: "NEXT" });
    await expect(orgSvc.create({ name: "Alias conflict", issuePrefix: "NOVA" }))
      .rejects.toMatchObject({ status: 409 });

    await expect(db.insert(organizations).values({
      name: "Direct collision",
      urlKey: "next",
      issuePrefix: "DIR",
    })).rejects.toThrow();
  });

  it("serializes concurrent direct writes across the route-key namespace", async () => {
    const competingDb = createDb(connectionString);
    let releaseFirstTransaction!: () => void;
    const holdFirstTransaction = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    let firstInsertCompleted!: () => void;
    const firstInsertReady = new Promise<void>((resolve) => {
      firstInsertCompleted = resolve;
    });

    const firstWrite = db.transaction(async (tx) => {
      await tx.insert(organizations).values({
        name: "Concurrent canonical owner",
        urlKey: "concurrent-route",
        issuePrefix: "CCO",
      });
      firstInsertCompleted();
      await holdFirstTransaction;
    });

    await firstInsertReady;
    let competingTransactionStarted!: () => void;
    const competingTransactionReady = new Promise<void>((resolve) => {
      competingTransactionStarted = resolve;
    });
    const competingWrite = competingDb.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      competingTransactionStarted();
      await tx.insert(organizations).values({
        name: "Concurrent Issue Key owner",
        urlKey: "different-route",
        issuePrefix: "CONCURRENT-ROUTE",
      });
    });

    await competingTransactionReady;
    const settledBeforeRelease = await Promise.race([
      competingWrite.then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledBeforeRelease).toBe(false);

    releaseFirstTransaction();
    await firstWrite;
    await expect(competingWrite).rejects.toThrow(/route key|Issue Key/i);
  });

  it("migrates issue identifiers while resolving every historical prefix", async () => {
    const organization = await orgSvc.create({ name: "R6" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      orgId: organization.id,
      title: "Historical link",
      issueNumber: 1,
      identifier: "R6-1",
    });

    const migrated = await orgSvc.update(organization.id, { issuePrefix: "RDX" });
    expect(migrated?.issuePrefix).toBe("RDX");
    expect(migrated?.issuePrefixAliases).toEqual(["R6"]);

    const issueSvc = issueService(db);
    expect((await issueSvc.getByIdentifier("RDX-1"))?.id).toBe(issueId);
    expect((await issueSvc.getByIdentifier("R6-1"))?.id).toBe(issueId);

    const restored = await orgSvc.update(organization.id, { issuePrefix: "R6" });
    expect(restored?.issuePrefix).toBe("R6");
    expect(restored?.issuePrefixAliases).toEqual(["RDX"]);
    expect((await issueSvc.getByIdentifier("RDX-1"))?.id).toBe(issueId);
  });
});
