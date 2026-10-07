import {
  activityLog,
  agentApiKeys,
  agents,
  applyPendingMigrations,
  assets,
  authUsers,
  boardApiKeys,
  createDb,
  ensurePostgresDatabase,
  goals,
  organizationBrandingMutationReceipts,
  organizationBrandingMutationState,
  organizationLogos,
  organizationMemberships,
  organizationMutationOutbox,
  organizationMutationReceipts,
  organizationMutationState,
  organizations,
  projectGoalMutationState,
  projectGoals,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { asc, eq, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organizationRoutes } from "../routes/orgs.js";
import { projectRoutes } from "../routes/projects.js";
import { handoffOrganizationBrandingAuthority } from "../services/organization-branding-fence.js";
import { organizationService } from "../services/orgs.js";
import { handoffProjectGoalMutationAuthority } from "../services/project-goal-mutation-fence.js";
import { projectService } from "../services/projects.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// The handoff race cases exercise real PostgreSQL Node writers; the authenticated
// Project-create case also crosses the real Rust Foundation bridge and SQLx store.
type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags: string[];
  onLog: () => void;
  onError: () => void;
}) => EmbeddedPostgresInstance;
type AdvisoryKey = { first: number; second: number };
type RaceResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(description: string, predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("D1 authenticated Project Rust writes and ownership-handoff races on real PostgreSQL", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let postgresInstance: EmbeddedPostgresInstance | undefined;
  let postgresStarted = false;
  let dataDir = "";
  let connectionString = "";
  let observer: ReturnType<typeof postgres> | undefined;
  let advisoryLockHolder: ReturnType<typeof postgres> | undefined;
  let server: Server | undefined;
  let rustFoundationBridge: RustFoundationBridge | undefined;

  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const projectId = randomUUID();
  const firstGoalId = randomUUID();
  const replacementGoalId = randomUUID();
  const foreignGoalId = randomUUID();
  const firstLogoAssetId = randomUUID();
  const committedLogoAssetId = randomUUID();
  const staleLogoAssetId = randomUUID();
  const boardUserId = `d1-handoff-user-${randomUUID()}`;
  const boardToken = `d1-handoff-board-${randomUUID()}`;
  const foreignAgentId = randomUUID();
  const foreignAgentToken = `d1-handoff-agent-${randomUUID()}`;
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
  const originalOrganizationWorkspaceHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-d1-write-handoff-postgres-"));
    process.env.RUDDER_HOME = path.join(dataDir, "rudder-home");
    process.env.RUDDER_INSTANCE_ID = `d1-rust-project-resource-${randomUUID()}`;
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    const port = await getAvailablePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    postgresInstance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {},
    });
    await postgresInstance.initialise();
    await postgresInstance.start();
    postgresStarted = true;

    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    observer = postgres(connectionString, { max: 1, onnotice: () => {} });
    advisoryLockHolder = postgres(connectionString, { max: 1, onnotice: () => {} });

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "D1 Handoff Target",
        urlKey: deriveOrganizationUrlKey(`D1 Handoff Target ${orgId}`),
        issuePrefix: `DH${orgId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      },
      {
        id: foreignOrgId,
        name: "D1 Handoff Foreign",
        urlKey: deriveOrganizationUrlKey(`D1 Handoff Foreign ${foreignOrgId}`),
        issuePrefix: `DF${foreignOrgId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      },
    ]);
    await db.insert(organizationMutationState).values([{ orgId }, { orgId: foreignOrgId }]).onConflictDoNothing();
    await db.insert(organizationBrandingMutationState)
      .values([{ orgId }, { orgId: foreignOrgId }])
      .onConflictDoNothing();

    await db.insert(assets).values([
      {
        id: firstLogoAssetId,
        orgId,
        provider: "test",
        objectKey: `logo/${firstLogoAssetId}`,
        contentType: "image/png",
        byteSize: 1,
        sha256: "a".repeat(64),
      },
      {
        id: committedLogoAssetId,
        orgId,
        provider: "test",
        objectKey: `logo/${committedLogoAssetId}`,
        contentType: "image/png",
        byteSize: 1,
        sha256: "b".repeat(64),
      },
      {
        id: staleLogoAssetId,
        orgId,
        provider: "test",
        objectKey: `logo/${staleLogoAssetId}`,
        contentType: "image/png",
        byteSize: 1,
        sha256: "c".repeat(64),
      },
    ]);
    await db.insert(organizationLogos).values({ orgId, assetId: firstLogoAssetId });

    await db.insert(goals).values([
      { id: firstGoalId, orgId, title: "Initial goal" },
      { id: replacementGoalId, orgId, title: "Replacement goal" },
      { id: foreignGoalId, orgId: foreignOrgId, title: "Foreign goal" },
    ]);
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "D1 Handoff Project",
      goalId: firstGoalId,
    });
    await db.insert(projectGoals).values({ projectId, orgId, goalId: firstGoalId });
    await db.insert(projectGoalMutationState).values({ projectId, orgId }).onConflictDoNothing();

    await db.insert(authUsers).values({
      id: boardUserId,
      name: "D1 Handoff Board User",
      email: `${boardUserId}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organizationMemberships).values({
      orgId,
      principalType: "user",
      principalId: boardUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(boardApiKeys).values({
      userId: boardUserId,
      name: "D1 handoff integration key",
      keyHash: createHash("sha256").update(boardToken).digest("hex"),
    });
    await db.insert(agents).values({
      id: foreignAgentId,
      orgId: foreignOrgId,
      name: "Foreign CEO",
      role: "ceo",
      status: "idle",
    });
    await db.insert(agentApiKeys).values({
      orgId: foreignOrgId,
      agentId: foreignAgentId,
      name: "Foreign organization key",
      keyHash: createHash("sha256").update(foreignAgentToken).digest("hex"),
    });

    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const targetRoot = path.resolve(process.cwd(), process.env.CARGO_TARGET_DIR ?? "native/target");
    const configuredBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const binaryCandidates = configuredBinary
      ? [configuredBinary]
      : [path.join(targetRoot, "debug", binaryName), path.join(targetRoot, "release", binaryName)];
    const nativeBinary = binaryCandidates.find((candidate) => {
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!nativeBinary) {
      throw new Error(`Real Rust Project-resource test requires ${binaryName}; build rudder-server-foundation or set RUDDER_SERVER_FOUNDATION_PATH`);
    }
    rustFoundationBridge = createRustFoundationBridge({
      databaseUrl: connectionString,
      binaryPath: nativeBinary,
      mode: "off",
      projectGoalSetMode: "required",
    });
    await rustFoundationBridge.start();

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api/orgs", organizationRoutes(db, undefined, undefined, rustFoundationBridge));
    app.use("/api", projectRoutes(db, rustFoundationBridge));
    app.use(errorHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
        server!.closeAllConnections();
      });
    }
    await rustFoundationBridge?.close();
    await advisoryLockHolder?.end({ timeout: 5 });
    await observer?.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    if (postgresStarted) await postgresInstance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
    if (originalOrganizationWorkspaceHome === undefined) delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    else process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalOrganizationWorkspaceHome;
  });

  function patchBranding(assetId: string, token = boardToken) {
    return request(server!)
      .patch(`/api/orgs/${orgId}/branding`)
      .set("authorization", `Bearer ${token}`)
      .send({ logoAssetId: assetId });
  }

  function patchProject(body: Record<string, unknown>, token = boardToken) {
    return request(server!)
      .patch(`/api/projects/${projectId}`)
      .set("authorization", `Bearer ${token}`)
      .send(body);
  }

  async function installUpdateGate(table: "organizations" | "projects", rowId: string, key: AdvisoryKey) {
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `rudder_test_d1_gate_${suffix}`;
    const triggerName = `rudder_test_d1_gate_trigger_${suffix}`;
    await db!.execute(sql.raw(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${rowId}'::uuid THEN
          PERFORM pg_advisory_xact_lock(${key.first}, ${key.second});
        END IF;
        RETURN NEW;
      END;
      $$
    `));
    await db!.execute(sql.raw(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `));
    return async () => {
      await db!.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`));
      await db!.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    };
  }

  async function isWaitingForGate(key: AdvisoryKey) {
    const rows = await observer!`
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks AS held_lock
        JOIN pg_stat_activity AS waiting_backend ON waiting_backend.pid = held_lock.pid
        WHERE held_lock.locktype = 'advisory'
          AND held_lock.classid = ${key.first}::oid
          AND held_lock.objid = ${key.second}::oid
          AND held_lock.objsubid = 2
          AND NOT held_lock.granted
          AND waiting_backend.wait_event_type = 'Lock'
      ) AS waiting
    `;
    return rows[0]?.waiting === true;
  }

  async function isHandoffWaitingOn(table: "organization_branding_mutation_state" | "organization_mutation_state") {
    const rows = await observer!`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE ${`%${table}%`}
      ) AS waiting
    `;
    return rows[0]?.waiting === true;
  }

  async function expectBrandingOwnerRowLocked() {
    await expect(observer!`
      SELECT org_id
      FROM organization_branding_mutation_state
      WHERE org_id = ${orgId}::uuid
      FOR UPDATE NOWAIT
    `).rejects.toMatchObject({ code: "55P03" });
  }

  async function expectProjectGoalOwnerRowLocked() {
    await expect(observer!`
      SELECT project_id
      FROM project_goal_mutation_state
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      FOR UPDATE NOWAIT
    `).rejects.toMatchObject({ code: "55P03" });
  }

  async function serializeWriterBeforeHandoff<T>(input: {
    key: AdvisoryKey;
    startWriter: () => Promise<T>;
    startHandoff: () => Promise<void>;
    expectOwnerRowLocked: () => Promise<void>;
    handoffWaitTable: "organization_branding_mutation_state" | "organization_mutation_state";
    cleanupGate: () => Promise<void>;
  }): Promise<T> {
    let gateHeld = false;
    let writerSettled = false;
    let handoffSettled = false;
    let writerOutcome: Promise<RaceResult<T>> | undefined;
    let handoffOutcome: Promise<RaceResult<void>> | undefined;
    let raceError: unknown;
    try {
      await advisoryLockHolder!`SELECT pg_advisory_lock(${input.key.first}, ${input.key.second})`;
      gateHeld = true;
      writerOutcome = input.startWriter().then(
        (value) => { writerSettled = true; return { ok: true as const, value }; },
        (error: unknown) => { writerSettled = true; return { ok: false as const, error }; },
      );
      await waitFor("the Node business write to wait at its PostgreSQL gate", () => isWaitingForGate(input.key));
      await input.expectOwnerRowLocked();

      handoffOutcome = input.startHandoff().then(
        () => { handoffSettled = true; return { ok: true as const, value: undefined }; },
        (error: unknown) => { handoffSettled = true; return { ok: false as const, error }; },
      );
      await waitFor(`the ownership handoff to wait on ${input.handoffWaitTable}`, () =>
        isHandoffWaitingOn(input.handoffWaitTable));
      expect(writerSettled).toBe(false);
      expect(handoffSettled).toBe(false);
    } catch (error) {
      raceError = error;
    } finally {
      if (gateHeld) {
        await advisoryLockHolder!`SELECT pg_advisory_unlock(${input.key.first}, ${input.key.second})`;
      }
      if (writerOutcome) await writerOutcome;
      if (handoffOutcome) await handoffOutcome;
      await input.cleanupGate();
    }

    if (raceError) throw raceError;
    if (!writerOutcome || !handoffOutcome) throw new Error("The writer/handoff race did not start");
    const [writer, handoff] = await Promise.all([writerOutcome, handoffOutcome]);
    if (!writer.ok) throw writer.error;
    if (!handoff.ok) throw handoff.error;
    return writer.value;
  }

  async function brandingSnapshot() {
    return {
      organization: await db!.select().from(organizations).where(eq(organizations.id, orgId)),
      logos: await db!.select().from(organizationLogos)
        .where(eq(organizationLogos.orgId, orgId))
        .orderBy(asc(organizationLogos.id)),
      assets: await db!.select().from(assets).where(eq(assets.orgId, orgId)).orderBy(asc(assets.id)),
      authority: await db!.select().from(organizationBrandingMutationState)
        .where(eq(organizationBrandingMutationState.orgId, orgId)),
      activities: await db!.select().from(activityLog).where(eq(activityLog.orgId, orgId))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id)),
      brandingReceipts: await db!.select().from(organizationBrandingMutationReceipts)
        .where(eq(organizationBrandingMutationReceipts.orgId, orgId))
        .orderBy(asc(organizationBrandingMutationReceipts.idempotencyKey)),
      mutationReceipts: await db!.select().from(organizationMutationReceipts)
        .where(eq(organizationMutationReceipts.orgId, orgId))
        .orderBy(asc(organizationMutationReceipts.idempotencyKey)),
      outbox: await db!.select().from(organizationMutationOutbox)
        .where(eq(organizationMutationOutbox.orgId, orgId))
        .orderBy(asc(organizationMutationOutbox.id)),
    };
  }

  async function projectSnapshot() {
    return {
      project: await db!.select().from(projects).where(eq(projects.id, projectId)),
      goalLinks: await db!.select().from(projectGoals).where(eq(projectGoals.projectId, projectId))
        .orderBy(asc(projectGoals.goalId)),
      authority: await db!.select().from(projectGoalMutationState)
        .where(eq(projectGoalMutationState.projectId, projectId)),
      organizationFence: await db!.select().from(organizationMutationState)
        .where(eq(organizationMutationState.orgId, orgId)),
      activities: await db!.select().from(activityLog).where(eq(activityLog.orgId, orgId))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id)),
      mutationReceipts: await db!.select().from(organizationMutationReceipts)
        .where(eq(organizationMutationReceipts.orgId, orgId))
        .orderBy(asc(organizationMutationReceipts.idempotencyKey)),
      outbox: await db!.select().from(organizationMutationOutbox)
        .where(eq(organizationMutationOutbox.orgId, orgId))
        .orderBy(asc(organizationMutationOutbox.id)),
    };
  }

  it(
    "serializes logo-only Node writes with branding handoff and rejects stale writes before touching logo data",
    async () => {
      const crossOrganization = await patchBranding(staleLogoAssetId, foreignAgentToken);
      expect(crossOrganization.status).toBe(403);

      const key = { first: 817_221, second: 913_447 };
      const cleanupGate = await installUpdateGate("organizations", orgId, key);
      const response = await serializeWriterBeforeHandoff({
        key,
        startWriter: () => patchBranding(committedLogoAssetId),
        startHandoff: () => handoffOrganizationBrandingAuthority(db!, orgId),
        expectOwnerRowLocked: expectBrandingOwnerRowLocked,
        handoffWaitTable: "organization_branding_mutation_state",
        cleanupGate,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((await db!.select().from(organizationLogos).where(eq(organizationLogos.orgId, orgId)))
        .map((row) => row.assetId)).toEqual([committedLogoAssetId]);
      const [handedOff] = await db!.select().from(organizationBrandingMutationState)
        .where(eq(organizationBrandingMutationState.orgId, orgId));
      expect(handedOff).toMatchObject({ owner: "rust", fenceEpoch: 1n });

      const beforeStaleWrite = await brandingSnapshot();
      const unavailableRustBridge = await request(server!)
        .patch(`/api/orgs/${orgId}/branding`)
        .set("authorization", `Bearer ${boardToken}`)
        .set("x-rudder-idempotency-key", `stale-branding-${randomUUID()}`)
        .send({ logoAssetId: staleLogoAssetId });
      expect(unavailableRustBridge.status).toBe(503);
      expect(unavailableRustBridge.body.error).toContain("Rust organization branding is not enabled");
      expect(await brandingSnapshot()).toEqual(beforeStaleWrite);

      await expect(organizationService(db!).update(orgId, { logoAssetId: staleLogoAssetId }))
        .rejects.toMatchObject({
          status: 409,
          message: "Organization branding mutation authority is owned by Rust",
        });
      expect(await brandingSnapshot()).toEqual(beforeStaleWrite);
    },
    60_000,
  );

  it("serializes complete Project–Goal replacement with handoff and rejects stale clear-all atomically", async () => {
    const foreignGoalWrite = await patchProject({ goalIds: [foreignGoalId] });
    expect(foreignGoalWrite.status).toBe(422);
    const crossOrganization = await patchProject({ goalIds: [replacementGoalId] }, foreignAgentToken);
    expect(crossOrganization.status).toBe(403);

    const key = { first: 817_221, second: 913_448 };
    const cleanupGate = await installUpdateGate("projects", projectId, key);
    // Project-Goal handoff uses the production organization-then-component lock order.
    // It waits on the organization row here; the NOWAIT probe above proves the paused
    // Node transaction also holds the exact component owner row before any Project write.
    const response = await serializeWriterBeforeHandoff({
      key,
      startWriter: () => patchProject({
        name: "Committed before handoff",
        goalIds: [replacementGoalId, firstGoalId],
      }),
      startHandoff: () => handoffProjectGoalMutationAuthority(db!, [projectId]),
      expectOwnerRowLocked: expectProjectGoalOwnerRowLocked,
      handoffWaitTable: "organization_mutation_state",
      cleanupGate,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [committedProject] = await db!.select().from(projects).where(eq(projects.id, projectId));
    expect(committedProject?.goalId).toBe(replacementGoalId);
    expect((await db!.select({ goalId: projectGoals.goalId }).from(projectGoals)
      .where(eq(projectGoals.projectId, projectId)).orderBy(asc(projectGoals.goalId)))
      .map((row) => row.goalId).sort()).toEqual([firstGoalId, replacementGoalId].sort());
    const [handedOff] = await db!.select().from(projectGoalMutationState)
      .where(eq(projectGoalMutationState.projectId, projectId));
    expect(handedOff).toMatchObject({ owner: "rust", fenceEpoch: 1n });

    const beforeStaleWrite = await projectSnapshot();
    await expect(projectService(db!).update(projectId, {
      name: "Stale Node patch must not land",
      goalIds: [],
    })).rejects.toMatchObject({ status: 409, message: "Project goal mutation authority is owned by Rust" });
    expect(await projectSnapshot()).toEqual(beforeStaleWrite);
  }, 60_000);

  it("creates and attaches a Project Resource through authenticated Rust Project creation", async () => {
    const idempotencyKey = `d1-rust-project-resource-${randomUUID()}`;
    const projectInput = {
      name: `D1 Rust Project Resource ${randomUUID()}`,
      newResources: [{
        name: `D1 Rust Resource ${randomUUID()}`,
        kind: "url",
        sourceType: "external",
        locator: `https://example.test/d1-rust-resource/${randomUUID()}`,
        description: "Created and attached by the authenticated Rust Project endpoint",
        metadata: { fixture: "d1-write-handoff-real-entry" },
        role: "reference",
        note: "Created with its Project attachment",
        sortOrder: 1,
        isPrimary: true,
      }],
    };
    const createPath = `/api/orgs/${orgId}/projects`;
    const beforeDeniedWrites = await observer!`
      SELECT
        (SELECT count(*)::text FROM projects WHERE org_id = ${orgId}::uuid) AS projects,
        (SELECT count(*)::text FROM organization_resources WHERE org_id = ${orgId}::uuid) AS resources,
        (SELECT count(*)::text FROM project_resource_attachments WHERE org_id = ${orgId}::uuid) AS attachments,
        (SELECT count(*)::text FROM activity_log WHERE org_id = ${orgId}::uuid) AS activities,
        (SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = ${orgId}::uuid AND idempotency_key = ${idempotencyKey}) AS receipts,
        (SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id = ${orgId}::uuid) AS outbox
    `;

    const missingToken = await request(server!).post(createPath)
      .set("x-rudder-idempotency-key", idempotencyKey)
      .send(projectInput);
    expect(missingToken.status).toBe(401);
    const foreignToken = await request(server!).post(createPath)
      .set("authorization", `Bearer ${foreignAgentToken}`)
      .set("x-rudder-idempotency-key", idempotencyKey)
      .send(projectInput);
    expect(foreignToken.status).toBe(403);
    expect(await observer!`
      SELECT
        (SELECT count(*)::text FROM projects WHERE org_id = ${orgId}::uuid) AS projects,
        (SELECT count(*)::text FROM organization_resources WHERE org_id = ${orgId}::uuid) AS resources,
        (SELECT count(*)::text FROM project_resource_attachments WHERE org_id = ${orgId}::uuid) AS attachments,
        (SELECT count(*)::text FROM activity_log WHERE org_id = ${orgId}::uuid) AS activities,
        (SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = ${orgId}::uuid AND idempotency_key = ${idempotencyKey}) AS receipts,
        (SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id = ${orgId}::uuid) AS outbox
    `).toEqual(beforeDeniedWrites);
    expect(await observer!`
      SELECT idempotency_key FROM organization_mutation_receipts
      WHERE org_id = ${orgId}::uuid AND idempotency_key = ${idempotencyKey}
    `).toEqual([]);

    const created = await request(server!).post(createPath)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", idempotencyKey)
      .send(projectInput);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.orgId).toBe(orgId);

    const persistedResource = await observer!`
      SELECT resource.id::text AS resource_id, attachment.id::text AS attachment_id,
        resource.org_id::text AS org_id, attachment.project_id::text AS project_id,
        resource.name, resource.kind, resource.source_type, resource.locator,
        resource.description, resource.metadata,
        attachment.role, attachment.note,
        attachment.sort_order, attachment.is_primary
      FROM organization_resources AS resource
      JOIN project_resource_attachments AS attachment
        ON attachment.org_id = resource.org_id AND attachment.resource_id = resource.id
      WHERE resource.org_id = ${orgId}::uuid AND attachment.project_id = ${created.body.id}::uuid
    `;
    expect(persistedResource).toHaveLength(1);
    const resource = persistedResource[0]!;
    expect(resource).toMatchObject({
      org_id: orgId,
      project_id: created.body.id,
      name: projectInput.newResources[0]!.name,
      kind: projectInput.newResources[0]!.kind,
      source_type: projectInput.newResources[0]!.sourceType,
      locator: projectInput.newResources[0]!.locator,
      description: projectInput.newResources[0]!.description,
      metadata: projectInput.newResources[0]!.metadata,
      role: "reference",
      note: "Created with its Project attachment",
      sort_order: 1,
      is_primary: true,
    });
    const projectId = String(created.body.id);
    const resourceId = String(resource.resource_id);
    const attachmentId = String(resource.attachment_id);

    async function snapshot() {
      const [projectRows, resourceRows, attachmentRows, allProjectAttachments, allProjectResources, projectOwners, resourceOwners, receipts, activities, outbox] = await Promise.all([
        observer!`SELECT id::text AS id, org_id::text AS org_id, name FROM projects WHERE id = ${projectId}::uuid`,
        observer!`SELECT id::text AS id, org_id::text AS org_id, name, locator FROM organization_resources WHERE id = ${resourceId}::uuid`,
        observer!`SELECT id::text AS id, org_id::text AS org_id, project_id::text AS project_id, resource_id::text AS resource_id, role, note, sort_order, is_primary FROM project_resource_attachments WHERE id = ${attachmentId}::uuid`,
        observer!`SELECT id::text AS id, resource_id::text AS resource_id, role, note, sort_order, is_primary FROM project_resource_attachments WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid ORDER BY sort_order, id`,
        observer!`SELECT resource.id::text AS id, resource.name, resource.kind, resource.source_type, resource.locator, resource.description, resource.metadata FROM project_resource_attachments AS attachment JOIN organization_resources AS resource ON resource.org_id = attachment.org_id AND resource.id = attachment.resource_id WHERE attachment.org_id = ${orgId}::uuid AND attachment.project_id = ${projectId}::uuid ORDER BY attachment.sort_order, resource.id`,
        observer!`SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch FROM project_goal_mutation_state WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid`,
        observer!`SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch FROM organization_resource_mutation_state WHERE org_id = ${orgId}::uuid AND resource_id = ${resourceId}::uuid`,
        observer!`SELECT idempotency_key, command_kind, outcome, activity_id::text AS activity_id FROM organization_mutation_receipts WHERE org_id = ${orgId}::uuid AND idempotency_key = ${idempotencyKey}`,
        observer!`SELECT id::text AS id, action, entity_type, entity_id FROM activity_log WHERE org_id = ${orgId}::uuid AND entity_type = 'project' AND entity_id = ${projectId}`,
        observer!`SELECT outbox.id::text AS id, outbox.activity_id::text AS activity_id, activity.action FROM organization_mutation_outbox AS outbox JOIN activity_log AS activity ON activity.org_id = outbox.org_id AND activity.id = outbox.activity_id WHERE outbox.org_id = ${orgId}::uuid AND activity.entity_type = 'project' AND activity.entity_id = ${projectId}`,
      ]);
      return { projectRows, resourceRows, attachmentRows, allProjectAttachments, allProjectResources, projectOwners, resourceOwners, receipts, activities, outbox };
    }

    const afterCreate = await snapshot();
    expect(afterCreate.projectOwners).toHaveLength(1);
    expect(afterCreate.projectOwners[0]).toMatchObject({ owner: "rust", mutation_version: "1", fence_epoch: "1" });
    expect(afterCreate.resourceOwners).toHaveLength(1);
    expect(afterCreate.resourceOwners[0]).toMatchObject({ owner: "rust", mutation_version: "0", fence_epoch: "1" });
    expect(afterCreate.allProjectAttachments).toHaveLength(1);
    expect(afterCreate.allProjectResources).toEqual([expect.objectContaining({
      id: resourceId,
      name: projectInput.newResources[0]!.name,
      kind: projectInput.newResources[0]!.kind,
      source_type: projectInput.newResources[0]!.sourceType,
      locator: projectInput.newResources[0]!.locator,
      description: projectInput.newResources[0]!.description,
      metadata: projectInput.newResources[0]!.metadata,
    })]);
    expect(afterCreate.receipts).toEqual([expect.objectContaining({
      idempotency_key: idempotencyKey,
      command_kind: "project_create",
      outcome: "applied",
    })]);
    expect(afterCreate.activities).toEqual([expect.objectContaining({
      action: "project.created",
      entity_type: "project",
      entity_id: projectId,
    })]);
    expect(afterCreate.outbox).toEqual([expect.objectContaining({
      activity_id: afterCreate.receipts[0]!.activity_id,
      action: "project.created",
    })]);

    const replay = await request(server!).post(createPath)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", idempotencyKey)
      .send(projectInput);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toEqual(created.body);
    expect(await snapshot()).toEqual(afterCreate);

    const updatedResourceName = `Updated ${projectInput.newResources[0]!.name}`;
    const resourceUpdateKey = `${idempotencyKey}:resource-update`;
    const resourceUpdate = await request(server!).patch(`/api/orgs/${orgId}/resources/${resourceId}`)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", resourceUpdateKey)
      .send({ name: updatedResourceName });
    expect(resourceUpdate.status, JSON.stringify(resourceUpdate.body)).toBe(200);
    expect(resourceUpdate.body).toMatchObject({ id: resourceId, name: updatedResourceName });
    expect(await observer!`
      SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch
      FROM organization_resource_mutation_state WHERE org_id = ${orgId}::uuid AND resource_id = ${resourceId}::uuid
    `).toEqual([{ owner: "rust", mutation_version: "1", fence_epoch: "1" }]);
    const resourceUpdateReceipt = await observer!`
      SELECT command_kind, outcome, resulting_version::text AS resulting_version, activity_id::text AS activity_id
      FROM organization_mutation_receipts WHERE org_id = ${orgId}::uuid AND idempotency_key = ${resourceUpdateKey}
    `;
    expect(resourceUpdateReceipt).toHaveLength(1);
    expect(resourceUpdateReceipt[0]).toMatchObject({ command_kind: "organization_resource", outcome: "applied", resulting_version: "1" });
    const resourceUpdateActivity = await observer!`
      SELECT id::text AS id, action, entity_type, entity_id
      FROM activity_log WHERE org_id = ${orgId}::uuid AND entity_type = 'organization_resource' AND entity_id = ${resourceId}
    `;
    expect(resourceUpdateActivity).toEqual([expect.objectContaining({
      id: resourceUpdateReceipt[0]!.activity_id,
      action: "organization.resource.updated",
      entity_type: "organization_resource",
      entity_id: resourceId,
    })]);
    expect(await observer!`
      SELECT outbox.activity_id::text AS activity_id, activity.action
      FROM organization_mutation_outbox AS outbox
      JOIN activity_log AS activity ON activity.org_id = outbox.org_id AND activity.id = outbox.activity_id
      WHERE outbox.org_id = ${orgId}::uuid AND activity.entity_type = 'organization_resource' AND activity.entity_id = ${resourceId}
    `).toEqual([expect.objectContaining({ activity_id: resourceUpdateReceipt[0]!.activity_id, action: "organization.resource.updated" })]);

    const attachmentUpdateKey = `${idempotencyKey}:attachment-update`;
    const attachmentUpdate = await request(server!).patch(`/api/projects/${projectId}/resources/${attachmentId}`)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", attachmentUpdateKey)
      .send({ note: "Edited through the authenticated Rust-owned Project route" });
    expect(attachmentUpdate.status, JSON.stringify(attachmentUpdate.body)).toBe(200);
    expect(attachmentUpdate.body).toMatchObject({
      id: attachmentId,
      resourceId,
      note: "Edited through the authenticated Rust-owned Project route",
    });
    const afterAttachmentUpdate = await snapshot();
    expect(afterAttachmentUpdate.allProjectAttachments).toEqual([expect.objectContaining({
      id: attachmentId,
      resource_id: resourceId,
      note: "Edited through the authenticated Rust-owned Project route",
    })]);
    expect(afterAttachmentUpdate.allProjectResources).toHaveLength(1);
    const attachmentUpdateReceipt = await observer!`
      SELECT command_kind, outcome, activity_id::text AS activity_id
      FROM organization_mutation_receipts WHERE org_id = ${orgId}::uuid AND idempotency_key = ${attachmentUpdateKey}
    `;
    expect(attachmentUpdateReceipt).toHaveLength(1);
    expect(attachmentUpdateReceipt[0]).toMatchObject({ command_kind: "project_goal_set_replacement", outcome: "applied" });
    expect(await observer!`
      SELECT id::text AS id, action, entity_type, entity_id
      FROM activity_log WHERE org_id = ${orgId}::uuid AND entity_type = 'project_resource_attachment' AND entity_id = ${attachmentId}
      ORDER BY id
    `).toEqual([expect.objectContaining({
      id: attachmentUpdateReceipt[0]!.activity_id,
      action: "project.resource.updated",
      entity_type: "project_resource_attachment",
      entity_id: attachmentId,
    })]);
    expect(await observer!`
      SELECT outbox.activity_id::text AS activity_id, activity.action
      FROM organization_mutation_outbox AS outbox
      JOIN activity_log AS activity ON activity.org_id = outbox.org_id AND activity.id = outbox.activity_id
      WHERE outbox.org_id = ${orgId}::uuid AND activity.entity_type = 'project_resource_attachment' AND activity.entity_id = ${attachmentId}
    `).toEqual([expect.objectContaining({ activity_id: attachmentUpdateReceipt[0]!.activity_id, action: "project.resource.updated" })]);

    const attachmentUpdateReplay = await request(server!).patch(`/api/projects/${projectId}/resources/${attachmentId}`)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", attachmentUpdateKey)
      .send({ note: "Edited through the authenticated Rust-owned Project route" });
    expect(attachmentUpdateReplay.status, JSON.stringify(attachmentUpdateReplay.body)).toBe(200);
    expect(attachmentUpdateReplay.body).toEqual(attachmentUpdate.body);
    expect(await snapshot()).toEqual(afterAttachmentUpdate);

    const attachmentDeleteKey = `${idempotencyKey}:attachment-delete`;
    const attachmentDeletePath = `/api/projects/${projectId}/resources/${attachmentId}`;
    const attachmentDelete = await request(server!).delete(attachmentDeletePath)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", attachmentDeleteKey);
    expect(attachmentDelete.status, JSON.stringify(attachmentDelete.body)).toBe(200);
    expect(attachmentDelete.body).toMatchObject({ id: attachmentId, resourceId });
    const afterAttachmentDelete = await snapshot();
    expect(afterAttachmentDelete.allProjectAttachments).toEqual([]);
    expect(afterAttachmentDelete.allProjectResources).toEqual([]);
    expect(afterAttachmentDelete.resourceRows).toEqual([expect.objectContaining({ id: resourceId, org_id: orgId, name: updatedResourceName })]);
    const attachmentDeleteReceipt = await observer!`
      SELECT command_kind, outcome, activity_id::text AS activity_id
      FROM organization_mutation_receipts WHERE org_id = ${orgId}::uuid AND idempotency_key = ${attachmentDeleteKey}
    `;
    expect(attachmentDeleteReceipt).toHaveLength(1);
    expect(attachmentDeleteReceipt[0]).toMatchObject({ command_kind: "project_goal_set_replacement", outcome: "applied" });
    const attachmentActivities = await observer!`
      SELECT id::text AS id, action, entity_type, entity_id
      FROM activity_log WHERE org_id = ${orgId}::uuid AND entity_type = 'project_resource_attachment' AND entity_id = ${attachmentId}
    `;
    expect(attachmentActivities).toHaveLength(2);
    expect(attachmentActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "project.resource.updated", entity_id: attachmentId }),
      expect.objectContaining({
        id: attachmentDeleteReceipt[0]!.activity_id,
        action: "project.resource.detached",
        entity_type: "project_resource_attachment",
        entity_id: attachmentId,
      }),
    ]));
    expect(await observer!`
      SELECT outbox.activity_id::text AS activity_id, activity.action
      FROM organization_mutation_outbox AS outbox
      JOIN activity_log AS activity ON activity.org_id = outbox.org_id AND activity.id = outbox.activity_id
      WHERE outbox.org_id = ${orgId}::uuid AND activity.entity_type = 'project_resource_attachment' AND activity.entity_id = ${attachmentId}
      ORDER BY activity.action
    `).toEqual([
      expect.objectContaining({ activity_id: attachmentDeleteReceipt[0]!.activity_id, action: "project.resource.detached" }),
      expect.objectContaining({ activity_id: attachmentUpdateReceipt[0]!.activity_id, action: "project.resource.updated" }),
    ]);

    const attachmentDeleteReplay = await request(server!).delete(attachmentDeletePath)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", attachmentDeleteKey);
    expect(attachmentDeleteReplay.status, JSON.stringify(attachmentDeleteReplay.body)).toBe(200);
    expect(attachmentDeleteReplay.body).toEqual(attachmentDelete.body);
    expect(await snapshot()).toEqual(afterAttachmentDelete);

    const resourceDeleteKey = `${idempotencyKey}:resource-delete`;
    const resourceDeletePath = `/api/orgs/${orgId}/resources/${resourceId}`;
    const resourceDelete = await request(server!).delete(resourceDeletePath)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", resourceDeleteKey);
    expect(resourceDelete.status, JSON.stringify(resourceDelete.body)).toBe(200);
    expect(resourceDelete.body).toMatchObject({
      id: resourceId,
      orgId,
      name: updatedResourceName,
    });
    const afterResourceDelete = await snapshot();
    expect(afterResourceDelete.resourceRows).toEqual([]);
    expect(afterResourceDelete.attachmentRows).toEqual([]);
    expect(afterResourceDelete.resourceOwners).toEqual([expect.objectContaining({
      owner: "rust",
      mutation_version: "2",
      fence_epoch: "1",
    })]);

    const resourceDeleteReceipt = await observer!`
      SELECT command_kind, outcome, resulting_version::text AS resulting_version,
        activity_id::text AS activity_id
      FROM organization_mutation_receipts
      WHERE org_id = ${orgId}::uuid AND idempotency_key = ${resourceDeleteKey}
    `;
    expect(resourceDeleteReceipt).toHaveLength(1);
    expect(resourceDeleteReceipt[0]).toMatchObject({
      command_kind: "organization_resource",
      outcome: "applied",
      resulting_version: "2",
    });
    const resourceDeleteActivity = await observer!`
      SELECT id::text AS id, action, entity_type, entity_id
      FROM activity_log
      WHERE org_id = ${orgId}::uuid
        AND entity_type = 'organization_resource' AND entity_id = ${resourceId}
    `;
    expect(resourceDeleteActivity).toHaveLength(2);
    expect(resourceDeleteActivity.map((row) => row.action).sort()).toEqual([
      "organization.resource.deleted",
      "organization.resource.updated",
    ]);
    expect(resourceDeleteActivity).toEqual(expect.arrayContaining([expect.objectContaining({
      id: resourceDeleteReceipt[0]!.activity_id,
      action: "organization.resource.deleted",
      entity_type: "organization_resource",
      entity_id: resourceId,
    })]));
    const resourceActivityOutbox = await observer!`
      SELECT outbox.activity_id::text AS activity_id, activity.action
      FROM organization_mutation_outbox AS outbox
      JOIN activity_log AS activity
        ON activity.org_id = outbox.org_id AND activity.id = outbox.activity_id
      WHERE outbox.org_id = ${orgId}::uuid
        AND activity.entity_type = 'organization_resource' AND activity.entity_id = ${resourceId}
    `;
    expect(resourceActivityOutbox).toHaveLength(2);
    expect(resourceActivityOutbox.map((row) => row.action).sort()).toEqual([
      "organization.resource.deleted",
      "organization.resource.updated",
    ]);
    expect(resourceActivityOutbox).toEqual(expect.arrayContaining([expect.objectContaining({
      activity_id: resourceDeleteReceipt[0]!.activity_id,
      action: "organization.resource.deleted",
    })]));

    const resourceDeleteReplay = await request(server!).delete(resourceDeletePath)
      .set("authorization", `Bearer ${boardToken}`)
      .set("x-rudder-idempotency-key", resourceDeleteKey);
    expect(resourceDeleteReplay.status, JSON.stringify(resourceDeleteReplay.body)).toBe(200);
    expect(resourceDeleteReplay.body).toEqual(resourceDelete.body);
    expect(await snapshot()).toEqual(afterResourceDelete);
  }, 60_000);
});
