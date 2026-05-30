import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@rudderhq/agent-runtime-cursor-local/server";

async function writeFakeCursorAgentCommand(binDir: string, argsCapturePath: string): Promise<string> {
  const commandPath = path.join(binDir, "cursor-agent");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const outPath = process.env.RUDDER_TEST_ARGS_PATH;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)), "utf8");
}
const envPath = process.env.RUDDER_TEST_ENV_PATH;
if (envPath) {
  fs.writeFileSync(envPath, JSON.stringify({ home: process.env.HOME }), "utf8");
}
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "hello",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("cursor environment diagnostics", () => {
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `rudder-cursor-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "cursor_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("adds -f to hello probe args by default", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-cursor-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    const envCapturePath = path.join(root, "env.json");
    const rudderHome = path.join(root, "rudder-home");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCursorAgentCommand(binDir, argsCapturePath);

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        command: "cursor-agent",
        cwd,
        env: {
          CURSOR_API_KEY: "test-key",
          RUDDER_TEST_ARGS_PATH: argsCapturePath,
          RUDDER_TEST_ENV_PATH: envCapturePath,
          RUDDER_HOME: rudderHome,
          RUDDER_INSTANCE_ID: "test-instance",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args).toContain("-f");
    expect(args).not.toContain("--workspace");
    expect(args).not.toContain("--mode");
    const capturedEnv = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as { home: string };
    expect(capturedEnv.home).toBe(
      path.join(rudderHome, "instances", "test-instance", "organizations", "organization-1", "cursor-home", "agents", "environment-test"),
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not auto-add -f when extraArgs already bypass trust", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-cursor-local-probe-extra-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCursorAgentCommand(binDir, argsCapturePath);

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        command: "cursor-agent",
        cwd,
        extraArgs: ["-f"],
        env: {
          CURSOR_API_KEY: "test-key",
          RUDDER_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args.filter((arg) => arg === "-f")).toHaveLength(1);
    expect(args).not.toContain("--trust");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("classifies interactive Cursor sign-in output as auth required", async () => {
    const root = path.join(
      os.tmpdir(),
      `rudder-cursor-local-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(binDir, "cursor-agent");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      commandPath,
      "#!/bin/sh\nprintf 'Press any key to sign in...\\n'\nexit 1\n",
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    const result = await testEnvironment({
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        command: "cursor-agent",
        cwd,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.find((check) => check.code === "cursor_hello_probe_auth_required")).toBeTruthy();
    await fs.rm(root, { recursive: true, force: true });
  });
});
