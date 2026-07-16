import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  instanceSettings,
  organizationSkills,
  organizations,
} from "@rudderhq/db";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
    skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(organizationSkills);
    await db.delete(organizations);
    await db.update(instanceSettings).set({ browser: {} });
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

    expect(skills.slice(0, 7).map((skill) => skill.key)).toEqual([
      "rudder/para-memory-files",
      "rudder/rudder",
      "rudder/rudder-create-agent",
      "rudder/rudder-create-plugin",
      "rudder/skill-creator",
      "rudder/visualize",
      "rudder/browser",
    ]);

    expect(skills.map((skill) => skill.key)).toEqual(expect.arrayContaining([
      "rudder/rudder",
      "rudder/rudder-create-agent",
      "rudder/skill-creator",
      "rudder/visualize",
      `organization/${orgId}/deep-research`,
      `organization/${orgId}/software-product-advisor`,
    ]));
    expect(skills.map((skill) => skill.key)).not.toEqual(expect.arrayContaining([
      "rudder/skill-optimizer",
      "rudder/conversation-to-skill",
    ]));

    expect(skills.find((skill) => skill.slug === "deep-research")).toMatchObject({
      sourceBadge: "community",
      sourceLabel: "Community preset",
      editable: false,
    });

    expect(skills.find((skill) => skill.slug === "skill-creator")).toMatchObject({
      key: "rudder/skill-creator",
      sourceBadge: "rudder",
      sourceLabel: "Bundled by Rudder",
      editable: false,
    });
    expect(skills.find((skill) => skill.slug === "visualize")).toMatchObject({
      key: "rudder/visualize",
      sourceBadge: "rudder",
      sourceLabel: "Bundled by Rudder",
      editable: false,
      trustLevel: "assets",
    });
  });

  it("removes the Browser bundled projection when the instance capability is disabled", { timeout: 30000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Browser Disabled Org",
      urlKey: "browser-disabled-org",
      issuePrefix: "BRO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(instanceSettings).values({
      singletonKey: "default",
      browser: { enabled: false, openLinksIn: "built_in" },
      general: {},
      notifications: {},
    }).onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: { browser: { enabled: false, openLinksIn: "built_in" } },
    });

    const skills = await skillSvc.list(orgId);
    expect(skills.map((skill) => skill.key)).not.toContain("rudder/browser");
    expect(skills.map((skill) => skill.key)).toContain("rudder/rudder");
  });

  it("does not expose the Browser bundled projection in authenticated deployments", { timeout: 30000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Authenticated Browser Org",
      urlKey: "authenticated-browser-org",
      issuePrefix: "ABR",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    const authenticatedSkillSvc = organizationSkillService(db, {
      deploymentMode: "authenticated",
    });
    const skills = await authenticatedSkillSvc.list(orgId);

    expect(skills.map((skill) => skill.key)).not.toContain("rudder/browser");
    expect(skills.map((skill) => skill.key)).toContain("rudder/rudder");
  });

  it("keeps external adapter skills visible and loadable across runtime switches", { timeout: 30000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-cross-runtime-skills-"));
    const codexSkillDir = path.join(home, ".codex", "skills", "build-advisor");
    const claudeSkillDir = path.join(home, ".claude", "skills", "crack-python");

    fs.mkdirSync(codexSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexSkillDir, "SKILL.md"),
      "---\nname: build-advisor\ndescription: Codex advisor.\n---\n",
      "utf8",
    );
    fs.mkdirSync(claudeSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeSkillDir, "SKILL.md"),
      "---\nname: crack-python\ndescription: Claude helper.\n---\n",
      "utf8",
    );

    try {
      await db.insert(organizations).values({
        id: orgId,
        name: "Cross Runtime Skills",
        urlKey: "cross-runtime-skills",
        issuePrefix: "CRS",
        status: "active",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        orgId,
        name: "Builder",
        workspaceKey: "builder",
        role: "engineer",
        status: "active",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          env: {
            HOME: home,
          },
        },
      });

      const agent = {
        id: agentId,
        orgId,
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          env: {
            HOME: home,
          },
        },
      };
      const snapshot = await skillSvc.buildAgentSkillSnapshot(agent, { env: { HOME: home } });

      expect(snapshot.entries).toContainEqual(expect.objectContaining({
        key: "build-advisor",
        selectionKey: "adapter:codex_local:build-advisor",
        sourceClass: "adapter_home",
        state: "external",
        locationLabel: "~/.codex/skills",
        sourcePath: codexSkillDir,
      }));
      expect(snapshot.entries).toContainEqual(expect.objectContaining({
        key: "crack-python",
        selectionKey: "adapter:claude_local:crack-python",
        sourceClass: "adapter_home",
        state: "external",
        locationLabel: "~/.claude/skills",
        sourcePath: claudeSkillDir,
      }));

      const enabledSelection = ["adapter:codex_local:build-advisor"];
      const enabledSnapshot = await skillSvc.buildAgentSkillSnapshot(
        agent,
        { env: { HOME: home } },
      );
      await skillSvc.replaceEnabledSkillKeysForAgent(orgId, agentId, enabledSelection);
      const refreshedSnapshot = await skillSvc.buildAgentSkillSnapshot(agent, { env: { HOME: home } });
      expect(refreshedSnapshot.entries).toContainEqual(expect.objectContaining({
        selectionKey: "adapter:codex_local:build-advisor",
        state: "configured",
        desired: true,
      }));
      expect(enabledSnapshot.entries.find((entry) => entry.selectionKey === enabledSelection[0])?.state).toBe("external");

      const runtimeEntries = await skillSvc.listRealizedSkillEntriesForAgent(
        orgId,
        agentId,
        "claude_local",
        { env: { HOME: home } },
        enabledSelection,
      );
      expect(runtimeEntries).toContainEqual(expect.objectContaining({
        key: "adapter:codex_local:build-advisor",
        runtimeName: "build-advisor",
        source: codexSkillDir,
        description: "Codex advisor.",
      }));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("creates stable org url keys and keeps them immutable on update", async () => {
    const first = await orgSvc.create({
      name: "Alpha Beta",
      description: null,
      budgetMonthlyCents: 0,
      defaultChatIssueCreationMode: "manual_approval",
    });
    const second = await orgSvc.create({
      name: "Alpha Beta",
      issuePrefix: "ALP2",
      description: "Second org",
      budgetMonthlyCents: 0,
      defaultChatIssueCreationMode: "manual_approval",
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
