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
    process.env.RUDDER_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `agentRuntimeConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.RUDDER_PI_COMMAND = "__paperclip_missing_pi_command__";
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
});
