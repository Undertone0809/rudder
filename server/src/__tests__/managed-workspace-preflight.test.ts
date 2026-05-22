import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_WORKSPACE_CONFIGURATION_ERROR_CODE,
  preflightManagedAgentWorkspace,
  WORKSPACE_PERMISSION_REPAIR_NEEDED_CODE,
} from "../services/managed-workspace-preflight.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function layout(root: string) {
  return {
    agentHome: root,
    instructionsDir: path.join(root, "instructions"),
    memoryDir: path.join(root, "memory"),
    lifeDir: path.join(root, "life"),
    skillsDir: path.join(root, "skills"),
  };
}

describe("managed workspace preflight", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("creates missing managed agent workspace directories and verifies writability", async () => {
    const root = path.join(await makeTempDir("rudder-workspace-preflight-"), "agent-home");
    cleanupDirs.add(path.dirname(root));

    await preflightManagedAgentWorkspace(layout(root));

    await expect(fs.stat(root).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(root, "instructions")).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(root, "memory")).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(root, "life")).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(root, "skills")).then((stat) => stat.isDirectory())).resolves.toBe(true);
  });

  it("fails before runtime execution when a managed path cannot be repaired as a writable directory", async () => {
    const root = path.join(await makeTempDir("rudder-workspace-preflight-file-"), "agent-home");
    cleanupDirs.add(path.dirname(root));
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "life"), "not a directory", "utf8");

    await expect(preflightManagedAgentWorkspace(layout(root))).rejects.toMatchObject({
      errorCode: WORKSPACE_PERMISSION_REPAIR_NEEDED_CODE,
      failure: {
        kind: "life",
        operation: "mkdir",
      },
    });
  });

  it("reports missing managed paths as runtime configuration errors without touching the filesystem", async () => {
    const root = await makeTempDir("rudder-workspace-preflight-empty-");
    cleanupDirs.add(root);

    await expect(preflightManagedAgentWorkspace({
      ...layout(path.join(root, "agent-home")),
      lifeDir: "",
    })).rejects.toMatchObject({
      errorCode: MANAGED_WORKSPACE_CONFIGURATION_ERROR_CODE,
      failure: {
        kind: "life",
        operation: "configure",
        code: "MISSING_PATH",
      },
    });
  });
});
