import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverPiModels,
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

  it("discovers models when Pi prints its table to stderr", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pi-models-"));
    const command = path.join(tempDir, "pi-fixture.mjs");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('provider   model                       context  max-out  thinking  images\\n');",
        "process.stderr.write('anthropic  claude-3-5-haiku-20241022   200K     8.2K     no        yes\\n');",
        "process.stderr.write('opencode   deepseek-v4-flash-free      128K     8K       no        no\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);

    try {
      const models = await discoverPiModels({
        command,
        cwd: process.cwd(),
        env: {},
      });

      expect(models.map((entry) => entry.id)).toEqual([
        "anthropic/claude-3-5-haiku-20241022",
        "opencode/deepseek-v4-flash-free",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
