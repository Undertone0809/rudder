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

// This exercises the real PostgreSQL startup-handoff helpers and Node public/service writers.
// The Rust Foundation exposes no ownership-handoff command, so this is not Rust-cutover proof.
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

describe("D1 Node-writer and ownership-handoff races on real PostgreSQL", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let postgresInstance: EmbeddedPostgresInstance | undefined;
  let postgresStarted = false;
  let dataDir = "";
  let connectionString = "";
  let observer: ReturnType<typeof postgres> | undefined;
  let advisoryLockHolder: ReturnType<typeof postgres> | undefined;
  let server: Server | undefined;

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

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-d1-write-handoff-postgres-"));
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

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api/orgs", organizationRoutes(db));
    app.use("/api", projectRoutes(db));
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
    await advisoryLockHolder?.end({ timeout: 5 });
    await observer?.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    if (postgresStarted) await postgresInstance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
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
});
