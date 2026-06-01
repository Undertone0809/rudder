import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.RUDDER_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.RUDDER_PI_COMMAND = "__rudder_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `agentRuntimeConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.RUDDER_PI_COMMAND = "__rudder_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  it("creates a missing cwd before discovering configured models", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-models-"));
    const command = path.join(root, "pi");
    const cwd = path.join(root, "missing-workspace");
    await fs.writeFile(
      command,
      "#!/bin/sh\nprintf 'provider  model\\ndeepseek  deepseek-v4-pro\\n'\n",
      "utf8",
    );
    await fs.chmod(command, 0o755);

    await expect(
      ensurePiModelConfiguredAndAvailable({
        command,
        cwd,
        model: "deepseek/deepseek-v4-pro",
      }),
    ).resolves.toEqual([{ id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" }]);
    expect((await fs.stat(cwd)).isDirectory()).toBe(true);
  });

  it("discovers configured models when pi writes the model table to stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-models-"));
    const command = path.join(root, "pi");
    await fs.writeFile(
      command,
      "#!/bin/sh\nprintf 'provider   model\\ndeepseek   deepseek-v4-pro\\n' >&2\n",
      "utf8",
    );
    await fs.chmod(command, 0o755);

    await expect(
      ensurePiModelConfiguredAndAvailable({
        command,
        cwd: root,
        model: "deepseek/deepseek-v4-pro",
      }),
    ).resolves.toEqual([{ id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" }]);
  });

  it("lists models with a Rudder-managed Pi agent directory and sessions directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-models-managed-home-"));
    const command = path.join(root, "pi");
    const envCapturePath = path.join(root, "env.json");
    const rudderHome = path.join(root, "rudder-home");
    await fs.writeFile(
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.RUDDER_TEST_ENV_PATH, JSON.stringify({
  home: process.env.HOME,
  piAgentDir: process.env.PI_CODING_AGENT_DIR,
  piSessionDir: process.env.PI_CODING_AGENT_SESSION_DIR
}), "utf8");
console.log("provider  model");
console.log("deepseek  deepseek-v4-pro");
`,
      "utf8",
    );
    await fs.chmod(command, 0o755);

    await expect(
      listPiModels({
        orgId: "organization-1",
        config: {
          command,
          env: {
            RUDDER_HOME: rudderHome,
            RUDDER_INSTANCE_ID: "test-instance",
            RUDDER_TEST_ENV_PATH: envCapturePath,
          },
        },
      }),
    ).resolves.toEqual([{ id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" }]);

    const capturedEnv = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as {
      home: string;
      piAgentDir: string;
      piSessionDir: string;
    };
    const managedHome = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      "organization-1",
      "pi-home",
      "agents",
      "model-list",
    );
    expect(capturedEnv.home).toBe(managedHome);
    expect(capturedEnv.piAgentDir).toBe(path.join(managedHome, ".pi", "agent"));
    expect(capturedEnv.piSessionDir).toBe(path.join(managedHome, ".pi", "agent", "rudder-sessions"));
    await fs.rm(root, { recursive: true, force: true });
  });
});
