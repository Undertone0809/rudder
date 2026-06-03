import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureManagedPiDeepSeekConfig, prepareManagedPiHome, resolvePiSessionsDir } from "./home.js";

describe("managed Pi home", () => {
  it("does not copy host Pi sessions and removes stale default session copies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-home-"));
    const sourceHome = path.join(root, "operator-home");
    const rudderHome = path.join(root, "rudder-home");
    const managedHome = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      "organization-1",
      "pi-home",
      "agents",
      "agent-1",
    );
    const hostSessionFile = path.join(sourceHome, ".pi", "agent", "sessions", "host-session.jsonl");
    const staleManagedSessionFile = path.join(managedHome, ".pi", "agent", "sessions", "stale-host-copy.jsonl");
    await fs.mkdir(path.dirname(hostSessionFile), { recursive: true });
    await fs.mkdir(path.dirname(staleManagedSessionFile), { recursive: true });
    await fs.writeFile(hostSessionFile, "host session", "utf8");
    await fs.writeFile(staleManagedSessionFile, "stale host copy", "utf8");

    try {
      const preparedHome = await prepareManagedPiHome({
        env: {
          HOME: sourceHome,
          RUDDER_HOME: rudderHome,
          RUDDER_INSTANCE_ID: "test-instance",
        },
        orgId: "organization-1",
        agentId: "agent-1",
      });

      expect(preparedHome).toBe(managedHome);
      await expect(fs.access(staleManagedSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(managedHome, ".pi", "agent", "sessions", "host-session.jsonl"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.access(resolvePiSessionsDir(managedHome))).resolves.toBeUndefined();
      await expect(fs.readdir(resolvePiSessionsDir(managedHome))).resolves.toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("writes DeepSeek models into the managed home without persisting the key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-home-deepseek-"));
    const managedHome = path.join(root, "managed-home");

    try {
      await ensureManagedPiDeepSeekConfig({
        env: { DEEPSEEK_API_KEY: "sk-test-secret" },
        homeDir: managedHome,
      });

      const modelsPath = path.join(managedHome, ".pi", "agent", "models.json");
      const raw = await fs.readFile(modelsPath, "utf8");
      expect(raw).not.toContain("sk-test-secret");
      const config = JSON.parse(raw) as {
        providers?: {
          deepseek?: {
            apiKey?: string;
            models?: Array<{ id?: string; name?: string }>;
          };
        };
      };
      expect(config.providers?.deepseek?.apiKey).toBe("DEEPSEEK_API_KEY");
      expect(config.providers?.deepseek?.models?.map((model) => model.id)).toEqual([
        "deepseek-v4-flash",
        "deepseek-v4-pro",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not write DeepSeek config unless the key is available", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-home-no-deepseek-"));
    const managedHome = path.join(root, "managed-home");

    try {
      await ensureManagedPiDeepSeekConfig({
        env: {},
        homeDir: managedHome,
      });

      await expect(fs.access(path.join(managedHome, ".pi", "agent", "models.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
