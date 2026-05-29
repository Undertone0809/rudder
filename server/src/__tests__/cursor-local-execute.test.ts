import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@rudderhq/agent-runtime-cursor-local/server";
import {
  clearInheritedGitIdentityEnv,
  expectPreparedGitConfigCapture,
  gitIdentityCaptureSnippet,
  type GitIdentityCapture,
} from "./local-runtime-git-identity-helpers";

async function writeFakeCursorCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}

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
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "cursor-session-1",
  model: "auto",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "cursor-session-1",
  result: "ok",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  rudderEnvKeys: string[];
  gitIdentity: GitIdentityCapture;
};

function setManagedCursorEnv(root: string) {
  const previous = {
    HOME: process.env.HOME,
    RUDDER_HOME: process.env.RUDDER_HOME,
    RUDDER_INSTANCE_ID: process.env.RUDDER_INSTANCE_ID,
    RUDDER_LOCAL_ENV: process.env.RUDDER_LOCAL_ENV,
  };
  process.env.HOME = root;
  process.env.RUDDER_HOME = path.join(root, ".rudder");
  process.env.RUDDER_INSTANCE_ID = "default";
  delete process.env.RUDDER_LOCAL_ENV;

  return () => {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.RUDDER_HOME === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = previous.RUDDER_HOME;
    if (previous.RUDDER_INSTANCE_ID === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = previous.RUDDER_INSTANCE_ID;
    if (previous.RUDDER_LOCAL_ENV === undefined) delete process.env.RUDDER_LOCAL_ENV;
    else process.env.RUDDER_LOCAL_ENV = previous.RUDDER_LOCAL_ENV;
  };
}

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("cursor execute", () => {
  it("injects rudder env vars and prompt note by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Prefer direct status updates.\n", "utf8");
    await writeFakeCursorCommand(commandPath);

    const restoreEnv = setManagedCursorEnv(root);

    let invocationPrompt = "";
    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
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
          model: "auto",
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
          invocationPrompt = meta.prompt ?? "";
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expectPreparedGitConfigCapture(capture);
      expect(capture.argv).not.toContain("Follow the rudder heartbeat.");
      expect(capture.argv).not.toContain("--mode");
      expect(capture.argv).not.toContain("ask");
      expect(capture.prompt).toContain("# Agent Instructions");
      expect(capture.prompt).toContain("# Tacit Memory");
      expect(capture.prompt).toContain("# Rudder Runtime Skill Boundary");
      expect(capture.prompt).toContain("Enabled Rudder Agent Skills: none.");
      expect(capture.rudderEnvKeys).toEqual(
        expect.arrayContaining([
          "RUDDER_AGENT_ID",
          "RUDDER_API_KEY",
          "RUDDER_API_URL",
          "RUDDER_ORG_ARTIFACTS_DIR",
          "RUDDER_ORG_ID",
          "RUDDER_RUN_ID",
        ]),
      );
      expect(capture.prompt).toContain("Rudder runtime note:");
      expect(capture.prompt).toContain("Rudder CLI access note:");
      expect(capture.prompt).toContain('"${RUDDER_CLI:-rudder}" agent me --json');
      expect(capture.prompt).toContain('"${RUDDER_CLI:-rudder}" issue checkout {id} --json');
      expect(invocationPrompt).toContain("# Rudder Runtime Skill Boundary");
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
      expect(promptMetrics.runtimeNoteChars).toBeGreaterThan(0);
      expect(capture.prompt).toContain("RUDDER_API_KEY");
      expect(invocationPrompt).toContain("Rudder runtime note:");
      expect(invocationPrompt).toContain("Rudder CLI access note:");
      expect(invocationPrompt).toContain("# Tacit Memory");
      expect(invocationPrompt).toContain("RUDDER_API_URL");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not pass unsupported Cursor CLI mode or workspace flags", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-mode-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
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
          model: "auto",
          mode: "ask",
          env: {
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
      expect(capture.argv).not.toContain("--mode");
      expect(capture.argv).not.toContain("ask");
      expect(capture.argv).not.toContain("--workspace");
      expect(capture.argv).toContain("-f");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies interactive sign-in output as an auth-required runtime failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-auth-required-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      commandPath,
      "#!/usr/bin/env node\nprocess.stdout.write('Press any key to sign in...\\n'); process.exit(1);\n",
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-cursor-auth",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
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
          model: "auto",
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("cursor_auth_required");
      expect(result.errorMessage).toBe("Cursor CLI authentication is required.");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats a Cursor result event as completion even when the CLI process stays open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-result-hang-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      commandPath,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-session-1' }));",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cursor-session-1', result: 'done' }));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-cursor-result-hang",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
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
          model: "auto",
          timeoutSec: 30,
          graceSec: 1,
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.timedOut).toBe(false);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toBe("done");
      expect(result.signal).toBe("SIGTERM");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when Cursor CLI reports an unsupported server tool message and stays open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-tool-handler-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      commandPath,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-session-1' }));",
        "process.stderr.write('\\nError (unhandledRejection): No handler found for server message\\nNoHandlerFoundError: No handler found for server message\\n');",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-cursor-tool-handler",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
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
          model: "auto",
          timeoutSec: 30,
          graceSec: 1,
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.timedOut).toBe(false);
      expect(result.errorCode).toBe("cursor_tool_handler_unsupported");
      expect(result.errorMessage).toBe("Cursor CLI tool execution failed: no handler found for a server tool message.");
      expect(result.signal).toBe("SIGTERM");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects organization-library runtime skills into the Cursor skills home before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-runtime-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const managedSkillsHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "cursor-home",
      "agents",
      "agent-1",
      ".cursor",
      "skills",
    );
    const managedSkillsCursorHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "cursor-home",
      "agents",
      "agent-1",
      ".cursor",
      "skills-cursor",
    );
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const rudderDir = await createSkillDir(runtimeSkillsRoot, "rudder");
    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");
    await createSkillDir(path.join(root, ".cursor", "skills"), "host-global-skill");
    await createSkillDir(path.join(root, ".cursor", "skills-cursor"), "shell");
    await fs.writeFile(path.join(root, ".cursor", "config.json"), "{}", "utf8");

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-3",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
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
          model: "auto",
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
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect((await fs.lstat(path.join(managedSkillsHome, "ascii-heart"))).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(path.join(managedSkillsHome, "ascii-heart"))).toBe(
        await fs.realpath(asciiHeartDir),
      );
      await expect(fs.lstat(path.join(managedSkillsHome, "host-global-skill"))).rejects.toThrow();
      await expect(fs.lstat(managedSkillsCursorHome)).rejects.toThrow();
      const bridgedCursorConfig = path.join(
        root,
        ".rudder",
        "instances",
        "default",
        "organizations",
        "organization-1",
        "cursor-home",
        "agents",
        "agent-1",
        ".cursor",
        "config.json",
      );
      expect((await fs.lstat(bridgedCursorConfig)).isSymbolicLink()).toBe(true);
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")("bridges the macOS Keychain search path into the managed Cursor home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-keychain-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const sourceKeychainsDir = path.join(root, "Library", "Keychains");
    const managedKeychainsDir = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "cursor-home",
      "agents",
      "agent-1",
      "Library",
      "Keychains",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sourceKeychainsDir, { recursive: true });
    await fs.writeFile(path.join(sourceKeychainsDir, "login.keychain-db"), "", "utf8");
    await writeFakeCursorCommand(commandPath);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-cursor-keychain",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
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
          model: "auto",
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect((await fs.lstat(managedKeychainsDir)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedKeychainsDir)).toBe(await fs.realpath(sourceKeychainsDir));
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
