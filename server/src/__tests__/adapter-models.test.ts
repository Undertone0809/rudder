import { models as codexFallbackModels } from "@rudderhq/agent-runtime-codex-local";
import { models as cursorFallbackModels } from "@rudderhq/agent-runtime-cursor-local";
import { resetOpenCodeModelsCacheForTests } from "@rudderhq/agent-runtime-opencode-local/server";
import { models as piFallbackModels } from "@rudderhq/agent-runtime-pi-local";
import { resetPiModelsCacheForTests } from "@rudderhq/agent-runtime-pi-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCodexModelsCacheForTests } from "../agent-runtimes/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../agent-runtimes/cursor-models.js";
import { discoverAgentRuntimeModels, listAgentRuntimeModels } from "../agent-runtimes/index.js";

async function writeFakeCommand(
  name: string,
  content: string,
): Promise<{ command: string; root: string }> {
  const root = path.join(
    os.tmpdir(),
    `rudder-adapter-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const command = path.join(root, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(command, content, "utf8");
  await fs.chmod(command, 0o755);
  return { command, root };
}

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.RUDDER_CODEX_COMMAND;
    delete process.env.RUDDER_OPENCODE_COMMAND;
    delete process.env.RUDDER_PI_COMMAND;
    delete process.env.PI_CODING_AGENT_DIR;
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    resetPiModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAgentRuntimeModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when the CLI is unavailable", async () => {
    process.env.RUDDER_CODEX_COMMAND = "__paperclip_missing_codex_command__";
    const models = await listAgentRuntimeModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
  });

  it("discovers official per-model reasoning levels from the Codex CLI", async () => {
    const catalog = JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }],
        },
        {
          slug: "hidden-model",
          display_name: "Hidden",
          visibility: "hide",
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    });
    const { command, root } = await writeFakeCommand(
      "codex",
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(catalog)});\n`,
    );
    process.env.RUDDER_CODEX_COMMAND = command;

    const first = await listAgentRuntimeModels("codex_local");
    const second = await listAgentRuntimeModels("codex_local");

    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        variants: ["low", "max", "ultra"],
      },
    ]);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("falls back to static codex models when CLI model discovery fails", async () => {
    process.env.RUDDER_CODEX_COMMAND = "__paperclip_missing_codex_command__";

    const models = await listAgentRuntimeModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });

  it("does not treat unavailable OpenCode or Pi discovery as an authoritative catalog", async () => {
    process.env.RUDDER_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.RUDDER_PI_COMMAND = "__paperclip_missing_pi_command__";

    await expect(discoverAgentRuntimeModels("opencode_local")).resolves.toBeUndefined();
    await expect(discoverAgentRuntimeModels("pi_local")).resolves.toBeUndefined();
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAgentRuntimeModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
    expect(models.find((model) => model.id === "gpt-5.3-codex")).toMatchObject({
      variants: ["low", "medium", "high", "xhigh", "max"],
      capabilities: { reasoning: true },
    });
    expect(models.find((model) => model.id === "auto")).not.toHaveProperty("variants");
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAgentRuntimeModels("cursor");
    const second = await listAgentRuntimeModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
    expect(first.find((model) => model.id === "gpt-5.3-codex")).toMatchObject({
      variants: ["low", "medium", "high", "xhigh", "max"],
      capabilities: { reasoning: true },
    });
    expect(first.find((model) => model.id === "sonnet-4.6")).not.toHaveProperty("variants");
  });

  it("returns no opencode models when opencode command is unavailable", async () => {
    process.env.RUDDER_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAgentRuntimeModels("opencode_local");
    expect(models).toEqual([]);
  });

  it("returns Pi starter models when CLI discovery is unavailable", async () => {
    process.env.RUDDER_PI_COMMAND = "__paperclip_missing_pi_command__";

    const models = await listAgentRuntimeModels("pi_local");
    expect(models).toEqual(piFallbackModels);
    expect(models.map((model) => model.id)).toContain("deepseek/deepseek-chat");
  });

  it("keeps Pi starter models when CLI discovery only returns local authenticated providers", async () => {
    const { command, root } = await writeFakeCommand(
      "pi",
      `#!/usr/bin/env node
console.log("provider     model             context  max-out  thinking  images");
console.log("kimi-coding  kimi-for-coding   262.1K   32.8K    yes       yes");
console.log("kimi-coding  kimi-k2-thinking  262.1K   32.8K    yes       no");
`,
    );
    process.env.RUDDER_PI_COMMAND = command;

    const models = await listAgentRuntimeModels("pi_local");

    expect(models.map((model) => model.id)).toContain("kimi-coding/kimi-for-coding");
    expect(models.map((model) => model.id)).toContain("deepseek/deepseek-chat");
    expect(models.map((model) => model.id)).toContain("openrouter/deepseek/deepseek-chat");
    expect(models.filter((model) => model.id === "kimi-coding/kimi-for-coding")).toHaveLength(1);

    await fs.rm(root, { recursive: true, force: true });
  });
});
