import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { models as codexFallbackModels } from "@rudderhq/agent-runtime-codex-local";
import { models as cursorFallbackModels } from "@rudderhq/agent-runtime-cursor-local";
import { resetOpenCodeModelsCacheForTests } from "@rudderhq/agent-runtime-opencode-local/server";
import { resetPiModelsCacheForTests } from "@rudderhq/agent-runtime-pi-local/server";
import { listAgentRuntimeModels } from "../agent-runtimes/index.js";
import { resetCodexModelsCacheForTests } from "../agent-runtimes/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../agent-runtimes/cursor-models.js";

const ORIGINAL_HOME = process.env.HOME;

describe("adapter model listing", () => {
  beforeEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    delete process.env.OPENAI_API_KEY;
    delete process.env.RUDDER_OPENCODE_COMMAND;
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

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAgentRuntimeModels("codex_local");
    const second = await listAgentRuntimeModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
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

  it("discovers cursor models with runtime config and a managed home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-model-list-"));
    const hostHome = path.join(root, "host-home");
    const commandPath = path.join(root, "cursor-agent");
    const capturePath = path.join(root, "capture.json");
    process.env.HOME = hostHome;
    await fs.mkdir(path.join(hostHome, ".cursor", "settings"), { recursive: true });
    await fs.writeFile(path.join(hostHome, ".cursor", "settings", "host-only.json"), "{}", "utf8");
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.RUDDER_TEST_CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  home: process.env.HOME,
}), "utf8");
if (process.argv[2] === "models") {
  console.log("Available models: cursor/custom-model");
  process.exit(0);
}
process.exit(1);
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    try {
      const models = await listAgentRuntimeModels("cursor", {
        orgId: "organization-1",
        config: {
          command: commandPath,
          cwd: root,
          env: {
            RUDDER_HOME: path.join(root, "rudder-home"),
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
        },
      });

      expect(models.some((model) => model.id === "cursor/custom-model")).toBe(true);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        home: string;
      };
      expect(capture.argv).toEqual(["models"]);
      expect(capture.home).toContain(path.join("organizations", "organization-1", "cursor-home", "agents", "model-list"));
      await expect(fs.stat(path.join(capture.home, ".cursor", "settings", "host-only.json"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns no opencode models when opencode command is unavailable", async () => {
    process.env.RUDDER_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAgentRuntimeModels("opencode_local");
    expect(models).toEqual([]);
  });

  it("discovers opencode models with runtime config and a managed home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-model-list-"));
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.RUDDER_TEST_CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME
}), "utf8");
if (process.argv[2] === "--pure" && process.argv[3] === "models") {
  console.log("opencode/deepseek-v4-flash-free");
  process.exit(0);
}
process.exit(1);
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    try {
      const models = await listAgentRuntimeModels("opencode_local", {
        orgId: "organization-1",
        config: {
          command: commandPath,
          cwd: root,
          env: {
            RUDDER_HOME: path.join(root, "rudder-home"),
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
        },
      });

      expect(models).toEqual([
        { id: "opencode/deepseek-v4-flash-free", label: "opencode/deepseek-v4-flash-free" },
      ]);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        home: string;
        xdgConfigHome: string;
      };
      expect(capture.argv).toEqual(["--pure", "models"]);
      expect(capture.home).toContain(path.join("organizations", "organization-1", "opencode-home", "agents", "model-list"));
      expect(capture.xdgConfigHome).toBe(path.join(capture.home, ".config"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers pi models with runtime config and a managed home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-model-list-"));
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.RUDDER_TEST_CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  home: process.env.HOME
}), "utf8");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("deepseek  deepseek-v4-pro");
  process.exit(0);
}
process.exit(1);
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    try {
      const models = await listAgentRuntimeModels("pi_local", {
        orgId: "organization-1",
        config: {
          command: commandPath,
          cwd: root,
          env: {
            RUDDER_HOME: path.join(root, "rudder-home"),
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
        },
      });

      expect(models).toEqual([
        { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
      ]);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        home: string;
      };
      expect(capture.argv).toEqual(["--list-models"]);
      expect(capture.home).toContain(path.join("organizations", "organization-1", "pi-home", "agents", "model-list"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
