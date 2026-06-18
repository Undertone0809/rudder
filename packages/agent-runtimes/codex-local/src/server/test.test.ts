import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("codex testEnvironment", () => {
  const originalPath = process.env.PATH;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
  });

  it("allows slow successful local probes by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-"));
    const command = path.join(tempDir, "codex");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => {",
        "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');",
        "}, 11_000);",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "codex_local",
        config: { cwd: process.cwd() },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.map((check) => check.code)).toContain("codex_hello_probe_passed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("sanitizes unsupported inherited service_tier values before probing Codex", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-envtest-"));
    const binDir = path.join(tempDir, "bin");
    const command = path.join(binDir, "codex");
    const sharedCodexHome = path.join(tempDir, "shared-codex-home");
    const rudderHome = path.join(tempDir, "rudder-home");
    const instanceId = "envtest";
    await mkdir(binDir, { recursive: true });
    await mkdir(sharedCodexHome, { recursive: true });
    await writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "gpt-5.5"',
        'service_tier = "default"',
        'model_reasoning_effort = "high"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
        "if (config.includes('service_tier = \"default\"')) {",
        "  process.stderr.write('Error loading config.toml: unknown variant `default`, expected `fast` or `flex`\\n');",
        "  process.exit(1);",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CODEX_HOME = sharedCodexHome;
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = instanceId;

    try {
      const result = await testEnvironment({
        orgId: "org-1",
        agentRuntimeType: "codex_local",
        config: {
          cwd: process.cwd(),
          env: {
            OPENAI_API_KEY: "test-key",
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.map((check) => check.code)).toContain("codex_hello_probe_passed");
      const managedConfig = await readFile(
        path.join(rudderHome, "instances", instanceId, "organizations", "org-1", "codex-home", "config.toml"),
        "utf8",
      );
      expect(managedConfig).toContain('model = "gpt-5.5"');
      expect(managedConfig).toContain('model_reasoning_effort = "high"');
      expect(managedConfig).not.toContain("service_tier");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
