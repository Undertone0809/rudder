import {
  activityLog,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  organizationMutationOutbox,
  organizations,
  projects,
} from "@rudderhq/db";
import { eq } from "drizzle-orm";
import express from "express";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

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

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe("Agent self-checkout through the public Node transport and Rust authority", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let postgres: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let bridge: RustFoundationBridge | undefined;
  const orgId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const issueId = "44444444-4444-4444-8444-444444444444";
  const runId = "55555555-5555-4555-8555-555555555555";
  const pendingIssueId = "66666666-6666-4666-8666-666666666666";
  const pendingRunId = "77777777-7777-4777-8777-777777777777";

  beforeAll(async () => {
    const external = process.env.RUDDER_ISSUE_CHECKOUT_TEST_DATABASE_URL?.trim();
    let connectionString: string;
    if (external) {
      const parsed = new URL(external);
      const databaseName = parsed.pathname.replace(/^\//, "");
      parsed.pathname = "/postgres";
      await ensurePostgresDatabase(parsed.toString(), databaseName);
      await applyPendingMigrations(external);
      connectionString = external;
    } else {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-issue-checkout-rust-"));
      const port = await availablePort();
      const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
      postgres = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "rudder",
        password: "rudder",
        port,
        persistent: true,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
        onLog: () => {},
        onError: () => {},
      });
      await postgres.initialise();
      await postgres.start();
      const admin = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
      await ensurePostgresDatabase(admin, "rudder");
      connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
      await applyPendingMigrations(connectionString);
    }
    db = createDb(connectionString);
    await db.insert(organizations).values({
      id: orgId,
      name: "Rust issue checkout acceptance",
      urlKey: "rust-issue-checkout-acceptance",
      issuePrefix: "RUSTCHK",
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

    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const binary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim()
      || path.join(repoRoot, "native", "target", "debug", process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation");
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
  }, 60_000);

  afterAll(async () => {
    await bridge?.close();
    await db?.$client.end({ timeout: 5 });
    await postgres?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 20_000);

  it("persists checkout, full labels projection, and activity through Rust", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId,
        orgId,
        orgIds: [orgId],
        runId,
      };
      next();
    });
    app.use("/api", issueRoutes(db as any, {} as any, bridge));
    app.use(errorHandler);

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
});
