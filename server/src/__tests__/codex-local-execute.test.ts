import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@rudderhq/agent-runtime-codex-local/server";

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const workspaceSkillsPath = path.join(process.cwd(), ".agents", "skills");
const codexSkillsPath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "skills") : null;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  codexHome: process.env.CODEX_HOME || null,
  home: process.env.HOME || null,
  userProfile: process.env.USERPROFILE || null,
  agentHome: process.env.AGENT_HOME || null,
  workspaceSkillEntries: fs.existsSync(workspaceSkillsPath)
    ? fs.readdirSync(workspaceSkillsPath).sort()
    : [],
  codexSkillEntries: codexSkillsPath && fs.existsSync(codexSkillsPath)
    ? fs.readdirSync(codexSkillsPath).sort()
    : [],
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFailingCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.error([
    "2026-04-13T09:25:56.430513Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at \\"/Users/test/.codex/shell_snapshots/019d8629-6e4c-7381-8538-7f93b18408cc.tmp-1776072355418943000\\": Os { code: 2, kind: NotFound, message: \\"No such file or directory\\" }",
    "file:///Users/test/.nvm/versions/node/v22.17.0/lib/node_modules/@openai/codex/bin/codex.js:100",
    "    throw new Error(",
    "          ^",
    "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
    "    at file:///Users/test/.nvm/versions/node/v22.17.0/lib/node_modules/@openai/codex/bin/codex.js:100:11",
    "    at ModuleJob.run (node:internal/modules/esm/module_job:329:25)",
    "Node.js v22.17.0",
  ].join("\\n"));
  process.exit(1);
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeBenignStderrCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("2026-04-13T09:25:56.430513Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at \\"/Users/test/.codex/shell_snapshots/019d8629-6e4c-7381-8538-7f93b18408cc.tmp-1776072355418943000\\": Os { code: 2, kind: NotFound, message: \\"No such file or directory\\" }\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  codexHome: string | null;
  home: string | null;
  userProfile: string | null;
  agentHome: string | null;
  workspaceSkillEntries: string[];
  codexSkillEntries: string[];
  rudderEnvKeys: string[];
};

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

function managedCodexHomePath(input: {
  rudderHome: string;
  instanceId?: string;
  orgId?: string;
  agentId?: string;
}): string {
  return path.join(
    input.rudderHome,
    "instances",
    input.instanceId ?? "default",
    "organizations",
    input.orgId ?? "organization-1",
    "codex-home",
    "agents",
    input.agentId ?? "agent-1",
  );
}

describe("codex execute", () => {
  it("uses a Rudder-managed CODEX_HOME outside worktree mode while preserving shared auth and config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-default-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-default",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(managedCodexHome);
      expect(capture.home).toBe(path.join(managedCodexHome, "home"));
      expect(capture.userProfile).toBe(path.join(managedCodexHome, "home"));
      expect(capture.agentHome).toBe(path.join(managedCodexHome, "home"));
      expect(capture.codexSkillEntries).toEqual(["rudder"]);
      expect(capture.argv).toEqual(expect.arrayContaining([
        "exec",
        "--json",
        "--disable",
        "plugins",
        "-c",
        "skills.bundled.enabled=false",
        "-",
      ]));

      const managedAuth = path.join(managedCodexHome, "auth.json");
      const managedConfig = path.join(managedCodexHome, "config.toml");
      const managedSkillLink = path.join(managedCodexHome, "skills", "rudder");
      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(managedConfig)).isFile()).toBe(true);
      const managedConfigContents = await fs.readFile(managedConfig, "utf8");
      expect(managedConfigContents).toContain('model = "codex-mini-latest"');
      expect(managedConfigContents).toContain("[skills.bundled]");
      expect(managedConfigContents).toContain("enabled = false");
      expect(managedConfigContents).toContain("[features]");
      expect(managedConfigContents).toContain("plugins = false");
      expect(managedConfigContents).not.toContain("[[skills.config]]");
      expect((await fs.lstat(managedSkillLink)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedSkillLink)).toBe(
        await fs.realpath(path.join(process.cwd(), "server", "resources", "bundled-skills", "rudder")),
      );
      await expect(fs.lstat(path.join(sharedCodexHome, "organizations", "organization-1"))).rejects.toThrow();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using Rudder-managed Codex home"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates managed CODEX_HOME per agent inside the same organization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-agent-isolation-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const firstCapturePath = path.join(root, "capture-agent-1.json");
    const secondCapturePath = path.join(root, "capture-agent-2.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const baseRuntime = {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      };
      const baseConfig = {
        command: commandPath,
        cwd: workspace,
        promptTemplate: "Follow the rudder heartbeat.",
      };

      const [firstResult, secondResult] = await Promise.all([
        execute({
          runId: "run-agent-1",
          agent: {
            id: "agent-1",
            orgId: "organization-1",
            name: "Codex Coder 1",
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: {},
          },
          runtime: baseRuntime,
          config: {
            ...baseConfig,
            env: { RUDDER_TEST_CAPTURE_PATH: firstCapturePath },
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
        }),
        execute({
          runId: "run-agent-2",
          agent: {
            id: "agent-2",
            orgId: "organization-1",
            name: "Codex Coder 2",
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: {},
          },
          runtime: baseRuntime,
          config: {
            ...baseConfig,
            env: { RUDDER_TEST_CAPTURE_PATH: secondCapturePath },
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
        }),
      ]);

      expect(firstResult.exitCode).toBe(0);
      expect(secondResult.exitCode).toBe(0);

      const firstCapture = JSON.parse(await fs.readFile(firstCapturePath, "utf8")) as CapturePayload;
      const secondCapture = JSON.parse(await fs.readFile(secondCapturePath, "utf8")) as CapturePayload;
      expect(firstCapture.codexHome).toBe(managedCodexHomePath({ rudderHome: paperclipHome, agentId: "agent-1" }));
      expect(secondCapture.codexHome).toBe(managedCodexHomePath({ rudderHome: paperclipHome, agentId: "agent-2" }));
      expect(firstCapture.codexHome).not.toBe(secondCapture.codexHome);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes inherited Codex [[skills.config]] entries from the managed config before invocation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-sanitize-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.writeFile(
      path.join(managedCodexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        "[skills.bundled]",
        "enabled = true",
        "",
        "[[skills.config]]",
        'name = "vercel:ai-sdk"',
        "enabled = false",
        "",
        "[[skills.config]]",
        'path = "/tmp/valid-skill/SKILL.md"',
        "enabled = false",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-sanitize",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(managedCodexHome);

      const managedConfig = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(managedConfig).toContain("[skills.bundled]");
      expect(managedConfig).toContain("enabled = false");
      expect(managedConfig).not.toContain('name = "vercel:ai-sdk"');
      expect(managedConfig).not.toContain('path = "/tmp/valid-skill/SKILL.md"');
      expect(managedConfig).not.toContain("[[skills.config]]");
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Removed 2 inherited Codex [[skills.config]] entries"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("strips inherited Codex MCP server and plugin tables from the managed config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-strip-managed-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "codex-mini-latest"',
        "",
        "[features]",
        "plugins = true",
        "",
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        "",
        '[plugins."linear@openai-curated"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-strip-managed",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const managedConfigContents = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(managedConfigContents).toContain('model = "codex-mini-latest"');
      expect(managedConfigContents).toContain("[skills.bundled]");
      expect(managedConfigContents).toContain("enabled = false");
      expect(managedConfigContents).toContain("[features]");
      expect(managedConfigContents).toContain("plugins = false");
      expect(managedConfigContents).not.toContain("plugins = true");
      expect(managedConfigContents).not.toContain("[mcp_servers.linear]");
      expect(managedConfigContents).not.toContain('[plugins."linear@openai-curated"]');
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Removed 2 inherited Codex plugin/MCP configuration tables"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prunes inherited Codex plugin cache state from the managed home before invocation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-prune-plugin-cache-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    const managedPluginSkill = path.join(
      managedCodexHome,
      "plugins",
      "cache",
      "openai-curated",
      "linear",
      "fb0a18376bcd9f2604047fbe7459ec5aed70c64b",
      "skills",
      "linear",
      "SKILL.md",
    );
    const managedTmpPluginManifest = path.join(
      managedCodexHome,
      ".tmp",
      "plugins",
      "plugins",
      "build-ios-apps",
      ".codex-plugin",
      "plugin.json",
    );
    const managedTmpPluginClone = path.join(
      managedCodexHome,
      ".tmp",
      "plugins-clone-demo",
      "placeholder.txt",
    );
    const managedTmpPluginMarker = path.join(
      managedCodexHome,
      ".tmp",
      "app-server-remote-plugin-sync-v1",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.mkdir(path.dirname(managedPluginSkill), { recursive: true });
    await fs.writeFile(managedPluginSkill, "# linear\n", "utf8");
    await fs.mkdir(path.dirname(managedTmpPluginManifest), { recursive: true });
    await fs.writeFile(managedTmpPluginManifest, '{"name":"build-ios-apps"}\n', "utf8");
    await fs.writeFile(path.join(managedCodexHome, ".tmp", "plugins.sha"), "sha\n", "utf8");
    await fs.mkdir(path.dirname(managedTmpPluginClone), { recursive: true });
    await fs.writeFile(managedTmpPluginClone, "clone\n", "utf8");
    await fs.writeFile(managedTmpPluginMarker, "marker\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-prune-plugin-cache",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      await expect(fs.access(path.join(managedCodexHome, "plugins"))).rejects.toThrow();
      await expect(fs.access(path.join(managedCodexHome, ".tmp", "plugins"))).rejects.toThrow();
      await expect(fs.access(path.join(managedCodexHome, ".tmp", "plugins.sha"))).rejects.toThrow();
      await expect(fs.access(path.join(managedCodexHome, ".tmp", "plugins-clone-demo"))).rejects.toThrow();
      await expect(fs.access(managedTmpPluginMarker)).rejects.toThrow();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Pruned 5 inherited Codex plugin cache entries"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits a command note that Codex auto-applies repo-scoped AGENTS.md files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-notes-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let commandNotes: string[] = [];
    try {
      const result = await execute({
        runId: "run-notes",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(commandNotes).toContain(
        "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Rudder does not currently suppress that discovery.",
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("adds --skip-git-repo-check for chat-scene Codex runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-chat-scene-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-chat-scene",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Reply in chat.",
        },
        context: {
          rudderScene: "chat",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--skip-git-repo-check");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not add --skip-git-repo-check outside the chat scene", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-non-chat-scene-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-non-chat-scene",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Run the assigned task.",
        },
        context: {
          rudderScene: "issue_heartbeat",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).not.toContain("--skip-git-repo-check");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a worktree-isolated CODEX_HOME while preserving shared auth and config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const isolatedCodexHome = managedCodexHomePath({
      rudderHome: paperclipHome,
      instanceId: "worktree-1",
    });
    const workspaceSkill = path.join(workspace, ".agents", "skills", "rudder");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "worktree-1";
    process.env.RUDDER_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(isolatedCodexHome);
      expect(capture.argv).toEqual(expect.arrayContaining([
        "exec",
        "--json",
        "--disable",
        "plugins",
        "-c",
        "skills.bundled.enabled=false",
        "-",
      ]));
      expect(capture.prompt).toContain("Follow the rudder heartbeat.");
      expect(capture.rudderEnvKeys).toEqual(
        expect.arrayContaining([
          "RUDDER_AGENT_ID",
          "RUDDER_API_KEY",
          "RUDDER_API_URL",
          "RUDDER_ORG_ID",
          "RUDDER_RUN_ID",
        ]),
      );

      const isolatedAuth = path.join(isolatedCodexHome, "auth.json");
      const isolatedConfig = path.join(isolatedCodexHome, "config.toml");

      expect((await fs.lstat(isolatedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(isolatedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(isolatedConfig)).isFile()).toBe(true);
      const isolatedConfigContents = await fs.readFile(isolatedConfig, "utf8");
      expect(isolatedConfigContents).toContain('model = "codex-mini-latest"');
      expect(isolatedConfigContents).toContain("[skills.bundled]");
      expect(isolatedConfigContents).toContain("enabled = false");
      expect(isolatedConfigContents).toContain("[features]");
      expect(isolatedConfigContents).toContain("plugins = false");
      expect(isolatedConfigContents).not.toContain("[[skills.config]]");
      expect((await fs.lstat(path.join(isolatedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
      await expect(fs.lstat(workspaceSkill)).rejects.toMatchObject({ code: "ENOENT" });
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using worktree-isolated Codex home"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not materialize enabled Codex skills into the workspace surface", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-user-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "worktree-1";
    process.env.RUDDER_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-user-skill",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.workspaceSkillEntries).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("extracts the real Codex error from Node stack-style stderr output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-error-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-error",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBe(
        "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("filters benign shell snapshot cleanup warnings from Codex stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-shell-snapshot-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeBenignStderrCodexCommand(commandPath);

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-shell-snapshot-noise",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.resultJson).toMatchObject({
        stderr: "",
      });
      expect(logs.some((entry) => entry.stream === "stderr")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects an explicit CODEX_HOME config override even in worktree mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-explicit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const explicitCodexHome = path.join(root, "explicit-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "worktree-1";
    process.env.RUDDER_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
            CODEX_HOME: explicitCodexHome,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(explicitCodexHome);
      await expect(fs.lstat(path.join(workspace, ".agents", "skills", "rudder"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(paperclipHome, "instances", "worktree-1", "codex-home"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not preserve inherited shared Codex skill entries in the managed config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-disable-inherited-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "codex-mini-latest"',
        "",
        "[[skills.config]]",
        'path = "/tmp/shared-enabled-skill/SKILL.md"',
        "enabled = true",
        "",
        "[[skills.config]]",
        'path = "/tmp/shared-legacy-skill/SKILL.md"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-disable-inherited",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const managedConfigContents = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(managedConfigContents).toContain("[skills.bundled]");
      expect(managedConfigContents).toContain("enabled = false");
      expect(managedConfigContents).not.toContain('path = "/tmp/shared-enabled-skill/SKILL.md"');
      expect(managedConfigContents).not.toContain('path = "/tmp/shared-legacy-skill/SKILL.md"');
      expect(managedConfigContents).not.toContain("[[skills.config]]");
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prunes stale managed-home skill directories including .system and isolates HOME from the shared user home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-prune-skill-surface-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    const staleManagedSkill = path.join(managedCodexHome, "skills", "stale-skill", "SKILL.md");
    const staleSystemSkill = path.join(managedCodexHome, "skills", ".system", "imagegen", "SKILL.md");
    const agentHome = path.join(root, "agent-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(path.dirname(staleManagedSkill), { recursive: true });
    await fs.mkdir(path.dirname(staleSystemSkill), { recursive: true });
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.writeFile(staleManagedSkill, "# stale\n", "utf8");
    await fs.writeFile(staleSystemSkill, "# system stale\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-prune-skill-surface",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            agentHome,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.home).toBe(agentHome);
      expect(capture.userProfile).toBe(agentHome);
      expect(capture.agentHome).toBe(agentHome);
      expect(capture.codexSkillEntries).toEqual(["rudder"]);
      await expect(fs.lstat(path.join(managedCodexHome, "skills", "stale-skill"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedCodexHome, "skills", ".system"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
