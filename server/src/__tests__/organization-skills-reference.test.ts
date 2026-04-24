import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  organizationSkills,
  organizations,
} from "@rudderhq/db";
import { organizationSkillService } from "../services/organization-skills.js";
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-org-skill-service-"));
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

describe("organization skill references", () => {
  let db!: ReturnType<typeof createDb>;
  let orgSvc!: ReturnType<typeof organizationService>;
  let skillSvc!: ReturnType<typeof organizationSkillService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    orgSvc = organizationService(db);
    skillSvc = organizationSkillService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(organizationSkills);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes public skill refs back to the current internal key", { timeout: 30000 }, async () => {
    const orgId = randomUUID();
    const orgUrlKey = "acme";
    const skillId = randomUUID();
    const bundledSkillId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Acme",
      urlKey: orgUrlKey,
      issuePrefix: "ACM",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(organizationSkills).values([
      {
        id: skillId,
        orgId,
        key: `organization/${orgId}/alpha-test`,
        slug: "alpha-test",
        name: "Alpha Test",
        description: null,
        markdown: "# Alpha Test\n",
        sourceType: "catalog",
        sourceLocator: "skills/alpha-test",
        sourceRef: null,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: { sourceKind: "catalog" },
      },
      {
        id: bundledSkillId,
        orgId,
        key: "rudder/omega-test",
        slug: "omega-test",
        name: "Omega Test",
        description: null,
        markdown: "# Omega Test\n",
        sourceType: "catalog",
        sourceLocator: "skills/omega-test",
        sourceRef: null,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: { sourceKind: "catalog" }, // Use catalog (not rudder_bundled) to prevent auto-deletion
      },
    ]);

    await expect(
      skillSvc.resolveRequestedSkillKeys(orgId, [
        "alpha-test",
        `org/${orgUrlKey}/alpha-test`,
        `org/${orgUrlKey}/builder/alpha-test`,
        `organization/${orgId}/alpha-test`,
        "rudder/omega-test",
        "rudder/rudder/omega-test",
      ]),
    ).resolves.toEqual(expect.arrayContaining([
      `organization/${orgId}/alpha-test`,
      "rudder/omega-test",
    ]));
  });

  it("seeds bundled and community preset skills into the organization library", { timeout: 30000 }, async () => {
    const orgId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Preset Org",
      urlKey: "preset-org",
      issuePrefix: "PRE",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    const skills = await skillSvc.list(orgId);

    expect(skills.slice(0, 4).map((skill) => skill.key)).toEqual([
      "rudder/para-memory-files",
      "rudder/rudder",
      "rudder/rudder-create-agent",
      "rudder/rudder-create-plugin",
    ]);

    expect(skills.map((skill) => skill.key)).toEqual(expect.arrayContaining([
      "rudder/rudder",
      "rudder/rudder-create-agent",
      `organization/${orgId}/deep-research`,
      `organization/${orgId}/skill-creator`,
      `organization/${orgId}/software-product-advisor`,
    ]));

    expect(skills.find((skill) => skill.slug === "deep-research")).toMatchObject({
      sourceBadge: "community",
      sourceLabel: "Community preset",
      editable: false,
    });

    expect(skills.find((skill) => skill.slug === "skill-creator")).toMatchObject({
      sourceType: "github",
      sourceLocator: "https://github.com/Undertone0809/skill-creator/tree/main/.agents/skills",
      sourceBadge: "community",
      sourceLabel: "Community preset",
      editable: false,
    });
  });

  it("creates stable org url keys and keeps them immutable on update", async () => {
    const first = await orgSvc.create({
      name: "Alpha Beta",
      description: null,
      budgetMonthlyCents: 0,
      defaultChatIssueCreationMode: "manual_approval",
      defaultChatAgentRuntimeType: null,
      defaultChatAgentRuntimeConfig: null,
    });
    const second = await orgSvc.create({
      name: "Alpha Beta",
      description: "Second org",
      budgetMonthlyCents: 0,
      defaultChatIssueCreationMode: "manual_approval",
      defaultChatAgentRuntimeType: null,
      defaultChatAgentRuntimeConfig: null,
    });

    expect(first.urlKey).toBe("alpha-beta");
    expect(second.urlKey).toBe("alpha-beta-2");

    await orgSvc.update(first.id, {
      name: "Alpha Beta Renamed",
      urlKey: "should-not-change" as unknown as string,
    } as any);

    const updated = await orgSvc.getById(first.id);
    expect(updated?.name).toBe("Alpha Beta Renamed");
    expect(updated?.urlKey).toBe("alpha-beta");
  });
});
