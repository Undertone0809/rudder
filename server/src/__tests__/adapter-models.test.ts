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
import { listAgentRuntimeModels } from "../agent-runtimes/index.js";

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
    delete process.env.RUDDER_OPENCODE_COMMAND;
    delete process.env.RUDDER_PI_COMMAND;
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

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAgentRuntimeModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps codex local model options aligned with the Codex app menu", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
          { id: "o3" },
        ],
      }),
    } as Response);

    const first = await listAgentRuntimeModels("codex_local");
    const second = await listAgentRuntimeModels("codex_local");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first).toEqual(second);
    expect(first).toEqual(codexFallbackModels);
    expect(first.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.5-codex",
      "gpt-5.5-fast",
      "gpt-5.5-flex",
      "gpt-5.4",
      "gpt-5.4-codex",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5-codex",
      "codex-mini-latest",
    ]);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAgentRuntimeModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
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
