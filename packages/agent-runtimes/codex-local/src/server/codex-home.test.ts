import { applyRudderBrowserCapabilityEnv } from "@rudderhq/agent-runtime-utils";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

describe("managed Codex home config sync", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function prepareWithSharedConfig(
    configToml: string,
    mcpEnv: Record<string, string> = {},
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-home-"));
    tempRoots.push(root);

    const sharedCodexHome = path.join(root, "shared-codex-home");
    await mkdir(sharedCodexHome, { recursive: true });
    await writeFile(path.join(sharedCodexHome, "config.toml"), configToml, "utf8");

    const logs: string[] = [];
    const codexHome = await prepareManagedCodexHome(
      {
        CODEX_HOME: sharedCodexHome,
        RUDDER_HOME: path.join(root, "rudder-home"),
        RUDDER_INSTANCE_ID: "prod-local-test",
      },
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      "org-1",
      "agent-1",
      undefined,
      undefined,
      mcpEnv,
    );

    return {
      codexHome,
      config: await readFile(path.join(codexHome, "config.toml"), "utf8"),
      logs,
    };
  }

  it.each([
    { enabled: true, expected: "true", untrusted: "false" },
    { enabled: false, expected: "false", untrusted: "true" },
  ])("renders the trusted Browser capability into managed MCP TOML ($expected)", async ({ enabled, expected, untrusted }) => {
    const mcpEnv = { RUDDER_BROWSER_ENABLED: untrusted };
    applyRudderBrowserCapabilityEnv(mcpEnv, { rudderBrowserEnabled: enabled });

    const { config } = await prepareWithSharedConfig('model = "gpt-5.5"\n', mcpEnv);

    expect(config).toContain(`[mcp_servers.rudder-control-plane.env]`);
    expect(config).toContain(`RUDDER_BROWSER_ENABLED = "${expected}"`);
  });

  it("strips inherited Codex service_tier default values unsupported by current Codex", async () => {
    const { config, logs } = await prepareWithSharedConfig([
      'model = "gpt-5.5"',
      'service_tier = "default"',
      'model_reasoning_effort = "high"',
      "",
    ].join("\n"));

    expect(config).toContain('model = "gpt-5.5"');
    expect(config).toContain('model_reasoning_effort = "high"');
    expect(config).not.toContain("service_tier");
    expect(logs.join("\n")).toContain("Removed 1 unsupported inherited Codex service_tier entry");
  });

  it("preserves Codex service_tier values accepted by current Codex", async () => {
    const { config } = await prepareWithSharedConfig([
      'model = "gpt-5.5"',
      'service_tier = "fast"',
      "",
    ].join("\n"));

    expect(config).toContain('service_tier = "fast"');
  });

  it("refreshes managed config from the shared Codex config instead of keeping stale provider settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-home-refresh-"));
    tempRoots.push(root);

    const sharedCodexHome = path.join(root, "shared-codex-home");
    const sharedConfigPath = path.join(sharedCodexHome, "config.toml");
    const env = {
      CODEX_HOME: sharedCodexHome,
      RUDDER_HOME: path.join(root, "rudder-home"),
      RUDDER_INSTANCE_ID: "prod-local-test",
    };
    const logs: string[] = [];

    await mkdir(sharedCodexHome, { recursive: true });
    await writeFile(sharedConfigPath, [
      'model_provider = "custom"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'base_url = "https://sub.zeeland.studio/backend-api/codex"',
      'wire_api = "responses"',
      "",
    ].join("\n"), "utf8");

    const codexHome = await prepareManagedCodexHome(
      env,
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      "org-1",
      "agent-1",
    );
    const initialConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(initialConfig).toContain('base_url = "https://sub.zeeland.studio/backend-api/codex"');

    await writeFile(path.join(codexHome, "config.toml"), [
      'model_provider = "stale"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.stale]",
      'base_url = "https://stale.example.invalid"',
      "",
    ].join("\n"), "utf8");

    await writeFile(sharedConfigPath, [
      'model = "gpt-5.5"',
      'service_tier = "default"',
      "",
    ].join("\n"), "utf8");

    await prepareManagedCodexHome(
      env,
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      "org-1",
      "agent-1",
    );

    const refreshedConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(refreshedConfig).not.toContain("sub.zeeland.studio");
    expect(refreshedConfig).not.toContain("stale.example.invalid");
    expect(refreshedConfig).not.toContain('model_provider = "custom"');
    expect(refreshedConfig).not.toContain('model_provider = "stale"');
    expect(refreshedConfig).not.toContain("service_tier");
    expect(refreshedConfig).toContain('model = "gpt-5.5"');
  });

  it("copies shared auth when symlink creation is denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-home-auth-copy-"));
    tempRoots.push(root);

    const sharedCodexHome = path.join(root, "shared-codex-home");
    await mkdir(sharedCodexHome, { recursive: true });
    await writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");

    vi.spyOn(fs, "symlink").mockImplementation(async () => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    const logs: string[] = [];
    const codexHome = await prepareManagedCodexHome(
      {
        CODEX_HOME: sharedCodexHome,
        RUDDER_HOME: path.join(root, "rudder-home"),
        RUDDER_INSTANCE_ID: "prod-local-test",
      },
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      "org-1",
      "agent-1",
    );

    const managedAuthPath = path.join(codexHome, "auth.json");
    expect((await fs.lstat(managedAuthPath)).isFile()).toBe(true);
    expect(await readFile(managedAuthPath, "utf8")).toBe('{"token":"shared"}\n');
    expect(logs.join("\n")).toContain("because this environment cannot create symlinks");
  });
});
