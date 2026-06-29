import { testEnvironment } from "@rudderhq/agent-runtime-pi-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function writeFakePiCommand(
  binDir: string,
  mode: "success" | "opencode-anonymous-success" | "auth-required" | "membership-required" | "stale-package",
): Promise<void> {
  const commandPath = path.join(binDir, "pi");
  const script =
    mode === "success"
      ? `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("openai    gpt-4.1-mini");
  process.exit(0);
}
console.log(JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } }
  },
  toolResults: []
}));
`
      : mode === "opencode-anonymous-success"
        ? `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("opencode  deepseek-v4-flash-free");
  process.exit(0);
}
const modelsPath = path.join(process.env.PI_CODING_AGENT_DIR || "", "models.json");
let ok = false;
try {
  const config = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  ok = config.providers?.opencode?.apiKey === "RUDDER_OPENCODE_ANONYMOUS" &&
    config.providers?.opencode?.authHeader === false &&
    config.providers?.opencode?.headers?.Authorization === "";
} catch {}
if (!ok) {
  console.error("No API key found for opencode.");
  process.exit(1);
}
console.log(JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } }
  },
  toolResults: []
}));
`
      : mode === "auth-required"
        ? `#!/usr/bin/env node
	if (process.argv.includes("--list-models")) {
	  console.log("provider  model");
	  console.log("kimi-coding  kimi-for-coding");
	  process.exit(0);
	}
	console.error('No API key found for deepseek.');
	process.exit(1);
	`
        : mode === "membership-required"
          ? `#!/usr/bin/env node
	if (process.argv.includes("--list-models")) {
	  console.log("provider  model");
	  console.log("kimi-coding  kimi-for-coding");
	  process.exit(0);
	}
	console.log(JSON.stringify({
	  type: "turn_end",
	  message: {
	    role: "assistant",
	    stopReason: "error",
	    errorMessage: "402 {\\\"error\\\":{\\\"message\\\":\\\"We're unable to verify your membership benefits at this time. Please ensure your membership is active.\\\"}}"
	  }
	}));
	process.exit(0);
	`
          : `#!/usr/bin/env node
	if (process.argv.includes("--list-models")) {
	  console.error("npm error 404 'pi-driver@*' is not in this registry.");
	  process.exit(1);
}
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi_local environment diagnostics", () => {
  it("passes a hello probe when model discovery and execution succeed", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-pi-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "success");

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
      config: {
        command: "pi",
        cwd,
        model: "openai/gpt-4.1-mini",
        env: {
          OPENAI_API_KEY: "test-key",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "pi_models_discovered")).toBe(true);
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("passes a hello probe when a custom model is not in discovered suggestions", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-pi-local-custom-model-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "success");

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
      config: {
        command: "pi",
        cwd,
        model: "deepseek/deepseek-chat",
        env: {
          DEEPSEEK_API_KEY: "test-key",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    const customModelCheck = result.checks.find((check) => check.code === "pi_model_not_discovered");
    expect(customModelCheck?.level).toBe("info");
    expect(customModelCheck?.hint).toContain("hello probe");
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("prepares managed OpenCode anonymous model config before the Pi hello probe", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-pi-local-opencode-anonymous-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const operatorModelsPath = path.join(root, ".pi", "agent", "models.json");
    const operatorSettingsPath = path.join(root, ".pi", "agent", "settings.json");
    const managedModelsPath = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "pi-home",
      ".pi",
      "agent",
      "models.json",
    );
    const managedSettingsPath = path.join(path.dirname(managedModelsPath), "settings.json");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.dirname(operatorModelsPath), { recursive: true });
    await fs.mkdir(path.dirname(managedSettingsPath), { recursive: true });
    await fs.writeFile(operatorModelsPath, JSON.stringify({ providers: { privateProvider: { apiKey: "PRIVATE" } } }), "utf8");
    await fs.writeFile(operatorSettingsPath, JSON.stringify({ packages: ["operator-only-package"] }), "utf8");
    await fs.symlink(operatorSettingsPath, managedSettingsPath);
    await writeFakePiCommand(binDir, "opencode-anonymous-success");

    const previous = {
      HOME: process.env.HOME,
      RUDDER_HOME: process.env.RUDDER_HOME,
      RUDDER_INSTANCE_ID: process.env.RUDDER_INSTANCE_ID,
      OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    };
    process.env.HOME = root;
    process.env.RUDDER_HOME = path.join(root, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "default";
    delete process.env.OPENCODE_API_KEY;

    try {
      const result = await testEnvironment({
        orgId: "organization-1",
        agentRuntimeType: "pi_local",
        config: {
          command: "pi",
          cwd,
          model: "opencode/deepseek-v4-flash-free",
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RUDDER_HOME: path.join(root, ".rudder"),
            RUDDER_INSTANCE_ID: "default",
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "pi_hello_probe_auth_required")).toBe(false);
      expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
      const managedModels = JSON.parse(await fs.readFile(managedModelsPath, "utf8"));
      expect(managedModels).toEqual({
        providers: {
          opencode: {
            apiKey: "RUDDER_OPENCODE_ANONYMOUS",
            authHeader: false,
            headers: {
              Authorization: "",
            },
          },
        },
      });
      const operatorModels = JSON.parse(await fs.readFile(operatorModelsPath, "utf8"));
      expect(operatorModels).toEqual({ providers: { privateProvider: { apiKey: "PRIVATE" } } });
      await expect(fs.lstat(managedSettingsPath)).rejects.toMatchObject({ code: "ENOENT" });
      const operatorSettings = JSON.parse(await fs.readFile(operatorSettingsPath, "utf8"));
      expect(operatorSettings).toEqual({ packages: ["operator-only-package"] });
    } finally {
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.RUDDER_HOME === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previous.RUDDER_HOME;
      if (previous.RUDDER_INSTANCE_ID === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previous.RUDDER_INSTANCE_ID;
      if (previous.OPENCODE_API_KEY === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous.OPENCODE_API_KEY;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces the provider-specific API key when DeepSeek auth is missing", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-pi-local-deepseek-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "auth-required");

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
      config: {
        command: "pi",
        cwd,
        model: "deepseek/deepseek-chat",
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    const authCheck = result.checks.find((check) => check.code === "pi_hello_probe_auth_required");
    expect(result.status).toBe("warn");
    expect(authCheck?.level).toBe("warn");
    expect(authCheck?.hint).toContain("DEEPSEEK_API_KEY");
    expect(authCheck?.hint).toContain("Pi /login");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("surfaces Pi membership entitlement errors as auth readiness warnings", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-pi-local-membership-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "membership-required");

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
      config: {
        command: "pi",
        cwd,
        model: "kimi-coding/kimi-for-coding",
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    const authCheck = result.checks.find((check) => check.code === "pi_hello_probe_auth_required");
    expect(result.status).toBe("warn");
    expect(authCheck?.level).toBe("warn");
    expect(authCheck?.detail).toContain("membership benefits");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails before hello probe when model is not provider/model", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-pi-local-invalid-model-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "success");

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
      config: {
        command: "pi",
        cwd,
        model: "deepseek-chat",
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.code === "pi_model_invalid")?.level).toBe("error");
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("surfaces stale configured package installs with a targeted hint", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-pi-local-stale-package-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakePiCommand(binDir, "stale-package");

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
      config: {
        command: "pi",
        cwd,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    const stalePackageCheck = result.checks.find((check) => check.code === "pi_package_install_failed");
    expect(stalePackageCheck?.level).toBe("warn");
    expect(stalePackageCheck?.hint).toContain("Remove `npm:pi-driver`");
    await fs.rm(root, { recursive: true, force: true });
  });
});
