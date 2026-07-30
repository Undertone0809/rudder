import {
  agents,
  appBuilderApps,
  applyPendingMigrations,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  organizations,
  projects,
} from "@rudderhq/db";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appBuilderService } from "../services/app-builder.js";

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
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-app-builder-"));
  const port = await getAvailablePort();
  const module = await import("embedded-postgres");
  const EmbeddedPostgres = module.default as EmbeddedPostgresCtor;
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

describe("App Builder service", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof appBuilderService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    service = appBuilderService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(appBuilderApps);
    await db.delete(heartbeatRuns);
    await db.delete(chatConversations);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createOrganization(label: string) {
    const id = randomUUID();
    await db.insert(organizations).values({
      id,
      name: label,
      urlKey: `${label.toLowerCase().replaceAll(" ", "-")}-${id.slice(0, 6)}`,
      issuePrefix: id.slice(0, 4).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function createProject(orgId: string, name: string) {
    const id = randomUUID();
    await db.insert(projects).values({ id, orgId, name });
    return id;
  }

  async function createAgent(orgId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      orgId,
      name,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  it("enforces organization scope, one App per Project, and unique source roots", async () => {
    const orgId = await createOrganization("Primary");
    const otherOrgId = await createOrganization("Other");
    const projectId = await createProject(orgId, "Cold Email CRM");
    const secondProjectId = await createProject(orgId, "Marketing Data");
    const otherProjectId = await createProject(otherOrgId, "Other CRM");

    const created = await service.create(orgId, {
      name: "Cold Email CRM",
      projectId,
      sourceRoot: "apps/cold-email-crm",
      scaffoldVersion: "1",
    });
    expect(created).toMatchObject({
      orgId,
      projectId,
      sourceRoot: "apps/cold-email-crm",
      buildStatus: "preparing",
    });

    await expect(
      service.create(orgId, {
        name: "Another App",
        projectId,
        sourceRoot: "apps/another-app",
        scaffoldVersion: "1",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.create(orgId, {
        name: "Marketing Data",
        projectId: secondProjectId,
        sourceRoot: "apps/cold-email-crm",
        scaffoldVersion: "1",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.create(otherOrgId, {
        name: "Cross organization",
        projectId,
        sourceRoot: "apps/cross-org-project",
        scaffoldVersion: "1",
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      service.create(otherOrgId, {
        name: "Other CRM",
        projectId: otherProjectId,
        sourceRoot: "apps/cold-email-crm",
        scaffoldVersion: "1",
      }),
    ).resolves.toMatchObject({ orgId: otherOrgId });

    await expect(service.listForOrganization(orgId)).resolves.toEqual([
      expect.objectContaining({
        orgId,
        projectId,
        sourceRoot: "apps/cold-email-crm",
      }),
    ]);
  });

  it("rejects cross-organization conversations", async () => {
    const orgId = await createOrganization("Primary");
    const otherOrgId = await createOrganization("Other");
    const projectId = await createProject(orgId, "CRM");
    const [otherConversation] = await db
      .insert(chatConversations)
      .values({ orgId: otherOrgId, title: "Other chat" })
      .returning();

    await expect(
      service.create(orgId, {
        name: "CRM",
        projectId,
        conversationId: otherConversation.id,
        sourceRoot: "apps/crm",
        scaffoldVersion: "1",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("creates an organization App without a backing Project", async () => {
    const orgId = await createOrganization("Standalone");

    await expect(service.create(orgId, {
      name: "Cold Email CRM",
      sourceRoot: "apps/cold-email-crm-standalo",
      scaffoldVersion: "1",
    })).resolves.toMatchObject({
      orgId,
      projectId: null,
      name: "Cold Email CRM",
      sourceRoot: "apps/cold-email-crm-standalo",
    });
  });

  it("attaches only an organization-owned Chat to a reserved App", async () => {
    const orgId = await createOrganization("Reserved");
    const otherOrgId = await createOrganization("Other");
    const [conversation, otherConversation] = await db
      .insert(chatConversations)
      .values([
        { orgId, title: "Build chat" },
        { orgId: otherOrgId, title: "Other chat" },
      ])
      .returning();
    const app = await service.create(orgId, {
      name: "Reserved App",
      sourceRoot: "apps/reserved-app",
      scaffoldVersion: "1",
    });

    await expect(service.attachConversation(orgId, app.id, {
      conversationId: conversation.id,
    })).resolves.toMatchObject({ conversationId: conversation.id });
    await expect(service.attachConversation(orgId, app.id, {
      conversationId: otherConversation.id,
    })).rejects.toMatchObject({ status: 422 });
  });

  it("uses an expected build state to prevent concurrent registration", async () => {
    const orgId = await createOrganization("Build lease");
    const app = await service.create(orgId, {
      name: "CRM",
      sourceRoot: "apps/build-lease-crm",
      scaffoldVersion: "1",
    });

    await expect(service.updateBuild(orgId, app.id, {
      status: "building",
      expectedStatus: "preparing",
      runKind: "build",
    })).resolves.toMatchObject({ buildStatus: "building" });
    await expect(service.updateBuild(orgId, app.id, {
      status: "building",
      expectedStatus: "preparing",
      runKind: "build",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("accepts only build and verification runs tied to the same Project and Chat", async () => {
    const orgId = await createOrganization("Primary");
    const projectId = await createProject(orgId, "CRM");
    const otherProjectId = await createProject(orgId, "Other");
    const agentId = await createAgent(orgId, "Builder");
    const [conversation, otherConversation] = await db
      .insert(chatConversations)
      .values([
        { orgId, title: "Build chat" },
        { orgId, title: "Other chat" },
      ])
      .returning();
    const app = await service.create(orgId, {
      name: "CRM",
      projectId,
      conversationId: conversation.id,
      sourceRoot: "apps/crm",
      scaffoldVersion: "1",
    });

    const [wrongProjectRun, wrongChatRun, validRun] = await db
      .insert(heartbeatRuns)
      .values([
        {
          orgId,
          agentId,
          status: "succeeded",
          chatConversationId: conversation.id,
          contextSnapshot: { projectId: otherProjectId },
        },
        {
          orgId,
          agentId,
          status: "succeeded",
          chatConversationId: otherConversation.id,
          contextSnapshot: { projectId },
        },
        {
          orgId,
          agentId,
          status: "succeeded",
          chatConversationId: conversation.id,
          contextSnapshot: { projectId },
        },
      ])
      .returning();

    await expect(
      service.updateBuild(orgId, app.id, {
        status: "failed",
        runId: wrongProjectRun.id,
        runKind: "build",
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.updateBuild(orgId, app.id, {
        status: "failed",
        runId: wrongChatRun.id,
        runKind: "verification",
      }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      service.updateBuild(orgId, app.id, {
        status: "ready",
        runId: validRun.id,
        runKind: "verification",
      }),
    ).resolves.toMatchObject({
      buildStatus: "ready",
      latestBuildRunId: null,
      latestVerificationRunId: validRun.id,
    });
  });

  it("keeps local binding identities unique within a Desktop installation", async () => {
    const orgId = await createOrganization("Primary");
    const firstProjectId = await createProject(orgId, "First");
    const secondProjectId = await createProject(orgId, "Second");
    const firstApp = await service.create(orgId, {
      name: "First",
      projectId: firstProjectId,
      sourceRoot: "apps/first",
      scaffoldVersion: "1",
    });
    const secondApp = await service.create(orgId, {
      name: "Second",
      projectId: secondProjectId,
      sourceRoot: "apps/second",
      scaffoldVersion: "1",
    });

    await service.bindLocalRuntime(orgId, firstApp.id, {
      desktopInstallationId: "desktop_1",
      appPublicId: "app_1",
      localBindingId: "binding_1",
    });
    await expect(
      service.bindLocalRuntime(orgId, secondApp.id, {
        desktopInstallationId: "desktop_1",
        appPublicId: "app_2",
        localBindingId: "binding_1",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      service.bindLocalRuntime(orgId, secondApp.id, {
        desktopInstallationId: "desktop_2",
        appPublicId: "app_1",
        localBindingId: "binding_1",
      }),
    ).resolves.toMatchObject({
      desktopInstallationId: "desktop_2",
      appPublicId: "app_1",
      localBindingId: "binding_1",
    });
  });
});
