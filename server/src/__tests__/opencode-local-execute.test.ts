import { execute, resetOpenCodeModelsCacheForTests } from "@rudderhq/agent-runtime-opencode-local/server";
import { buildOpenCodeLocalConfig } from "@rudderhq/agent-runtime-opencode-local/ui";
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

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}

if (process.argv[2] === "models") {
  console.log("openai/gpt-4.1-mini");
  process.exit(0);
}

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  home: process.env.HOME || null,
  userProfile: process.env.USERPROFILE || null,
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
if (process.env.RUDDER_TEST_NO_FINAL_TEXT !== "1") {
  console.log(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }));
}
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

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
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
        prompt: string;
        rudderEnvKeys: string[];
        gitIdentity: GitIdentityCapture;
      };
      expectPreparedGitConfigCapture(capture);
      expect(capture.home).toBe(root);
      expect(capture.userProfile).toBe(process.env.USERPROFILE ?? root);
      expect(capture.argv).toEqual(expect.arrayContaining(["run", "--pure", "--format", "json", "--dir", workspace]));
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
      expect(capture.argv).toEqual(expect.arrayContaining(["run", "--pure", "--format", "json", "--dir", workspace]));
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

  it("injects organization-library runtime skills into the OpenCode prompt from the managed sidecar", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-execute-runtime-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const operatorSkillPath = path.join(root, ".claude", "skills", "operator-skill", "SKILL.md");
    const managedSkillsHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "opencode-home",
      ".claude",
      "skills",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(operatorSkillPath), { recursive: true });
    await fs.writeFile(operatorSkillPath, "---\nname: operator-skill\n---\n", "utf8");
    await writeFakeOpenCodeCommand(commandPath);

    const rudderDir = await createSkillDir(runtimeSkillsRoot, "rudder");
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        home: string | null;
        prompt: string;
      };
      expect(capture.home).toBe(root);
      expect(capture.argv).toContain("--pure");
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
});
