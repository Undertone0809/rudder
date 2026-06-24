import {
  execute,
  resetPiModelsCacheForTests,
} from "@rudderhq/agent-runtime-pi-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      errorMessage: "402 membership benefits unavailable",
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

type CapturePayload = {
  argv: string[];
  stdin: string;
  home: string | null;
  userProfile: string | null;
  piCodingAgentDir: string | null;
  piCodingAgentSessionDir: string | null;
  rudderEnvKeys: string[];
  gitIdentity: GitIdentityCapture;
};

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
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const soulPath = path.join(root, "instructions", "SOUL.md");
    const toolsPath = path.join(root, "instructions", "TOOLS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(operatorSkillPath), { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(operatorSkillPath, "---\nname: operator-skill\n---\n", "utf8");
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
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expectPreparedGitConfigCapture(capture);
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
      expect(capture.home).toBe(managedPiHome);
      expect(capture.userProfile).toBe(managedPiHome);
      expect(capture.piCodingAgentDir).toBe(managedPiAgentDir);
      expect(capture.piCodingAgentSessionDir).toBe(path.join(managedPiHome, ".pi", "paperclips"));
      expect(capture.argv).toEqual(expect.arrayContaining(["--print", "--mode", "json"]));
      expect(capture.argv).not.toContain("rpc");
      expect(capture.argv).toEqual(expect.arrayContaining(["--skill", path.join(managedPiAgentDir, "skills")]));
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
      expect(systemPrompt).toContain("# Rudder Heartbeat Instruction");
      expect(systemPrompt.match(/## Your Current Automations/g)).toHaveLength(1);
      expect(systemPrompt.indexOf("# Agent Instructions")).toBeLessThan(systemPrompt.indexOf("# Agent Soul"));
      expect(systemPrompt.indexOf("# Agent Soul")).toBeLessThan(systemPrompt.indexOf("# Agent Tools"));
      expect(systemPrompt.indexOf("# Agent Tools")).toBeLessThan(systemPrompt.indexOf("# Tacit Memory"));
      expect(systemPrompt.indexOf("# Tacit Memory")).toBeLessThan(systemPrompt.indexOf("## Your Current Automations"));
      expect(systemPrompt.indexOf("## Your Current Automations")).toBeLessThan(systemPrompt.indexOf("## Current Time"));
      expect(systemPrompt.indexOf("## Current Time")).toBeLessThan(systemPrompt.indexOf("# Rudder Heartbeat Instruction"));
      expect(agentInstructionStack).toContain(systemPrompt);
      expect(agentInstructionStack).toContain("Follow the rudder heartbeat.");
      expect(agentInstructionStack).toContain("# Agent Instructions");
      expect(agentInstructionStack).toContain("# Agent Soul");
      expect(agentInstructionStack).toContain("# Agent Tools");
      expect(agentInstructionStack).toContain("# Tacit Memory");
      expect(agentInstructionStack).not.toContain("## Agent Instruction:");
      expect(agentInstructionStack).toContain("## Your Current Automations");
      expect(agentInstructionStack).not.toContain("[startup context omitted from persisted prompt]");
      expect(capture.rudderEnvKeys).toEqual(expect.arrayContaining([
        "RUDDER_PROJECT_LIBRARY_PATH",
        "RUDDER_PROJECT_LIBRARY_ROOT",
      ]));
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
      expect(loadedSkills).toEqual([
        expect.objectContaining({
          key: "ascii-heart",
          runtimeName: "ascii-heart",
        }),
      ]);
      expect(realizedSkills).toEqual(loadedSkills);
      expect(nativeDiscoverableSkills).toBeUndefined();
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
      expect(result.summary).toBe("final ok");
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
      expect(logs.join("")).toContain("\"type\":\"agent_end\"");
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
      expect(result.errorMessage).toBe("402 membership benefits unavailable");
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
});
