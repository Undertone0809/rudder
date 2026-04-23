import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigRevisions,
  agents,
  applyPendingMigrations,
  budgetPolicies,
  createDb,
  documentRevisions,
  documents,
  ensurePostgresDatabase,
  executionWorkspaces,
  issueDocuments,
  issues,
  labels,
  organizationSkills,
  organizations,
  projectWorkspaces,
  projects,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@rudder/db";
import { deriveOrganizationUrlKey } from "@rudder/shared";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import { agentService } from "../services/agents.js";
import { organizationService } from "../services/orgs.js";
import {
  resolveOrganizationRoot,
  resolveOrganizationWorkspaceRoot,
} from "../home-paths.js";

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
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  beforeAll(async () => {
    rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-orgs-service-home-"));
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    agentSvc = agentService(db);
    orgSvc = organizationService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentConfigRevisions);
    await db.delete(organizationSkills);
    await db.delete(budgetPolicies);
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

  it("initializes the default chat runtime from the first chat-capable agent", async () => {
    const createdOrg = await orgSvc.create({
      name: "Copilot Default Org",
      requireBoardApprovalForNewAgents: false,
    });

    await agentSvc.create(createdOrg.id, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      reportsTo: null,
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
    expect(reloaded?.defaultChatAgentRuntimeType).toBe("codex_local");
    expect(reloaded?.defaultChatAgentRuntimeConfig).toEqual({
      model: "gpt-5.4",
      command: "codex",
    });
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
      reportsTo: null,
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
      reportsTo: ceo.id,
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

  it("preserves an explicit organization chat default when the first agent is created", async () => {
    const createdOrg = await orgSvc.create({
      name: "Preserved Copilot Default Org",
      requireBoardApprovalForNewAgents: false,
      defaultChatAgentRuntimeType: "claude_local",
      defaultChatAgentRuntimeConfig: {
        model: "claude-sonnet-4-5",
      },
    });

    await agentSvc.create(createdOrg.id, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      reportsTo: null,
      capabilities: null,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
      metadata: null,
    });

    const reloaded = await orgSvc.getById(createdOrg.id);
    expect(reloaded?.defaultChatAgentRuntimeType).toBe("claude_local");
    expect(reloaded?.defaultChatAgentRuntimeConfig).toEqual({
      model: "claude-sonnet-4-5",
    });
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
          created.id,
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
});
