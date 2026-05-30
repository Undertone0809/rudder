import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@rudderhq/agent-runtime-opencode-local/server";

describe("opencode_local environment diagnostics", () => {
  it("creates a missing working directory before diagnostics when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `rudder-opencode-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    try {
      const result = await testEnvironment({
        orgId: "organization-1",
        agentRuntimeType: "opencode_local",
        config: {
          command: process.execPath,
          cwd,
        },
      });

      expect(result.checks.some((check) => check.code === "opencode_cwd_valid")).toBe(true);
      expect(result.checks.some((check) => check.code === "opencode_cwd_invalid")).toBe(false);
      expect(result.checks.some((check) => check.level === "error")).toBe(false);
      expect((await fs.stat(cwd)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(path.dirname(cwd), { recursive: true, force: true });
    }
  });

  it("treats an empty OPENAI_API_KEY override as missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-env-empty-key-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-host-value";

    try {
      const result = await testEnvironment({
        orgId: "organization-1",
        agentRuntimeType: "opencode_local",
        config: {
          command: process.execPath,
          cwd,
          env: {
            OPENAI_API_KEY: "",
          },
        },
      });

      const missingCheck = result.checks.find((check) => check.code === "opencode_openai_api_key_missing");
      expect(missingCheck).toBeTruthy();
      expect(missingCheck?.hint).toContain("empty");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("probes with the same managed home, XDG env, and pure mode used by execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-env-managed-"));
    const cwd = path.join(root, "workspace");
    const rudderHome = path.join(root, "rudder-home");
    const fakeOpencode = path.join(root, "opencode");
    const capturePath = path.join(root, "captures.jsonl");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      fakeOpencode,
      `#!/usr/bin/env node
const fs = require("node:fs");
const capture = {
  argv: process.argv.slice(2),
  home: process.env.HOME,
  xdgConfig: process.env.XDG_CONFIG_HOME,
  xdgData: process.env.XDG_DATA_HOME,
  xdgCache: process.env.XDG_CACHE_HOME,
};
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(capture) + "\\n", "utf8");
if (process.argv.includes("models")) {
  console.log("opencode/deepseek-v4-flash-free");
  process.exit(0);
}
console.log(JSON.stringify({ type: "text", part: { text: "hello" } }));
`,
      "utf8",
    );
    await fs.chmod(fakeOpencode, 0o755);

    try {
      const result = await testEnvironment({
        orgId: "organization-1",
        agentRuntimeType: "opencode_local",
        config: {
          command: fakeOpencode,
          cwd,
          model: "opencode/deepseek-v4-flash-free",
          env: {
            RUDDER_HOME: rudderHome,
            RUDDER_INSTANCE_ID: "test-instance",
          },
        },
      });

      expect(result.status).toBe("pass");
      const captures = (await fs.readFile(capturePath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      const runCapture = captures.find((capture) => capture.argv.includes("run"));
      expect(runCapture).toBeTruthy();
      expect(runCapture.argv).toContain("--pure");
      expect(runCapture.home).toBe(
        path.join(rudderHome, "instances", "test-instance", "organizations", "organization-1", "opencode-home", "agents", "environment-test"),
      );
      expect(runCapture.xdgConfig).toBe(path.join(runCapture.home, ".config"));
      expect(runCapture.xdgData).toBe(path.join(runCapture.home, ".local", "share"));
      expect(runCapture.xdgCache).toBe(path.join(runCapture.home, ".cache"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies ProviderModelNotFoundError probe output as model-unavailable warning", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-env-probe-cwd-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-env-probe-bin-"));
    const fakeOpencode = path.join(binDir, "opencode");
    const script = [
      "#!/bin/sh",
      "echo 'ProviderModelNotFoundError: ProviderModelNotFoundError' 1>&2",
      "echo 'data: { providerID: \"openai\", modelID: \"gpt-5.3-codex\", suggestions: [] }' 1>&2",
      "exit 1",
      "",
    ].join("\n");

    try {
      await fs.writeFile(fakeOpencode, script, "utf8");
      await fs.chmod(fakeOpencode, 0o755);

      const result = await testEnvironment({
        orgId: "organization-1",
        agentRuntimeType: "opencode_local",
        config: {
          command: fakeOpencode,
          cwd,
        },
      });

      const modelCheck = result.checks.find((check) => check.code === "opencode_hello_probe_model_unavailable");
      expect(modelCheck).toBeTruthy();
      expect(modelCheck?.level).toBe("warn");
      expect(result.status).toBe("warn");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });
});
