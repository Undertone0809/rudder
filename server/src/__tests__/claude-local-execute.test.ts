import { execute, runClaudeLogin } from "@rudderhq/agent-runtime-claude-local/server";
import {
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_TOOL_COUNT,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeSkillFixture,
  installCanonicalDesktopMcp,
  installVersionMismatchedDesktopMcp,
  readMcpToolNames,
} from "./local-runtime-browser-mismatch-helpers";
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
const mcpConfigIndex = process.argv.indexOf("--mcp-config");
const mcpConfigPath = mcpConfigIndex >= 0 ? process.argv[mcpConfigIndex + 1] : null;
const managedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? null;
const managedClaudeSettingsPath = process.env.RUDDER_CLAUDE_HOME
  ? path.join(process.env.RUDDER_CLAUDE_HOME, ".claude", "settings.json")
  : null;
const managedClaudeMcpConfigPath = mcpConfigPath;
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
    RUDDER_API_KEY: process.env.RUDDER_API_KEY ?? null,
    RUDDER_BROWSER_ENABLED: process.env.RUDDER_BROWSER_ENABLED ?? null,
    RUDDER_OPERATOR_HOME: process.env.RUDDER_OPERATOR_HOME ?? null,
    RUDDER_RUNTIME_TMPDIR: runtimeTmpDir,
    PATH: process.env.PATH ?? null,
  },
  settingsPath,
  settingSources,
  mcpConfigPath,
  managedClaudeConfigDir,
  managedClaudeSettingsPath,
  managedClaudeSettings:
    managedClaudeSettingsPath && fs.existsSync(managedClaudeSettingsPath)
      ? fs.readFileSync(managedClaudeSettingsPath, "utf8")
      : null,
  managedClaudeMcpConfigPath,
  managedClaudeMcpConfig:
    managedClaudeMcpConfigPath && fs.existsSync(managedClaudeMcpConfigPath)
      ? fs.readFileSync(managedClaudeMcpConfigPath, "utf8")
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
if (process.env.RUDDER_TEST_PROVIDER_FAILURE === "1") {
  console.error("forced Claude provider failure");
  process.exit(7);
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

async function createOperatorHomeSentinels(home: string) {
  await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
  await fs.mkdir(path.join(home, ".config", "gh"), { recursive: true });
  await fs.mkdir(path.join(home, ".npm"), { recursive: true });
  await fs.mkdir(path.join(home, ".vscode"), { recursive: true });
  await fs.writeFile(path.join(home, ".npmrc"), "//registry.example/:_authToken=secret\n", "utf8");
  await fs.writeFile(path.join(home, ".git-credentials"), "https://token@example.invalid\n", "utf8");
  await fs.writeFile(path.join(home, ".ssh", "config"), "Host example\n", "utf8");
  await fs.writeFile(path.join(home, ".config", "gh", "hosts.yml"), "github.com: {}\n", "utf8");
  await fs.writeFile(path.join(home, ".npm", "sentinel"), "operator npm cache\n", "utf8");
  await fs.writeFile(path.join(home, ".vscode", "settings.json"), "{}\n", "utf8");
}

async function expectNoOperatorHomeSentinelsInManagedHome(managedHome: string) {
  for (const relativePath of [
    ".npmrc",
    ".git-credentials",
    ".ssh",
    ".config/gh",
    ".npm",
    ".vscode",
  ]) {
    await expect(fs.lstat(path.join(managedHome, relativePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
}

async function createLegacyManagedCredentialBridgeSentinels(operatorHome: string, managedHome: string) {
  await fs.mkdir(managedHome, { recursive: true });
  for (const relativePath of [".npmrc", ".git-credentials", ".ssh", ".config/gh", ".npm", ".vscode"]) {
    const source = path.join(operatorHome, relativePath);
    const target = path.join(managedHome, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target);
  }
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
      await expect(fs.stat(path.join(
        root,
        ".rudder",
        "instances",
        "default",
        "organizations",
        "organization-1",
        "claude-home",
        "runtime-tmp",
        "claude-login-test",
      ))).rejects.toMatchObject({ code: "ENOENT" });
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
          id: "d573266f-af95-44e6-9303-e903a54662b8",
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
          promptTemplate: "Follow the rudder heartbeat as {{agent.id}}.",
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
      expect(systemPrompt).toContain("Use a plain newline-separated list. Do not use prose, bullets, Markdown, code spans, explanations, prefixes, or suffixes.");
      expect(systemPrompt).toContain("If exactly one skill is listed, answer exactly that runtime skill name and nothing else.");
      expect(systemPrompt).toContain("Do not list, summarize, or explain provider-native Claude Code skills or slash commands in that answer.");
      expect(systemPrompt.match(/## Your Current Automations/g)).toHaveLength(1);
      expect(systemPrompt.indexOf("# Agent Instructions")).toBeLessThan(systemPrompt.indexOf("# Agent Soul"));
      expect(systemPrompt.indexOf("# Agent Soul")).toBeLessThan(systemPrompt.indexOf("# Agent Tools"));
      expect(systemPrompt.indexOf("# Agent Tools")).toBeLessThan(systemPrompt.indexOf("# Tacit Memory"));
      expect(systemPrompt.indexOf("# Tacit Memory")).toBeLessThan(systemPrompt.indexOf("## Your Current Automations"));
      expect(systemPrompt.indexOf("## Your Current Automations")).toBeLessThan(systemPrompt.indexOf("# Rudder Heartbeat Instruction"));
      expect(systemPrompt).not.toContain("## Current Time");
      expect(systemPrompt).not.toContain("Instruction load time:");
      expect(systemPrompt.indexOf("# Rudder Heartbeat Instruction")).toBeLessThan(systemPrompt.indexOf("# Enabled Rudder Skills"));
      expect(agentInstructionStack).toContain(systemPrompt);
      expect(agentInstructionStack).toContain("Follow the rudder heartbeat as agt_d573266f.");
      expect(agentInstructionStack).not.toContain("Follow the rudder heartbeat as d573266f-af95-44e6-9303-e903a54662b8.");
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
      expect(capture.appendedSystemPrompt).toContain("- build-advisor");
      expect(capture.appendedSystemPrompt).not.toContain("- build-advisor: adapter:claude_local:build-advisor");
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
    const bundledSkillRoot = path.join(root, "bundled", "rudder-docs");
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
              key: "bundled:rudder/rudder-docs",
              runtimeName: "rudder-docs",
              name: "rudder-docs",
              source: bundledSkillRoot,
            },
          ],
          rudderSkillSync: {
            desiredSkills: ["bundled:rudder/rudder-docs"],
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
      expect(capture.addDirSkillEntries).toContain("rudder-docs");
      expect(capture.appendedSystemPrompt).toContain("# Enabled Rudder Skills");
      expect(capture.appendedSystemPrompt).toContain("- rudder-docs");
      expect(capture.appendedSystemPrompt).not.toContain("- rudder-docs: bundled:rudder/rudder-docs");
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
    const managedHome = path.join(root, ".rudder", "instances", "default", "organizations", "organization-1", "claude-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedSkillsDir, { recursive: true });
    await createOperatorHomeSentinels(root);
    await createLegacyManagedCredentialBridgeSentinels(root, managedHome);
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
            RUDDER_AGENT_ID: "stale-agent",
            RUDDER_API_KEY: "stale-agent-key",
            RUDDER_API_URL: "https://stale.example.invalid",
            RUDDER_BROWSER_ENABLED: "true",
            RUDDER_ORG_ID: "stale-organization",
            RUDDER_PROJECT_LIBRARY_PATH: "stale/project-library",
            RUDDER_RUN_ID: "stale-run",
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
            projectLibraryRoot: path.join(root, "org-workspace", "projects", "product"),
            projectLibraryRelativePath: "projects/product",
          },
        },
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
          RUDDER_API_KEY: string | null;
          RUDDER_OPERATOR_HOME: string | null;
          RUDDER_RUNTIME_TMPDIR: string | null;
          PATH: string | null;
        };
        settingsPath: string | null;
        settingSources: string | null;
        mcpConfigPath: string | null;
        managedClaudeConfigDir: string | null;
        managedClaudeSettingsPath: string | null;
        managedClaudeSettings: string | null;
        managedClaudeMcpConfigPath: string | null;
        managedClaudeMcpConfig: string | null;
        managedClaudeJsonPath: string | null;
        managedClaudeJsonExists: boolean;
        addDirSkillEntries: string[];
        runtimeTmpExists: boolean;
      };
      const managedConfigDir = path.join(managedHome, ".claude");
      const runtimeTmpDir = path.join(managedHome, "runtime-tmp", "run-3");
      expect(capture.managedClaudeSettingsPath).toContain("/.rudder/instances/default/organizations/organization-1/claude-home/.claude/settings.json");
      expect(capture.env.HOME).toBe(root);
      expect(capture.env.USERPROFILE).toBe(root);
      expect(capture.env.RUDDER_OPERATOR_HOME).toBe(root);
      expect(capture.env.RUDDER_CLAUDE_HOME).toBe(managedHome);
      expect(capture.env.RUDDER_RUNTIME_TMPDIR).toBe(runtimeTmpDir);
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(managedConfigDir);
      expect(capture.env.RUDDER_API_KEY).toBe("run-jwt-token");
      await expectNoOperatorHomeSentinelsInManagedHome(managedHome);
      expect(capture.runtimeTmpExists).toBe(true);
      expect(capture.managedClaudeConfigDir).toBe(managedConfigDir);
      expect(capture.argv).toContain("--permission-mode");
      expect(capture.argv[capture.argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(capture.argv).toContain("--settings");
      expect(capture.settingsPath).toBe(capture.managedClaudeSettingsPath);
      expect(capture.argv).toContain("--setting-sources");
      expect(capture.settingSources).toBe("user");
      expect(capture.argv).toContain("--mcp-config");
      expect(capture.mcpConfigPath).toBe(capture.managedClaudeMcpConfigPath);
      expect(capture.argv).toContain("--strict-mcp-config");
      const settingsStat = await fs.lstat(capture.managedClaudeSettingsPath!);
      expect(settingsStat.isSymbolicLink()).toBe(false);
      expect(settingsStat.mode & 0o777).toBe(0o600);
      await expect(fs.lstat(capture.managedClaudeMcpConfigPath!)).rejects.toMatchObject({
        code: "ENOENT",
      });
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
      expect(managedSettings.mcpServers).toMatchObject({
        "rudder-tools": {
          command: expect.any(String),
          args: expect.arrayContaining(["mcp-server"]),
        },
      });
      const managedMcpConfig = JSON.parse(capture.managedClaudeMcpConfig ?? "{}") as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      expect(managedMcpConfig.mcpServers).toMatchObject({
        "rudder-tools": {
          type: "stdio",
          command: expect.any(String),
          args: expect.arrayContaining(["mcp-server"]),
          env: {
            RUDDER_MCP_RUDDER_BIN: expect.any(String),
          },
        },
      });
      expect(Object.keys(managedMcpConfig.mcpServers ?? {})).toEqual(["rudder-tools"]);
      expect(managedMcpConfig.mcpServers?.["rudder-tools"]?.env).toMatchObject({
        RUDDER_API_URL: "http://localhost:3100",
        RUDDER_API_KEY: "run-jwt-token",
        RUDDER_ORG_ID: "organization-1",
        RUDDER_AGENT_ID: "agent-3",
        RUDDER_RUN_ID: "run-3",
        RUDDER_PROJECT_LIBRARY_PATH: "projects/product",
      });
      expect(managedMcpConfig.mcpServers?.["rudder-tools"]?.env).not.toHaveProperty(
        "RUDDER_BROWSER_ENABLED",
      );
      expect(capture.managedClaudeMcpConfig).not.toContain("stale-agent-key");
      expect(capture.managedClaudeMcpConfig).not.toContain("stale.example.invalid");
      expect(capture.managedClaudeMcpConfig).not.toContain("stale-organization");
      expect(capture.managedClaudeMcpConfig).not.toContain('"RUDDER_AGENT_ID": "stale-agent"');
      expect(capture.managedClaudeMcpConfig).not.toContain("stale-run");
      expect(capture.managedClaudeMcpConfig).not.toContain("stale/project-library");
      expect(managedSettings.permissions).toBeUndefined();
      expect(capture.managedClaudeJsonPath).toContain("/.rudder/instances/default/organizations/organization-1/claude-home/.claude.json");
      expect(capture.managedClaudeJsonExists).toBe(false);
      expect(capture.argv).toContain("--add-dir");
      expect(capture.argv).toContain(runtimeTmpDir);
      expect(capture.addDirSkillEntries).not.toContain("user-skill.txt");
      expect(capture.appendedSystemPrompt).toContain("# Enabled Rudder Skills");
      expect(capture.appendedSystemPrompt).toContain("No optional Rudder skills are enabled for this run.");
      expect(capture.appendedSystemPrompt).toContain("Claude Code built-in/provider-native skills");
      expect(capture.appendedSystemPrompt).toContain("Use a plain newline-separated list. Do not use prose, bullets, Markdown, code spans, explanations, prefixes, or suffixes.");
      expect(capture.appendedSystemPrompt).toContain("If exactly one skill is listed, answer exactly that runtime skill name and nothing else.");
      expect(capture.appendedSystemPrompt).toContain("Do not list, summarize, or explain provider-native Claude Code skills or slash commands in that answer.");
      expect(capture.appendedSystemPrompt).not.toContain("host-global-skill");
      expect(capture.appendedSystemPrompt).not.toContain("user-skill");
      expect(commandNotes).toContain("Injected Rudder enabled-skill boundary via --append-system-prompt-file.");
      expect(promptMetrics.skillBoundaryPromptChars).toBeGreaterThan(0);
      expect(loadedSkills).toEqual([]);
      expect(realizedSkills).toEqual([]);
      expect(nativeDiscoverableSkills).toBeUndefined();
      expect(commandNotes).toContain("Configured first-party Rudder MCP tools for Claude Code.");
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
        mcpConfigPath: string | null;
        managedClaudeSettingsPath: string | null;
        managedClaudeMcpConfigPath: string | null;
        addDirSkillEntries: string[];
      };
      expect(capture.argv).not.toContain(hostileSettingsPath);
      expect(capture.argv).not.toContain(hostileAddDir);
      expect(capture.argv).not.toContain(path.join(root, "hostile-mcp.json"));
      expect(capture.argv).toContain("--mcp-config");
      expect(capture.mcpConfigPath).toBe(capture.managedClaudeMcpConfigPath);
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

  it.skipIf(process.platform === "win32")(
    "configures isolated core and Browser MCP servers for an eligible Claude run",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-browser-enabled-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "claude");
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeClaudeCommand(commandPath);
      const installedDesktopMcp = await installCanonicalDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_HOME = path.join(root, ".rudder");
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};
      try {
        const result = await execute({
          runId: "run-claude-browser-enabled",
          agent: { id: "agent-1", orgId: "organization-1", name: "Claude Agent", agentRuntimeType: "claude_local", agentRuntimeConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            rudderBrowserEnabled: true,
            env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
            promptTemplate: "Follow the heartbeat.",
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
          onMeta: async (value) => { meta = value as Record<string, unknown>; },
        });
        expect(result.exitCode).toBe(0);
        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
          managedClaudeMcpConfig: string;
          managedClaudeMcpConfigPath: string;
        };
        const managedConfig = JSON.parse(capture.managedClaudeMcpConfig) as {
          mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
        };
        expect(Object.keys(managedConfig.mcpServers)).toEqual(["rudder-tools", "rudder-browser"]);
        const core = managedConfig.mcpServers["rudder-tools"];
        const browser = managedConfig.mcpServers["rudder-browser"];
        expect(await readMcpToolNames(core)).toEqual([...RUDDER_CORE_MCP_TOOL_NAMES]);
        expect(await readMcpToolNames(browser)).toEqual([...RUDDER_BROWSER_MCP_TOOL_NAMES]);
        expect(meta.rudderMcp).toMatchObject({
          available: true,
          serverName: "rudder-tools",
          toolCount: RUDDER_MCP_TOOL_COUNT,
        });
        expect(meta.browserMcp).toMatchObject({
          available: true,
          serverName: "rudder-browser",
          toolCount: RUDDER_BROWSER_MCP_TOOL_NAMES.length,
        });
        await expect(fs.stat(path.dirname(path.dirname(capture.managedClaudeMcpConfigPath))))
          .rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        installedDesktopMcp.restore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
        else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "isolates concurrent Claude MCP configs by run identity and Browser eligibility",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-concurrent-mcp-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "claude");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeClaudeCommand(commandPath);
      const installedDesktopMcp = await installCanonicalDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      process.env.HOME = root;
      process.env.RUDDER_HOME = path.join(root, ".rudder");
      try {
        const invoke = async (input: {
          agentId: string;
          browserEnabled: boolean;
          capturePath: string;
          runId: string;
          token: string;
        }) => execute({
          runId: input.runId,
          agent: { id: input.agentId, orgId: "organization-1", name: input.agentId, agentRuntimeType: "claude_local", agentRuntimeConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            rudderBrowserEnabled: input.browserEnabled,
            env: { RUDDER_TEST_CAPTURE_PATH: input.capturePath },
            promptTemplate: "Follow the heartbeat.",
          },
          context: {},
          authToken: input.token,
          onLog: async () => {},
        });
        const enabledCapturePath = path.join(root, "enabled.json");
        const disabledCapturePath = path.join(root, "disabled.json");
        const [enabledResult, disabledResult] = await Promise.all([
          invoke({ agentId: "agent-enabled", browserEnabled: true, capturePath: enabledCapturePath, runId: "run-enabled", token: "token-enabled" }),
          invoke({ agentId: "agent-disabled", browserEnabled: false, capturePath: disabledCapturePath, runId: "run-disabled", token: "token-disabled" }),
        ]);
        expect([enabledResult.exitCode, disabledResult.exitCode]).toEqual([0, 0]);
        const captures = await Promise.all([enabledCapturePath, disabledCapturePath].map(async (filePath) =>
          JSON.parse(await fs.readFile(filePath, "utf8")) as {
            managedClaudeMcpConfig: string;
            managedClaudeMcpConfigPath: string;
          }
        ));
        expect(captures[0].managedClaudeMcpConfigPath).not.toBe(captures[1].managedClaudeMcpConfigPath);
        const [enabledConfig, disabledConfig] = captures.map((capture) => JSON.parse(capture.managedClaudeMcpConfig) as {
          mcpServers: Record<string, { env: Record<string, string> }>;
        });
        expect(Object.keys(enabledConfig.mcpServers)).toEqual(["rudder-tools", "rudder-browser"]);
        expect(Object.keys(disabledConfig.mcpServers)).toEqual(["rudder-tools"]);
        for (const server of Object.values(enabledConfig.mcpServers)) {
          expect(server.env).toMatchObject({ RUDDER_AGENT_ID: "agent-enabled", RUDDER_API_KEY: "token-enabled", RUDDER_RUN_ID: "run-enabled" });
          expect(JSON.stringify(server.env)).not.toContain("token-disabled");
        }
        expect(disabledConfig.mcpServers["rudder-tools"].env).toMatchObject({
          RUDDER_AGENT_ID: "agent-disabled",
          RUDDER_API_KEY: "token-disabled",
          RUDDER_RUN_ID: "run-disabled",
        });
        expect(JSON.stringify(disabledConfig)).not.toContain("token-enabled");
        await Promise.all(captures.map(async (capture) => {
          await expect(fs.stat(path.dirname(path.dirname(capture.managedClaudeMcpConfigPath))))
            .rejects.toMatchObject({ code: "ENOENT" });
        }));
      } finally {
        installedDesktopMcp.restore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes the Claude run credential config after provider failure",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-failed-config-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "claude");
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeClaudeCommand(commandPath);
      const installedDesktopMcp = await installCanonicalDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      process.env.HOME = root;
      process.env.RUDDER_HOME = path.join(root, ".rudder");
      try {
        const result = await execute({
          runId: "run-failed",
          agent: { id: "agent-failed", orgId: "organization-1", name: "Failed Agent", agentRuntimeType: "claude_local", agentRuntimeConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            env: { RUDDER_TEST_CAPTURE_PATH: capturePath, RUDDER_TEST_PROVIDER_FAILURE: "1" },
            promptTemplate: "Follow the heartbeat.",
          },
          context: {},
          authToken: "token-failed",
          onLog: async () => {},
        });
        expect(result.exitCode).toBe(7);
        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
          managedClaudeMcpConfig: string;
          managedClaudeMcpConfigPath: string;
        };
        expect(capture.managedClaudeMcpConfig).toContain("token-failed");
        await expect(fs.stat(path.dirname(path.dirname(capture.managedClaudeMcpConfigPath))))
          .rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        installedDesktopMcp.restore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes Browser skill, prompt, tools, and metadata together after a bundle mismatch",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-browser-mismatch-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "claude");
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeClaudeCommand(commandPath);
      const browserSkill = await createRuntimeSkillFixture(root, "browser", "BROWSER_SKILL_PROMISE");
      const keepSkill = await createRuntimeSkillFixture(root, "keep-skill", "KEEP_SKILL_AVAILABLE");
      const installedDesktopMcp = await installVersionMismatchedDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_HOME = path.join(root, ".rudder");
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};

      try {
        const result = await execute({
          runId: "run-claude-browser-mismatch",
          agent: {
            id: "agent-1",
            orgId: "organization-1",
            name: "Claude Agent",
            agentRuntimeType: "claude_local",
            agentRuntimeConfig: {},
          },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            rudderBrowserEnabled: true,
            rudderRuntimeSkills: [
              { key: "bundled:rudder/browser", runtimeName: "browser", source: browserSkill },
              { key: "org:keep-skill", runtimeName: "keep-skill", source: keepSkill },
            ],
            rudderSkillSync: { desiredSkills: ["bundled:rudder/browser", "org:keep-skill"] },
            env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
            promptTemplate: "Follow the heartbeat.",
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
          onMeta: async (value) => { meta = value as Record<string, unknown>; },
        });

        expect(result.exitCode).toBe(0);
        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
          env: { RUDDER_BROWSER_ENABLED: string | null };
          appendedSystemPrompt: string | null;
          addDirSkillEntries: string[];
          managedClaudeMcpConfig: string;
        };
        expect(capture.env.RUDDER_BROWSER_ENABLED).toBe("false");
        expect(capture.appendedSystemPrompt).toContain("- keep-skill");
        expect(capture.appendedSystemPrompt).not.toContain("browser");
        expect(capture.addDirSkillEntries).toEqual(["keep-skill"]);
        expect(meta.agentInstructionStack).toContain("- keep-skill");
        expect(meta.agentInstructionStack).not.toContain("BROWSER_SKILL_PROMISE");
        expect(meta.loadedSkills).toEqual([expect.objectContaining({ runtimeName: "keep-skill" })]);
        expect(meta.realizedSkills).toEqual(meta.loadedSkills);
        expect(meta.rudderMcp).toMatchObject({
          available: true,
          toolCount: RUDDER_MCP_TOOL_COUNT,
        });
        expect(meta.rudderMcp).not.toHaveProperty("browserAvailable");
        expect(meta.rudderMcp).not.toHaveProperty("contractHash");
        expect(meta.rudderMcp).not.toHaveProperty("diagnosticCode");
        expect(meta.browserMcp).toMatchObject({
          available: false,
          diagnosticCode: "browser_bundle_version_mismatch",
          serverName: "rudder-browser",
          toolCount: RUDDER_BROWSER_MCP_TOOL_NAMES.length,
        });
        const managedConfig = JSON.parse(capture.managedClaudeMcpConfig) as {
          mcpServers: Record<string, {
            command: string;
            args: string[];
            env?: Record<string, string>;
          }>;
        };
        expect(Object.keys(managedConfig.mcpServers)).toEqual(["rudder-tools"]);
        const generatedMcpConfig = managedConfig.mcpServers["rudder-tools"];
        expect(generatedMcpConfig.env?.RUDDER_BROWSER_ENABLED).toBeUndefined();
        expect(generatedMcpConfig.command).toBe(installedDesktopMcp.command);
        expect(generatedMcpConfig.args).toEqual(installedDesktopMcp.args);
        expect(await readMcpToolNames({
          command: generatedMcpConfig.command,
          args: generatedMcpConfig.args,
          env: generatedMcpConfig.env,
        })).toEqual([...RUDDER_CORE_MCP_TOOL_NAMES]);
      } finally {
        installedDesktopMcp.restore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
        else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
