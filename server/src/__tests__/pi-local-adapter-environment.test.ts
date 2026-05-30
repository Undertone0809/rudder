import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@rudderhq/agent-runtime-pi-local/server";

async function writeFakePiCommand(binDir: string, mode: "success" | "stale-package"): Promise<void> {
  const commandPath = path.join(binDir, "pi");
  const script =
    mode === "success"
      ? `#!/usr/bin/env node
const fs = require("node:fs");
const envPath = process.env.RUDDER_TEST_ENV_PATH;
if (envPath) {
  fs.writeFileSync(envPath, JSON.stringify({ home: process.env.HOME }), "utf8");
}
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
    const envCapturePath = path.join(root, "env.json");
    const rudderHome = path.join(root, "rudder-home");
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
          RUDDER_TEST_ENV_PATH: envCapturePath,
          RUDDER_HOME: rudderHome,
          RUDDER_INSTANCE_ID: "test-instance",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "pi_models_discovered")).toBe(true);
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    const capturedEnv = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as { home: string };
    expect(capturedEnv.home).toBe(
      path.join(rudderHome, "instances", "test-instance", "organizations", "organization-1", "pi-home", "agents", "environment-test"),
    );
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
    expect(result.status).toBe("fail");
    expect(stalePackageCheck?.level).toBe("error");
    expect(stalePackageCheck?.hint).toContain("Remove `npm:pi-driver`");
    await fs.rm(root, { recursive: true, force: true });
  });
});
