import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";
import { agentInstructionsService } from "../services/agent-instructions.js";

type TestAgent = {
  id: string;
  orgId: string;
  name: string;
  workspaceKey: string;
  agentRuntimeConfig: Record<string, unknown>;
};

const agentId = "11111111-1111-4111-8111-111111111111";
const orgId = "organization-1";
const agentName = "Agent 1";
const workspaceKey = buildAgentWorkspaceKey(agentName, agentId);

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAgent(agentRuntimeConfig: Record<string, unknown>): TestAgent {
  return {
    id: agentId,
    orgId,
    name: agentName,
    workspaceKey,
    agentRuntimeConfig,
  };
}

function managedInstructionsRoot(paperclipHome: string): string {
  return path.join(
    paperclipHome,
    "instances",
    "test-instance",
    "organizations",
    orgId,
    "workspaces",
    "agents",
    workspaceKey,
    "instructions",
  );
}

function legacyManagedInstructionsRoot(paperclipHome: string): string {
  return path.join(
    paperclipHome,
    "instances",
    "test-instance",
    "organizations",
    orgId,
    "agents",
    agentId,
    "instructions",
  );
}

describe("agent instructions service", () => {
  const originalPaperclipHome = process.env.RUDDER_HOME;
  const originalPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("copies the existing bundle into the managed root when switching to managed mode", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-home-");
    const externalRoot = await makeTempDir("rudder-agent-instructions-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, { mode: "managed" });

    expect(result.bundle.mode).toBe("managed");
    expect(result.bundle.managedRootPath).toBe(managedInstructionsRoot(paperclipHome));
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "docs/TOOLS.md"]);
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe("# External Agent\n");
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("includes MEMORY.md in default managed instruction bundles", async () => {
    await expect(loadDefaultAgentInstructionsBundle("default")).resolves.toEqual(expect.objectContaining({
      "AGENTS.md": expect.any(String),
      "MEMORY.md": expect.stringContaining("# Tacit Memory"),
    }));
    await expect(loadDefaultAgentInstructionsBundle("ceo")).resolves.toEqual(expect.objectContaining({
      "AGENTS.md": expect.any(String),
      "MEMORY.md": expect.stringContaining("# Tacit Memory"),
    }));
  });

  it("creates the target entry file when switching to a new external root", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-home-");
    const managedRoot = managedInstructionsRoot(paperclipHome);
    const externalRoot = await makeTempDir("rudder-agent-instructions-new-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, {
      mode: "external",
      rootPath: externalRoot,
      entryFile: "docs/AGENTS.md",
    });

    expect(result.bundle.mode).toBe("external");
    expect(result.bundle.rootPath).toBe(externalRoot);
    await expect(fs.readFile(path.join(externalRoot, "docs", "AGENTS.md"), "utf8")).resolves.toBe("# Managed Agent\n");
  });

  it("filters junk files, dependency bundles, and python caches from bundle listings and exports", async () => {
    const externalRoot = await makeTempDir("rudder-agent-instructions-ignore-");
    cleanupDirs.add(externalRoot);

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".DS_Store"), "junk", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "module.pyc"), "compiled", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "._TOOLS.md"), "appledouble", "utf8");
    await fs.mkdir(path.join(externalRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "node_modules", "pkg", "index.js"), "export {};\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "python", "__pycache__"), { recursive: true });
    await fs.writeFile(
      path.join(externalRoot, "python", "__pycache__", "module.cpython-313.pyc"),
      "compiled",
      "utf8",
    );
    await fs.mkdir(path.join(externalRoot, ".pytest_cache"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, ".pytest_cache", "README.md"), "cache", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.files.map((file) => file.path)).toEqual([".gitignore", "AGENTS.md", "docs/TOOLS.md"]);
    expect(Object.keys(exported.files).sort((left, right) => left.localeCompare(right))).toEqual([
      ".gitignore",
      "AGENTS.md",
      "docs/TOOLS.md",
    ]);
  });

  it("recovers a managed bundle from disk when bundle config metadata is missing", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-recover-");
    cleanupDirs.add(paperclipHome);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Recovered Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Recovered Agent\n" });
  });

  it("copies legacy root MEMORY.md into managed instructions when missing", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-memory-copy-");
    cleanupDirs.add(paperclipHome);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    const agentRoot = path.dirname(managedRoot);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");
    await fs.writeFile(path.join(agentRoot, "MEMORY.md"), "# Legacy Memory\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);

    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "MEMORY.md"]);
    await expect(fs.readFile(path.join(managedRoot, "MEMORY.md"), "utf8")).resolves.toBe("# Legacy Memory\n");
    await expect(fs.readFile(path.join(agentRoot, "MEMORY.md"), "utf8")).resolves.toBe("# Legacy Memory\n");
  });

  it("does not overwrite managed instructions MEMORY.md with legacy root memory", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-memory-keep-");
    cleanupDirs.add(paperclipHome);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    const agentRoot = path.dirname(managedRoot);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "MEMORY.md"), "# Managed Memory\n", "utf8");
    await fs.writeFile(path.join(agentRoot, "MEMORY.md"), "# Legacy Memory\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);

    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "MEMORY.md"]);
    await expect(fs.readFile(path.join(managedRoot, "MEMORY.md"), "utf8")).resolves.toBe("# Managed Memory\n");
  });

  it("prefers the managed bundle on disk when managed metadata points at a stale root", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-stale-managed-");
    const staleRoot = await makeTempDir("rudder-agent-instructions-stale-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });

  it("heals stale managed metadata when writing bundle files", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-heal-write-");
    const staleRoot = await makeTempDir("rudder-agent-instructions-heal-write-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.writeFile(agent, "docs/TOOLS.md", "## Tools\n");

    expect(result.agentRuntimeConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.readFile(path.join(managedRoot, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("heals stale managed metadata when deleting bundle files", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-heal-delete-");
    const staleRoot = await makeTempDir("rudder-agent-instructions-heal-delete-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.deleteFile(agent, "docs/TOOLS.md");

    expect(result.agentRuntimeConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.stat(path.join(managedRoot, "docs", "TOOLS.md"))).rejects.toThrow();
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("reconciles stale managed metadata into the org-scoped workspace config", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-reconcile-managed-");
    const staleRoot = await makeTempDir("rudder-agent-instructions-reconcile-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.reconcileBundle(agent);

    expect(result.changed).toBe(true);
    expect(result.agentRuntimeConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    expect(result.bundle.rootPath).toBe(managedRoot);
    expect(result.bundle.entryFile).toBe("AGENTS.md");
    expect(result.bundle.warnings).toEqual([]);
  });

  it("recovers the managed bundle when stale root metadata is present but mode is missing", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-partial-managed-");
    const staleRoot = await makeTempDir("rudder-agent-instructions-partial-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const managedRoot = managedInstructionsRoot(paperclipHome);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });

  it("does not read legacy managed instructions into the canonical workspace root", async () => {
    const paperclipHome = await makeTempDir("rudder-agent-instructions-legacy-managed-");
    cleanupDirs.add(paperclipHome);
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const legacyRoot = legacyManagedInstructionsRoot(paperclipHome);
    const managedRoot = managedInstructionsRoot(paperclipHome);
    await fs.mkdir(path.join(legacyRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "AGENTS.md"), "# Legacy Agent\n", "utf8");
    await fs.writeFile(path.join(legacyRoot, "docs", "TOOLS.md"), "## Legacy Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);

    expect(bundle.mode).toBeNull();
    expect(bundle.rootPath).toBeNull();
    expect(bundle.files).toEqual([]);
    await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(legacyRoot, "AGENTS.md"), "utf8")).resolves.toBe("# Legacy Agent\n");
  });
});
