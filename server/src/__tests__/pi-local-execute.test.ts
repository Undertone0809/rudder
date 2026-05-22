import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  execute,
  resetPiModelsCacheForTests,
} from "@rudderhq/agent-runtime-pi-local/server";
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
    rudderEnvKeys: Object.keys(process.env)
      .filter((key) => key.startsWith("RUDDER_"))
      .sort(),
    gitIdentity: captureGitIdentityEnv(),
  }), "utf8");
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
  rudderEnvKeys: string[];
  gitIdentity: GitIdentityCapture;
};

afterEach(() => {
  resetPiModelsCacheForTests();
});

describe("pi execute", () => {
  it("appends agent memory instructions to the system prompt and reports prompt metrics", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Keep status concise.\n", "utf8");
    await writeFakePiCommand(commandPath);

    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    const previousHome = process.env.HOME;
    process.env.HOME = root;
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
        },
        context: {
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
            orgPlansDir: path.join(root, "org-workspace", "plans"),
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
      const appendSystemPromptIndex = capture.argv.indexOf("--append-system-prompt");
      expect(appendSystemPromptIndex).toBeGreaterThanOrEqual(0);
      const systemPrompt = capture.argv[appendSystemPromptIndex + 1];
      expect(systemPrompt).toContain("# Agent Instructions");
      expect(systemPrompt).toContain("# Tacit Memory");
      expect(capture.rudderEnvKeys).toEqual(
        expect.arrayContaining(["RUDDER_ORG_ARTIFACTS_DIR"]),
      );
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
