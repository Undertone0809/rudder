import {
  agentApiKeys,
  agents,
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  createDb,
  ensurePostgresDatabase,
  goals,
  organizationMemberships,
  organizationMutationState,
  organizationResources,
  organizations,
  projectGoalMutationState,
  projectGoals,
  projectResourceAttachments,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@rudderhq/db";
import { DEFAULT_PROJECT_ICON, deriveOrganizationUrlKey, shortRefFor } from "@rudderhq/shared";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { projectRoutes } from "../routes/projects.js";
import { projectService } from "../services/projects.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// This suite deliberately fails when its real native prerequisite is absent.
// From the repository root:
// cargo build --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --bin rudder-server-foundation
// pnpm exec vitest run --root server --config vitest.config.ts src/__tests__/project-read-real-entry.test.ts
// RUDDER_SERVER_FOUNDATION_PATH may select an already built candidate binary.
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
  initdbFlags: string[];
  onLog: () => void;
  onError: () => void;
}) => EmbeddedPostgresInstance;
type ProjectRead = Awaited<ReturnType<ReturnType<typeof projectService>["list"]>>[number];

function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Neither list order nor project_goals join order is a public contract. Keep
// every field and every explicitly ordered nested collection in this oracle.
function canonicalProject(value: ProjectRead) {
  return {
    ...wire(value),
    goalIds: [...value.goalIds].sort(),
    goals: [...value.goals].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function canonicalList(values: ProjectRead[]) {
  return values.map(canonicalProject).sort((left, right) => left.id.localeCompare(right.id));
}

function filesystemSnapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        entries[relative] = "directory";
        visit(absolute);
      } else if (stat.isSymbolicLink()) {
        entries[relative] = `symlink:${fs.readlinkSync(absolute)}`;
      } else {
        entries[relative] = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
      }
    }
  }
  visit(root);
  return entries;
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
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe("Project reads through real public HTTP, Rust and PostgreSQL", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let database: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let home = "";
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let connectionString = "";
  let nativeBinary = "";
  let expected: ProjectRead[];
  let expectedVolume: ProjectRead[];
  let baselineDatabase: unknown;
  let baselineFilesystem: Record<string, string>;
  let rustProjectId = "";
  const originalHome = process.env.RUDDER_HOME;
  const originalInstance = process.env.RUDDER_INSTANCE_ID;
  const originalWorkspaceHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const emptyOrgId = randomUUID();
  const volumeOrgId = randomUUID();
  const volumeProjectIds = Array.from({ length: 80 }, () => randomUUID());
  const agentId = randomUUID();
  const oldProjectId = "11111111-1111-4111-8111-111111111111";
  const bareProjectId = "22222222-2222-4222-8222-222222222222";
  const foreignProjectId = "33333333-3333-4333-8333-333333333333";
  const ambiguousIds = ["44444444-1111-4111-8111-111111111111", "44444444-2222-4222-8222-222222222222"];
  const goalIds = [randomUUID(), randomUUID()];
  const workspaceIds = [randomUUID(), randomUUID()];
  const serviceIds = [randomUUID(), randomUUID()];
  const resourceIds = [randomUUID(), randomUUID()];
  const agentToken = `project-read-agent-${randomUUID()}`;
  const boardToken = `project-read-board-${randomUUID()}`;
  const boardUserId = `project-read-user-${randomUUID()}`;
  const early = new Date("2024-02-29T12:34:56.123+08:00");
  const later = new Date("2024-03-01T01:02:03.456-07:00");
  // Keep this as raw JSON text: constructing a JavaScript object first would
  // already round integers and stringify overflow to null before PostgreSQL.
  const legacyNumericJson = `{
    "overflow": [1e400, -1e400],
    "unsafeInteger": 9007199254740993,
    "underflow": [1e-400, -1e-400],
    "finite": {
      "precisionSensitive": 1.0790143258645723e-180,
      "maximum": 1.7976931348623157e308,
      "subnormal": 5e-324,
      "roundedDecimal": 0.84551240822557006
    },
    "nested": {
      "array": [9007199254740993, {"positive": 1e400, "negative": -1e400, "tiny": 1e-400}],
      "strings": ["1e400", "-1e400", "9007199254740993", "1e-400", "-1e-400", "1.0790143258645723e-180", "1.7976931348623157e308", "5e-324", "0.84551240822557006"]
    }
  }`;
  const expectedLegacyNumbers = {
    overflow: [null, null],
    unsafeInteger: 9007199254740992,
    underflow: [0, 0],
    finite: {
      precisionSensitive: 1.0790143258645723e-180,
      maximum: 1.7976931348623157e308,
      subnormal: 5e-324,
      roundedDecimal: 0.8455124082255701,
    },
    nested: {
      array: [9007199254740992, { positive: null, negative: null, tiny: 0 }],
      strings: ["1e400", "-1e400", "9007199254740993", "1e-400", "-1e-400", "1.0790143258645723e-180", "1.7976931348623157e308", "5e-324", "0.84551240822557006"],
    },
  };

  function expectLegacyNumericFields(project: ProjectRead) {
    expect(project.executionWorkspacePolicy?.runtimePolicy?.legacyNumbers).toEqual(expectedLegacyNumbers);
    expect(project.resources.find((attachment) => attachment.resourceId === resourceIds[1])
      ?.resource.metadata?.legacyNumbers).toEqual(expectedLegacyNumbers);
    const workspace = project.workspaces.find((row) => row.id === workspaceIds[1]);
    expect(workspace?.metadata?.legacyNumbers).toEqual(expectedLegacyNumbers);
    expect(workspace?.runtimeServices?.find((service) => service.id === serviceIds[0])
      ?.stopPolicy?.legacyNumbers).toEqual(expectedLegacyNumbers);
  }

  async function startApp(selectedBridge?: RustFoundationBridge) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db!, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api", projectRoutes(db!, selectedBridge));
    app.use(errorHandler);
    const result = app.listen(0, "127.0.0.1");
    await once(result, "listening");
    return result;
  }

  function get(url: string, token = agentToken, target = server!) {
    return request(target).get(url).set("authorization", `Bearer ${token}`);
  }

  async function databaseSnapshot() {
    // Authentication intentionally touches API-key lastUsedAt. Domain rows,
    // ownership/fence state, receipts, audit, outbox and runtime provisioning
    // must all remain byte-for-byte unchanged by Project reads.
    const tables = [
      "projects", "project_goals", "project_workspaces", "workspace_runtime_services",
      "execution_workspaces", "organization_resources", "project_resource_attachments",
      "organization_mutation_state", "project_goal_mutation_state",
      "organization_mutation_receipts", "organization_mutation_outbox", "activity_log",
    ];
    const snapshots: Record<string, unknown> = {};
    for (const table of tables) {
      const rows = await db!.execute(sql.raw(
        // Preserve PostgreSQL numeric text so a read-side rewrite cannot hide
        // behind JavaScript's own overflow/precision normalization.
        `SELECT coalesce(jsonb_agg(to_jsonb(snapshot) ORDER BY to_jsonb(snapshot)::text), '[]'::jsonb)::text AS value FROM "${table}" AS snapshot`,
      ));
      snapshots[table] = rows[0]?.value;
    }
    return snapshots;
  }

  async function expectReadOnly() {
    expect(await databaseSnapshot()).toEqual(baselineDatabase);
    expect(filesystemSnapshot(home)).toEqual(baselineFilesystem);
    expect(fs.existsSync(resolveOrganizationWorkspaceRoot(orgId))).toBe(false);
  }

  beforeAll(async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const targetRoot = path.resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "native/target");
    const explicitBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicitBinary
      ? [explicitBinary]
      : [path.join(targetRoot, "debug", binaryName), path.join(targetRoot, "release", binaryName)];
    nativeBinary = candidates.find((candidate) => {
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? candidates[0]!;
    try {
      fs.accessSync(nativeBinary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    } catch {
      throw new Error(`Real Project-read integration requires a built foundation binary at ${nativeBinary}. Run cargo build --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --bin rudder-server-foundation, or set RUDDER_SERVER_FOUNDATION_PATH.`);
    }
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-project-read-home-"));
    process.env.RUDDER_HOME = home;
    process.env.RUDDER_INSTANCE_ID = "project-read-test";
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-project-read-postgres-"));
    const port = await getAvailablePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({
      databaseDir: dataDir, user: "rudder", password: "rudder", port, persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {},
    });
    await database.initialise();
    await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    // Both new Node and Rust connections must use a non-UTC database default;
    // wire dates still match JavaScript Date.toJSON millisecond UTC output.
    await db.execute(sql`ALTER DATABASE rudder SET timezone TO 'Pacific/Honolulu'`);
    await db.$client.end({ timeout: 5 });
    db = createDb(connectionString);
    const timezone = await db.execute(sql`SELECT current_setting('TimeZone') AS timezone`);
    expect(timezone[0]?.timezone).toBe("Pacific/Honolulu");
    await db.insert(organizations).values([
      { id: orgId, name: "Read parity", urlKey: deriveOrganizationUrlKey("Read parity"), issuePrefix: "RDP" },
      { id: foreignOrgId, name: "Foreign org", urlKey: deriveOrganizationUrlKey("Foreign org"), issuePrefix: "FRN" },
      { id: emptyOrgId, name: "Empty org", urlKey: deriveOrganizationUrlKey("Empty org"), issuePrefix: "EMP" },
      { id: volumeOrgId, name: "Volume org", urlKey: deriveOrganizationUrlKey("Volume org"), issuePrefix: "VOL" },
    ]);
    await db.insert(organizationMutationState).values([{ orgId }, { orgId: foreignOrgId }, { orgId: emptyOrgId }, { orgId: volumeOrgId }]).onConflictDoNothing();
    await db.insert(agents).values({ id: agentId, orgId, name: "Reader", role: "general", status: "idle" });
    await db.insert(agentApiKeys).values({ orgId, agentId, name: "Read test", keyHash: createHash("sha256").update(agentToken).digest("hex") });
    await db.insert(authUsers).values({ id: boardUserId, name: "Read operator", email: "read-test@example.test", createdAt: early, updatedAt: later });
    await db.insert(organizationMemberships).values([orgId, emptyOrgId, volumeOrgId].map((id) => ({ orgId: id, principalType: "user", principalId: boardUserId, status: "active", membershipRole: "member" })));
    await db.insert(boardApiKeys).values({ userId: boardUserId, name: "Read test", keyHash: createHash("sha256").update(boardToken).digest("hex") });
    await db.insert(goals).values(goalIds.map((id, index) => ({ id, orgId, title: `Linked goal ${index}`, createdAt: early, updatedAt: later })));
    await db.insert(projects).values([
      {
        id: oldProjectId, orgId, name: "Old Project", description: "Legacy \u2603 project", status: "paused",
        goalId: goalIds[1], leadAgentId: agentId, targetDate: "2024-02-29", color: "#ABCDEF", icon: null,
        pauseReason: "Awaiting review", pausedAt: early, archivedAt: later, createdAt: early, updatedAt: later,
        executionWorkspacePolicy: {
          enabled: true, defaultMode: "isolated", allowIssueOverride: false,
          defaultProjectWorkspaceId: workspaceIds[1],
          workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "work/{id}", ignored: "legacy" },
          workspaceRuntime: { services: [{ name: "preview", command: "must-not-be-started" }] },
          branchPolicy: { prefix: "work" }, pullRequestPolicy: { draft: true },
          runtimePolicy: { reuse: true }, cleanupPolicy: { days: 3 }, ignored: "legacy",
        },
      },
      // A legacy primary goal without join rows must stay distinct from goalIds.
      { id: bareProjectId, orgId, name: "Bare Project", goalId: goalIds[0], createdAt: early, updatedAt: later },
      { id: foreignProjectId, orgId: foreignOrgId, name: "Old Project", createdAt: early, updatedAt: later },
      ...ambiguousIds.map((id, index) => ({ id, orgId, name: index ? "Collision-Name" : "Collision Name", createdAt: early, updatedAt: later })),
    ]);
    await db.insert(projects).values(volumeProjectIds.map((id, index) => ({
      id, orgId: volumeOrgId, name: `Volume project ${index}`, description: `Project ${index}: ${"x".repeat(4096)}`,
      createdAt: early, updatedAt: later,
    })));
    await db.insert(projectGoalMutationState).values({ projectId: oldProjectId, orgId, owner: "node" }).onConflictDoNothing();
    await db.insert(projectGoals).values(goalIds.map((goalId) => ({ projectId: oldProjectId, orgId, goalId, createdAt: early, updatedAt: later })));
    await db.insert(organizationResources).values([
      { id: resourceIds[0], orgId, name: "Reference", kind: "url", sourceType: "external", locator: "https://example.test/reference", description: null, metadata: null, createdAt: early, updatedAt: later },
      { id: resourceIds[1], orgId, name: "Code", kind: "url", sourceType: "external", locator: "https://example.test/repo.git", description: "Source", metadata: { ref: "main", nullable: null }, createdAt: early, updatedAt: later },
    ]);
    await db.insert(projectResourceAttachments).values([
      { orgId, projectId: oldProjectId, resourceId: resourceIds[0], role: "reference", note: null, sortOrder: 7, isPrimary: false, createdAt: early, updatedAt: later },
      { orgId, projectId: oldProjectId, resourceId: resourceIds[1], role: "working_set", note: "Primary source", sortOrder: 2, isPrimary: true, createdAt: early, updatedAt: later },
    ]);
    await db.insert(projectWorkspaces).values([
      { id: workspaceIds[0], orgId, projectId: oldProjectId, name: "Older local workspace", sourceType: "local_path", cwd: "  /tmp/legacy-project  ", isPrimary: false, createdAt: early, updatedAt: early },
      { id: workspaceIds[1], orgId, projectId: oldProjectId, name: "Primary repository", sourceType: "git_repo", cwd: "/__paperclip_repo_only__", repoUrl: "https://example.test/repo.git", repoRef: "main", defaultRef: null, visibility: "advanced", setupCommand: "must-not-be-started", cleanupCommand: "must-not-be-started", remoteProvider: "legacy", remoteWorkspaceRef: "workspace-1", sharedWorkspaceKey: "shared", metadata: { nested: { nullable: null } }, isPrimary: true, createdAt: later, updatedAt: later },
    ]);
    await db.insert(workspaceRuntimeServices).values([
      { id: serviceIds[0], orgId, projectId: oldProjectId, projectWorkspaceId: workspaceIds[1], scopeType: "project_workspace", scopeId: workspaceIds[1], serviceName: "preview", status: "running", lifecycle: "persistent", reuseKey: "preview-key", command: "must-not-be-started", cwd: "/tmp/legacy-project", port: 3100, url: "http://127.0.0.1:3100", provider: "local_process", providerRef: "legacy-process", ownerAgentId: agentId, lastUsedAt: later, startedAt: early, stopPolicy: { timeout: 5 }, healthStatus: "healthy", createdAt: early, updatedAt: later },
      { id: serviceIds[1], orgId, projectId: oldProjectId, projectWorkspaceId: workspaceIds[1], scopeType: "project_workspace", serviceName: "stopped", status: "stopped", lifecycle: "ephemeral", provider: "local_process", lastUsedAt: early, startedAt: early, stoppedAt: later, healthStatus: "unknown", createdAt: early, updatedAt: early },
    ]);
    bridge = createRustFoundationBridge({ databaseUrl: connectionString, binaryPath: nativeBinary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "required", requestTimeoutMs: 10_000 });
    await bridge.start();
    server = await startApp(bridge);
    const created = await request(server).post(`/api/orgs/${orgId}/projects`)
      .set("authorization", `Bearer ${agentToken}`)
      .set("x-rudder-idempotency-key", "project-read-rust-create")
      .send({ name: "New Rust Project", status: "planned", goalIds, description: null });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rustProjectId = created.body.id as string;
    const ownership = await db.select().from(projectGoalMutationState);
    expect(ownership.find((row) => row.projectId === oldProjectId)?.owner).toBe("node");
    expect(ownership.find((row) => row.projectId === rustProjectId)?.owner).toBe("rust");

    // Historical JSONB can contain valid PostgreSQL numbers outside IEEE 754.
    // The public Node contract parses them as Number, then JSON-serializes them.
    // Seed these literals only after creation, before capturing that oracle.
    await db.execute(sql`
      UPDATE projects SET execution_workspace_policy = jsonb_set(
        execution_workspace_policy, '{runtimePolicy,legacyNumbers}', ${legacyNumericJson}::jsonb
      ) WHERE id = ${oldProjectId}::uuid
    `);
    await db.execute(sql`
      UPDATE organization_resources SET metadata = jsonb_set(
        metadata, '{legacyNumbers}', ${legacyNumericJson}::jsonb
      ) WHERE id = ${resourceIds[1]}::uuid
    `);
    await db.execute(sql`
      UPDATE project_workspaces SET metadata = jsonb_set(
        metadata, '{legacyNumbers}', ${legacyNumericJson}::jsonb
      ) WHERE id = ${workspaceIds[1]}::uuid
    `);
    await db.execute(sql`
      UPDATE workspace_runtime_services SET stop_policy = jsonb_set(
        stop_policy, '{legacyNumbers}', ${legacyNumericJson}::jsonb
      ) WHERE id = ${serviceIds[0]}::uuid
    `);

    // The retained Node implementation is an independent response oracle. It
    // still repairs Library directories, so capture it before the read-only
    // boundary and remove only this test's disposable organization workspace.
    expected = wire(await projectService(db).list(orgId));
    expectLegacyNumericFields(expected.find((project) => project.id === oldProjectId)!);
    expectedVolume = wire(await projectService(db).list(volumeOrgId));
    for (const id of [orgId, volumeOrgId]) {
      const root = resolveOrganizationWorkspaceRoot(id);
      if (!root.startsWith(`${home}${path.sep}`)) throw new Error("Test workspace escaped its disposable home");
      fs.rmSync(root, { recursive: true, force: true });
    }
    baselineDatabase = await databaseSnapshot();
    baselineFilesystem = filesystemSnapshot(home);
    await closeServer(server);
    server = undefined;
    await bridge.close();
    // All three mutation/member switches off must still support all reads.
    bridge = createRustFoundationBridge({ databaseUrl: connectionString, binaryPath: nativeBinary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10_000 });
    server = await startApp(bridge);
  }, 60_000);

  afterAll(async () => {
    try {
      await closeServer(server);
      await bridge?.close();
      await db?.$client.end({ timeout: 5 });
      await database?.stop();
    } finally {
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
      if (home) fs.rmSync(home, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = originalHome;
      if (originalInstance === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = originalInstance;
      if (originalWorkspaceHome === undefined) delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
      else process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalWorkspaceHome;
    }
  }, 20_000);

  it("returns complete Node-contract parity for old Node-owned and new Rust-created projects without writes", async () => {
    const list = await get(`/api/orgs/${orgId}/projects`);
    expect(list.status).toBe(200);
    expect(canonicalList(list.body as ProjectRead[])).toEqual(canonicalList(expected));
    expect((list.body as ProjectRead[]).map((project) => project.id)).not.toContain(foreignProjectId);
    for (const project of expected) {
      const detail = await get(`/api/projects/${project.id}`);
      expect(detail.status).toBe(200);
      expect(canonicalProject(detail.body as ProjectRead)).toEqual(canonicalProject(project));
      if (project.id === oldProjectId) expectLegacyNumericFields(detail.body as ProjectRead);
      const resources = await get(`/api/projects/${project.id}/resources`);
      expect(resources.status).toBe(200);
      expect(resources.body).toEqual(project.resources);
      if (project.id === oldProjectId) {
        const attachment = (resources.body as ProjectRead["resources"])
          .find((row) => row.resourceId === resourceIds[1]);
        expect(attachment?.resource.metadata?.legacyNumbers).toEqual(expectedLegacyNumbers);
      }
    }
    const empty = await get(`/api/orgs/${emptyOrgId}/projects`, boardToken);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
    expect(fs.existsSync(resolveOrganizationWorkspaceRoot(emptyOrgId))).toBe(false);
    const old = list.body.find((project: ProjectRead) => project.id === oldProjectId);
    expectLegacyNumericFields(old as ProjectRead);
    expect(old.createdAt).toBe("2024-02-29T04:34:56.123Z");
    expect(old.updatedAt).toBe("2024-03-01T08:02:03.456Z");
    expect(old.targetDate).toBe("2024-02-29");
    expect(old.icon).toBe(DEFAULT_PROJECT_ICON);
    expect(old.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([workspaceIds[1], workspaceIds[0]]);
    expect(old.primaryWorkspace).toEqual(old.workspaces[0]);
    expect(old.primaryWorkspace.cwd).toBeNull();
    expect(old.primaryWorkspace.defaultRef).toBe("main");
    expect(old.primaryWorkspace.runtimeServices.map((service: { id: string }) => service.id)).toEqual(serviceIds);
    expect(old.resources.map((attachment: { resourceId: string }) => attachment.resourceId)).toEqual([resourceIds[1], resourceIds[0]]);
    const bare = list.body.find((project: ProjectRead) => project.id === bareProjectId);
    expect(bare).toMatchObject({ goalId: goalIds[0], goalIds: [], goals: [], description: null, leadAgentId: null, targetDate: null, color: null, pauseReason: null, pausedAt: null, executionWorkspacePolicy: null, archivedAt: null, resources: [], workspaces: [], primaryWorkspace: null });
    const newlyCreated = list.body.find((project: ProjectRead) => project.id === rustProjectId);
    expect(newlyCreated.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await expectReadOnly();
  }, 20_000);

  it("returns the complete legacy list above the generic native response cap", async () => {
    // Foundation's generic bounded response default is 256 KiB. Project lists
    // have never had that cap, so this fixture must remain complete above it.
    expect(Buffer.byteLength(JSON.stringify(expectedVolume))).toBeGreaterThan(256 * 1024);
    const response = await get(`/api/orgs/${volumeOrgId}/projects`, boardToken);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(volumeProjectIds.length);
    expect(canonicalList(response.body as ProjectRead[])).toEqual(canonicalList(expectedVolume));
    expect(fs.existsSync(resolveOrganizationWorkspaceRoot(volumeOrgId))).toBe(false);
    await expectReadOnly();
  }, 20_000);

  it("preserves implicit and explicit organization-scoped aliases, ambiguity, missing IDs and access denial", async () => {
    const old = expected.find((project) => project.id === oldProjectId)!;
    for (const alias of [old.urlKey, shortRefFor("project", oldProjectId)]) {
      for (const suffix of ["", "/resources"]) {
        const implicit = await get(`/api/projects/${alias}${suffix}`);
        const scoped = await get(`/api/projects/${alias}${suffix}?orgId=${orgId}`, boardToken);
        expect(implicit.status).toBe(200);
        expect(scoped.status).toBe(200);
        if (suffix) {
          expect(implicit.body).toEqual(old.resources);
          expect(scoped.body).toEqual(old.resources);
        } else {
          expect(canonicalProject(implicit.body as ProjectRead)).toEqual(canonicalProject(old));
          expect(canonicalProject(scoped.body as ProjectRead)).toEqual(canonicalProject(old));
        }
      }
    }
    for (const suffix of ["", "/resources"]) {
      for (const alias of ["collision-name", shortRefFor("project", ambiguousIds[0]!)]) {
        const ambiguous = await get(`/api/projects/${alias}${suffix}`);
        expect(ambiguous.status).toBe(409);
        expect(ambiguous.body.error).toContain("ambiguous");
      }
      for (const missing of [randomUUID(), "does-not-exist"]) {
        const response = await get(`/api/projects/${missing}${suffix}`);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "Project not found" });
      }
      expect((await get(`/api/projects/${foreignProjectId}${suffix}`)).status).toBe(403);
      expect((await get(`/api/projects/old-project${suffix}?orgId=${foreignOrgId}`)).status).toBe(403);
      expect((await get(`/api/projects/${foreignProjectId}${suffix}`, boardToken)).status).toBe(403);
      expect((await request(server!).get(`/api/projects/${oldProjectId}${suffix}`)).status).toBe(401);
    }
    expect((await get(`/api/orgs/${foreignOrgId}/projects`)).status).toBe(403);
    expect((await get(`/api/orgs/${foreignOrgId}/projects`, boardToken)).status).toBe(403);
    expect((await request(server!).get(`/api/orgs/${orgId}/projects`)).status).toBe(401);
    await expectReadOnly();
  }, 20_000);

  it("filters corrupt cross-organization associations without exposing foreign data or repairing rows", async () => {
    const foreignGoalId = randomUUID();
    const foreignResourceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const foreignServiceId = randomUUID();
    const attachmentIds = [randomUUID(), randomUUID()];
    try {
      // Legacy independent foreign keys permit these malformed associations.
      // Do not use the legacy Node oracle for this intentionally corrupt data:
      // organization isolation takes precedence over its unscoped old joins.
      await db!.insert(goals).values({ id: foreignGoalId, orgId: foreignOrgId, title: "FOREIGN_GOAL_MUST_NOT_LEAK" });
      await db!.insert(projectGoals).values([
        { orgId, projectId: bareProjectId, goalId: foreignGoalId },
        { orgId: foreignOrgId, projectId: bareProjectId, goalId: goalIds[1]! },
      ]);
      await db!.insert(organizationResources).values({ id: foreignResourceId, orgId: foreignOrgId, name: "FOREIGN_RESOURCE_MUST_NOT_LEAK", kind: "url", locator: "https://example.test/foreign" });
      await db!.insert(projectResourceAttachments).values([
        { id: attachmentIds[0], orgId, projectId: bareProjectId, resourceId: foreignResourceId },
        { id: attachmentIds[1], orgId: foreignOrgId, projectId: bareProjectId, resourceId: resourceIds[0]! },
      ]);
      await db!.insert(projectWorkspaces).values({ id: foreignWorkspaceId, orgId: foreignOrgId, projectId: bareProjectId, name: "FOREIGN_WORKSPACE_MUST_NOT_LEAK", cwd: "/tmp/foreign" });
      await db!.insert(workspaceRuntimeServices).values({ id: foreignServiceId, orgId: foreignOrgId, projectId: foreignProjectId, projectWorkspaceId: workspaceIds[1], scopeType: "project_workspace", serviceName: "FOREIGN_SERVICE_MUST_NOT_LEAK", status: "running", lifecycle: "persistent", provider: "local_process" });
      const corruptSnapshot = await databaseSnapshot();
      const list = await get(`/api/orgs/${orgId}/projects`);
      expect(list.status).toBe(200);
      expect(canonicalList(list.body as ProjectRead[])).toEqual(canonicalList(expected));
      expect(JSON.stringify(list.body)).not.toContain("MUST_NOT_LEAK");
      for (const id of [bareProjectId, oldProjectId]) {
        const detail = await get(`/api/projects/${id}`);
        const original = expected.find((project) => project.id === id)!;
        expect(detail.status).toBe(200);
        expect(canonicalProject(detail.body as ProjectRead)).toEqual(canonicalProject(original));
        const resources = await get(`/api/projects/${id}/resources`);
        expect(resources.status).toBe(200);
        expect(resources.body).toEqual(original.resources);
      }
      expect(await databaseSnapshot()).toEqual(corruptSnapshot);
      expect(filesystemSnapshot(home)).toEqual(baselineFilesystem);
    } finally {
      await db!.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, foreignServiceId));
      await db!.delete(projectWorkspaces).where(eq(projectWorkspaces.id, foreignWorkspaceId));
      for (const id of attachmentIds) await db!.delete(projectResourceAttachments).where(eq(projectResourceAttachments.id, id));
      await db!.delete(projectGoals).where(eq(projectGoals.projectId, bareProjectId));
      await db!.delete(organizationResources).where(eq(organizationResources.id, foreignResourceId));
      await db!.delete(goals).where(eq(goals.id, foreignGoalId));
    }
    await expectReadOnly();
  }, 20_000);

  it("does not fall back to Node when the native process is unavailable", async () => {
    const unavailable = createRustFoundationBridge({
      databaseUrl: connectionString,
      binaryPath: path.join(home, "foundation-does-not-exist"),
      mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off",
    });
    const failingServer = await startApp(unavailable);
    try {
      for (const url of [`/api/orgs/${orgId}/projects`, `/api/projects/${oldProjectId}`, `/api/projects/${oldProjectId}/resources`]) {
        const response = await get(url, agentToken, failingServer);
        expect(response.status).toBe(503);
        expect(response.body.code).toBe("rust_foundation_project_read_request_failed");
      }
      await expectReadOnly();
    } finally {
      await closeServer(failingServer);
      await unavailable.close();
    }
  });
});
