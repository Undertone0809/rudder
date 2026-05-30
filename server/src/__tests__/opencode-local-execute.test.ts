import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, resetOpenCodeModelsCacheForTests } from "@rudderhq/agent-runtime-opencode-local/server";
import {
  clearInheritedGitIdentityEnv,
  expectPreparedGitConfigCapture,
  gitIdentityCaptureSnippet,
  type GitIdentityCapture,
} from "./local-runtime-git-identity-helpers";

function managedOpenCodeSkillsHome(home: string, orgId: string, agentId: string) {
  return path.join(
    home,
    "instances",
    "default",
    "organizations",
    orgId,
    "opencode-home",
    "agents",
    agentId,
    ".claude",
    "skills",
  );
}

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}

if (
  process.argv[2] === "models" ||
  (process.argv[2] === "--pure" && process.argv[3] === "models")
) {
  console.log("openai/gpt-4.1-mini");
  process.exit(0);
}

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
  gitIdentity: captureGitIdentityEnv(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "step_start", sessionID: "opencode-session-1" }));
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }));
console.log(JSON.stringify({
  type: "step_finish",
  part: {
    reason: "stop",
    cost: 0,
    tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }
  }
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("opencode execute", () => {
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
    process.env.HOME = root;

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
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        prompt: string;
        rudderEnvKeys: string[];
        gitIdentity: GitIdentityCapture;
      };
      expectPreparedGitConfigCapture(capture);
      expect(capture.prompt).toContain("# Agent Instructions");
      expect(capture.prompt).toContain("# Tacit Memory");
      expect(capture.prompt).toContain("# Rudder Runtime Skill Boundary");
      expect(capture.prompt).toContain("Enabled Rudder Agent Skills: none.");
      expect(capture.prompt).toContain("Rudder runtime note:");
      expect(capture.prompt).toContain("Rudder CLI access note:");
      expect(capture.prompt).toContain('"${RUDDER_CLI:-rudder}" agent me --json');
      expect(capture.prompt).toContain('"${RUDDER_CLI:-rudder}" issue checkout {id} --json');
      expect(capture.rudderEnvKeys).toEqual(
        expect.arrayContaining(["RUDDER_ORG_ARTIFACTS_DIR"]),
      );
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
      expect(promptMetrics.runtimeNoteChars).toBeGreaterThan(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps enabled user-installed OpenCode skills in the managed skills home during execution", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-user-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const skillsHome = managedOpenCodeSkillsHome(root, "organization-1", "agent-1");
    const externalSkillDir = path.join(skillsHome, "build-advisor");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(externalSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: build-advisor\ndescription: Review build direction.\n---\n",
      "utf8",
    );
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-opencode-user-skill",
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
            RUDDER_HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["build-advisor"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        prompt: string;
      };
      expect(capture.prompt).toContain("Enabled Rudder Agent Skills:");
      expect(capture.prompt).toContain("build-advisor");
      expect(capture.prompt).toContain("Review build direction.");
      expect((await fs.lstat(externalSkillDir)).isDirectory()).toBe(true);
      expect((await fs.lstat(externalSkillDir)).isSymbolicLink()).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
