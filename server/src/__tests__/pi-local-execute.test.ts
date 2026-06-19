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
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    piCodingAgentDir: process.env.PI_CODING_AGENT_DIR,
    piCodingAgentSessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
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

type CapturePayload = {
  argv: string[];
  stdin: string;
  home: string;
  userProfile?: string;
  piCodingAgentDir: string;
  piCodingAgentSessionDir: string;
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
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const soulPath = path.join(root, "instructions", "SOUL.md");
    const toolsPath = path.join(root, "instructions", "TOOLS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(soulPath, "# Agent Soul\n", "utf8");
    await fs.writeFile(toolsPath, "# Agent Tools\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Keep status concise.\n", "utf8");
    await writeFakePiCommand(commandPath);

    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
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
            HOME: path.join(root, "ignored-config-home"),
            PI_CODING_AGENT_DIR: path.join(root, "ignored-pi-agent"),
            PI_CODING_AGENT_SESSION_DIR: path.join(root, "ignored-pi-sessions"),
            RUDDER_HOME: path.join(root, ".rudder"),
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          instructionsFilePath: instructionsPath,
          promptTemplate: "Follow the rudder heartbeat.",
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
      expect(capture.home).toBe(root);
      expect(capture.piCodingAgentDir).toBe(path.join(managedPiHome, ".pi", "agent"));
      expect(capture.piCodingAgentSessionDir).toBe(path.join(managedPiHome, ".pi", "paperclips"));
      expect(capture.argv).toEqual(expect.arrayContaining(["--print", "--mode", "json"]));
      expect(capture.argv).toContain("--no-skills");
      expect(capture.argv).toEqual(expect.arrayContaining(["--skill", path.join(managedPiHome, ".pi", "agent", "skills")]));
      expect(capture.argv).not.toContain("rpc");
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

  it("keeps final text from realistic Pi JSON while sanitizing noisy stdout persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-execute-realistic-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const logs: string[] = [];
    const previousHome = process.env.HOME;
    process.env.HOME = root;
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
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
