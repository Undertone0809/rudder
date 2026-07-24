import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  organizationSkills,
  organizations,
} from "@rudderhq/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { organizationSkillService } from "../services/organization-skills.js";

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

const PINNED_REF = "a".repeat(40);
const UPDATED_REF = "b".repeat(40);

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-org-skill-install-db-"));
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

function githubTreeResponse() {
  return new Response(JSON.stringify({
    tree: [
      { path: "skills/offline-skill/SKILL.md", type: "blob" },
      { path: "skills/offline-skill/references/guide.md", type: "blob" },
      { path: "skills/offline-skill/scripts/run.sh", type: "blob" },
    ],
  }));
}

describe("organization skill local installations", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let rudderHome = "";
  let previousRudderHome: string | undefined;

  beforeAll(async () => {
    previousRudderHome = process.env.RUDDER_HOME;
    rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-org-skill-install-home-"));
    process.env.RUDDER_HOME = rudderHome;

    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(agents);
    await db.delete(organizationSkills);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(rudderHome, { recursive: true, force: true });
    if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = previousRudderHome;
  });

  it("installs the complete remote tree once and reuses it offline", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Offline Skill Org",
      urlKey: "offline-skill-org",
      issuePrefix: "OSO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Builder",
      workspaceKey: "builder",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return githubTreeResponse();
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Offline Skill\ndescription: Works offline.\n---\n\n# Offline\n");
      }
      if (url.endsWith("/references/guide.md")) return new Response("# Local guide\n");
      if (url.endsWith("/scripts/run.sh")) return new Response("echo local\n");
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const sourceUrl = `https://github.com/acme/skills/tree/${PINNED_REF}/skills/offline-skill`;
    const imported = await skillSvc.importFromSource(orgId, sourceUrl);
    const skill = imported.imported[0]!;

    expect(skill).toMatchObject({
      sourceType: "github",
      sourceLocator: sourceUrl,
      sourceRef: PINNED_REF,
      fileInventory: [
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/run.sh", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ],
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    const guide = await skillSvc.readFile(orgId, skill.id, "references/guide.md");
    expect(guide).toMatchObject({
      content: "# Local guide\n",
      editable: true,
    });

    const firstRuntime = await skillSvc.listRealizedSkillEntriesForAgent(
      orgId,
      agentId,
      "codex_local",
      {},
      [`org:${skill.key}`],
    );
    const secondRuntime = await skillSvc.listRealizedSkillEntriesForAgent(
      orgId,
      agentId,
      "codex_local",
      {},
      [`org:${skill.key}`],
    );
    const installedPath = firstRuntime.find((entry) => entry.key === `org:${skill.key}`)?.source;
    expect(installedPath).toBeTruthy();
    expect(secondRuntime.find((entry) => entry.key === `org:${skill.key}`)?.source).toBe(installedPath);
    await expect(fs.promises.readFile(path.join(installedPath!, "scripts", "run.sh"), "utf8"))
      .resolves.toBe("echo local\n");
  });

  it("installs sibling files when importing a GitHub blob SKILL.md URL", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Blob Skill Org",
      urlKey: "blob-skill-org",
      issuePrefix: "BLO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return githubTreeResponse();
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Offline Skill\ndescription: Blob import.\n---\n");
      }
      if (url.endsWith("/references/guide.md")) return new Response("# Blob guide\n");
      if (url.endsWith("/scripts/run.sh")) return new Response("echo blob\n");
      return new Response("not found", { status: 404 });
    }));

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const sourceUrl = `https://github.com/acme/skills/blob/${PINNED_REF}/skills/offline-skill/SKILL.md`;
    const skill = (await skillSvc.importFromSource(orgId, sourceUrl)).imported[0]!;

    expect(skill.fileInventory).toEqual([
      { path: "references/guide.md", kind: "reference" },
      { path: "scripts/run.sh", kind: "script" },
      { path: "SKILL.md", kind: "skill" },
    ]);
    await expect(skillSvc.readFile(orgId, skill.id, "references/guide.md")).resolves.toMatchObject({
      content: "# Blob guide\n",
    });
  });

  it("edits an installed remote skill and realizes the edited content", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Editable Skill Org",
      urlKey: "editable-skill-org",
      issuePrefix: "ESO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Editor",
      workspaceKey: "editor",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return githubTreeResponse();
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Offline Skill\ndescription: Original.\n---\n\n# Original\n");
      }
      if (url.endsWith("/references/guide.md")) return new Response("# Original guide\n");
      if (url.endsWith("/scripts/run.sh")) return new Response("echo original\n");
      return new Response("not found", { status: 404 });
    }));

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const sourceUrl = `https://github.com/acme/skills/tree/${PINNED_REF}/skills/offline-skill`;
    const skill = (await skillSvc.importFromSource(orgId, sourceUrl)).imported[0]!;
    const edited = "---\nname: Offline Skill\ndescription: Edited locally.\n---\n\n# Edited\n";

    await expect(skillSvc.updateFile(orgId, skill.id, "SKILL.md", edited)).resolves.toMatchObject({
      content: edited,
      editable: true,
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const runtimeEntries = await skillSvc.listRealizedSkillEntriesForAgent(
      orgId,
      agentId,
      "codex_local",
      {},
      [`org:${skill.key}`],
    );
    const installedPath = runtimeEntries.find((entry) => entry.key === `org:${skill.key}`)?.source;
    await expect(fs.promises.readFile(path.join(installedPath!, "SKILL.md"), "utf8"))
      .resolves.toBe(edited);
  });

  it("keeps Rudder-bundled skills read-only at the service boundary", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Bundled Skill Org",
      urlKey: "bundled-skill-org",
      issuePrefix: "BSO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const bundled = (await skillSvc.list(orgId)).find((skill) => skill.key === "rudder/rudder-docs")!;

    expect(bundled).toMatchObject({
      editable: false,
      editableReason: "Bundled Rudder skills are read-only.",
    });
    await expect(skillSvc.updateFile(
      orgId,
      bundled.id,
      "SKILL.md",
      "# Mutated bundled skill\n",
    )).rejects.toThrow("Bundled Rudder skills are read-only.");
  });

  it("rejects deletion of Rudder-bundled and capability-bundled skills", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Protected Bundled Skill Org",
      urlKey: "protected-bundled-skill-org",
      issuePrefix: "PBS",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const skills = await skillSvc.list(orgId);
    const bundled = skills.find((skill) => skill.key === "rudder/rudder-docs")!;
    const capabilityBundled = skills.find((skill) => skill.key === "rudder/browser")!;

    await expect(skillSvc.deleteSkill(orgId, bundled.id)).rejects.toThrow(
      "Bundled Rudder skills are read-only.",
    );
    await expect(skillSvc.deleteSkill(orgId, capabilityBundled.id)).rejects.toThrow(
      "Bundled Rudder skills are read-only.",
    );
    await expect(skillSvc.getById(bundled.id)).resolves.toMatchObject({ id: bundled.id });
    await expect(skillSvc.getById(capabilityBundled.id)).resolves.toMatchObject({
      id: capabilityBundled.id,
    });
  });

  it("does not replace an existing bundled identity through package or local imports", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const localReplacementDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "rudder-bundled-replacement-"),
    );
    await db.insert(organizations).values({
      id: orgId,
      name: "Bundled Replacement Org",
      urlKey: "bundled-replacement-org",
      issuePrefix: "BRO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    const replacementMarkdown = [
      "---",
      "key: rudder/rudder-docs",
      "name: Replacement Docs",
      "---",
      "",
      "# Replacement",
      "",
    ].join("\n");
    await fs.promises.writeFile(
      path.join(localReplacementDir, "SKILL.md"),
      replacementMarkdown,
      "utf8",
    );

    try {
      const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
      const originalListItem = (await skillSvc.list(orgId)).find(
        (skill) => skill.key === "rudder/rudder-docs",
      )!;
      const original = (await skillSvc.getById(originalListItem.id))!;

      await skillSvc.importPackageFiles(orgId, {
        "skills/replacement-docs/SKILL.md": replacementMarkdown,
      });
      await skillSvc.importFromSource(orgId, localReplacementDir);

      const preserved = await skillSvc.getById(original.id);
      expect(preserved).toMatchObject({
        id: original.id,
        key: "rudder/rudder-docs",
        sourceType: "local_path",
        markdown: original.markdown,
        metadata: expect.objectContaining({ sourceKind: "rudder_bundled" }),
      });
    } finally {
      await fs.promises.rm(localReplacementDir, { recursive: true, force: true });
    }
  });

  it("migrates a community preset before editing without mutating its provenance source", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Community Skill Org",
      urlKey: "community-skill-org",
      issuePrefix: "CSO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Researcher",
      workspaceKey: "researcher",
      role: "researcher",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const community = (await skillSvc.list(orgId)).find((skill) => skill.slug === "deep-research")!;
    const provenanceFile = path.join(community.sourceLocator!, "SKILL.md");
    const original = await fs.promises.readFile(provenanceFile, "utf8");
    const edited = original.replace("# Deep Research", "# Organization Research");

    try {
      expect(community).toMatchObject({
        sourceBadge: "community",
        editable: true,
      });
      await skillSvc.updateFile(orgId, community.id, "SKILL.md", edited);
      await expect(fs.promises.readFile(provenanceFile, "utf8")).resolves.toBe(original);
      await expect(skillSvc.readFile(orgId, community.id, "SKILL.md")).resolves.toMatchObject({
        content: edited,
        editable: true,
      });

      const runtime = await skillSvc.listRealizedSkillEntriesForAgent(
        orgId,
        agentId,
        "codex_local",
        {},
        [`org:${community.key}`],
      );
      expect(runtime.find((entry) => entry.key === `org:${community.key}`)?.source)
        .toContain(`${path.sep}__installed__${path.sep}`);
    } finally {
      await fs.promises.writeFile(provenanceFile, original, "utf8");
    }
  });

  it("installs a complete catalog package while preserving catalog provenance", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Catalog Skill Org",
      urlKey: "catalog-skill-org",
      issuePrefix: "KSO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Catalog User",
      workspaceKey: "catalog-user",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const [result] = await skillSvc.importPackageFiles(orgId, {
      "skills/catalog-helper/SKILL.md": "---\nname: Catalog Helper\n---\n\n# Catalog Helper\n",
      "skills/catalog-helper/references/guide.md": "# Catalog guide\n",
      "skills/catalog-helper/scripts/run.sh": "echo catalog\n",
    });
    const skill = result!.skill;

    expect(skill).toMatchObject({
      sourceType: "catalog",
      sourceLocator: null,
      fileInventory: expect.arrayContaining([
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/run.sh", kind: "script" },
      ]),
    });
    const runtime = await skillSvc.listRealizedSkillEntriesForAgent(
      orgId,
      agentId,
      "codex_local",
      {},
      [`org:${skill.key}`],
    );
    const installedPath = runtime.find((entry) => entry.key === `org:${skill.key}`)?.source;
    expect(installedPath).toContain(`${path.sep}__installed__${path.sep}`);
    await expect(fs.promises.readFile(path.join(installedPath!, "references", "guide.md"), "utf8"))
      .resolves.toBe("# Catalog guide\n");
  });

  it("keeps local_path imports direct and editable without managed installation", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const localSkillDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rudder-direct-local-skill-"));
    await db.insert(organizations).values({
      id: orgId,
      name: "Direct Local Skill Org",
      urlKey: "direct-local-skill-org",
      issuePrefix: "DLS",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await fs.promises.mkdir(path.join(localSkillDir, "references"), { recursive: true });
    await fs.promises.writeFile(
      path.join(localSkillDir, "SKILL.md"),
      "---\nname: Direct Local\ndescription: Direct source.\n---\n\n# Direct Local\n",
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(localSkillDir, "references", "guide.md"),
      "# Direct guide\n",
      "utf8",
    );

    try {
      const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
      const skill = (await skillSvc.importFromSource(orgId, localSkillDir)).imported[0]!;

      expect(skill).toMatchObject({
        sourceType: "local_path",
        sourceLocator: path.resolve(localSkillDir),
      });
      expect(skill.metadata).not.toMatchObject({ installationVersion: 1 });

      const runtime = await skillSvc.listRuntimeSkillEntries(orgId);
      expect(runtime.find((entry) => entry.key === skill.key)?.source).toBe(path.resolve(localSkillDir));

      const edited = "# Edited direct guide\n";
      await skillSvc.updateFile(orgId, skill.id, "references/guide.md", edited);
      await expect(fs.promises.readFile(path.join(localSkillDir, "references", "guide.md"), "utf8"))
        .resolves.toBe(edited);
    } finally {
      await fs.promises.rm(localSkillDir, { recursive: true, force: true });
    }
  });

  it("clears managed installation state when a local_path import replaces a remote row", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const localSkillDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rudder-local-replacement-"));
    await db.insert(organizations).values({
      id: orgId,
      name: "Local Replacement Org",
      urlKey: "local-replacement-org",
      issuePrefix: "LRO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await fs.promises.writeFile(
      path.join(localSkillDir, "SKILL.md"),
      "---\nkey: acme/skills/direct-transition\nname: Direct Transition\n---\n\n# Local bytes\n",
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [{ path: "skills/direct-transition/SKILL.md", type: "blob" }],
        }));
      }
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Direct Transition\n---\n\n# Remote bytes\n");
      }
      return new Response("not found", { status: 404 });
    }));

    try {
      const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
      const remote = (await skillSvc.importFromSource(
        orgId,
        `https://github.com/acme/skills/tree/${PINNED_REF}/skills/direct-transition`,
      )).imported[0]!;
      expect(remote.metadata).toMatchObject({ installationVersion: 1 });
      const remoteRuntime = await skillSvc.listRuntimeSkillEntries(orgId);
      const installedPath = remoteRuntime.find((entry) => entry.key === remote.key)?.source;
      expect(installedPath).toContain(`${path.sep}__installed__${path.sep}`);

      const local = (await skillSvc.importFromSource(orgId, localSkillDir)).imported[0]!;
      expect(local.id).toBe(remote.id);
      expect(local).toMatchObject({
        sourceType: "local_path",
        sourceLocator: path.resolve(localSkillDir),
      });
      expect(local.metadata).not.toMatchObject({ installationVersion: 1 });
      const runtime = await skillSvc.listRuntimeSkillEntries(orgId);
      expect(runtime.find((entry) => entry.key === local.key)?.source).toBe(path.resolve(localSkillDir));
      await expect(fs.promises.stat(installedPath!).catch(() => null)).resolves.toBeNull();
    } finally {
      await fs.promises.rm(localSkillDir, { recursive: true, force: true });
    }
  });

  it("preserves the managed installation when a direct local replacement fails to persist", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const localSkillDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "rudder-direct-transition-rollback-"),
    );
    await db.insert(organizations).values({
      id: orgId,
      name: "Direct Transition Rollback Org",
      urlKey: "direct-transition-rollback-org",
      issuePrefix: "DTR",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await fs.promises.writeFile(
      path.join(localSkillDir, "SKILL.md"),
      "---\nkey: acme/skills/direct-transition\nname: Direct Transition\n---\n\n# Local\n",
      "utf8",
    );

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [{ path: "skills/direct-transition/SKILL.md", type: "blob" }],
        }));
      }
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Direct Transition\n---\n\n# Remote\n");
      }
      return new Response("not found", { status: 404 });
    }));

    try {
      const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
      const remote = (await skillSvc.importFromSource(
        orgId,
        `https://github.com/acme/skills/tree/${PINNED_REF}/skills/direct-transition`,
      )).imported[0]!;
      const runtime = await skillSvc.listRuntimeSkillEntries(orgId);
      const installedPath = runtime.find((entry) => entry.key === remote.key)?.source;
      expect(installedPath).toContain(`${path.sep}__installed__${path.sep}`);

      const realUpdate = db.update.bind(db);
      const updateSpy = vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
        const builder = realUpdate(table as never) as unknown as {
          set: (values: Record<string, unknown>) => unknown;
        };
        const realSet = builder.set.bind(builder);
        builder.set = (values: Record<string, unknown>) => {
          if (values.sourceType === "local_path") {
            throw new Error("simulated local transition persistence failure");
          }
          return realSet(values);
        };
        return builder;
      }) as typeof db.update);

      try {
        await expect(skillSvc.importFromSource(orgId, localSkillDir)).rejects.toThrow(
          "simulated local transition persistence failure",
        );
      } finally {
        updateSpy.mockRestore();
      }

      await expect(fs.promises.stat(installedPath!)).resolves.toMatchObject({});
      await expect(skillSvc.getById(remote.id)).resolves.toMatchObject({
        sourceType: "github",
        metadata: expect.objectContaining({ installationVersion: 1 }),
      });
    } finally {
      await fs.promises.rm(localSkillDir, { recursive: true, force: true });
    }
  });

  it("rejects using a managed installation as its own direct local replacement", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Managed Source Rejection Org",
      urlKey: "managed-source-rejection-org",
      issuePrefix: "MSR",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [{ path: "skills/direct-transition/SKILL.md", type: "blob" }],
        }));
      }
      if (url.endsWith("/SKILL.md")) {
        return new Response(
          "---\nkey: acme/skills/direct-transition\nname: Direct Transition\n---\n\n# Remote\n",
        );
      }
      return new Response("not found", { status: 404 });
    }));

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const remote = (await skillSvc.importFromSource(
      orgId,
      `https://github.com/acme/skills/tree/${PINNED_REF}/skills/direct-transition`,
    )).imported[0]!;
    const runtime = await skillSvc.listRuntimeSkillEntries(orgId);
    const installedPath = runtime.find((entry) => entry.key === remote.key)?.source;

    await expect(skillSvc.importFromSource(orgId, installedPath!)).rejects.toThrow(
      "Managed organization skill installations cannot be imported",
    );
    await expect(fs.promises.stat(path.join(installedPath!, "SKILL.md"))).resolves.toMatchObject({});
    await expect(skillSvc.getById(remote.id)).resolves.toMatchObject({
      sourceType: "github",
      metadata: expect.objectContaining({ installationVersion: 1 }),
    });
  });

  it("keeps a direct local replacement when legacy migration finishes later", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const skillId = randomUUID();
    const skillKey = "acme/skills/migration-race";
    const localSkillDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rudder-migration-race-"));
    await db.insert(organizations).values({
      id: orgId,
      name: "Migration Race Org",
      urlKey: "migration-race-org",
      issuePrefix: "MRO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Race Agent",
      workspaceKey: "race-agent",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });
    await db.insert(organizationSkills).values({
      id: skillId,
      orgId,
      key: skillKey,
      slug: "migration-race",
      name: "Migration Race",
      description: "Legacy remote row.",
      markdown: "---\nname: Migration Race\n---\n\n# Legacy\n",
      sourceType: "github",
      sourceLocator: `https://github.com/acme/skills/tree/${PINNED_REF}/skills/migration-race`,
      sourceRef: PINNED_REF,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: {
        sourceKind: "github",
        owner: "acme",
        repo: "skills",
        ref: PINNED_REF,
        trackingRef: "main",
        repoSkillDir: "skills/migration-race",
      },
    });
    await fs.promises.writeFile(
      path.join(localSkillDir, "SKILL.md"),
      `---\nkey: ${skillKey}\nname: Migration Race\n---\n\n# Local wins\n`,
      "utf8",
    );

    let releaseRemoteFetch!: () => void;
    const remoteFetchBlocked = new Promise<void>((resolve) => {
      releaseRemoteFetch = resolve;
    });
    let markRemoteFetchStarted!: () => void;
    const remoteFetchStarted = new Promise<void>((resolve) => {
      markRemoteFetchStarted = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [{ path: "skills/migration-race/SKILL.md", type: "blob" }],
        }));
      }
      if (url.endsWith("/SKILL.md")) {
        markRemoteFetchStarted();
        await remoteFetchBlocked;
        return new Response("---\nname: Migration Race\n---\n\n# Remote loses\n");
      }
      return new Response("not found", { status: 404 });
    }));

    try {
      const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
      const realization = skillSvc.listRealizedSkillEntriesForAgent(
        orgId,
        agentId,
        "codex_local",
        {},
        [`org:${skillKey}`],
      );
      await remoteFetchStarted;

      const local = (await skillSvc.importFromSource(orgId, localSkillDir)).imported[0]!;
      releaseRemoteFetch();
      const realized = await realization;

      expect(local).toMatchObject({
        id: skillId,
        sourceType: "local_path",
        sourceLocator: path.resolve(localSkillDir),
      });
      expect(realized.find((entry) => entry.key === `org:${skillKey}`)?.source)
        .toBe(path.resolve(localSkillDir));
      const stored = await skillSvc.getById(skillId);
      expect(stored).toMatchObject({
        sourceType: "local_path",
        sourceLocator: path.resolve(localSkillDir),
      });
      expect(stored?.metadata).not.toMatchObject({ installationVersion: 1 });
    } finally {
      releaseRemoteFetch();
      await fs.promises.rm(localSkillDir, { recursive: true, force: true });
    }
  });

  it("keeps list and detail reconciliation free of remote installation", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const skillId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Metadata Only Org",
      urlKey: "metadata-only-org",
      issuePrefix: "MDO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(organizationSkills).values({
      id: skillId,
      orgId,
      key: "acme/skills/metadata-only",
      slug: "metadata-only",
      name: "Metadata Only",
      description: "Must not download during metadata reads.",
      markdown: "---\nname: Metadata Only\n---\n",
      sourceType: "github",
      sourceLocator: "https://github.com/acme/skills/tree/main/skills/metadata-only",
      sourceRef: PINNED_REF,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: {
        sourceKind: "github",
        owner: "acme",
        repo: "skills",
        ref: PINNED_REF,
        trackingRef: "main",
        repoSkillDir: "skills/metadata-only",
      },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("metadata reads must stay offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    await expect(skillSvc.list(orgId)).resolves.toContainEqual(expect.objectContaining({
      id: skillId,
      editable: true,
    }));
    await expect(skillSvc.detail(orgId, skillId)).resolves.toMatchObject({
      id: skillId,
      editable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the previous installation when an update download fails", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Atomic Update Org",
      urlKey: "atomic-update-org",
      issuePrefix: "AUO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return githubTreeResponse();
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Offline Skill\ndescription: Stable.\n---\n\n# Stable\n");
      }
      if (url.endsWith("/references/guide.md")) return new Response("# Stable guide\n");
      if (url.endsWith("/scripts/run.sh")) return new Response("echo stable\n");
      return new Response("not found", { status: 404 });
    }));

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const pinnedSource = `https://github.com/acme/skills/tree/${PINNED_REF}/skills/offline-skill`;
    const skill = (await skillSvc.importFromSource(orgId, pinnedSource)).imported[0]!;
    const branchSource = "https://github.com/acme/skills/tree/main/skills/offline-skill";
    await db
      .update(organizationSkills)
      .set({
        sourceLocator: branchSource,
        metadata: {
          ...(skill.metadata ?? {}),
          trackingRef: "main",
        },
      })
      .where(eq(organizationSkills.id, skill.id));

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/main")) {
        return new Response(JSON.stringify({ sha: UPDATED_REF }));
      }
      if (url.includes("/git/trees/")) return githubTreeResponse();
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Offline Skill\ndescription: New.\n---\n\n# New\n");
      }
      if (url.endsWith("/references/guide.md")) {
        return new Response("download failed", { status: 503 });
      }
      if (url.endsWith("/scripts/run.sh")) return new Response("echo new\n");
      return new Response("not found", { status: 404 });
    }));

    await expect(skillSvc.installUpdate(orgId, skill.id)).rejects.toThrow(
      "Failed to fetch",
    );
    await expect(skillSvc.readFile(orgId, skill.id, "SKILL.md")).resolves.toMatchObject({
      content: "---\nname: Offline Skill\ndescription: Stable.\n---\n\n# Stable\n",
    });
    await expect(skillSvc.readFile(orgId, skill.id, "references/guide.md")).resolves.toMatchObject({
      content: "# Stable guide\n",
    });
  });

  it("restores the previous installation when update persistence fails", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Persistence Rollback Org",
      urlKey: "persistence-rollback-org",
      issuePrefix: "PRO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return githubTreeResponse();
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Offline Skill\ndescription: Stable.\n---\n\n# Stable\n");
      }
      if (url.endsWith("/references/guide.md")) return new Response("# Stable guide\n");
      if (url.endsWith("/scripts/run.sh")) return new Response("echo stable\n");
      return new Response("not found", { status: 404 });
    }));

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const pinnedSource = `https://github.com/acme/skills/tree/${PINNED_REF}/skills/offline-skill`;
    const skill = (await skillSvc.importFromSource(orgId, pinnedSource)).imported[0]!;
    await db
      .update(organizationSkills)
      .set({
        sourceLocator: "https://github.com/acme/skills/tree/main/skills/offline-skill",
        metadata: { ...(skill.metadata ?? {}), trackingRef: "main" },
      })
      .where(eq(organizationSkills.id, skill.id));

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/main")) {
        return new Response(JSON.stringify({ sha: UPDATED_REF }));
      }
      if (url.includes("/git/trees/")) return githubTreeResponse();
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Offline Skill\ndescription: New.\n---\n\n# New\n");
      }
      if (url.endsWith("/references/guide.md")) return new Response("# New guide\n");
      if (url.endsWith("/scripts/run.sh")) return new Response("echo new\n");
      return new Response("not found", { status: 404 });
    }));

    const realUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
      const builder = realUpdate(table as never) as unknown as {
        set: (values: Record<string, unknown>) => unknown;
      };
      const realSet = builder.set.bind(builder);
      builder.set = (values: Record<string, unknown>) => {
        if (values.sourceRef === UPDATED_REF) {
          throw new Error("simulated database persistence failure");
        }
        return realSet(values);
      };
      return builder;
    }) as typeof db.update);

    try {
      await expect(skillSvc.installUpdate(orgId, skill.id)).rejects.toThrow(
        "simulated database persistence failure",
      );
    } finally {
      updateSpy.mockRestore();
    }

    await expect(skillSvc.readFile(orgId, skill.id, "SKILL.md")).resolves.toMatchObject({
      content: "---\nname: Offline Skill\ndescription: Stable.\n---\n\n# Stable\n",
    });
    await expect(skillSvc.readFile(orgId, skill.id, "references/guide.md")).resolves.toMatchObject({
      content: "# Stable guide\n",
    });
  });

  it("deduplicates concurrent legacy remote migration", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const skillId = randomUUID();
    const skillKey = "acme/skills/legacy-skill";
    await db.insert(organizations).values({
      id: orgId,
      name: "Legacy Migration Org",
      urlKey: "legacy-migration-org",
      issuePrefix: "LMO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Migrator",
      workspaceKey: "migrator",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });
    await db.insert(organizationSkills).values({
      id: skillId,
      orgId,
      key: skillKey,
      slug: "legacy-skill",
      name: "Legacy Skill",
      description: "Legacy remote row.",
      markdown: "---\nname: Legacy Skill\ndescription: Legacy remote row.\n---\n",
      sourceType: "github",
      sourceLocator: `https://github.com/acme/skills/tree/${PINNED_REF}/skills/legacy-skill`,
      sourceRef: PINNED_REF,
      trustLevel: "scripts_executables",
      compatibility: "compatible",
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "references/guide.md", kind: "reference" },
      ],
      metadata: {
        sourceKind: "github",
        owner: "acme",
        repo: "skills",
        ref: PINNED_REF,
        repoSkillDir: "skills/legacy-skill",
      },
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [
            { path: "skills/legacy-skill/SKILL.md", type: "blob" },
            { path: "skills/legacy-skill/references/guide.md", type: "blob" },
          ],
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Legacy Skill\ndescription: Migrated.\n---\n");
      }
      if (url.endsWith("/references/guide.md")) return new Response("# Migrated guide\n");
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    const realize = () => skillSvc.listRealizedSkillEntriesForAgent(
      orgId,
      agentId,
      "codex_local",
      {},
      [`org:${skillKey}`],
    );
    const [first, second] = await Promise.all([realize(), realize()]);

    expect(first.find((entry) => entry.key === `org:${skillKey}`)?.source)
      .toBe(second.find((entry) => entry.key === `org:${skillKey}`)?.source);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/git/trees/"))).toHaveLength(1);
    const stored = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.id, skillId))
      .then((rows) => rows[0]!);
    expect(stored.metadata).toMatchObject({ installationVersion: 1 });
  });

  it("migrates a legacy branch row from its pinned sourceRef", { timeout: 30_000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const skillId = randomUUID();
    const skillKey = "acme/skills/pinned-legacy";
    await db.insert(organizations).values({
      id: orgId,
      name: "Pinned Legacy Org",
      urlKey: "pinned-legacy-org",
      issuePrefix: "PLO",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Pinned Migrator",
      workspaceKey: "pinned-migrator",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });
    await db.insert(organizationSkills).values({
      id: skillId,
      orgId,
      key: skillKey,
      slug: "pinned-legacy",
      name: "Pinned Legacy",
      description: "Pinned legacy row.",
      markdown: "---\nname: Pinned Legacy\n---\n",
      sourceType: "github",
      sourceLocator: "https://github.com/acme/skills/tree/main/skills/pinned-legacy",
      sourceRef: PINNED_REF,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: {
        sourceKind: "github",
        owner: "acme",
        repo: "skills",
        ref: PINNED_REF,
        trackingRef: "main",
        repoSkillDir: "skills/pinned-legacy",
      },
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/main")) {
        return new Response(JSON.stringify({ sha: UPDATED_REF }));
      }
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [{ path: "skills/pinned-legacy/SKILL.md", type: "blob" }],
        }));
      }
      if (url.endsWith("/SKILL.md")) {
        return new Response("---\nname: Pinned Legacy\n---\n\n# Pinned bytes\n");
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const skillSvc = organizationSkillService(db, { deploymentMode: "local_trusted" });
    await skillSvc.listRealizedSkillEntriesForAgent(
      orgId,
      agentId,
      "codex_local",
      {},
      [`org:${skillKey}`],
    );

    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes(`/git/trees/${PINNED_REF}`))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes(`/git/trees/${UPDATED_REF}`))).toBe(false);
    const stored = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.id, skillId))
      .then((rows) => rows[0]!);
    expect(stored.sourceRef).toBe(PINNED_REF);
    expect(stored.metadata).toMatchObject({
      ref: PINNED_REF,
      trackingRef: "main",
      installationVersion: 1,
    });
  });
});
