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
    delete process.env.PI_CODING_AGENT_DIR;
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

  it("rejects when model is not in provider/model format", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "deepseek-chat" }),
    ).rejects.toThrow("Pi requires `agentRuntimeConfig.model`");
  });

  it("allows custom provider/model when discovery cannot run", async () => {
    process.env.RUDDER_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).resolves.toEqual([]);
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

      expect(models).toEqual([
        {
          id: "anthropic/claude-3-5-haiku-20241022",
          label: "anthropic/claude-3-5-haiku-20241022",
          capabilities: { reasoning: false },
        },
        {
          id: "opencode/deepseek-v4-flash-free",
          label: "opencode/deepseek-v4-flash-free",
          capabilities: { reasoning: false },
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses Pi's official thinkingLevelMap from models.json", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pi-models-"));
    const command = path.join(tempDir, "pi-fixture.mjs");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('provider   model             context  max-out  thinking  images\\n');",
        "process.stdout.write('openai     gpt-5.6-luna     128K     16K      yes       no\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    await writeFile(
      path.join(tempDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            models: [{
              id: "gpt-5.6-luna",
              reasoning: true,
              thinkingLevelMap: {
                off: "none",
                minimal: "minimal",
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: "max",
              },
            }],
          },
        },
      }),
      "utf8",
    );

    try {
      const models = await discoverPiModels({
        command,
        cwd: process.cwd(),
        env: { PI_CODING_AGENT_DIR: tempDir },
      });

      expect(models).toEqual([{
        id: "openai/gpt-5.6-luna",
        label: "openai/gpt-5.6-luna",
        variants: ["off", "minimal", "low", "medium", "high", "xhigh"],
        capabilities: { reasoning: true },
      }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps omitted map entries on Pi's provider defaults and hides explicit null entries", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pi-models-"));
    const command = path.join(tempDir, "pi-fixture.mjs");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('provider   model             context  max-out  thinking  images\\n');",
        "process.stdout.write('openai     custom-reasoner  128K     16K      yes       no\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    await writeFile(
      path.join(tempDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            models: [{
              id: "custom-reasoner",
              reasoning: true,
              thinkingLevelMap: { low: null },
            }],
          },
        },
      }),
      "utf8",
    );

    try {
      await expect(discoverPiModels({
        command,
        cwd: process.cwd(),
        env: { PI_CODING_AGENT_DIR: tempDir },
      })).resolves.toEqual([{
        id: "openai/custom-reasoner",
        label: "openai/custom-reasoner",
        variants: ["off", "minimal", "medium", "high"],
        capabilities: { reasoning: true },
      }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses Pi's official defaults when thinkingLevelMap is omitted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pi-models-"));
    const command = path.join(tempDir, "pi-fixture.mjs");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('provider   model             context  max-out  thinking  images\\n');",
        "process.stdout.write('openai     default-reasoner  128K     16K      yes       no\\n');",
        "process.stdout.write('openai     no-reasoner       128K     16K      no        no\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    await writeFile(
      path.join(tempDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            models: [
              { id: "default-reasoner", reasoning: true },
              { id: "no-reasoner", reasoning: false },
            ],
          },
        },
      }),
      "utf8",
    );

    try {
      await expect(discoverPiModels({
        command,
        cwd: process.cwd(),
        env: { PI_CODING_AGENT_DIR: tempDir },
      })).resolves.toEqual([
        {
          id: "openai/default-reasoner",
          label: "openai/default-reasoner",
          variants: ["off", "minimal", "low", "medium", "high"],
          capabilities: { reasoning: true },
        },
        {
          id: "openai/no-reasoner",
          label: "openai/no-reasoner",
          variants: ["off"],
          capabilities: { reasoning: false },
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps custom Pi models ahead of same-id modelOverrides", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pi-models-"));
    const command = path.join(tempDir, "pi-fixture.mjs");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('provider   model             context  max-out  thinking  images\\n');",
        "process.stdout.write('openai     custom-model     128K     16K      yes       no\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);
    await writeFile(
      path.join(tempDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            modelOverrides: {
              "custom-model": { name: "Override", reasoning: false },
            },
            models: [{
              id: "custom-model",
              name: "Custom",
              reasoning: true,
              thinkingLevelMap: { xhigh: "max" },
            }],
          },
        },
      }),
      "utf8",
    );

    try {
      await expect(discoverPiModels({
        command,
        cwd: process.cwd(),
        env: { PI_CODING_AGENT_DIR: tempDir },
      })).resolves.toEqual([{
        id: "openai/custom-model",
        label: "Custom",
        variants: ["off", "minimal", "low", "medium", "high", "xhigh"],
        capabilities: { reasoning: true },
      }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows configured provider/model values that are not in discovered suggestions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pi-models-"));
    const command = path.join(tempDir, "pi-fixture.mjs");
    await writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('provider   model                       context  max-out  thinking  images\\n');",
        "process.stderr.write('kimi-coding  kimi-for-coding            128K     8K       no        no\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(command, 0o755);

    try {
      await expect(
        ensurePiModelConfiguredAndAvailable({
          model: "deepseek/deepseek-chat",
          command,
          cwd: process.cwd(),
          env: {},
        }),
      ).resolves.toEqual([
        {
          id: "kimi-coding/kimi-for-coding",
          label: "kimi-coding/kimi-for-coding",
          capabilities: { reasoning: false },
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
