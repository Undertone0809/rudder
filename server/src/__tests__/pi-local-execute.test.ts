import {
  execute,
  resetPiModelsCacheForTests,
} from "@rudderhq/agent-runtime-pi-local/server";
import {
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_CONTRACT_VERSION,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeSkillFixture,
  installCanonicalDesktopMcp,
  installCoreVersionMismatchedDesktopMcp,
  installVersionMismatchedDesktopMcp,
  readMcpToolNames,
  readRepositoryCliVersion,
} from "./local-runtime-browser-mismatch-helpers";
import {
  clearInheritedGitIdentityEnv,
  expectPreparedGitConfigCapture,
  gitIdentityCaptureSnippet,
  type GitIdentityCapture,
} from "./local-runtime-git-identity-helpers";

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}
const emitJson = (value) => fs.writeSync(1, JSON.stringify(value) + "\\n");

if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("openai    gpt-test");
  process.exit(0);
}

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const stdin = fs.readFileSync(0, "utf8");
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    home: process.env.HOME || null,
    userProfile: process.env.USERPROFILE || null,
    piCodingAgentDir: process.env.PI_CODING_AGENT_DIR || null,
    piCodingAgentSessionDir: process.env.PI_CODING_AGENT_SESSION_DIR || null,
    rudderEnvKeys: Object.keys(process.env)
      .filter((key) => key.startsWith("RUDDER_"))
      .sort(),
    rudderManagedEnv: {
      RUDDER_API_URL: process.env.RUDDER_API_URL || null,
      RUDDER_API_KEY: process.env.RUDDER_API_KEY || null,
      RUDDER_ORG_ID: process.env.RUDDER_ORG_ID || null,
      RUDDER_AGENT_ID: process.env.RUDDER_AGENT_ID || null,
      RUDDER_BROWSER_ENABLED: process.env.RUDDER_BROWSER_ENABLED || null,
      RUDDER_RUN_ID: process.env.RUDDER_RUN_ID || null,
      RUDDER_PROJECT_LIBRARY_PATH: process.env.RUDDER_PROJECT_LIBRARY_PATH || null,
    },
    gitIdentity: captureGitIdentityEnv(),
  }), "utf8");
}
if (process.env.RUDDER_TEST_PI_REALISTIC_OUTPUT === "1") {
  const bigSignature = "sig_".repeat(3000);
  emitJson({ type: "session", version: 3, id: "pi-session-1", timestamp: new Date().toISOString(), cwd: process.cwd() });
  emitJson({ type: "agent_start", signature: bigSignature });
  emitJson({ type: "turn_start" });
  emitJson({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      thinking: "internal reasoning should not be persisted",
      signature: bigSignature
    }
  });
  emitJson({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "streamed " }
  });
  emitJson({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "write",
    args: { path: "output.txt", content: "RUDDER_CAPABILITY_SUM=18", signature: bigSignature }
  });
  emitJson({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "write",
    result: { ok: true, signature: bigSignature },
    isError: false
  });
  console.log('{"type":"agent_end","signature":"' + bigSignature);
  console.log("unframed-secret-" + bigSignature);
  emitJson({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "turn ok" }],
      usage: { input: 10, output: 3, cacheRead: 2, cost: { total: 0.01 } }
    },
    toolResults: [{ toolCallId: "tool-1", content: { ok: true, signature: bigSignature }, isError: false }]
  });
  emitJson({
    type: "agent_end",
    messages: [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "text", text: "final ok" }], signature: bigSignature }
    ]
  });
  process.exit(0);
}
if (process.env.RUDDER_TEST_PI_SEMANTIC_ERROR === "1") {
  emitJson({ type: "session", version: 3, id: "pi-session-1", timestamp: new Date().toISOString(), cwd: process.cwd() });
  emitJson({ type: "agent_start" });
  emitJson({ type: "turn_start" });
  emitJson({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "401 status code (no body)",
      text: "",
      usage: { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } }
    }
  });
  emitJson({ type: "agent_end", messageCount: 2 });
  process.exit(0);
}
if (process.env.RUDDER_TEST_PI_NON_AUTH_ERROR_WITH_AUTH_WORDS === "1") {
  emitJson({ type: "session", version: 3, id: "pi-session-1", timestamp: new Date().toISOString(), cwd: process.cwd() });
  emitJson({ type: "agent_start" });
  emitJson({ type: "turn_start" });
  emitJson({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I can document API key rotation and membership benefits later." }],
      stopReason: "error",
      errorMessage: "model overloaded before completion",
      usage: { input: 1, output: 0, cacheRead: 0, cost: { total: 0 } }
    }
  });
  emitJson({ type: "agent_end", messageCount: 2 });
  process.exit(0);
}
console.log(JSON.stringify({ type: "session", version: 3, id: "pi-session-1", timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } }
  },
  toolResults: []
}));
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

type CapturePayload = {
  argv: string[];
  stdin: string;
  home: string | null;
  userProfile: string | null;
  piCodingAgentDir: string | null;
  piCodingAgentSessionDir: string | null;
  rudderEnvKeys: string[];
  rudderManagedEnv: Record<string, string | null>;
  gitIdentity: GitIdentityCapture;
};

function parseGeneratedPiJsonConstant<T>(
  source: string,
  name: string,
  suffix: string,
): T {
  const prefix = `const ${name} = `;
  const start = source.indexOf(prefix);
  const end = start < 0 ? -1 : source.indexOf(suffix, start + prefix.length);
  if (start < 0 || end < 0) throw new Error(`Generated Pi extension omitted ${name}`);
  return JSON.parse(source.slice(start + prefix.length, end)) as T;
}

afterEach(() => {
  resetPiModelsCacheForTests();
});

describe("pi execute", { timeout: 20_000 }, () => {
  it("appends agent memory instructions to the system prompt and reports prompt metrics", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const operatorSkillPath = path.join(root, ".pi", "agent", "skills", "operator-skill", "SKILL.md");
    const managedPiHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "pi-home",
    );
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const soulPath = path.join(root, "instructions", "SOUL.md");
    const toolsPath = path.join(root, "instructions", "TOOLS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(operatorSkillPath), { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(operatorSkillPath, "---\nname: operator-skill\n---\n", "utf8");
    await createOperatorHomeSentinels(root);
    await createLegacyManagedCredentialBridgeSentinels(root, managedPiHome);
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(soulPath, "# Agent Soul\n", "utf8");
    await fs.writeFile(toolsPath, "# Agent Tools\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Keep status concise.\n", "utf8");
    await writeFakePiCommand(commandPath);

    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    let loadedSkills: unknown[] = [];
    let realizedSkills: unknown[] = [];
    let nativeDiscoverableSkills: unknown[] | undefined;
    let agentInstructionStack = "";
    let rudderMcp: unknown;
    let rudderNativeTools: unknown;
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const rudderDir = await createSkillDir(runtimeSkillsRoot, "rudder");
    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");
    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    try {
      const result = await execute({
        runId: "run-pi-memory",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Pi Agent",
          agentRuntimeType: "pi",
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
          model: "openai/gpt-test",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_AGENT_ID: "forbidden-agent",
            RUDDER_API_KEY: "forbidden-api-key",
            RUDDER_API_URL: "https://forbidden.example.invalid",
            RUDDER_ORG_ID: "forbidden-org",
            RUDDER_PROJECT_LIBRARY_PATH: "forbidden/project-library",
            RUDDER_RUN_ID: "forbidden-run",
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          instructionsFilePath: instructionsPath,
          promptTemplate: "Follow the rudder heartbeat.",
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
        },
        context: {
          rudderScene: "heartbeat",
          rudderResourcesPrompt: "## Your Current Automations\n\n- Daily Pi review",
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
            projectLibraryRoot: path.join(root, "org-workspace", "projects", "product"),
            projectLibraryRelativePath: "projects/product",
            resourcesPrompt: "## Your Current Automations\n\n- Daily Pi review",
            orgResourcesPrompt: "## Your Current Automations\n\n- Daily Pi review",
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
          agentInstructionStack = meta.agentInstructionStack ?? "";
          rudderMcp = meta.rudderMcp;
          rudderNativeTools = meta.rudderNativeTools;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expectPreparedGitConfigCapture(capture);
      const managedPiAgentDir = path.join(managedPiHome, ".pi", "agent");
      expect(capture.home).toBe(root);
      expect(capture.userProfile).toBe(root);
      expect(capture.piCodingAgentDir).toBe(managedPiAgentDir);
      expect(capture.piCodingAgentSessionDir).toBe(path.join(managedPiHome, ".pi", "paperclips"));
      await expectNoOperatorHomeSentinelsInManagedHome(managedPiHome);
      expect(capture.argv).toEqual(expect.arrayContaining(["--print", "--mode", "json"]));
      expect(capture.argv).not.toContain("rpc");
      expect(capture.argv).toEqual(expect.arrayContaining(["--no-skills", "--skill", path.join(managedPiAgentDir, "skills")]));
      expect(capture.argv).toEqual(expect.arrayContaining(["--skill", path.join(managedPiAgentDir, "skills")]));
      const extensionIndex = capture.argv.indexOf("--extension");
      expect(extensionIndex).toBeGreaterThanOrEqual(0);
      expect(capture.argv.filter((arg) => arg === "--extension")).toHaveLength(1);
      const extensionPath = capture.argv[extensionIndex + 1];
      expect(extensionPath).toBe(path.join(managedPiAgentDir, "extensions", "rudder-tools", "index.ts"));
      const extensionSource = await fs.readFile(extensionPath, "utf8");
      expect(extensionSource).toContain("rudder_agent_me");
      expect(extensionSource).toContain("rudder_issue_checkout");
      expect(extensionSource).toContain('"additionalProperties": false');
      expect(extensionSource).toContain('"issue"');
      expect(extensionSource).toContain("pickManagedRuntimeEnv");
      expect(extensionSource).toContain("result.isError === true");
      expect(extensionSource).not.toContain("run-jwt-token");
      expect(extensionSource).not.toContain("forbidden-api-key");
      expect(extensionSource).not.toContain("forbidden-agent");
      expect(extensionSource).not.toContain("forbidden-org");
      expect(extensionSource).not.toContain("forbidden-run");
      expect(extensionSource).not.toContain("https://forbidden.example.invalid");
      const toolsIndex = capture.argv.indexOf("--tools");
      expect(toolsIndex).toBeGreaterThanOrEqual(0);
      expect(capture.argv[toolsIndex + 1].split(",")).toEqual(expect.arrayContaining([
        "read",
        "bash",
        "rudder_agent_me",
        "rudder_library_file_list",
        "rudder_runs_errors",
      ]));
      expect(capture.argv.at(-1)).toContain("Follow the rudder heartbeat.");
      expect(capture.stdin).toBe("");
      const appendSystemPromptIndex = capture.argv.indexOf("--append-system-prompt");
      expect(appendSystemPromptIndex).toBeGreaterThanOrEqual(0);
      const systemPrompt = capture.argv[appendSystemPromptIndex + 1];
      expect(systemPrompt).toContain("# Agent Instructions");
      expect(systemPrompt).toContain("# Agent Soul");
      expect(systemPrompt).toContain("# Agent Tools");
      expect(systemPrompt).toContain("# Tacit Memory");
      expect(systemPrompt).toContain("## Your Current Automations");
      expect(systemPrompt).not.toContain("# Rudder Heartbeat Instruction");
      expect(systemPrompt).toContain("# Enabled Rudder Skills");
      expect(systemPrompt).toContain("Only skills listed in this section are enabled by Rudder for this run.");
      expect(systemPrompt).toContain("Use a plain newline-separated list. Do not use prose, bullets, Markdown, code spans, explanations, prefixes, or suffixes.");
      expect(systemPrompt).toContain("If exactly one skill is listed, answer exactly that runtime skill name and nothing else.");
      expect(systemPrompt).toContain("- ascii-heart");
      expect(systemPrompt).not.toContain("- ascii-heart: ascii-heart");
      expect(systemPrompt.match(/## Your Current Automations/g)).toHaveLength(1);
      expect(systemPrompt.indexOf("# Agent Instructions")).toBeLessThan(systemPrompt.indexOf("# Agent Soul"));
      expect(systemPrompt.indexOf("# Agent Soul")).toBeLessThan(systemPrompt.indexOf("# Agent Tools"));
      expect(systemPrompt.indexOf("# Agent Tools")).toBeLessThan(systemPrompt.indexOf("# Tacit Memory"));
      expect(systemPrompt.indexOf("# Tacit Memory")).toBeLessThan(systemPrompt.indexOf("## Your Current Automations"));
      expect(systemPrompt.indexOf("## Your Current Automations")).toBeLessThan(systemPrompt.indexOf("## Current Time"));
      expect(systemPrompt).toContain("## Current Time");
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
      expect(capture.rudderEnvKeys).toEqual(expect.arrayContaining([
        "RUDDER_PROJECT_LIBRARY_PATH",
        "RUDDER_PROJECT_LIBRARY_ROOT",
      ]));
      expect(capture.rudderManagedEnv).toMatchObject({
        RUDDER_API_URL: "http://localhost:3100",
        RUDDER_API_KEY: "run-jwt-token",
        RUDDER_ORG_ID: "organization-1",
        RUDDER_AGENT_ID: "agent-1",
        RUDDER_RUN_ID: "run-pi-memory",
        RUDDER_PROJECT_LIBRARY_PATH: "projects/product",
      });
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
      expect(promptMetrics.skillBoundaryPromptChars).toBeGreaterThan(0);
      expect(loadedSkills).toEqual([
        expect.objectContaining({
          key: "ascii-heart",
          runtimeName: "ascii-heart",
        }),
      ]);
      expect(realizedSkills).toEqual(loadedSkills);
      expect(nativeDiscoverableSkills).toBeUndefined();
      expect(rudderMcp).toEqual({
        available: false,
        coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
        contractVersion: RUDDER_MCP_CONTRACT_VERSION,
        serverName: "rudder-tools",
        toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length,
        provenance: "repo",
        version: await readRepositoryCliVersion(),
        fallbackReason: "Pi CLI does not expose a supported MCP server configuration surface; Rudder tools are injected through a managed Pi extension.",
      });
      expect(rudderNativeTools).toEqual({
        available: true,
        transport: "pi_extension",
        serverName: "rudder-tools",
        toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length,
        toolNames: expect.arrayContaining(["rudder_agent_me", "rudder_issue_checkout", "rudder_library_file_list"]),
        authMode: "runtime_managed",
        modelVisibleCliFallback: false,
        fallbackReason: null,
      });
      expect((await fs.lstat(path.join(managedPiAgentDir, "skills", "ascii-heart"))).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(path.join(managedPiAgentDir, "skills", "ascii-heart"))).toBe(
        await fs.realpath(asciiHeartDir),
      );
      await expect(fs.lstat(path.join(root, ".pi", "agent", "skills", "rudder"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes previously materialized Pi skills when they are no longer selected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-prune-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const managedPiHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "pi-home",
    );
    const managedSkillsHome = path.join(managedPiHome, ".pi", "agent", "skills");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");
    await fs.mkdir(managedSkillsHome, { recursive: true });
    await fs.symlink(asciiHeartDir, path.join(managedSkillsHome, "ascii-heart"));

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    const previousRudderHome = process.env.RUDDER_HOME;
    const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousLocalEnv = process.env.RUDDER_LOCAL_ENV;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    process.env.RUDDER_HOME = path.join(root, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "default";
    delete process.env.RUDDER_LOCAL_ENV;

    let loadedSkills: unknown[] = [{ key: "before" }];

    try {
      const result = await execute({
        runId: "run-pi-prune-skill",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Pi Agent",
          agentRuntimeType: "pi",
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
          model: "openai/gpt-test",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderRuntimeSkills: [
            {
              name: "ascii-heart",
              source: asciiHeartDir,
            },
          ],
          rudderSkillSync: {
            desiredSkills: [],
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
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv.at(-1)).not.toContain("## Skill: ascii-heart");
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
      if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
      if (previousLocalEnv === undefined) delete process.env.RUDDER_LOCAL_ENV;
      else process.env.RUDDER_LOCAL_ENV = previousLocalEnv;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepares managed OpenCode anonymous model config for Pi without writing operator Pi config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-opencode-models-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const operatorModelsPath = path.join(root, ".pi", "agent", "models.json");
    const operatorSettingsPath = path.join(root, ".pi", "agent", "settings.json");
    const managedPiHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "pi-home",
    );
    const managedPiAgentDir = path.join(managedPiHome, ".pi", "agent");
    const managedModelsPath = path.join(managedPiAgentDir, "models.json");
    const managedSettingsPath = path.join(managedPiAgentDir, "settings.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(operatorModelsPath), { recursive: true });
    await fs.writeFile(
      operatorModelsPath,
      JSON.stringify({
        providers: {
          privateProvider: { apiKey: "PRIVATE_OPERATOR_KEY" },
        },
      }),
      "utf8",
    );
    await fs.writeFile(operatorSettingsPath, JSON.stringify({ packages: ["operator-only-package"] }), "utf8");
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    const previousRudderHome = process.env.RUDDER_HOME;
    const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousOpenCodeApiKey = process.env.OPENCODE_API_KEY;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    process.env.RUDDER_HOME = path.join(root, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "default";
    delete process.env.OPENCODE_API_KEY;

    try {
      const result = await execute({
        runId: "run-pi-opencode-models",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Pi Agent",
          agentRuntimeType: "pi",
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
          model: "opencode/deepseek-v4-flash-free",
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

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(expect.arrayContaining(["--provider", "opencode", "--model", "deepseek-v4-flash-free"]));
      expect((await fs.lstat(managedModelsPath)).isSymbolicLink()).toBe(false);
      const managedModels = JSON.parse(await fs.readFile(managedModelsPath, "utf8"));
      expect(managedModels).toEqual({
        providers: {
          opencode: {
            apiKey: "RUDDER_OPENCODE_ANONYMOUS",
            authHeader: false,
            headers: {
              Authorization: "",
            },
          },
        },
      });
      const operatorModels = JSON.parse(await fs.readFile(operatorModelsPath, "utf8"));
      expect(operatorModels).toEqual({
        providers: {
          privateProvider: { apiKey: "PRIVATE_OPERATOR_KEY" },
        },
      });
      await expect(fs.lstat(managedSettingsPath)).rejects.toMatchObject({ code: "ENOENT" });
      const operatorSettings = JSON.parse(await fs.readFile(operatorSettingsPath, "utf8"));
      expect(operatorSettings).toEqual({ packages: ["operator-only-package"] });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousRudderHome;
      if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
      if (previousOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousOpenCodeApiKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps final text from realistic Pi JSON while sanitizing noisy stdout persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-execute-realistic-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const logs: string[] = [];
    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    try {
      const result = await execute({
        runId: "run-pi-realistic",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Pi Agent",
          agentRuntimeType: "pi",
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
          model: "openai/gpt-test",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_PI_REALISTIC_OUTPUT: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toMatch(/^(turn ok|final ok)$/);
      expect(result.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 2,
      });
      expect(result.resultJson).toMatchObject({
        stdoutSanitized: true,
      });
      expect(JSON.stringify(result.resultJson)).not.toContain("internal reasoning should not be persisted");
      expect(JSON.stringify(result.resultJson)).not.toContain("sig_sig_sig_sig_sig_sig_sig_sig_sig_sig_");
      expect(logs.join("")).not.toContain("internal reasoning should not be persisted");
      expect(logs.join("")).not.toContain("sig_sig_sig_sig_sig_sig_sig_sig_sig_sig_");
      expect(logs.join("")).toContain("\"type\":\"malformed_event\"");
      expect(logs.join("")).toContain("\"type\":\"turn_end\"");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns an adapter error when Pi reports a semantic turn error with exit zero", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-execute-semantic-error-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    try {
      const result = await execute({
        runId: "run-pi-semantic-error",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Pi Agent",
          agentRuntimeType: "pi",
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
          model: "openai/gpt-test",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_PI_SEMANTIC_ERROR: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBe("pi_auth_required");
      expect(result.errorMessage).toBe("401 status code (no body)");
      expect(result.summary).toBe("");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not classify non-auth Pi semantic failures from ordinary stdout text", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-execute-non-auth-error-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;
    try {
      const result = await execute({
        runId: "run-pi-non-auth-error",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Pi Agent",
          agentRuntimeType: "pi",
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
          model: "openai/gpt-test",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_PI_NON_AUTH_ERROR_WITH_AUTH_WORDS: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeNull();
      expect(result.errorMessage).toBe("model overloaded before completion");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "configures isolated core and Browser extensions for an eligible Pi run",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-browser-enabled-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "pi");
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakePiCommand(commandPath);
      const installedDesktopMcp = await installCanonicalDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_OPERATOR_HOME = root;
      process.env.RUDDER_HOME = path.join(root, ".rudder");
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};
      try {
        const result = await execute({
          runId: "run-pi-browser-enabled",
          agent: { id: "agent-1", orgId: "organization-1", name: "Pi Agent", agentRuntimeType: "pi", agentRuntimeConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            model: "openai/gpt-test",
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
        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
        const extensionPaths = capture.argv.flatMap((arg, index) =>
          arg === "--extension" ? [capture.argv[index + 1]] : []
        );
        expect(extensionPaths).toHaveLength(2);
        expect(extensionPaths.map((entry) => path.basename(path.dirname(entry)))).toEqual([
          "rudder-tools",
          "rudder-browser",
        ]);
        const toolNamesByExtension: string[][] = [];
        for (const extensionPath of extensionPaths) {
          const source = await fs.readFile(extensionPath, "utf8");
          const command = parseGeneratedPiJsonConstant<string>(source, "RUDDER_MCP_COMMAND", ";\n");
          const args = parseGeneratedPiJsonConstant<string[]>(source, "RUDDER_MCP_ARGS", " as string[];");
          const env = parseGeneratedPiJsonConstant<Record<string, string>>(source, "RUDDER_MCP_ENV", " as Record<string, string>;");
          toolNamesByExtension.push(await readMcpToolNames({ command, args, env }));
        }
        expect(toolNamesByExtension).toEqual([
          [...RUDDER_CORE_MCP_TOOL_NAMES],
          [...RUDDER_BROWSER_MCP_TOOL_NAMES],
        ]);
        expect(meta.rudderNativeTools).toMatchObject({
          available: true,
          serverName: "rudder-tools",
          toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length,
        });
        expect(meta.browserNativeTools).toMatchObject({
          available: true,
          serverName: "rudder-browser",
          toolCount: RUDDER_BROWSER_MCP_TOOL_NAMES.length,
        });
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

  it.skipIf(process.platform === "win32")(
    "continues the model turn without a missing extension after core MCP preflight fails",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-core-mismatch-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "pi");
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakePiCommand(commandPath);
      const installedDesktopMcp = await installCoreVersionMismatchedDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_OPERATOR_HOME = root;
      process.env.RUDDER_HOME = path.join(root, ".rudder");
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};

      try {
        const result = await execute({
          runId: "run-pi-core-mismatch",
          agent: {
            id: "agent-1",
            orgId: "organization-1",
            name: "Pi Agent",
            agentRuntimeType: "pi",
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
            model: "openai/gpt-test",
            env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
            promptTemplate: "Follow the heartbeat.",
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
          onMeta: async (value) => { meta = value as Record<string, unknown>; },
        });

        expect(result.exitCode).toBe(0);
        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
        expect(capture.argv).not.toContain("--extension");
        const toolsIndex = capture.argv.indexOf("--tools");
        expect(capture.argv[toolsIndex + 1].split(",")).not.toEqual(
          expect.arrayContaining([...RUDDER_CORE_MCP_TOOL_NAMES]),
        );
        expect(meta.rudderNativeTools).toMatchObject({
          available: false,
          toolCount: 0,
          toolNames: [],
        });
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

  it.skipIf(process.platform === "win32")(
    "removes Browser skill, prompt, tools, and metadata together after a bundle mismatch",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-browser-mismatch-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "pi");
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakePiCommand(commandPath);
      const browserSkill = await createRuntimeSkillFixture(root, "browser", "BROWSER_SKILL_PROMISE");
      const keepSkill = await createRuntimeSkillFixture(root, "keep-skill", "KEEP_SKILL_AVAILABLE");
      const installedDesktopMcp = await installVersionMismatchedDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_OPERATOR_HOME = root;
      process.env.RUDDER_HOME = path.join(root, ".rudder");
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};

      try {
        const result = await execute({
          runId: "run-pi-browser-mismatch",
          agent: {
            id: "agent-1",
            orgId: "organization-1",
            name: "Pi Agent",
            agentRuntimeType: "pi",
            agentRuntimeConfig: {},
          },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            model: "openai/gpt-test",
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
        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
        expect(capture.rudderManagedEnv.RUDDER_BROWSER_ENABLED).toBe("false");
        const appendSystemPromptIndex = capture.argv.indexOf("--append-system-prompt");
        expect(appendSystemPromptIndex).toBeGreaterThanOrEqual(0);
        expect(capture.argv[appendSystemPromptIndex + 1]).toContain("- keep-skill");
        expect(capture.argv[appendSystemPromptIndex + 1]).not.toContain("browser");
        const toolsIndex = capture.argv.indexOf("--tools");
        const toolNames = capture.argv[toolsIndex + 1].split(",");
        expect(toolNames.filter((name) => name.startsWith("rudder_"))).toEqual([
          ...RUDDER_CORE_MCP_TOOL_NAMES,
        ]);
        const extensionIndex = capture.argv.indexOf("--extension");
        expect(capture.argv.filter((arg) => arg === "--extension")).toHaveLength(1);
        const extensionSource = await fs.readFile(capture.argv[extensionIndex + 1], "utf8");
        expect(extensionSource).toContain("rudder_agent_me");
        expect(extensionSource).not.toContain("rudder_browser_");
        const extensionCommand = parseGeneratedPiJsonConstant<string>(
          extensionSource,
          "RUDDER_MCP_COMMAND",
          ";\n",
        );
        const extensionArgs = parseGeneratedPiJsonConstant<string[]>(
          extensionSource,
          "RUDDER_MCP_ARGS",
          " as string[];",
        );
        const extensionEnv = parseGeneratedPiJsonConstant<Record<string, string>>(
          extensionSource,
          "RUDDER_MCP_ENV",
          " as Record<string, string>;",
        );
        const managedEnv = Object.fromEntries(
          Object.entries(capture.rudderManagedEnv).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        expect(extensionCommand).toBe(installedDesktopMcp.command);
        expect(extensionArgs).toEqual(installedDesktopMcp.args);
        expect(await readMcpToolNames({
          command: extensionCommand,
          args: extensionArgs,
          env: { ...extensionEnv, ...managedEnv },
        })).toEqual([...RUDDER_CORE_MCP_TOOL_NAMES]);
        expect(meta.loadedSkills).toEqual([expect.objectContaining({ runtimeName: "keep-skill" })]);
        expect(meta.realizedSkills).toEqual(meta.loadedSkills);
        expect(meta.rudderMcp).toMatchObject({
          toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length,
        });
        expect(meta.rudderMcp).not.toHaveProperty("browserAvailable");
        expect(meta.rudderMcp).not.toHaveProperty("contractHash");
        expect(meta.rudderMcp).not.toHaveProperty("diagnosticCode");
        expect(meta.rudderNativeTools).toMatchObject({
          toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length,
        });
        expect((meta.rudderNativeTools as { toolNames: string[] }).toolNames).toEqual([
          ...RUDDER_CORE_MCP_TOOL_NAMES,
        ]);
        expect(meta.browserMcp).toMatchObject({
          available: false,
          diagnosticCode: "browser_bundle_version_mismatch",
          provenance: "desktop_bundle",
          serverName: "rudder-browser",
          toolCount: RUDDER_BROWSER_MCP_TOOL_NAMES.length,
          version: "0.4.5",
        });
        expect((meta.browserMcp as { fallbackReason?: string }).fallbackReason).toContain(
          "bundle version mismatch",
        );
        expect(meta.browserNativeTools).toMatchObject({
          available: false,
          diagnosticCode: "browser_bundle_version_mismatch",
          provenance: "desktop_bundle",
          serverName: "rudder-browser",
          toolCount: 0,
          toolNames: [],
        });
        expect((meta.browserNativeTools as { fallbackReason?: string }).fallbackReason).toContain(
          "bundle version mismatch",
        );
        await expect(fs.stat(path.join(
          capture.piCodingAgentDir!,
          "extensions",
          "rudder-browser",
        ))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readdir(path.join(capture.piCodingAgentDir!, "skills"))).toEqual(["keep-skill"]);
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
