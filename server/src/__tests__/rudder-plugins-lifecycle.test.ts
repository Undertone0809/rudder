import {
  activityLog,
  agentCustomIntegrationBindings,
  agentEnabledSkills,
  agents,
  appBuilderApps,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  installedPlugins,
  mcpConnections,
  organizationSkills,
  organizations,
  pluginComponentLinks,
  pluginImportReports,
  pluginPackages,
  pluginSources,
} from "@rudderhq/db";
import type { InspectRudderPlugin } from "@rudderhq/shared";
import { eq, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";
import { managedMcpBindingService } from "../services/mcp/managed-bindings.js";
import type { ManagedMcpConnectionServiceOptions } from "../services/mcp/managed-connections.js";
import { organizationSkillService } from "../services/organization-skills.js";
import { rudderPluginService } from "../services/rudder-plugins.js";

vi.setConfig({ hookTimeout: 180_000, testTimeout: 30_000 });

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
  return new Promise((resolve, reject) => {
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

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-v1-db-"));
  const port = await getAvailablePort();
  const { default: EmbeddedPostgres } = await import("embedded-postgres") as { default: EmbeddedPostgresCtor };
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

function pluginInput(sourceLabel: string, options: { mcpCommand?: string; mcpCwd?: string; mcpEnv?: Record<string, string>; appOnly?: boolean; version?: string; skillBody?: string } = {}): InspectRudderPlugin {
  const manifest: Record<string, unknown> = {
    name: "research-kit",
    version: options.version ?? "1.0.0",
    description: "Research with a repeatable method.",
    interface: { displayName: "Research Kit" },
  };
  const files: InspectRudderPlugin["files"] = [];
  if (options.appOnly) {
    manifest.apps = ".app.json";
    files.push({ path: ".app.json", content: JSON.stringify({ research: "asdk_app_123" }), encoding: "utf8" });
  } else {
    files.push({
      path: "skills/research/SKILL.md",
      content: options.skillBody ?? "---\nname: Research\ndescription: Gather evidence.\n---\n\n# Research\n",
      encoding: "utf8",
    });
    if (options.mcpCommand) {
      manifest.mcpServers = { evidence: { command: options.mcpCommand, args: ["server.js"], cwd: options.mcpCwd, env: options.mcpEnv } };
    }
  }
  files.push({
    path: ".codex-plugin/plugin.json",
    content: JSON.stringify(manifest),
    encoding: "utf8",
  });
  return { sourceLabel, sourceType: "local_upload", files };
}

describe("Rudder Plugin V1 lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 180_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(agentCustomIntegrationBindings);
    await db.delete(mcpConnections);
    await db.delete(activityLog);
    await db.delete(agentEnabledSkills);
    await db.delete(organizationSkills);
    await db.delete(appBuilderApps);
    await db.delete(installedPlugins);
    await db.delete(pluginImportReports);
    await db.delete(pluginPackages);
    await db.delete(pluginSources);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedOrg(name: string, issuePrefix: string) {
    const [org] = await db.insert(organizations).values({
      name,
      urlKey: name.toLowerCase().replaceAll(" ", "-"),
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const [agent] = await db.insert(agents).values({
      orgId: org!.id,
      name: `${name} Agent`,
      role: "general",
    }).returning();
    return { org: org!, agent: agent! };
  }

  function service(
    stdioCommands: string[][] = [],
    stdioWorkingDirectories: string[] = [],
    createClient: ManagedMcpConnectionServiceOptions["createClient"] = async () => { throw new Error("MCP client must not start during Plugin setup"); },
    stdioEnvironmentNames: string[] = [],
  ) {
    return rudderPluginService(db, {
      deploymentMode: "authenticated",
      allowlists: {
        httpOrigins: [],
        stdioCommands,
        stdioWorkingDirectories,
        stdioEnvironmentNames,
      },
      hostEnv: {},
      createClient,
      createOAuthCredential: () => ({
        token: async () => "unused",
        refresh: async () => undefined,
      }),
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
    });
  }

  it("installs a managed Skill, restores Agent assignment, and supports uninstall/reinstall", async () => {
    const { org, agent } = await seedOrg("Acme", "ACM");
    const plugins = service();
    const report = await plugins.inspect(org.id, pluginInput("Acme folder"));
    const installed = await plugins.install(org.id, report.id);

    expect(installed).toMatchObject({ displayName: "Research Kit", enabled: true, setupState: "ready" });
    expect(installed.components).toHaveLength(1);
    const [skill] = await db.select().from(organizationSkills).where(eq(organizationSkills.orgId, org.id));
    expect(skill?.metadata).toMatchObject({
      sourceKind: "plugin_managed",
      pluginManaged: true,
      pluginEnabled: true,
      installedPluginId: installed.id,
      pluginDigest: report.digest,
    });
    const runtimeSkills = organizationSkillService(db);
    const settings = instanceSettingsService(db);
    await settings.updateGeneral({ experimentalPluginsEnabled: true });
    expect((await runtimeSkills.listRuntimeSkillEntries(org.id)).some((entry) => entry.key === skill!.key)).toBe(true);
    await settings.updateGeneral({ experimentalPluginsEnabled: false });
    expect((await runtimeSkills.listRuntimeSkillEntries(org.id)).some((entry) => entry.key === skill!.key)).toBe(false);
    await settings.updateGeneral({ experimentalPluginsEnabled: true });

    await plugins.configureSkills(org.id, installed.id, [agent.id]);
    expect(await db.select().from(agentEnabledSkills)).toHaveLength(1);
    await plugins.setEnabled(org.id, installed.id, false);
    expect(await db.select().from(agentEnabledSkills)).toHaveLength(0);
    expect((await db.select().from(organizationSkills).where(eq(organizationSkills.id, skill!.id)))[0]?.metadata)
      .toMatchObject({ pluginEnabled: false });
    await plugins.setEnabled(org.id, installed.id, true);
    expect(await db.select().from(agentEnabledSkills)).toHaveLength(1);

    await plugins.uninstall(org.id, installed.id);
    expect(await db.select().from(organizationSkills).where(eq(organizationSkills.id, skill!.id))).toHaveLength(0);
    const [uninstalled] = await db.select().from(installedPlugins).where(eq(installedPlugins.id, installed.id));
    expect(uninstalled).toMatchObject({ lifecycleState: "uninstalled", enabled: false });

    const nextReport = await plugins.inspect(org.id, pluginInput("Reimported folder"));
    const reinstalled = await plugins.install(org.id, nextReport.id);
    expect(reinstalled.id).not.toBe(installed.id);
    expect(reinstalled.sourceLabel).toBe("Reimported folder");
  });

  it("compensates a partial install and allows the same reviewed import to retry", async () => {
    const { org } = await seedOrg("Retry", "RTY");
    const plugins = service();
    const report = await plugins.inspect(org.id, pluginInput("Retry folder"));
    await db.execute(sql.raw(`
      CREATE FUNCTION rudder_test_fail_plugin_link() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected plugin link failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER rudder_test_fail_plugin_link
      BEFORE INSERT ON plugin_component_links
      FOR EACH ROW EXECUTE FUNCTION rudder_test_fail_plugin_link();
    `));
    let installError: unknown = null;
    try {
      await plugins.install(org.id, report.id);
    } catch (error) {
      installError = error;
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS rudder_test_fail_plugin_link ON plugin_component_links;
        DROP FUNCTION IF EXISTS rudder_test_fail_plugin_link();
      `));
    }
    expect(installError).toBeInstanceOf(Error);
    expect((installError as Error).message).toMatch(/Failed query: insert into "plugin_component_links"/i);
    expect(await db.select().from(installedPlugins)).toHaveLength(0);
    expect((await db.select().from(organizationSkills)).filter((skill) => (
      skill.metadata as Record<string, unknown> | null
    )?.sourceKind === "plugin_managed")).toHaveLength(0);
    const retried = await plugins.install(org.id, report.id);
    expect(retried).toMatchObject({ displayName: "Research Kit", setupState: "ready" });
  });

  it("requires an explicit keep, replace, or rename choice for existing Skill conflicts", async () => {
    const { org } = await seedOrg("Skill conflict", "SCF");
    const existing = await organizationSkillService(db).createLocalSkill(org.id, {
      slug: "research",
      name: "Existing Research",
      description: "Independent Skill",
      markdown: "---\nname: Existing Research\n---\n\n# Existing\n",
    });
    const plugins = service();
    const report = await plugins.inspect(org.id, pluginInput("Conflicting folder"));
    expect(report.skillConflicts).toEqual([expect.objectContaining({
      existingSkillId: existing!.id,
      existingSkillName: "Existing Research",
    })]);
    await expect(plugins.install(org.id, report.id)).rejects.toThrow(/Choose keep, replace, or rename/);

    const installed = await plugins.install(org.id, report.id, true, false, "keep");
    expect(installed.components).toEqual([expect.objectContaining({
      type: "skill",
      status: "disabled",
      targetId: null,
      metadata: expect.objectContaining({ action: "skipped", keptExistingSkillId: existing!.id }),
    })]);
    expect((await db.select().from(organizationSkills).where(eq(organizationSkills.id, existing!.id)))[0]?.metadata)
      .toMatchObject({ sourceKind: "managed_local" });
    await plugins.uninstall(org.id, installed.id);
    expect(await db.select().from(organizationSkills).where(eq(organizationSkills.id, existing!.id))).toHaveLength(1);
  });

  it("ingests an ordered local Codex marketplace as review-only Discover entries with policy provenance", async () => {
    const { org } = await seedOrg("Marketplace", "MKT");
    const plugins = service();
    const marketplace = {
      name: "team-tools",
      interface: { displayName: "Team tools" },
      plugins: [{
        name: "research-kit",
        source: { source: "local", path: "./plugins/research-kit" },
        policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    };
    const reports = await plugins.configureMarketplace(org.id, {
      sourceLabel: "Team marketplace",
      files: [
        { path: "marketplace.json", content: JSON.stringify(marketplace), encoding: "utf8" },
        { path: "plugins/research-kit/.codex-plugin/plugin.json", content: pluginInput("unused").files.find((file) => file.path === ".codex-plugin/plugin.json")!.content, encoding: "utf8" },
        { path: "plugins/research-kit/skills/research/SKILL.md", content: "---\nname: Research\n---\n\n# Research\n", encoding: "utf8" },
      ],
    });
    expect(reports).toHaveLength(1);
    expect(await db.select().from(installedPlugins)).toHaveLength(0);
    const directory = await plugins.directory(org.id);
    expect(directory.discoverSource).toBe("configured");
    expect(directory.discover).toEqual([expect.objectContaining({
      reportId: reports[0]!.id,
      sourceType: "marketplace",
      category: "Productivity",
      policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_INSTALL" },
    })]);
    const installed = await plugins.install(org.id, reports[0]!.id);
    expect(installed.sourceLabel).toBe("team-tools/research-kit");
  });

  it("fetches a GitHub marketplace only from an HTTPS repository pinned to a full commit SHA", async () => {
    const { org } = await seedOrg("Pinned marketplace", "PMK");
    const commit = "a".repeat(40);
    const marketplace = JSON.stringify({
      name: "pinned-tools",
      plugins: [{
        name: "research-kit",
        source: { source: "local", path: "./plugins/research-kit" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Research",
      }],
    });
    const manifestFile = pluginInput("unused").files.find((file) => file.path === ".codex-plugin/plugin.json")!.content;
    const archive = zipSync({
      [`repo-${commit}/marketplace.json`]: strToU8(marketplace),
      [`repo-${commit}/plugins/research-kit/.codex-plugin/plugin.json`]: strToU8(manifestFile),
      [`repo-${commit}/plugins/research-kit/skills/research/SKILL.md`]: strToU8("---\nname: Research\n---\n\n# Research\n"),
    });
    const fetchMock = vi.fn(async () => new Response(archive, {
      status: 200,
      headers: { "content-type": "application/zip", "content-length": String(archive.byteLength) },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const plugins = service();
    const reports = await plugins.configureMarketplace(org.id, {
      sourceLabel: "Pinned tools",
      github: { repository: "https://github.com/acme/repo", commit },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://codeload.github.com/acme/repo/zip/${commit}`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(reports).toHaveLength(1);
    expect((await plugins.directory(org.id)).discover).toEqual([
      expect.objectContaining({ sourceType: "git", category: "Research" }),
    ]);
    expect((await db.select().from(pluginSources).where(eq(pluginSources.id, (await db.select().from(pluginImportReports).where(eq(pluginImportReports.id, reports[0]!.id)))[0]!.sourceId!)))[0]?.metadata)
      .toMatchObject({ repository: "https://github.com/acme/repo", commit, immutable: true });
  });

  it("keeps deduplicated package source identity organization-scoped", async () => {
    const first = await seedOrg("First", "FST");
    const second = await seedOrg("Second", "SND");
    const plugins = service();
    const firstReport = await plugins.inspect(first.org.id, pluginInput("First private folder"));
    const secondReport = await plugins.inspect(second.org.id, pluginInput("Second private folder"));
    expect(firstReport.digest).toBe(secondReport.digest);

    const firstPlugin = await plugins.install(first.org.id, firstReport.id);
    const secondPlugin = await plugins.install(second.org.id, secondReport.id);
    expect(firstPlugin.sourceLabel).toBe("First private folder");
    expect(secondPlugin.sourceLabel).toBe("Second private folder");
    expect(await plugins.getInstalled(first.org.id, secondPlugin.id)).toBeNull();
    await expect(plugins.configureSkills(first.org.id, firstPlugin.id, [second.agent.id])).rejects.toThrow(/Organization/);
  });

  it("creates only a disabled managed MCP draft and enforces deployment allowlists", async () => {
    const { org } = await seedOrg("Mcp", "MCP");
    const command = process.execPath;
    const cwd = process.cwd();
    const denied = service();
    const deniedReport = await denied.inspect(org.id, pluginInput("MCP denied", { mcpCommand: command, mcpCwd: cwd }));
    const deniedPlugin = await denied.install(org.id, deniedReport.id);
    const deniedComponent = deniedPlugin.components.find((component) => component.type === "mcp")!;
    await expect(denied.configureMcp(org.id, deniedPlugin.id, deniedComponent.id, {})).rejects.toThrow(/policy rejected/i);
    expect(await db.select().from(mcpConnections)).toHaveLength(0);

    const allowed = service([[command, "server.js"]], [cwd]);
    const configured = await allowed.configureMcp(org.id, deniedPlugin.id, deniedComponent.id, {});
    const [connection] = await db.select().from(mcpConnections);
    expect(configured.targetId).toBe(connection?.id);
    expect(connection).toMatchObject({
      orgId: org.id,
      status: "draft",
      enabled: false,
      transport: "stdio",
      safeConfig: { command, args: ["server.js"], cwd },
    });

    await db.update(mcpConnections).set({ status: "active", enabled: true }).where(eq(mcpConnections.id, connection!.id));
    expect((await allowed.getInstalled(org.id, deniedPlugin.id))?.components.find((entry) => entry.id === deniedComponent.id)?.status).toBe("ready");
    expect((await allowed.getInstalled(org.id, deniedPlugin.id))?.setupState).toBe("ready");

    await db.update(mcpConnections).set({ status: "error", enabled: true }).where(eq(mcpConnections.id, connection!.id));
    expect(await allowed.getInstalled(org.id, deniedPlugin.id)).toMatchObject({
      setupState: "setup_required",
      healthState: "degraded",
    });
  });

  it("admits Plugin-linked MCP bindings only while the Plugin and global feature are enabled", async () => {
    const { org, agent } = await seedOrg("Mcp admission", "MAD");
    const command = process.execPath;
    const cwd = process.cwd();
    const plugins = service([[command, "server.js"]], [cwd]);
    const report = await plugins.inspect(org.id, pluginInput("MCP admission", { mcpCommand: command, mcpCwd: cwd }));
    const installed = await plugins.install(org.id, report.id);
    const component = installed.components.find((entry) => entry.type === "mcp")!;
    const configured = await plugins.configureMcp(org.id, installed.id, component.id, {});
    await db.update(mcpConnections).set({ status: "active", enabled: true }).where(eq(mcpConnections.id, configured.targetId!));
    await db.insert(agentCustomIntegrationBindings).values({
      orgId: org.id,
      agentId: agent.id,
      connectionId: configured.targetId,
      status: "active",
      accessMode: "full",
      enabledToolIds: [],
    });
    const bindings = managedMcpBindingService(db);

    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: true }))
      .resolves.toHaveLength(1);
    await plugins.setEnabled(org.id, installed.id, false);
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: true }))
      .resolves.toEqual([]);
    expect((await db.select().from(mcpConnections).where(eq(mcpConnections.id, configured.targetId!)))[0])
      .toMatchObject({ status: "active", enabled: true });

    await plugins.setEnabled(org.id, installed.id, true);
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: true }))
      .resolves.toHaveLength(1);
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: false }))
      .resolves.toEqual([]);
  });

  it("discovers and reads only HTML MCP UI resources through the active managed connection", async () => {
    const { org } = await seedOrg("Mcp UI", "MUI");
    const command = process.execPath;
    const cwd = process.cwd();
    const close = vi.fn(async () => undefined);
    const createClient: ManagedMcpConnectionServiceOptions["createClient"] = async () => ({
      discoverTools: async () => [],
      callTool: async () => ({ content: [] }),
      listResources: async () => [
        { uri: "ui://research", name: "Research UI", description: "Interactive research view", mimeType: "text/html;profile=mcp-app" },
        { uri: "data://research", name: "Raw data", mimeType: "application/json" },
      ],
      readResource: async (uri) => ({ contents: [{ uri, mimeType: "text/html", text: "<main>Research UI</main>" }] }),
      close,
    });
    const plugins = service([[command, "server.js"]], [cwd], createClient);
    const report = await plugins.inspect(org.id, pluginInput("MCP UI", { mcpCommand: command, mcpCwd: cwd }));
    const installed = await plugins.install(org.id, report.id);
    const component = installed.components.find((entry) => entry.type === "mcp")!;
    const configured = await plugins.configureMcp(org.id, installed.id, component.id, {});
    await db.update(mcpConnections).set({ status: "active", enabled: true }).where(eq(mcpConnections.id, configured.targetId!));

    await expect(plugins.listMcpUiResources(org.id, installed.id, component.id)).resolves.toEqual([{
      uri: "ui://research",
      name: "Research UI",
      description: "Interactive research view",
      mimeType: "text/html;profile=mcp-app",
    }]);
    await expect(plugins.readMcpUiResource(org.id, installed.id, component.id, "ui://research")).resolves.toMatchObject({
      uri: "ui://research",
      html: "<main>Research UI</main>",
    });
    await expect(plugins.readMcpUiResource(org.id, installed.id, component.id, "data://research")).rejects.toThrow(/not found/i);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("rejects oversized MCP HTML UI resources before returning them to the browser", async () => {
    const { org } = await seedOrg("Mcp UI size", "MUS");
    const command = process.execPath;
    const cwd = process.cwd();
    const createClient: ManagedMcpConnectionServiceOptions["createClient"] = async () => ({
      discoverTools: async () => [],
      callTool: async () => ({ content: [] }),
      listResources: async () => [
        { uri: "ui://oversized", name: "Oversized UI", mimeType: "text/html" },
      ],
      readResource: async (uri) => ({
        contents: [{ uri, mimeType: "text/html", text: `<main>${"x".repeat(2 * 1024 * 1024)}</main>` }],
      }),
      close: async () => undefined,
    });
    const plugins = service([[command, "server.js"]], [cwd], createClient);
    const report = await plugins.inspect(org.id, pluginInput("MCP UI size", { mcpCommand: command, mcpCwd: cwd }));
    const installed = await plugins.install(org.id, report.id);
    const component = installed.components.find((entry) => entry.type === "mcp")!;
    const configured = await plugins.configureMcp(org.id, installed.id, component.id, {});
    await db.update(mcpConnections).set({ status: "active", enabled: true }).where(eq(mcpConnections.id, configured.targetId!));

    await expect(plugins.readMcpUiResource(org.id, installed.id, component.id, "ui://oversized"))
      .rejects.toThrow(/2 MiB display limit/);
  });

  it("creates an independent customized Skill that survives Plugin uninstall", async () => {
    const { org } = await seedOrg("Customize", "CUS");
    const plugins = service();
    const report = await plugins.inspect(org.id, pluginInput("Customize folder"));
    const installed = await plugins.install(org.id, report.id);
    const component = installed.components.find((entry) => entry.type === "skill")!;

    const fork = await plugins.customizeSkill(org.id, installed.id, component.id);
    expect(fork.metadata).toMatchObject({
      sourceKind: "managed_local",
      forkedFromPluginId: installed.id,
      forkedFromSkillId: component.targetId,
      forkedFromDigest: installed.digest,
    });

    await plugins.uninstall(org.id, installed.id);
    expect(await db.select().from(organizationSkills).where(eq(organizationSkills.id, fork.id))).toHaveLength(1);
  });

  it("updates through a reviewed package and rolls back to the immutable previous snapshot", async () => {
    const { org } = await seedOrg("Update", "UPD");
    const plugins = service();
    const firstReport = await plugins.inspect(org.id, pluginInput("Version one"));
    const first = await plugins.install(org.id, firstReport.id);

    const updateReport = await plugins.inspect(org.id, pluginInput("Version two", {
      version: "2.0.0",
      skillBody: "---\nname: Research\ndescription: Updated evidence.\n---\n\n# Research V2\n",
    }));
    expect(updateReport).toMatchObject({ operation: "update", installedPluginId: first.id });
    expect(updateReport.capabilityDiff).toMatchObject({
      accessExpansion: true,
      changes: [expect.objectContaining({ key: "skill:research", kind: "changed", accessImpact: "expanded" })],
    });
    await expect(plugins.install(org.id, updateReport.id)).rejects.toThrow(/confirm the reviewed access expansion/i);
    const updated = await plugins.install(org.id, updateReport.id, true, true);
    expect(updated).toMatchObject({ id: first.id, version: "2.0.0", previousPackageId: first.packageId });
    expect((await db.select().from(organizationSkills).where(eq(organizationSkills.id, updated.components[0]!.targetId!)))[0]?.markdown).toContain("Research V2");

    const rolledBack = await plugins.rollback(org.id, first.id);
    expect(rolledBack).toMatchObject({ id: first.id, version: "1.0.0", previousPackageId: updated.packageId });
    expect((await db.select().from(organizationSkills).where(eq(organizationSkills.id, rolledBack.components[0]!.targetId!)))[0]?.markdown).toContain("# Research\n");
  });

  it("requires review when an MCP environment surface changes without exposing static values", async () => {
    const { org, agent } = await seedOrg("MCP environment update", "MEU");
    const command = process.execPath;
    const cwd = process.cwd();
    const plugins = service(
      [[command, "server.js"]],
      [cwd],
      undefined,
      ["MODE", "SEARCH_TOKEN", "SEARCH_TOKEN_V2"],
    );
    const firstReport = await plugins.inspect(org.id, pluginInput("MCP environment v1", {
      mcpCommand: command,
      mcpCwd: cwd,
      mcpEnv: { MODE: "read-only", TOKEN: "${SEARCH_TOKEN}" },
    }));
    const installed = await plugins.install(org.id, firstReport.id);
    const configured = await plugins.configureMcp(
      org.id,
      installed.id,
      installed.components.find((component) => component.type === "mcp")!.id,
      {},
    );
    await db.update(mcpConnections).set({ status: "active", enabled: true })
      .where(eq(mcpConnections.id, configured.targetId!));
    await db.insert(agentCustomIntegrationBindings).values({
      orgId: org.id,
      agentId: agent.id,
      connectionId: configured.targetId,
      status: "active",
      accessMode: "full",
      enabledToolIds: [],
    });
    const bindings = managedMcpBindingService(db);
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: true }))
      .resolves.toHaveLength(1);

    const updateReport = await plugins.inspect(org.id, pluginInput("MCP environment v2", {
      version: "2.0.0",
      mcpCommand: command,
      mcpCwd: cwd,
      mcpEnv: { MODE: "read-write", TOKEN: "${SEARCH_TOKEN_V2}" },
    }));

    expect(updateReport.capabilityDiff).toMatchObject({
      accessExpansion: true,
      changes: [expect.objectContaining({
        key: "mcp:evidence",
        accessImpact: "expanded",
        before: expect.objectContaining({
          executionSurface: expect.objectContaining({ forwardedEnvironment: ["SEARCH_TOKEN"] }),
        }),
        after: expect.objectContaining({
          executionSurface: expect.objectContaining({ forwardedEnvironment: ["SEARCH_TOKEN_V2"] }),
        }),
      })],
    });
    expect(JSON.stringify(updateReport.capabilityDiff)).not.toContain("read-only");
    expect(JSON.stringify(updateReport.capabilityDiff)).not.toContain("read-write");
    await expect(plugins.install(org.id, updateReport.id)).rejects.toThrow(/confirm the reviewed access expansion/i);
    const updated = await plugins.install(org.id, updateReport.id, false, true);
    expect(updated).toMatchObject({ version: "2.0.0", setupState: "setup_required" });
    expect(updated.components.find((component) => component.type === "mcp")?.targetId).toBeNull();
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: true }))
      .resolves.toEqual([]);
    expect((await db.select().from(mcpConnections).where(eq(mcpConnections.id, configured.targetId!)))[0])
      .toMatchObject({ status: "active", enabled: true });
    expect(await db.select().from(pluginComponentLinks).where(eq(pluginComponentLinks.targetId, configured.targetId!)))
      .toEqual([expect.objectContaining({ status: "disabled", metadata: expect.objectContaining({ retired: true }) })]);

    const rolledBack = await plugins.rollback(org.id, installed.id);
    expect(rolledBack).toMatchObject({ version: "1.0.0", setupState: "ready" });
    expect(rolledBack.components.find((component) => component.type === "mcp"))
      .toMatchObject({ targetId: configured.targetId, status: "ready" });
    expect(await db.select().from(pluginComponentLinks).where(eq(pluginComponentLinks.targetId, configured.targetId!)))
      .toEqual([expect.objectContaining({ componentKey: "mcp:evidence", status: "ready" })]);
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: true }))
      .resolves.toHaveLength(1);
  });

  it("keeps a removed MCP connection outside runtime through disabled provenance", async () => {
    const { org, agent } = await seedOrg("MCP removal", "MRM");
    const command = process.execPath;
    const cwd = process.cwd();
    const plugins = service([[command, "server.js"]], [cwd]);
    const firstReport = await plugins.inspect(org.id, pluginInput("MCP removal v1", {
      mcpCommand: command,
      mcpCwd: cwd,
    }));
    const installed = await plugins.install(org.id, firstReport.id);
    const configured = await plugins.configureMcp(
      org.id,
      installed.id,
      installed.components.find((component) => component.type === "mcp")!.id,
      {},
    );
    await db.update(mcpConnections).set({ status: "active", enabled: true })
      .where(eq(mcpConnections.id, configured.targetId!));
    await db.insert(agentCustomIntegrationBindings).values({
      orgId: org.id,
      agentId: agent.id,
      connectionId: configured.targetId,
      status: "active",
      accessMode: "full",
      enabledToolIds: [],
    });

    const removalReport = await plugins.inspect(org.id, pluginInput("MCP removal v2", { version: "2.0.0" }));
    expect(removalReport.capabilityDiff).toMatchObject({
      changes: [expect.objectContaining({ key: "mcp:evidence", kind: "removed", accessImpact: "reduced" })],
    });
    await plugins.install(org.id, removalReport.id);

    const bindings = managedMcpBindingService(db);
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: true }))
      .resolves.toEqual([]);
    await expect(bindings.listRuntimeBindings(org.id, agent.id, { pluginCapabilitiesEnabled: false }))
      .resolves.toEqual([]);
    expect((await plugins.getInstalled(org.id, installed.id))?.components.some((component) => component.type === "mcp"))
      .toBe(false);
    expect(await db.select().from(pluginComponentLinks).where(eq(pluginComponentLinks.targetId, configured.targetId!)))
      .toEqual([expect.objectContaining({ status: "disabled", metadata: expect.objectContaining({ retired: true }) })]);
  });

  it("reconciles existing Local Apps before directory access and keeps one projection per App", async () => {
    const { org } = await seedOrg("Local Apps", "LAP");
    const [app] = await db.insert(appBuilderApps).values({
      orgId: org.id,
      name: "Research Canvas",
      sourceRoot: "apps/research-canvas",
      scaffoldVersion: "1",
      buildStatus: "ready",
      desktopInstallationId: "desktop-1",
      appPublicId: "public-1",
      localBindingId: "binding-1",
    }).returning();
    const plugins = service();
    await plugins.syncAllLocalApps();
    await plugins.syncAllLocalApps();

    const installedBeforeDirectory = await db.select().from(installedPlugins)
      .where(eq(installedPlugins.orgId, org.id));
    const linksBeforeDirectory = await db.select().from(pluginComponentLinks)
      .where(eq(pluginComponentLinks.orgId, org.id));
    expect(installedBeforeDirectory).toHaveLength(1);
    expect(linksBeforeDirectory).toEqual([
      expect.objectContaining({ componentType: "app", targetId: app!.id }),
    ]);

    const directory = await plugins.directory(org.id);
    expect(directory.localApps).toEqual([]);
    expect(directory.installed).toHaveLength(1);
    expect(directory.installed[0]).toMatchObject({
      displayName: "Research Canvas",
      publisher: "Rudder",
      setupState: "ready",
      components: [expect.objectContaining({
        type: "app",
        targetId: app!.id,
        metadata: expect.objectContaining({ appKey: `managed:${app!.id}`, localBindingId: "binding-1" }),
      })],
    });
    expect((await plugins.directory(org.id)).installed).toHaveLength(1);

    const firstProjection = directory.installed[0]!;
    await db.update(appBuilderApps).set({
      name: "Research Canvas V2",
      latestVerificationRunId: null,
      updatedAt: new Date(app!.updatedAt.getTime() + 1_000),
    }).where(eq(appBuilderApps.id, app!.id));
    const revised = (await plugins.directory(org.id)).installed[0]!;
    expect(revised).toMatchObject({
      id: firstProjection.id,
      displayName: "Research Canvas",
      packageId: firstProjection.packageId,
      updateState: "review_required",
      pendingUpdate: expect.objectContaining({ displayName: "Research Canvas V2" }),
    });
    await plugins.setEnabled(org.id, revised.id, false);
    expect(await plugins.getInstalled(org.id, revised.id)).toMatchObject({
      enabled: false,
      updateState: "review_required",
      pendingUpdate: expect.objectContaining({ displayName: "Research Canvas V2" }),
    });
    await plugins.setEnabled(org.id, revised.id, true);
    const applied = await plugins.applyPendingLocalAppUpdate(org.id, revised.id);
    expect(applied).toMatchObject({
      id: firstProjection.id,
      displayName: "Research Canvas V2",
      previousPackageId: firstProjection.packageId,
      updateState: "none",
      pendingUpdate: null,
    });
    expect(applied.packageId).not.toBe(firstProjection.packageId);
    expect(applied.digest).not.toBe(firstProjection.digest);

    await plugins.uninstall(org.id, applied.id);
    const restored = (await plugins.directory(org.id)).installed;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ displayName: "Research Canvas V2", packageId: applied.packageId });
    expect(restored[0]!.id).not.toBe(revised.id);
  });

  it("preserves App aliases but refuses an unsupported-only package", async () => {
    const { org } = await seedOrg("Apps", "APP");
    const plugins = service();
    const report = await plugins.inspect(org.id, pluginInput("App aliases", { appOnly: true }));
    expect(report.status).toBe("failed");
    expect(report.components).toEqual([
      expect.objectContaining({ type: "app", status: "unsupported", metadata: { alias: "research", registeredId: "asdk_app_123" } }),
    ]);
    await expect(plugins.install(org.id, report.id)).rejects.toThrow(/not ready/i);
    expect(await db.select().from(installedPlugins)).toHaveLength(0);
  });
});
