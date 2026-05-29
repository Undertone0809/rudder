import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.RUDDER_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.RUDDER_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `agentRuntimeConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.RUDDER_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("creates a missing cwd before discovering configured models", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-models-"));
    const command = path.join(root, "opencode");
    const cwd = path.join(root, "missing-workspace");
    await fs.writeFile(command, "#!/bin/sh\nprintf 'deepseek/deepseek-v4-pro\\n'\n", "utf8");
    await fs.chmod(command, 0o755);

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        command,
        cwd,
        model: "deepseek/deepseek-v4-pro",
      }),
    ).resolves.toEqual([{ id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" }]);
    expect((await fs.stat(cwd)).isDirectory()).toBe(true);
  });

  it("scopes configured model discovery to the provider", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-models-provider-"));
    const command = path.join(root, "opencode");
    const capturePath = path.join(root, "argv.json");
    await fs.writeFile(
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)), "utf8");
if (process.argv[2] === "models" && process.argv[3] === "deepseek") {
  console.log("deepseek/deepseek-v4-pro");
  process.exit(0);
}
console.error("unexpected argv", process.argv.slice(2).join(" "));
process.exit(1);
`,
      "utf8",
    );
    await fs.chmod(command, 0o755);

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        command,
        cwd: root,
        model: "deepseek/deepseek-v4-pro",
      }),
    ).resolves.toEqual([{ id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" }]);
    await expect(fs.readFile(capturePath, "utf8").then(JSON.parse)).resolves.toEqual([
      "models",
      "deepseek",
    ]);
  });
});
