import { execute, resetOpenCodeModelsCacheForTests } from "@rudderhq/agent-runtime-opencode-local/server";
import { buildOpenCodeLocalConfig } from "@rudderhq/agent-runtime-opencode-local/ui";
import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_CONTRACT_VERSION,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeSkillFixture,
  installVersionMismatchedDesktopMcp,
  readMcpToolNames,
} from "./local-runtime-browser-mismatch-helpers";
import {
  clearInheritedGitIdentityEnv,
  expectPreparedGitConfigCapture,
  gitIdentityCaptureSnippet,
  type GitIdentityCapture,
} from "./local-runtime-git-identity-helpers";

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}

if (process.argv[2] === "models") {
  console.log("openai/gpt-4.1-mini");
  process.exit(0);
}

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const fileFlagIndex = process.argv.indexOf("--file");
const promptFilePath = fileFlagIndex >= 0 ? process.argv[fileFlagIndex + 1] : "";
const payload = {
  argv: process.argv.slice(2),
  home: process.env.HOME || null,
  userProfile: process.env.USERPROFILE || null,
  opencodeConfig: process.env.OPENCODE_CONFIG || null,
  opencodeConfigContent: process.env.OPENCODE_CONFIG_CONTENT || null,
  opencodeConfigDir: process.env.OPENCODE_CONFIG_DIR || null,
  rudderOperatorHome: process.env.RUDDER_OPERATOR_HOME || null,
  rudderBrowserEnabled: process.env.RUDDER_BROWSER_ENABLED || null,
  xdgConfigHome: process.env.XDG_CONFIG_HOME || null,
  xdgDataHome: process.env.XDG_DATA_HOME || null,
  xdgCacheHome: process.env.XDG_CACHE_HOME || null,
  prompt: promptFilePath ? fs.readFileSync(promptFilePath, "utf8") : fs.readFileSync(0, "utf8"),
  promptFilePath,
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
  gitIdentity: captureGitIdentityEnv(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
if (process.env.RUDDER_TEST_OPENCODE_STARTUP_IDLE === "1") {
  setInterval(() => {}, 1000);
} else {
console.log(JSON.stringify({ type: "step_start", sessionID: "opencode-session-1" }));
if (process.env.RUDDER_TEST_NO_FINAL_TEXT !== "1") {
  console.log(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }));
}
if (process.env.RUDDER_TEST_OPENCODE_COMPLETION_SUMMARY_LOOP === "1") {
  console.log(JSON.stringify({
    type: "text",
    part: {
      type: "text",
      text: [
        "## Goal",
        "- Validate Rudder runtime tools.",
        "",
        "## Constraints & Preferences",
        "- Use Rudder tools.",
        "",
        "## Progress",
        "### Done",
        "- Called rudder_agent_me tool successfully.",
        "",
        "### In Progress",
        "- (none)",
        "",
        "## Next Steps",
        "- Task complete - runtime validation successful.",
        "",
        "## Critical Context",
        "- Tool call completed.",
        "",
        "## Relevant Files",
        "- /tmp/rudder-prompt.md"
      ].join("\\n")
    }
  }));
}
if (process.env.RUDDER_TEST_OPENCODE_NON_COMPLETION_SUMMARY === "1") {
  console.log(JSON.stringify({
    type: "text",
    part: {
      type: "text",
      text: [
        "## Goal",
        "- No task initiated yet.",
        "",
        "## Constraints & Preferences",
        "- (none)",
        "",
        "## Progress",
        "### Done",
        "- Read the prompt file.",
        "",
        "## Next Steps",
        "- (none)",
        "",
        "## Critical Context",
        "- Prompt loaded.",
        "",
        "## Relevant Files",
        "- /tmp/rudder-prompt.md"
      ].join("\\n")
    }
  }));
}
if (process.env.RUDDER_TEST_OPENCODE_TOOL_CALL_IDLE === "1") {
  console.log(JSON.stringify({
    type: "step_finish",
    part: {
      reason: "tool-calls",
      cost: 0,
      tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }
    }
  }));
  setInterval(() => {}, 1000);
} else {
console.log(JSON.stringify({
  type: "step_finish",
  part: {
    reason: "stop",
    cost: 0,
    tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }
  }
}));
}
}
if (process.env.RUDDER_TEST_OPENCODE_COMPACTION_LOOP === "1") {
  console.log(JSON.stringify({
    type: "text",
    part: {
      type: "text",
      metadata: { compaction_continue: true },
      synthetic: true,
      text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
    }
  }));
  setInterval(() => {
    console.log(JSON.stringify({ type: "step_start", sessionID: "opencode-session-1" }));
  }, 50);
}
if (process.env.RUDDER_TEST_OPENCODE_COMPLETION_SUMMARY_LOOP === "1") {
  setInterval(() => {
    console.log(JSON.stringify({
      type: "text",
      part: {
        type: "text",
        text: "I don't have access to a rudder_agent_me tool."
      }
    }));
  }, 50);
}
if (process.env.RUDDER_TEST_OPENCODE_NON_COMPLETION_SUMMARY === "1") {
  console.log(JSON.stringify({
    type: "text",
    part: {
      type: "text",
      text: "final answer after continuation"
    }
  }));
}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
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

describe("opencode execute", { timeout: 20_000 }, () => {
  it("does not inherit the global dangerous permission default unless explicitly enabled", () => {
    expect(buildOpenCodeLocalConfig({
      agentRuntimeType: "opencode_local",
      cwd: "",
      instructionsFilePath: "",
      promptTemplate: "",
      model: "opencode/deepseek-v4-flash-free",
      modelFallbacks: [],
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: true,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      payloadTemplateJson: "",
      workspaceStrategyType: "project_primary",
      workspaceBaseRef: "",
      workspaceBranchTemplate: "",
      worktreeParentDir: "",
      runtimeServicesJson: "",
      maxTurnsPerRun: 300,
      heartbeatEnabled: false,
      intervalSec: 300,
      preflightEnabled: true,
      maxConcurrentRuns: 1,
    })).toMatchObject({
      model: "opencode/deepseek-v4-flash-free",
      dangerouslySkipPermissions: true,
    });

    expect(buildOpenCodeLocalConfig({
      agentRuntimeType: "opencode_local",
      cwd: "",
      instructionsFilePath: "",
      promptTemplate: "",
      model: "opencode/deepseek-v4-flash-free",
      modelFallbacks: [],
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      payloadTemplateJson: "",
      workspaceStrategyType: "project_primary",
      workspaceBaseRef: "",
      workspaceBranchTemplate: "",
      worktreeParentDir: "",
      runtimeServicesJson: "",
      maxTurnsPerRun: 300,
      heartbeatEnabled: false,
      intervalSec: 300,
      preflightEnabled: true,
      maxConcurrentRuns: 1,
    })).not.toHaveProperty("dangerouslySkipPermissions");
  });

  it("prepends sibling memory instructions and reports memory prompt metrics", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-memory-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Prefer short handoffs.\n", "utf8");
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    try {
      const result = await execute({
        runId: "run-opencode-memory",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          instructionsFilePath: instructionsPath,
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
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        home: string | null;
        userProfile: string | null;
        opencodeConfig: string | null;
        rudderOperatorHome: string | null;
        prompt: string;
        rudderEnvKeys: string[];
        gitIdentity: GitIdentityCapture;
      };
      expectPreparedGitConfigCapture(capture);
      expect(capture.home).toBe(root);
      expect(capture.userProfile).toBe(root);
      expect(capture.opencodeConfig).toBe(path.join(root, ".rudder", "instances", "default", "organizations", "organization-1", "opencode-home", ".config", "opencode", "opencode.json"));
      expect(capture.rudderOperatorHome).toBe(root);
      expect(capture.argv).toEqual(expect.arrayContaining(["run", "--format", "json", "--dir", workspace]));
      expect(capture.argv).toContain("--pure");
      expect(capture.argv).toContain("Follow the attached Rudder runtime prompt file exactly.");
      expect(capture.argv).toContain("--file");
      expect(capture.argv).not.toContain(capture.prompt);
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");
      expect(capture.prompt).toContain("# Agent Instructions");
      expect(capture.prompt).toContain("# Tacit Memory");
      expect(capture.rudderEnvKeys).toEqual(expect.arrayContaining([
        "RUDDER_PROJECT_LIBRARY_PATH",
        "RUDDER_PROJECT_LIBRARY_ROOT",
      ]));
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes explicit cwd and permission bypass when configured", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-dir-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      await execute({
        runId: "run-opencode-dir",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          dangerouslySkipPermissions: true,
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { argv: string[] };
      expect(capture.argv).toEqual(expect.arrayContaining(["run", "--format", "json", "--dir", workspace]));
      expect(capture.argv).toContain("--pure");
      expect(capture.argv).toContain("Follow the attached Rudder runtime prompt file exactly.");
      expect(capture.argv).toContain("--file");
      expect(capture.argv).toContain("--dangerously-skip-permissions");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("marks a zero-exit run without final text as degraded instead of returning an empty summary", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-no-summary-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-no-summary",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_NO_FINAL_TEXT: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("without a final text summary");
      expect(result.summary).toContain("without a final text summary");
      expect(result.resultJson).toMatchObject({ summaryStatus: "missing_final_text" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stops after terminal final text when OpenCode emits synthetic compaction continuation", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-compaction-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-compaction",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          timeoutSec: 30,
          graceSec: 1,
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_OPENCODE_COMPACTION_LOOP: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toBe("hello");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stops after a completed OpenCode continuation summary without persisting later contradictory text", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-completion-summary-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-completion-summary",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          timeoutSec: 30,
          graceSec: 1,
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_NO_FINAL_TEXT: "1",
            RUDDER_TEST_OPENCODE_COMPLETION_SUMMARY_LOOP: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toContain("Task complete");
      expect(result.summary).not.toContain("don't have access");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not stop on a non-completion OpenCode continuation summary", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-non-completion-summary-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-non-completion-summary",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          timeoutSec: 30,
          graceSec: 1,
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_NO_FINAL_TEXT: "1",
            RUDDER_TEST_OPENCODE_NON_COMPLETION_SUMMARY: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toBe("final answer after continuation");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when OpenCode stops producing output after a tool-call step", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-tool-idle-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-tool-idle",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          graceSec: 1,
          toolLoopIdleTimeoutSec: 1,
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_NO_FINAL_TEXT: "1",
            RUDDER_TEST_OPENCODE_TOOL_CALL_IDLE: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.signal).toBe("SIGTERM");
      expect(result.errorCode).toBe("opencode_tool_loop_idle");
      expect(result.errorMessage).toContain("without continuing after a Rudder tool-call step");
      expect(result.resultJson).toMatchObject({
        summaryStatus: "tool_loop_idle",
        stoppedAfterToolLoopIdle: true,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when OpenCode emits no JSON output after startup", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-startup-idle-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-startup-idle",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          graceSec: 1,
          startupIdleTimeoutSec: 1,
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_OPENCODE_STARTUP_IDLE: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.signal).toBe("SIGTERM");
      expect(result.errorCode).toBe("opencode_startup_idle");
      expect(result.errorMessage).toContain("without emitting JSON output");
      expect(result.resultJson).toMatchObject({
        summaryStatus: "startup_idle",
        stoppedAfterStartupIdle: true,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects organization-library runtime skills into the OpenCode prompt from the managed sidecar", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-runtime-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const operatorSkillPath = path.join(root, ".claude", "skills", "operator-skill", "SKILL.md");
    const operatorOpenCodeConfigDir = path.join(root, ".config", "opencode");
    const operatorOpenCodePluginPath = path.join(operatorOpenCodeConfigDir, "plugins", "forbidden-plugin.js");
    const forbiddenConfigMarker = "ZST646_FORBIDDEN_OPENCODE_CONFIG_PLUGIN";
    const managedOpenCodeHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "opencode-home",
    );
    const managedSkillsHome = path.join(
      managedOpenCodeHome,
      ".claude",
      "skills",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(operatorSkillPath), { recursive: true });
    await fs.mkdir(path.dirname(operatorOpenCodePluginPath), { recursive: true });
    await createOperatorHomeSentinels(root);
    await createLegacyManagedCredentialBridgeSentinels(root, managedOpenCodeHome);
    await fs.writeFile(operatorSkillPath, "---\nname: operator-skill\n---\n", "utf8");
    await fs.mkdir(path.join(managedOpenCodeHome, ".config", "opencode", "skills", "stale-skill"), { recursive: true });
    await fs.mkdir(path.join(managedOpenCodeHome, ".config", "opencode", "plugin"), { recursive: true });
    await fs.writeFile(
      path.join(managedOpenCodeHome, ".config", "opencode", "skills", "stale-skill", "SKILL.md"),
      `---\nname: stale-skill\n---\n\n${forbiddenConfigMarker}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(managedOpenCodeHome, ".config", "opencode", "plugin", "stale-plugin.js"),
      `export default () => "${forbiddenConfigMarker}";\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(managedOpenCodeHome, ".config", "opencode", "opencode.jsonc"),
      JSON.stringify({
        plugin: ["./plugin/stale-plugin.js"],
        mcp: {
          forbidden: {
            command: `printf ${forbiddenConfigMarker}`,
          },
        },
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(operatorOpenCodeConfigDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: {
          command: ["printf", forbiddenConfigMarker],
        },
        autoupdate: true,
        provider: {
          deepseek: {
            id: "deepseek",
            name: "DeepSeek",
            api: "deepseek-key",
            options: {
              apiKey: "deepseek-key",
              baseURL: "https://api.deepseek.com/v1",
            },
          },
          localDanger: {
            api: "local-danger-key",
            command: ["printf", forbiddenConfigMarker],
            options: {
              apiKey: "local-danger-key",
              plugin: ["./plugins/forbidden-plugin.js"],
            },
          },
        },
        keybinds: {
          danger: `plugin:${forbiddenConfigMarker}`,
        },
        plugin: ["./plugins/forbidden-plugin.js"],
        mcp: {
          forbidden: {
            command: `printf ${forbiddenConfigMarker}`,
          },
        },
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(operatorOpenCodePluginPath, `export default () => "${forbiddenConfigMarker}";\n`, "utf8");
    await writeFakeOpenCodeCommand(commandPath);

    const rudderDir = await createSkillDir(runtimeSkillsRoot, "rudder");
    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");

    let loadedSkills: unknown[] = [];
    let realizedSkills: unknown[] = [];
    let promptInjectedSkills: unknown[] = [];
    let nativeDiscoverableSkills: unknown[] | undefined;
    let rudderMcp: unknown;
    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    const previousRudderHome = process.env.RUDDER_HOME;
    const previousRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    process.env.RUDDER_HOME = path.join(root, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "default";
    process.env.XDG_CONFIG_HOME = path.join(root, "forbidden-host-xdg-config");
    process.env.XDG_DATA_HOME = path.join(root, "forbidden-host-xdg-data");
    process.env.XDG_CACHE_HOME = path.join(root, "forbidden-host-xdg-cache");

    try {
      const result = await execute({
        runId: "run-opencode-runtime-skill",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          rudderRuntimeSkills: [
            {
              name: "rudder",
              source: rudderDir,
            },
            {
              name: "ascii-heart",
              source: asciiHeartDir,
            },
          ],
          rudderSkillSync: {
            desiredSkills: ["ascii-heart"],
          },
          env: {
            ...clearInheritedGitIdentityEnv,
            OPENCODE_CONFIG: path.join(root, "forbidden-opencode.json"),
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              mcp: {
                forbidden: {
                  command: `printf ${forbiddenConfigMarker}`,
                },
              },
            }),
            OPENCODE_CONFIG_DIR: path.join(root, "forbidden-opencode-config-dir"),
            RUDDER_AGENT_ID: "forbidden-agent",
            RUDDER_API_KEY: "forbidden-api-key",
            RUDDER_API_URL: "https://forbidden.example.invalid",
            RUDDER_ORG_ID: "forbidden-org",
            RUDDER_PROJECT_LIBRARY_PATH: "forbidden/project-library",
            RUDDER_RUN_ID: "forbidden-run",
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loadedSkills = meta.loadedSkills ?? [];
          realizedSkills = meta.realizedSkills ?? [];
          promptInjectedSkills = meta.promptInjectedSkills ?? [];
          nativeDiscoverableSkills = meta.nativeDiscoverableSkills;
          rudderMcp = meta.rudderMcp;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        home: string | null;
        opencodeConfig: string | null;
        rudderOperatorHome: string | null;
        xdgConfigHome: string | null;
        xdgDataHome: string | null;
        xdgCacheHome: string | null;
        prompt: string;
        opencodeConfigContent: string | null;
        opencodeConfigDir: string | null;
      };
      expect(capture.home).toBe(root);
      expect(capture.opencodeConfig).toBe(path.join(managedOpenCodeHome, ".config", "opencode", "opencode.json"));
      expect(capture.rudderOperatorHome).toBe(root);
      expect(capture.xdgConfigHome).toBe(path.join(managedOpenCodeHome, ".config"));
      expect(capture.xdgDataHome).toBe(path.join(managedOpenCodeHome, ".local", "share"));
      expect(capture.xdgCacheHome).toBe(path.join(managedOpenCodeHome, ".cache"));
      expect(capture.argv).toEqual(expect.arrayContaining(["run", "--format", "json", "--dir", workspace]));
      expect(capture.argv).toContain("--pure");
      expect(capture.argv).toContain("Follow the attached Rudder runtime prompt file exactly.");
      expect(capture.argv).toContain("--file");
      expect(capture.argv).not.toContain(capture.prompt);
      expect(capture.opencodeConfigContent).toBeNull();
      expect(capture.opencodeConfigDir).toBeNull();
      await expectNoOperatorHomeSentinelsInManagedHome(managedOpenCodeHome);
      const managedConfigDir = path.join(managedOpenCodeHome, ".config", "opencode");
      expect((await fs.lstat(managedConfigDir)).isSymbolicLink()).toBe(false);
      await expect(fs.lstat(path.join(managedConfigDir, "plugins", "forbidden-plugin.js"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedConfigDir, "skills", "stale-skill", "SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedConfigDir, "plugin", "stale-plugin.js"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedConfigDir, "opencode.jsonc"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fs.stat(path.join(managedConfigDir, "opencode.json"))).mode & 0o777).toBe(0o600);
      await expect(fs.readFile(path.join(managedConfigDir, "opencode.json"), "utf8")).resolves.not.toContain(
        forbiddenConfigMarker,
      );
      const managedConfig = JSON.parse(await fs.readFile(path.join(managedConfigDir, "opencode.json"), "utf8")) as {
        autoupdate?: unknown;
        mcp?: Record<string, { type?: unknown; command?: unknown; environment?: Record<string, unknown>; enabled?: unknown }>;
        provider?: Record<string, unknown>;
      };
      expect(managedConfig.autoupdate).toBe(false);
      expect(Object.keys(managedConfig.mcp ?? {})).toEqual(["rudder-operating-layer"]);
      expect(managedConfig.mcp?.["rudder-operating-layer"]).toMatchObject({
        type: "local",
        enabled: true,
        environment: {
          RUDDER_API_URL: "http://localhost:3100",
          RUDDER_API_KEY: "run-jwt-token",
          RUDDER_ORG_ID: "organization-1",
          RUDDER_AGENT_ID: "agent-1",
          RUDDER_RUN_ID: "run-opencode-runtime-skill",
        },
      });
      expect(JSON.stringify(managedConfig)).not.toContain("forbidden-agent");
      expect(JSON.stringify(managedConfig)).not.toContain("forbidden-api-key");
      expect(JSON.stringify(managedConfig)).not.toContain("https://forbidden.example.invalid");
      expect(JSON.stringify(managedConfig)).not.toContain("forbidden-org");
      expect(JSON.stringify(managedConfig)).not.toContain("forbidden/project-library");
      expect(JSON.stringify(managedConfig)).not.toContain("forbidden-run");
      expect(managedConfig.mcp?.["rudder-operating-layer"]?.command).toEqual(
        expect.arrayContaining(["mcp-server"]),
      );
      expect(managedConfig.provider).toMatchObject({
        deepseek: {
          id: "deepseek",
          name: "DeepSeek",
          api: "deepseek-key",
          options: {
            apiKey: "deepseek-key",
            baseURL: "https://api.deepseek.com/v1",
          },
        },
        localDanger: {
          api: "local-danger-key",
          options: {
            apiKey: "local-danger-key",
          },
        },
      });
      expect(JSON.stringify(managedConfig.provider)).not.toContain("command");
      expect(JSON.stringify(managedConfig.provider)).not.toContain("plugin");
      expect((await fs.lstat(path.join(managedSkillsHome, "ascii-heart"))).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(path.join(managedSkillsHome, "ascii-heart"))).toBe(
        await fs.realpath(asciiHeartDir),
      );
      await expect(fs.lstat(path.join(root, ".claude", "skills", "ascii-heart"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(capture.prompt).toContain("# Enabled Rudder Skills");
      expect(capture.prompt).toContain("## Skill: ascii-heart");
      expect(capture.prompt).not.toContain("operator-skill");
      expect(loadedSkills).toEqual([
        expect.objectContaining({
          key: "ascii-heart",
          runtimeName: "ascii-heart",
        }),
      ]);
      expect(realizedSkills).toEqual(loadedSkills);
      expect(promptInjectedSkills).toEqual(loadedSkills);
      expect(nativeDiscoverableSkills).toBeUndefined();
      expect(rudderMcp).toEqual({
        available: true,
        browserAvailable: false,
        contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
        coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
        contractVersion: RUDDER_MCP_CONTRACT_VERSION,
        diagnosticCode: null,
        provenance: "repo",
        serverName: "rudder-operating-layer",
        toolCount: 69,
        version: "0.5.0",
        fallbackReason: null,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousRudderHome;
      if (previousRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousRudderInstanceId;
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes previously materialized OpenCode skills when they are no longer selected", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-prune-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const managedOpenCodeHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "opencode-home",
    );
    const managedSkillsHome = path.join(managedOpenCodeHome, ".claude", "skills");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");
    await fs.mkdir(managedSkillsHome, { recursive: true });
    await fs.symlink(asciiHeartDir, path.join(managedSkillsHome, "ascii-heart"));

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    const previousRudderHome = process.env.RUDDER_HOME;
    const previousRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    process.env.RUDDER_HOME = path.join(root, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "default";
    process.env.XDG_CONFIG_HOME = path.join(root, ".config");
    process.env.XDG_DATA_HOME = path.join(root, ".local", "share");
    process.env.XDG_CACHE_HOME = path.join(root, ".cache");

    let loadedSkills: unknown[] = [{ key: "before" }];

    try {
      const result = await execute({
        runId: "run-opencode-prune-skill",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          rudderRuntimeSkills: [
            {
              name: "ascii-heart",
              source: asciiHeartDir,
            },
          ],
          rudderSkillSync: {
            desiredSkills: [],
          },
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loadedSkills = meta.loadedSkills ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { prompt: string };
      expect(capture.prompt).not.toContain("## Skill: ascii-heart");
      await expect(fs.lstat(path.join(managedSkillsHome, "ascii-heart"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(loadedSkills).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousRudderHome;
      if (previousRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousRudderInstanceId;
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("omits injected skill prompt text during internal chat result repair", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-repair-skill-prompt-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");
    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    const previousRudderHome = process.env.RUDDER_HOME;
    const previousRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    process.env.RUDDER_HOME = path.join(root, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "default";

    try {
      const result = await execute({
        runId: "run-opencode-repair-skill-prompt",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          rudderRuntimeSkills: [
            {
              name: "ascii-heart",
              source: asciiHeartDir,
            },
          ],
          rudderSkillSync: {
            desiredSkills: ["ascii-heart"],
          },
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "{{context.chatPrompt}}",
        },
        context: {
          chatMode: true,
          rudderChatResultRepair: true,
          chatPrompt: "Rudder internal repair request: emit the result envelope.",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { prompt: string };
      expect(capture.prompt).toContain("Rudder internal repair request: emit the result envelope.");
      expect(capture.prompt).not.toContain("# Enabled Rudder Skills");
      expect(capture.prompt).not.toContain("## Skill: ascii-heart");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousRudderHome;
      if (previousRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousRudderInstanceId;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes chat prompts through stdin instead of an attached prompt file", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-chat-stdin-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-chat-stdin",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "{{context.chatPrompt}}",
        },
        context: {
          chatMode: true,
          chatPrompt: "Chat prompt with final result envelope.",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { argv: string[]; prompt: string; promptFilePath: string };
      expect(capture.argv).toEqual(expect.arrayContaining(["run", "--format", "json", "--dir", workspace]));
      expect(capture.argv).not.toContain("Follow the attached Rudder runtime prompt file exactly.");
      expect(capture.argv).not.toContain("--file");
      expect(capture.promptFilePath).toBe("");
      expect(capture.prompt).toContain("Chat prompt with final result envelope.");
      expect(capture.argv).not.toContain(capture.prompt);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies a finite default timeout for chat mode when timeoutSec is unset", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-chat-timeout-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    let commandNotes: string[] = [];
    try {
      const result = await execute({
        runId: "run-opencode-chat-timeout",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "OpenCode Agent",
          agentRuntimeType: "opencode_local",
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
          model: "openai/gpt-4.1-mini",
          timeoutSec: 0,
          env: {
            ...clearInheritedGitIdentityEnv,
          },
          promptTemplate: "{{context.chatPrompt}}",
        },
        context: {
          chatMode: true,
          chatPrompt: "Chat prompt with timeout fallback.",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(commandNotes).toContain(
        "Applied 60s default timeout for OpenCode chat mode because timeoutSec was unset.",
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "removes Browser skill, prompt, tools, and metadata together after a bundle mismatch",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-browser-mismatch-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "opencode");
      const capturePath = path.join(root, "capture.json");
      const rudderHome = path.join(root, ".rudder");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeOpenCodeCommand(commandPath);
      const browserSkill = await createRuntimeSkillFixture(root, "browser", "BROWSER_SKILL_PROMISE");
      const keepSkill = await createRuntimeSkillFixture(root, "keep-skill", "KEEP_SKILL_AVAILABLE");
      const installedDesktopMcp = await installVersionMismatchedDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_OPERATOR_HOME = root;
      process.env.RUDDER_HOME = rudderHome;
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};

      try {
        const result = await execute({
          runId: "run-opencode-browser-mismatch",
          agent: {
            id: "agent-1",
            orgId: "organization-1",
            name: "OpenCode Agent",
            agentRuntimeType: "opencode_local",
            agentRuntimeConfig: {},
          },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            model: "openai/gpt-4.1-mini",
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
          prompt: string;
          opencodeConfig: string;
          rudderBrowserEnabled: string | null;
        };
        expect(capture.rudderBrowserEnabled).toBe("false");
        expect(capture.prompt).toContain("KEEP_SKILL_AVAILABLE");
        expect(capture.prompt).not.toContain("BROWSER_SKILL_PROMISE");
        expect(meta.loadedSkills).toEqual([expect.objectContaining({ runtimeName: "keep-skill" })]);
        expect(meta.realizedSkills).toEqual(meta.loadedSkills);
        expect(meta.promptInjectedSkills).toEqual(meta.loadedSkills);
        expect(meta.rudderMcp).toMatchObject({
          available: true,
          browserAvailable: false,
          diagnosticCode: "browser_bundle_version_mismatch",
          toolCount: 69,
        });
        const managedSkills = path.join(
          rudderHome,
          "instances",
          "default",
          "organizations",
          "organization-1",
          "opencode-home",
          ".claude",
          "skills",
        );
        expect(await fs.readdir(managedSkills)).toEqual(["keep-skill"]);
        const managedConfig = JSON.parse(await fs.readFile(capture.opencodeConfig, "utf8")) as {
          mcp?: Record<string, {
            command?: string[];
            environment?: Record<string, string>;
          }>;
        };
        expect(managedConfig.mcp?.["rudder-operating-layer"]?.environment?.RUDDER_BROWSER_ENABLED).toBe("false");
        const generatedMcpConfig = managedConfig.mcp?.["rudder-operating-layer"];
        expect(generatedMcpConfig?.command?.[0]).toBe(installedDesktopMcp.command);
        expect(generatedMcpConfig?.command?.slice(1)).toEqual(installedDesktopMcp.args);
        expect(await readMcpToolNames({
          command: generatedMcpConfig!.command![0],
          args: generatedMcpConfig!.command!.slice(1),
          env: generatedMcpConfig!.environment,
        })).toEqual([...RUDDER_CORE_MCP_TOOL_NAMES]);
      } finally {
        installedDesktopMcp.restore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
        else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
        else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
