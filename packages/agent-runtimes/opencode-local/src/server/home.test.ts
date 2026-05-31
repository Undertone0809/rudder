import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureManagedOpenCodeDeepSeekConfig } from "./home.js";

describe("managed OpenCode home", () => {
  it("writes DeepSeek provider config into the managed home without persisting the key", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-home-"));
    const configFile = path.join(homeDir, ".config", "opencode", "opencode.json");

    try {
      await ensureManagedOpenCodeDeepSeekConfig({
        env: { DEEPSEEK_API_KEY: "sk-test-secret" },
        homeDir,
        model: "deepseek/deepseek-v4-pro",
      });

      const raw = await fs.readFile(configFile, "utf8");
      const config = JSON.parse(raw);
      expect(config.provider.deepseek.npm).toBe("@ai-sdk/openai-compatible");
      expect(config.provider.deepseek.options.baseURL).toBe("https://api.deepseek.com");
      expect(config.provider.deepseek.options.apiKey).toBe("{env:DEEPSEEK_API_KEY}");
      expect(raw).not.toContain("sk-test-secret");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not create provider config unless a DeepSeek model and key are configured", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-home-skip-"));
    const configFile = path.join(homeDir, ".config", "opencode", "opencode.json");

    try {
      await ensureManagedOpenCodeDeepSeekConfig({
        env: { DEEPSEEK_API_KEY: "sk-test-secret" },
        homeDir,
        model: "opencode/deepseek-v4-flash-free",
      });

      await expect(fs.access(configFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
