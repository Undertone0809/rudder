import {
  activityLog,
  agents,
  applyPendingMigrations,
  createDb,
  createLocalPostgresInstance,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  organizationMutationOutbox,
  organizations,
  projects,
  type LocalPostgresInstance,
} from "@rudderhq/db";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
const foundationBinaryCandidates = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim()
  ? [process.env.RUDDER_SERVER_FOUNDATION_PATH.trim()]
  : [
      path.join(repositoryRoot, "native", "target", "debug", binaryName),
      path.join(repositoryRoot, "native", "target", "release", binaryName),
    ];
const foundationBinaryAvailable = foundationBinaryCandidates.some((candidate) => fs.existsSync(candidate));
const configuredDatabaseUrl = process.env.RUDDER_ISSUE_CHECKOUT_TEST_DATABASE_URL?.trim();
const disposableDatabaseRequested = process.env.RUDDER_ISSUE_CHECKOUT_TEST_DISPOSABLE === "1";

if (disposableDatabaseRequested && configuredDatabaseUrl) {
  throw new Error("Set either RUDDER_ISSUE_CHECKOUT_TEST_DISPOSABLE=1 or RUDDER_ISSUE_CHECKOUT_TEST_DATABASE_URL, not both");
}

function availablePostgresPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local PostgreSQL test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const shouldSkipRealEntrySuite = !disposableDatabaseRequested
  && (!foundationBinaryAvailable || !configuredDatabaseUrl);

describe.skipIf(shouldSkipRealEntrySuite)("Agent self-checkout through the public Node transport and Rust authority", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let bridge: RustFoundationBridge | undefined;
  let ownedPostgres: LocalPostgresInstance | undefined;
  let ownedPostgresStarted = false;
  let ownedTempRoot: string | undefined;
  const isolatedHomeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";
  let previousHome: string | undefined;
  let isolatedHomeSet = false;
  const orgId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const issueId = "44444444-4444-4444-8444-444444444444";
  const runId = "55555555-5555-4555-8555-555555555555";
  const pendingIssueId = "66666666-6666-4666-8666-666666666666";
  const pendingRunId = "77777777-7777-4777-8777-777777777777";
  const foreignOrgId = "88888888-8888-4888-8888-888888888888";
  const foreignProjectId = "99999999-9999-4999-8999-999999999999";
  const foreignIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const concurrentIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const tamperedIssueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const rollbackIssueId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const concurrentRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  function createApp(actorRunId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId,
        orgId,
        orgIds: [orgId],
        runId: actorRunId,
      };
      next();
    });
    app.use("/api", issueRoutes(db as any, {} as any, bridge));
    app.use(errorHandler);
    return app;
  }

  async function expectNoCheckoutEffects(targetIssueId: string, expectedOrgId = orgId) {
    const [persisted] = await db!.select().from(issues).where(eq(issues.id, targetIssueId));
    expect(persisted).toMatchObject({
      orgId: expectedOrgId,
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
    const activities = await db!.select().from(activityLog).where(eq(activityLog.entityId, targetIssueId));
    expect(activities).toHaveLength(0);
    const outbox = await db!
      .select()
      .from(organizationMutationOutbox)
      .where(sql`${organizationMutationOutbox.payload}->>'entityId' = ${targetIssueId}`);
    expect(outbox).toHaveLength(0);
  }

  async function activitiesFor(targetIssueId: string) {
    return db!.select().from(activityLog).where(eq(activityLog.entityId, targetIssueId));
  }

  async function outboxFor(targetIssueId: string) {
    return db!
      .select()
      .from(organizationMutationOutbox)
      .where(sql`${organizationMutationOutbox.payload}->>'entityId' = ${targetIssueId}`);
  }

  async function startOwnedDisposableDatabase(): Promise<string> {
    ownedTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-issue-checkout-"));
    const isolatedHome = path.join(ownedTempRoot, "home");
    fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    previousHome = process.env[isolatedHomeVariable];
    process.env[isolatedHomeVariable] = isolatedHome;
    isolatedHomeSet = true;

    const port = await availablePostgresPort();
    const { instance } = await createLocalPostgresInstance({
      databaseDir: path.join(ownedTempRoot, "pgdata"),
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: (message) => console.error("[issue-checkout PostgreSQL]", message),
      onError: (message) => console.error("[issue-checkout PostgreSQL]", message),
    });
    ownedPostgres = instance;
    await instance.initialise();
    ownedPostgresStarted = true;
    await instance.start();

    const databaseName = `rudder_issue_checkout_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, databaseName);
    return `postgres://rudder:rudder@127.0.0.1:${port}/${databaseName}`;
  }

  async function cleanupOwnedResources(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await bridge?.close();
      bridge = undefined;
    } catch (error) {
      failures.push(error);
    }
    try {
      await db?.$client.end({ timeout: 5 });
      db = undefined;
    } catch (error) {
      failures.push(error);
    }
    let tempRootCanBeRemoved = !ownedPostgresStarted && !bridge && !db;
    if (ownedPostgres && ownedPostgresStarted && !bridge && !db) {
      try {
        await ownedPostgres.stop();
        ownedPostgresStarted = false;
        tempRootCanBeRemoved = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (isolatedHomeSet) {
      if (previousHome === undefined) delete process.env[isolatedHomeVariable];
      else process.env[isolatedHomeVariable] = previousHome;
      isolatedHomeSet = false;
    }
    if (tempRootCanBeRemoved) ownedPostgres = undefined;
    if (ownedTempRoot && tempRootCanBeRemoved) {
      try {
        fs.rmSync(ownedTempRoot, { recursive: true, force: true });
        ownedTempRoot = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Issue checkout real-entry cleanup failed for an owned resource");
    }
  }

  beforeAll(async () => {
    try {
      if (disposableDatabaseRequested && !foundationBinaryAvailable) {
        throw new Error(`RUDDER_ISSUE_CHECKOUT_TEST_DISPOSABLE=1 requires a Rust foundation binary; checked: ${foundationBinaryCandidates.join(", ")}`);
      }

      let connectionString: string;
      if (disposableDatabaseRequested) {
        connectionString = await startOwnedDisposableDatabase();
      } else {
        const external = configuredDatabaseUrl;
        if (!external) throw new Error("Issue checkout real-entry suite requires its explicit disposable mode or database URL");
        const parsed = new URL(external);
        const databaseName = parsed.pathname.replace(/^\//, "");
        parsed.pathname = "/postgres";
        await ensurePostgresDatabase(parsed.toString(), databaseName);
        connectionString = external;
      }
      await applyPendingMigrations(connectionString);
      db = createDb(connectionString);
      await db.insert(organizations).values({
        id: orgId,
        name: "Rust issue checkout acceptance",
        urlKey: "rust-issue-checkout-acceptance",
        issuePrefix: "RUSTCHK",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(organizations).values({
        id: foreignOrgId,
        name: "Foreign Rust issue checkout acceptance",
        urlKey: "rust-issue-checkout-foreign",
        issuePrefix: "RUSTXCHK",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        orgId,
        name: "Checkout Agent",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(projects).values({ id: projectId, orgId, name: "Checkout Project", status: "in_progress" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: { issueId },
      });
      await db.insert(heartbeatRuns).values({
        id: pendingRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "failed",
        terminalEffectsPending: true,
        contextSnapshot: { issueId: pendingIssueId },
      });
      await db.insert(heartbeatRuns).values({
        id: concurrentRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: { issueId: concurrentIssueId },
      });
      await db.insert(issues).values({
        id: issueId,
        orgId,
        projectId,
        title: "Rust checkout acceptance",
        status: "todo",
        priority: "medium",
      });
      await db.insert(issues).values({
        id: pendingIssueId,
        orgId,
        projectId,
        title: "Pending terminal effects must not be adopted",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: pendingRunId,
        executionRunId: pendingRunId,
      });
      await db.insert(issues).values([
        {
          id: concurrentIssueId,
          orgId,
          projectId,
          title: "Concurrent Rust checkout acceptance",
          status: "todo",
          priority: "medium",
        },
        {
          id: tamperedIssueId,
          orgId,
          projectId,
          title: "Tampered Rust checkout acceptance",
          status: "todo",
          priority: "medium",
        },
        {
          id: rollbackIssueId,
          orgId,
          projectId,
          title: "Rollback Rust checkout acceptance",
          status: "todo",
          priority: "medium",
        },
      ]);
      await db.insert(projects).values({
        id: foreignProjectId,
        orgId: foreignOrgId,
        name: "Foreign Checkout Project",
        status: "in_progress",
      });
      await db.insert(issues).values({
        id: foreignIssueId,
        orgId: foreignOrgId,
        projectId: foreignProjectId,
        title: "Foreign organization checkout must be denied",
        status: "todo",
        priority: "medium",
      });

      const binary = foundationBinaryCandidates.find((candidate) => fs.existsSync(candidate)) ?? foundationBinaryCandidates[0]!;
      if (!fs.existsSync(binary)) {
        throw new Error(`missing Rust foundation binary: ${binary}`);
      }
      bridge = createRustFoundationBridge({
        databaseUrl: connectionString,
        binaryPath: binary,
        actorEnvelopeKey: "issue-checkout-acceptance-envelope-key",
        mode: "off",
        organizationBrandingMode: "off",
        projectGoalSetMode: "off",
        requestTimeoutMs: 10_000,
      });
      await bridge.start();
    } catch (error) {
      try {
        await cleanupOwnedResources();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Issue checkout real-entry setup and cleanup both failed");
      }
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await cleanupOwnedResources();
  }, 60_000);

  it("persists checkout, full labels projection, and activity through Rust", async () => {
    const app = createApp(runId);

    const response = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      id: issueId,
      orgId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      labels: [],
      labelIds: [],
    });
    const [persisted] = await db!.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted).toMatchObject({ status: "in_progress", assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId });
    const activities = await db!.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ action: "issue.checked_out", actorType: "agent", agentId, runId });
    const outbox = await db!.select().from(organizationMutationOutbox).where(eq(organizationMutationOutbox.activityId, activities[0]!.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ eventType: "activity.logged", orgId });

    const conflict = await request(app)
      .post(`/api/issues/${pendingIssueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_progress"] });
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
    const [pending] = await db!.select().from(issues).where(eq(issues.id, pendingIssueId));
    expect(pending).toMatchObject({ checkoutRunId: pendingRunId, executionRunId: pendingRunId });
  });

  it("denies a same-organization Agent checkout against a foreign-organization issue without effects", async () => {
    const response = await request(createApp(runId))
      .post(`/api/issues/${foreignIssueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await expectNoCheckoutEffects(foreignIssueId, foreignOrgId);
  });

  it("rejects a body changed after signing and leaves the issue and effects untouched", async () => {
    const nativeFetch = globalThis.fetch;
    let tamperedRequestCount = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      if (!String(url).endsWith("/issue-checkout")) return nativeFetch(url, options);
      tamperedRequestCount += 1;
      const signedEnvelope = new Headers(options?.headers).get("x-rudder-actor-envelope");
      expect(signedEnvelope).toBeTruthy();
      const body = JSON.parse(Buffer.from(options?.body as Uint8Array).toString("utf8")) as {
        expectedStatuses: string[];
      };
      body.expectedStatuses = ["done"];
      return nativeFetch(url, {
        ...options,
        body: Buffer.from(JSON.stringify(body)) as unknown as BodyInit,
      });
    });

    let status: number;
    try {
      status = (
        await request(createApp(runId))
          .post(`/api/issues/${tamperedIssueId}/checkout`)
          .send({ agentId, expectedStatuses: ["todo"] })
      ).status;
    } finally {
      spy.mockRestore();
    }

    expect(tamperedRequestCount).toBe(1);
    expect(status!).toBe(401);
    await expectNoCheckoutEffects(tamperedIssueId);
  });

  it("serializes two running runs competing to checkout one issue and records only the winner", async () => {
    const nativeFetch = globalThis.fetch;
    let releaseRequests!: () => void;
    const bothRequestsAtBridge = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    let bridgeRequestCount = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      if (!String(url).endsWith("/issue-checkout")) return nativeFetch(url, options);
      bridgeRequestCount += 1;
      if (bridgeRequestCount === 2) releaseRequests();
      await bothRequestsAtBridge;
      return nativeFetch(url, options);
    });

    try {
      const [first, second] = await Promise.all([
        request(createApp(runId))
          .post(`/api/issues/${concurrentIssueId}/checkout`)
          .send({ agentId, expectedStatuses: ["todo"] }),
        request(createApp(concurrentRunId))
          .post(`/api/issues/${concurrentIssueId}/checkout`)
          .send({ agentId, expectedStatuses: ["todo"] }),
      ]);

      expect(bridgeRequestCount).toBe(2);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const winner = first.status === 200 ? first : second;
      const winningRunId = winner.body.checkoutRunId;
      expect([runId, concurrentRunId]).toContain(winningRunId);

      const [persisted] = await db!.select().from(issues).where(eq(issues.id, concurrentIssueId));
      expect(persisted).toMatchObject({
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: winningRunId,
        executionRunId: winningRunId,
      });
      const activities = await activitiesFor(concurrentIssueId);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ action: "issue.checked_out", actorType: "agent", agentId, runId: winningRunId });
      const outbox = await outboxFor(concurrentIssueId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ eventType: "activity.logged", orgId, activityId: activities[0]!.id });
    } finally {
      spy.mockRestore();
    }
  });

  it("rolls back checkout and audit effects when outbox insertion fails, then succeeds after trigger removal", async () => {
    const functionName = "rudder_test_reject_issue_checkout_outbox";
    const triggerName = "rudder_test_reject_issue_checkout_outbox";
    await expectNoCheckoutEffects(rollbackIssueId);
    await db!.execute(sql.raw(`
      CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.payload->>'entityId' = '${rollbackIssueId}' THEN
          RAISE EXCEPTION 'forced issue checkout outbox failure';
        END IF;
        RETURN NEW;
      END
      $$
    `));
    try {
      await db!.execute(sql.raw(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON organization_mutation_outbox
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()
      `));
      const failed = await request(createApp(runId))
        .post(`/api/issues/${rollbackIssueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });

      expect(failed.status, JSON.stringify(failed.body)).toBe(500);
      await expectNoCheckoutEffects(rollbackIssueId);
    } finally {
      await db!.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON organization_mutation_outbox`));
      await db!.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }

    const retry = await request(createApp(runId))
      .post(`/api/issues/${rollbackIssueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    const [persisted] = await db!.select().from(issues).where(eq(issues.id, rollbackIssueId));
    expect(persisted).toMatchObject({ status: "in_progress", assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId });
    const activities = await activitiesFor(rollbackIssueId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ action: "issue.checked_out", agentId, runId });
    const outbox = await outboxFor(rollbackIssueId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ eventType: "activity.logged", orgId, activityId: activities[0]!.id });
  });
});
