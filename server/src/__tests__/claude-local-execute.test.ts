import { execute, runClaudeLogin } from "@rudderhq/agent-runtime-claude-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearInheritedGitIdentityEnv,
  expectPreparedGitConfigCapture,
  gitIdentityCaptureSnippet,
  type GitIdentityCapture,
} from "./local-runtime-git-identity-helpers";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}
const path = require("node:path");

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const addDirIndex = process.argv.indexOf("--add-dir");
const addDir = addDirIndex >= 0 ? process.argv[addDirIndex + 1] : null;
const appendSystemPromptFileIndex = process.argv.indexOf("--append-system-prompt-file");
const appendSystemPromptFile = appendSystemPromptFileIndex >= 0 ? process.argv[appendSystemPromptFileIndex + 1] : null;
const addDirSkillsPath = addDir ? path.join(addDir, ".claude", "skills") : null;
const settingsIndex = process.argv.indexOf("--settings");
const settingsPath = settingsIndex >= 0 ? process.argv[settingsIndex + 1] : null;
const settingSourcesIndex = process.argv.indexOf("--setting-sources");
const settingSources = settingSourcesIndex >= 0 ? process.argv[settingSourcesIndex + 1] : null;
const managedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? null;
const managedClaudeSettingsPath = process.env.RUDDER_CLAUDE_HOME
  ? path.join(process.env.RUDDER_CLAUDE_HOME, ".claude", "settings.json")
  : null;
const managedClaudeJsonPath = process.env.RUDDER_CLAUDE_HOME
  ? path.join(process.env.RUDDER_CLAUDE_HOME, ".claude.json")
  : null;
const runtimeTmpDir = process.env.RUDDER_RUNTIME_TMPDIR ?? null;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
  env: {
    HOME: process.env.HOME ?? null,
    USERPROFILE: process.env.USERPROFILE ?? null,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null,
    RUDDER_CLAUDE_HOME: process.env.RUDDER_CLAUDE_HOME ?? null,
    RUDDER_OPERATOR_HOME: process.env.RUDDER_OPERATOR_HOME ?? null,
    RUDDER_RUNTIME_TMPDIR: runtimeTmpDir,
    PATH: process.env.PATH ?? null,
  },
  settingsPath,
  settingSources,
  managedClaudeConfigDir,
  managedClaudeSettingsPath,
  managedClaudeSettings:
    managedClaudeSettingsPath && fs.existsSync(managedClaudeSettingsPath)
      ? fs.readFileSync(managedClaudeSettingsPath, "utf8")
      : null,
  managedClaudeJsonPath,
  managedClaudeJsonExists: managedClaudeJsonPath ? fs.existsSync(managedClaudeJsonPath) : false,
  appendedSystemPrompt:
    appendSystemPromptFile && fs.existsSync(appendSystemPromptFile)
      ? fs.readFileSync(appendSystemPromptFile, "utf8")
      : null,
  addDirSkillEntries:
    addDirSkillsPath && fs.existsSync(addDirSkillsPath)
      ? fs.readdirSync(addDirSkillsPath).sort()
      : [],
  runtimeTmpExists: runtimeTmpDir ? fs.existsSync(runtimeTmpDir) : false,
  gitIdentity: captureGitIdentityEnv(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-1",
  model: "claude-test",
}));
console.log(JSON.stringify({
  type: "assistant",
  session_id: "claude-session-1",
  message: {
    content: [{ type: "text", text: "hello" }],
  },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-1",
  result: "ok",
  usage: {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  },
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

function setOperatorHomeForTest(home: string) {
  const previousHome = process.env.HOME;
  const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
  process.env.HOME = home;
  process.env.RUDDER_OPERATOR_HOME = home;
  return () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
    else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
  };
}

describe("claude execute", { timeout: 20_000 }, () => {
  it("runs the current Claude auth login subcommand", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-login-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await runClaudeLogin({
        runId: "claude-login-test",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
          agentRuntimeConfig: {},
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
        },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };
      expect(capture.argv).toEqual(["auth", "login"]);
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs a loaded instructions file as stdout instead of stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const soulPath = path.join(root, "instructions", "SOUL.md");
    const toolsPath = path.join(root, "instructions", "TOOLS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(soulPath, "# Agent Soul\n", "utf8");
    await fs.writeFile(toolsPath, "# Agent Tools\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Prefer concise status.\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const logs: LogEntry[] = [];
      let agentInstructionStack = "";
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          instructionsFilePath: instructionsPath,
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderScene: "heartbeat",
          rudderResourcesPrompt: "## Your Current Automations\n\n- Daily Claude review",
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
            projectLibraryRoot: path.join(root, "org-workspace", "projects", "product"),
            projectLibraryRelativePath: "projects/product",
            resourcesPrompt: "## Your Current Automations\n\n- Daily Claude review",
            orgResourcesPrompt: "## Your Current Automations\n\n- Daily Claude review",
          },
        },
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
        onMeta: async (meta) => {
          agentInstructionStack = meta.agentInstructionStack ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("[rudder] Loaded agent instructions file: $AGENT_HOME/instructions/AGENTS.md"),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("[rudder] Loaded agent memory instructions file: $AGENT_HOME/instructions/MEMORY.md"),
        }),
      );
      expect(logs).not.toContainEqual(
        expect.objectContaining({
          stream: "stderr",
          chunk: expect.stringContaining("[rudder] Loaded agent instructions file: $AGENT_HOME/instructions/AGENTS.md"),
        }),
      );
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        appendedSystemPrompt: string | null;
        rudderEnvKeys: string[];
        gitIdentity: GitIdentityCapture;
      };
      expectPreparedGitConfigCapture(capture);
      expect(capture.appendedSystemPrompt).not.toBeNull();
      const systemPrompt = capture.appendedSystemPrompt ?? "";
      expect(systemPrompt).toContain("# Agent Instructions");
      expect(systemPrompt).toContain("# Agent Soul");
      expect(systemPrompt).toContain("# Agent Tools");
      expect(systemPrompt).toContain("# Tacit Memory");
      expect(systemPrompt).toContain("## Your Current Automations");
      expect(systemPrompt).toContain("# Rudder Heartbeat Instruction");
      expect(systemPrompt).toContain("# Enabled Rudder Skills");
      expect(systemPrompt).toContain("No optional Rudder skills are enabled for this run.");
      expect(systemPrompt).toContain("Claude Code built-in/provider-native skills");
      expect(systemPrompt.match(/## Your Current Automations/g)).toHaveLength(1);
      expect(systemPrompt.indexOf("# Agent Instructions")).toBeLessThan(systemPrompt.indexOf("# Agent Soul"));
      expect(systemPrompt.indexOf("# Agent Soul")).toBeLessThan(systemPrompt.indexOf("# Agent Tools"));
      expect(systemPrompt.indexOf("# Agent Tools")).toBeLessThan(systemPrompt.indexOf("# Tacit Memory"));
      expect(systemPrompt.indexOf("# Tacit Memory")).toBeLessThan(systemPrompt.indexOf("## Your Current Automations"));
      expect(systemPrompt.indexOf("## Your Current Automations")).toBeLessThan(systemPrompt.indexOf("## Current Time"));
      expect(systemPrompt.indexOf("## Current Time")).toBeLessThan(systemPrompt.indexOf("# Rudder Heartbeat Instruction"));
      expect(systemPrompt.indexOf("# Rudder Heartbeat Instruction")).toBeLessThan(systemPrompt.indexOf("# Enabled Rudder Skills"));
      expect(agentInstructionStack).toContain(systemPrompt);
      expect(agentInstructionStack).toContain("Follow the rudder heartbeat.");
      expect(agentInstructionStack).toContain("# Agent Instructions");
      expect(agentInstructionStack).toContain("# Agent Soul");
      expect(agentInstructionStack).toContain("# Agent Tools");
      expect(agentInstructionStack).toContain("# Tacit Memory");
      expect(agentInstructionStack).toContain("# Enabled Rudder Skills");
      expect(agentInstructionStack).not.toContain("## Agent Instruction:");
      expect(agentInstructionStack).toContain("## Your Current Automations");
      expect(agentInstructionStack).not.toContain("[startup context omitted from persisted prompt]");
      expect(capture.rudderEnvKeys).toContain("RUDDER_PROJECT_LIBRARY_ROOT");
      expect(capture.rudderEnvKeys).toContain("RUDDER_PROJECT_LIBRARY_PATH");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports runtime image media as local prompt paths for Claude Code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-image-media-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const imagePath = path.join(root, "chat-image.png");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(imagePath, "png-bytes", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      let commandNotes: string[] = [];
      const result = await execute({
        runId: "run-claude-image",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
          promptTemplate: "Inspect {{context.chatAttachments}} before replying.",
        },
        context: {
          chatAttachments: [{
            attachmentId: "attachment-1",
            localPath: imagePath,
          }],
        },
        media: [{
          source: "chat_attachment",
          attachmentId: "attachment-1",
          assetId: "asset-1",
          name: "chat-image.png",
          originalFilename: "chat-image.png",
          contentType: "image/png",
          byteSize: 9,
          localPath: imagePath,
        }],
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        prompt: string;
      };
      expect(capture.argv).not.toContain("--image");
      expect(capture.prompt).toContain(imagePath);
      expect(commandNotes).toContain("Provided 1 local image attachment path in the prompt for Claude Code inspection.");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("mounts explicitly enabled user-installed Claude skills into the transient add-dir surface", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-external-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const externalSkillRoot = path.join(root, ".claude", "skills", "build-advisor");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(externalSkillRoot, { recursive: true });
    await fs.writeFile(path.join(externalSkillRoot, "SKILL.md"), "---\nname: build-advisor\n---\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-2",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderRuntimeSkills: [
            {
              key: "adapter:claude_local:build-advisor",
              runtimeName: "build-advisor",
              source: externalSkillRoot,
            },
          ],
          rudderSkillSync: {
            desiredSkills: ["adapter:claude_local:build-advisor"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        appendedSystemPrompt: string | null;
        addDirSkillEntries: string[];
      };
      expect(capture.addDirSkillEntries).toContain("build-advisor");
      expect(capture.appendedSystemPrompt).toContain("# Enabled Rudder Skills");
      expect(capture.appendedSystemPrompt).toContain("- build-advisor: adapter:claude_local:build-advisor");
      expect(capture.appendedSystemPrompt).not.toContain("No optional Rudder skills are enabled");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("mounts always-enabled Rudder bundled skills from runtime context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-bundled-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const bundledSkillRoot = path.join(root, "bundled", "rudder");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(bundledSkillRoot, { recursive: true });
    await fs.writeFile(path.join(bundledSkillRoot, "SKILL.md"), "---\nname: rudder\n---\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await execute({
        runId: "run-claude-bundled-skill",
        agent: {
          id: "agent-bundled",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderRuntimeSkills: [
            {
              key: "bundled:rudder/rudder",
              runtimeName: "rudder",
              name: "rudder",
              source: bundledSkillRoot,
            },
          ],
          rudderSkillSync: {
            desiredSkills: ["bundled:rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        appendedSystemPrompt: string | null;
        addDirSkillEntries: string[];
      };
      expect(capture.addDirSkillEntries).toContain("rudder");
      expect(capture.appendedSystemPrompt).toContain("# Enabled Rudder Skills");
      expect(capture.appendedSystemPrompt).toContain("- rudder: bundled:rudder/rudder");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs Claude with managed config dir and sanitized user settings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-settings-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const sharedClaudeDir = path.join(root, ".claude");
    const sharedSkillsDir = path.join(sharedClaudeDir, "skills");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedSkillsDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedClaudeDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
          ENABLE_TOOL_SEARCH: "true",
        },
        enabledPlugins: {
          "skill-creator@claude-plugins-official": true,
        },
        hooks: {
          Stop: [{ command: "echo host hook" }],
        },
        mcpServers: {
          host: { command: "host-mcp" },
        },
        permissions: {
          defaultMode: "bypassPermissions",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, ".claude.json"),
      JSON.stringify({
        mcpServers: { hostJson: { command: "host-json-mcp" } },
        projects: { [workspace]: { enabledMcpjsonServers: ["hostJson"] } },
        skillUsage: { "host-global-skill": 2 },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(sharedSkillsDir, "user-skill.txt"), "shared skill marker", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      let commandNotes: string[] = [];
      let promptMetrics: Record<string, number> = {};
      let loadedSkills: unknown[] = [{ key: "before" }];
      let realizedSkills: unknown[] = [{ key: "before" }];
      let nativeDiscoverableSkills: unknown[] | undefined = [{ key: "before" }];
      const result = await execute({
        runId: "run-3",
        agent: {
          id: "agent-3",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
          promptMetrics = meta.promptMetrics ?? {};
          loadedSkills = meta.loadedSkills ?? [];
          realizedSkills = meta.realizedSkills ?? [];
          nativeDiscoverableSkills = meta.nativeDiscoverableSkills;
        },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        appendedSystemPrompt: string | null;
        argv: string[];
        env: {
          HOME: string | null;
          USERPROFILE: string | null;
          CLAUDE_CONFIG_DIR: string | null;
          RUDDER_CLAUDE_HOME: string | null;
          RUDDER_OPERATOR_HOME: string | null;
          RUDDER_RUNTIME_TMPDIR: string | null;
          PATH: string | null;
        };
        settingsPath: string | null;
        settingSources: string | null;
        managedClaudeConfigDir: string | null;
        managedClaudeSettingsPath: string | null;
        managedClaudeSettings: string | null;
        managedClaudeJsonPath: string | null;
        managedClaudeJsonExists: boolean;
        addDirSkillEntries: string[];
        runtimeTmpExists: boolean;
      };
      const managedHome = path.join(root, ".rudder", "instances", "default", "organizations", "organization-1", "claude-home");
      const managedConfigDir = path.join(managedHome, ".claude");
      const runtimeTmpDir = path.join(managedHome, "runtime-tmp", "run-3");
      expect(capture.managedClaudeSettingsPath).toContain("/.rudder/instances/default/organizations/organization-1/claude-home/.claude/settings.json");
      expect(capture.env.HOME).toBe(managedHome);
      expect(capture.env.USERPROFILE).toBe(managedHome);
      expect(capture.env.RUDDER_OPERATOR_HOME).toBe(root);
      expect(capture.env.RUDDER_CLAUDE_HOME).toBe(managedHome);
      expect(capture.env.RUDDER_RUNTIME_TMPDIR).toBe(runtimeTmpDir);
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(managedConfigDir);
      expect(capture.runtimeTmpExists).toBe(true);
      expect(capture.managedClaudeConfigDir).toBe(managedConfigDir);
      expect(capture.argv).toContain("--permission-mode");
      expect(capture.argv[capture.argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(capture.argv).toContain("--settings");
      expect(capture.settingsPath).toBe(capture.managedClaudeSettingsPath);
      expect(capture.argv).toContain("--setting-sources");
      expect(capture.settingSources).toBe("user");
      expect(capture.argv).toContain("--strict-mcp-config");
      const settingsStat = await fs.lstat(capture.managedClaudeSettingsPath!);
      expect(settingsStat.isSymbolicLink()).toBe(false);
      const managedSettings = JSON.parse(capture.managedClaudeSettings ?? "{}") as {
        env?: Record<string, string>;
        enabledPlugins?: unknown;
        hooks?: unknown;
        mcpServers?: unknown;
        permissions?: unknown;
      };
      expect(managedSettings.env).toMatchObject({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
      });
      expect(managedSettings.env).not.toHaveProperty("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
      expect(managedSettings.env).not.toHaveProperty("ENABLE_TOOL_SEARCH");
      expect(managedSettings.enabledPlugins).toBeUndefined();
      expect(managedSettings.hooks).toBeUndefined();
      expect(managedSettings.mcpServers).toBeUndefined();
      expect(managedSettings.permissions).toBeUndefined();
      expect(capture.managedClaudeJsonPath).toContain("/.rudder/instances/default/organizations/organization-1/claude-home/.claude.json");
      expect(capture.managedClaudeJsonExists).toBe(false);
      expect(capture.argv).toContain("--add-dir");
      expect(capture.argv).toContain(runtimeTmpDir);
      expect(capture.addDirSkillEntries).not.toContain("user-skill.txt");
      expect(capture.appendedSystemPrompt).toContain("# Enabled Rudder Skills");
      expect(capture.appendedSystemPrompt).toContain("No optional Rudder skills are enabled for this run.");
      expect(capture.appendedSystemPrompt).toContain("Claude Code built-in/provider-native skills");
      expect(capture.appendedSystemPrompt).not.toContain("host-global-skill");
      expect(capture.appendedSystemPrompt).not.toContain("user-skill");
      expect(commandNotes).toContain("Injected Rudder enabled-skill boundary via --append-system-prompt-file.");
      expect(promptMetrics.skillBoundaryPromptChars).toBeGreaterThan(0);
      expect(loadedSkills).toEqual([]);
      expect(realizedSkills).toEqual([]);
      expect(nativeDiscoverableSkills).toBeUndefined();
    } finally {
      restoreEnv();
      await fs.rm(path.join(root, ".rudder"), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps DeepSeek credentials available for Claude Code deepseek models", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-deepseek-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const sharedClaudeDir = path.join(root, ".claude");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedClaudeDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedClaudeDir, "settings.json"),
      JSON.stringify({
        env: {
          DEEPSEEK_API_KEY: "deepseek-settings-key",
          ENABLE_TOOL_SEARCH: "true",
        },
      }),
      "utf8",
    );
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await execute({
        runId: "run-deepseek",
        agent: {
          id: "agent-deepseek",
          orgId: "organization-1",
          name: "Claude DeepSeek Coder",
          agentRuntimeType: "claude_local",
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
          model: "deepseek-v4-pro[1m]",
          env: {
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
            DEEPSEEK_API_KEY: "deepseek-config-key",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        env: {
          ANTHROPIC_API_KEY: string | null;
          DEEPSEEK_API_KEY: string | null;
        };
        managedClaudeSettings: string | null;
      };
      expect(capture.argv).toContain("--model");
      expect(capture.argv[capture.argv.indexOf("--model") + 1]).toBe("deepseek-v4-pro[1m]");
      expect(capture.env.DEEPSEEK_API_KEY).toBe("deepseek-config-key");
      expect(capture.env.ANTHROPIC_API_KEY).toBeNull();
      const managedSettings = JSON.parse(capture.managedClaudeSettings ?? "{}") as {
        env?: Record<string, string>;
      };
      expect(managedSettings.env).toMatchObject({
        DEEPSEEK_API_KEY: "deepseek-settings-key",
      });
      expect(managedSettings.env).not.toHaveProperty("ENABLE_TOOL_SEARCH");
    } finally {
      restoreEnv();
      await fs.rm(path.join(root, ".rudder"), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves explicit Claude permission mode overrides without dangerous bypass", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-permission-mode-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await execute({
        runId: "run-permission-mode",
        agent: {
          id: "agent-permission-mode",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          permissionMode: "plan",
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };
      expect(capture.argv).toContain("--permission-mode");
      expect(capture.argv[capture.argv.indexOf("--permission-mode") + 1]).toBe("plan");
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");
    } finally {
      restoreEnv();
      await fs.rm(path.join(root, ".rudder"), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not accept bypassPermissions through the structured non-dangerous permission mode field", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-permission-mode-bypass-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await execute({
        runId: "run-permission-mode-bypass",
        agent: {
          id: "agent-permission-mode-bypass",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          permissionMode: "bypassPermissions",
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };
      expect(capture.argv).toContain("--permission-mode");
      expect(capture.argv[capture.argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(capture.argv).not.toContain("bypassPermissions");
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");
    } finally {
      restoreEnv();
      await fs.rm(path.join(root, ".rudder"), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prevents extra args from overriding managed Claude config isolation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-extra-args-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const hostileSettingsPath = path.join(root, "hostile-settings.json");
    const hostileAddDir = path.join(root, "hostile-add-dir");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(hostileSettingsPath, JSON.stringify({ mcpServers: { host: { command: "host-mcp" } } }), "utf8");
    await fs.mkdir(path.join(hostileAddDir, ".claude", "skills", "hostile-skill"), { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await execute({
        runId: "run-4",
        agent: {
          id: "agent-4",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          extraArgs: [
            "--settings",
            hostileSettingsPath,
            "--setting-sources",
            "user,project,local",
            "--settings=/tmp/hostile-prefixed-settings.json",
            "--setting-sources=project,local",
            "--add-dir",
            hostileAddDir,
            `--add-dir=${path.join(root, "hostile-prefixed-add-dir")}`,
            "--mcp-config",
            path.join(root, "hostile-mcp.json"),
            "--mcp-config=/tmp/hostile-prefixed-mcp.json",
            "--plugin-dir",
            path.join(root, "hostile-plugin"),
            "--plugin-url=https://example.invalid/hostile-plugin.zip",
            "--permission-mode",
            "bypassPermissions",
            "--permission-mode=default",
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--allowedTools",
            "Bash(*)",
            "--allowedTools=Bash(*)",
            "--disallowedTools",
            "",
            "--disallowedTools=",
            "--tools",
            "default",
            "--tools=default",
            "--strict-mcp-config=false",
            "--no-strict-mcp-config",
          ],
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        settingsPath: string | null;
        settingSources: string | null;
        managedClaudeSettingsPath: string | null;
        addDirSkillEntries: string[];
      };
      expect(capture.argv).not.toContain(hostileSettingsPath);
      expect(capture.argv).not.toContain(hostileAddDir);
      expect(capture.argv).not.toContain("--mcp-config");
      expect(capture.argv).not.toContain("--plugin-dir");
      expect(capture.argv).not.toContain("--no-strict-mcp-config");
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");
      expect(capture.argv).not.toContain("--allow-dangerously-skip-permissions");
      expect(capture.argv).not.toContain("Bash(*)");
      expect(capture.argv).not.toContain("default");
      expect(capture.argv.some((arg) => arg.startsWith("--settings="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--setting-sources="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--add-dir="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--mcp-config="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--plugin-url="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--permission-mode="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--allowedTools="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--disallowedTools="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--tools="))).toBe(false);
      expect(capture.argv.some((arg) => arg.startsWith("--strict-mcp-config="))).toBe(false);
      expect(capture.argv[capture.argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(capture.settingsPath).toBe(capture.managedClaudeSettingsPath);
      expect(capture.settingSources).toBe("user");
      expect(capture.addDirSkillEntries).not.toContain("hostile-skill");
    } finally {
      restoreEnv();
      await fs.rm(path.join(root, ".rudder"), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prevents legacy args from overriding managed Claude config isolation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-legacy-args-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const hostileSettingsPath = path.join(root, "legacy-hostile-settings.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(hostileSettingsPath, JSON.stringify({ hooks: { Stop: [{ command: "host-hook" }] } }), "utf8");
    await writeFakeClaudeCommand(commandPath);

    const restoreEnv = setOperatorHomeForTest(root);

    try {
      const result = await execute({
        runId: "run-5",
        agent: {
          id: "agent-5",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          args: [
            "--settings",
            hostileSettingsPath,
            "--add-dir=/tmp/legacy-hostile-add-dir",
            "--dangerously-skip-permissions",
            "--tools=default",
            "--no-strict-mcp-config",
          ],
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        settingsPath: string | null;
        managedClaudeSettingsPath: string | null;
      };
      expect(capture.argv).not.toContain(hostileSettingsPath);
      expect(capture.argv.some((arg) => arg.startsWith("--add-dir="))).toBe(false);
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");
      expect(capture.argv.some((arg) => arg.startsWith("--tools="))).toBe(false);
      expect(capture.argv).not.toContain("--no-strict-mcp-config");
      expect(capture.settingsPath).toBe(capture.managedClaudeSettingsPath);
    } finally {
      restoreEnv();
      await fs.rm(path.join(root, ".rudder"), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
