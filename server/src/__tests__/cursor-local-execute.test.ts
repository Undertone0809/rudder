import { execute } from "@rudderhq/agent-runtime-cursor-local/server";
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

async function writeFakeCursorCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}

if (process.argv[2] === "status") {
  if ((process.env.HOME || "").includes("cursor-home")) {
    console.error("Authentication required. Please run 'agent login' first.");
    process.exit(1);
  }
  console.log("Logged in");
  process.exit(0);
}

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  home: process.env.HOME,
  userProfile: process.env.USERPROFILE,
  rudderOperatorHome: process.env.RUDDER_OPERATOR_HOME,
  prompt: fs.readFileSync(0, "utf8"),
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
  gitIdentity: captureGitIdentityEnv(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
if (process.env.RUDDER_TEST_CURSOR_UNKNOWN_SESSION_THEN_SUCCESS === "1") {
  if (process.argv.includes("--resume")) {
    console.error("Error: unknown session id old-cursor-session");
    process.exit(1);
  }
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cursor-session-after-retry",
    model: "auto",
  }));
  console.log(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "output_text", text: "fresh retry ok" }] },
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "cursor-session-after-retry",
    result: "ok",
  }));
  process.exit(0);
}
if (process.env.RUDDER_TEST_CURSOR_USAGE_LIMIT === "1") {
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cursor-failed-session",
    model: "auto",
  }));
  console.error("ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.");
  process.exit(1);
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
  home: string;
  userProfile: string;
  rudderOperatorHome: string;
  prompt: string;
  rudderEnvKeys: string[];
  gitIdentity: GitIdentityCapture;
};

function setManagedCursorEnv(root: string) {
  const previous = {
    HOME: process.env.HOME,
    RUDDER_OPERATOR_HOME: process.env.RUDDER_OPERATOR_HOME,
    RUDDER_HOME: process.env.RUDDER_HOME,
    RUDDER_INSTANCE_ID: process.env.RUDDER_INSTANCE_ID,
    RUDDER_LOCAL_ENV: process.env.RUDDER_LOCAL_ENV,
  };
  process.env.HOME = root;
  process.env.RUDDER_OPERATOR_HOME = root;
  process.env.RUDDER_HOME = path.join(root, ".rudder");
  process.env.RUDDER_INSTANCE_ID = "default";
  delete process.env.RUDDER_LOCAL_ENV;

  return () => {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.RUDDER_OPERATOR_HOME === undefined) delete process.env.RUDDER_OPERATOR_HOME;
    else process.env.RUDDER_OPERATOR_HOME = previous.RUDDER_OPERATOR_HOME;
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

describe("cursor execute", { timeout: 20_000 }, () => {
  const itDarwin = process.platform === "darwin" ? it : it.skip;

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
            projectLibraryRoot: path.join(root, "org-workspace", "projects", "product"),
            projectLibraryRelativePath: "projects/product",
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
      const managedHome = path.join(root, ".rudder", "instances", "default", "organizations", "organization-1", "cursor-home");
      expectPreparedGitConfigCapture(capture);
      expect(capture.home).toBe(managedHome);
      expect(capture.userProfile).toBe(managedHome);
      expect(capture.rudderOperatorHome).toBe(root);
      expect(capture.argv).not.toContain("Follow the rudder heartbeat.");
      expect(capture.argv).not.toContain("--mode");
      expect(capture.argv).not.toContain("ask");
      expect(capture.prompt).toContain("# Agent Instructions");
      expect(capture.prompt).toContain("# Tacit Memory");
      expect(capture.rudderEnvKeys).toEqual(
        expect.arrayContaining([
          "RUDDER_AGENT_ID",
          "RUDDER_API_KEY",
          "RUDDER_API_URL",
          "RUDDER_ORG_ID",
          "RUDDER_PROJECT_LIBRARY_PATH",
          "RUDDER_PROJECT_LIBRARY_ROOT",
          "RUDDER_RUN_ID",
        ]),
      );
      expect(capture.prompt).toContain("Rudder runtime note:");
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
      expect(capture.prompt).toContain("RUDDER_API_KEY");
      expect(invocationPrompt).toContain("Rudder runtime note:");
      expect(invocationPrompt).toContain("# Tacit Memory");
      expect(invocationPrompt).toContain("RUDDER_API_URL");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes --mode when explicitly configured", async () => {
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
      expect(capture.argv).toContain("--mode");
      expect(capture.argv).toContain("ask");
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not wrap the Cursor process in an operator HOME shim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-shim-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "cursor-agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const restoreEnv = setManagedCursorEnv(root);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    const logs: string[] = [];

    try {
      const result = await execute({
        runId: "run-cursor-shim",
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
          command: "cursor-agent",
          cwd: workspace,
          model: "auto",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
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
      expect(logs.join("")).not.toContain("Prepared local CLI credential shim");
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.home).toBe(path.join(root, ".rudder", "instances", "default", "organizations", "organization-1", "cursor-home"));
      expect(capture.rudderOperatorHome).toBe(root);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  itDarwin("bridges operator keychain into the managed Cursor home for subscription auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-keychain-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const operatorKeychains = path.join(root, "Library", "Keychains");
    const managedHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "cursor-home",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
    await fs.mkdir(operatorKeychains, { recursive: true });
    await fs.writeFile(path.join(operatorKeychains, "login.keychain-db"), "operator-keychain\n", "utf8");
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
      expect(capture.home).toBe(managedHome);
      expect(capture.rudderOperatorHome).toBe(root);
      const linkedKeychains = path.join(managedHome, "Library", "Keychains");
      expect((await fs.lstat(linkedKeychains)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(linkedKeychains)).toBe(await fs.realpath(operatorKeychains));
      await expect(fs.lstat(path.join(managedHome, ".cursor", "skills"))).resolves.toBeTruthy();
      await expect(fs.lstat(path.join(root, ".cursor", "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies Cursor usage limits and does not persist the failed session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-usage-limit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-cursor-usage-limit",
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
            RUDDER_TEST_CURSOR_USAGE_LIMIT: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("cursor_quota_exhausted");
      expect(result.errorMessage).toContain("usage limit");
      expect(Object.prototype.hasOwnProperty.call(result, "sessionId")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, "sessionParams")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, "sessionDisplayId")).toBe(false);
      expect(result.clearSession).toBe(false);
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the previous session record on Cursor quota failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-usage-limit-old-session-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-cursor-usage-limit-old-session",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: "old-cursor-session",
          sessionParams: {
            sessionId: "old-cursor-session",
            cwd: workspace,
          },
          sessionDisplayId: "old-cursor-session",
          taskKey: "issue:1",
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "auto",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CURSOR_USAGE_LIMIT: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("cursor_quota_exhausted");
      expect(result.errorMessage).toContain("usage limit");
      expect(Object.prototype.hasOwnProperty.call(result, "sessionId")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, "sessionParams")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, "sessionDisplayId")).toBe(false);
      expect(result.clearSession).toBe(false);
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists the fresh session when unknown-session retry succeeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-retry-session-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-cursor-retry-session",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Cursor Coder",
          agentRuntimeType: "cursor",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: "old-cursor-session",
          sessionParams: {
            sessionId: "old-cursor-session",
            cwd: workspace,
          },
          sessionDisplayId: "old-cursor-session",
          taskKey: "issue:1",
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "auto",
          env: {
            ...clearInheritedGitIdentityEnv,
            RUDDER_TEST_CURSOR_UNKNOWN_SESSION_THEN_SUCCESS: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.sessionId).toBe("cursor-session-after-retry");
      expect(result.sessionParams).toMatchObject({
        sessionId: "cursor-session-after-retry",
        cwd: workspace,
      });
      expect(result.sessionDisplayId).toBe("cursor-session-after-retry");
      expect(result.clearSession).toBe(false);
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  itDarwin("uses RUDDER_OPERATOR_HOME for the keychain bridge when the server HOME is isolated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-operator-home-"));
    const operatorHome = path.join(root, "operator-home");
    const serverHome = path.join(root, "server-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const operatorConfig = path.join(operatorHome, ".cursor", "cli-config.json");
    const operatorMcpConfig = path.join(operatorHome, ".cursor", "mcp.json");
    const operatorSkill = path.join(operatorHome, ".cursor", "skills", "operator-only", "SKILL.md");
    const operatorKeychains = path.join(operatorHome, "Library", "Keychains");
    const managedHome = path.join(
      serverHome,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "cursor-home",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(serverHome, { recursive: true });
    await fs.mkdir(path.dirname(operatorConfig), { recursive: true });
    await fs.mkdir(path.dirname(operatorSkill), { recursive: true });
    await fs.mkdir(operatorKeychains, { recursive: true });
    await fs.writeFile(operatorConfig, "{}\n", "utf8");
    await fs.writeFile(operatorMcpConfig, "{}\n", "utf8");
    await fs.writeFile(operatorSkill, "---\nname: operator-only\n---\n", "utf8");
    await fs.writeFile(path.join(operatorKeychains, "login.keychain-db"), "operator-keychain\n", "utf8");
    await writeFakeCursorCommand(commandPath);

    const previous = {
      HOME: process.env.HOME,
      RUDDER_OPERATOR_HOME: process.env.RUDDER_OPERATOR_HOME,
      RUDDER_HOME: process.env.RUDDER_HOME,
      RUDDER_INSTANCE_ID: process.env.RUDDER_INSTANCE_ID,
      RUDDER_LOCAL_ENV: process.env.RUDDER_LOCAL_ENV,
    };
    process.env.HOME = serverHome;
    process.env.RUDDER_OPERATOR_HOME = operatorHome;
    process.env.RUDDER_HOME = path.join(serverHome, ".rudder");
    process.env.RUDDER_INSTANCE_ID = "default";
    delete process.env.RUDDER_LOCAL_ENV;

    try {
      const result = await execute({
        runId: "run-cursor-operator-home",
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
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.home).toBe(managedHome);
      expect(capture.rudderOperatorHome).toBe(operatorHome);
      const linkedKeychains = path.join(managedHome, "Library", "Keychains");
      expect((await fs.lstat(linkedKeychains)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(linkedKeychains)).toBe(await fs.realpath(operatorKeychains));
      await expect(fs.lstat(path.join(managedHome, ".cursor", "cli-config.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedHome, ".cursor", "mcp.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedHome, ".cursor", "skills", "operator-only"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.RUDDER_OPERATOR_HOME === undefined) delete process.env.RUDDER_OPERATOR_HOME;
      else process.env.RUDDER_OPERATOR_HOME = previous.RUDDER_OPERATOR_HOME;
      if (previous.RUDDER_HOME === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previous.RUDDER_HOME;
      if (previous.RUDDER_INSTANCE_ID === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previous.RUDDER_INSTANCE_ID;
      if (previous.RUDDER_LOCAL_ENV === undefined) delete process.env.RUDDER_LOCAL_ENV;
      else process.env.RUDDER_LOCAL_ENV = previous.RUDDER_LOCAL_ENV;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects organization-library runtime skills into the Cursor skills home before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-runtime-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const operatorSkillPath = path.join(root, ".cursor", "skills", "operator-skill", "SKILL.md");
    const managedSkillsHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "cursor-home",
      ".cursor",
      "skills",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(operatorSkillPath), { recursive: true });
    await fs.writeFile(operatorSkillPath, "---\nname: operator-skill\n---\n", "utf8");
    await writeFakeCursorCommand(commandPath);

    const rudderDir = await createSkillDir(runtimeSkillsRoot, "rudder");
    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");

    let loadedSkills: unknown[] = [];
    let realizedSkills: unknown[] = [];
    let promptInjectedSkills: unknown[] = [];
    let nativeDiscoverableSkills: unknown[] | undefined;
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
          realizedSkills = meta.realizedSkills ?? [];
          promptInjectedSkills = meta.promptInjectedSkills ?? [];
          nativeDiscoverableSkills = meta.nativeDiscoverableSkills;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.home).toBe(path.join(root, ".rudder", "instances", "default", "organizations", "organization-1", "cursor-home"));
      expect(capture.rudderOperatorHome).toBe(root);
      expect((await fs.lstat(path.join(managedSkillsHome, "ascii-heart"))).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(path.join(managedSkillsHome, "ascii-heart"))).toBe(
        await fs.realpath(asciiHeartDir),
      );
      await expect(fs.lstat(path.join(root, ".cursor", "skills", "ascii-heart"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(capture.prompt ?? "").toContain("# Enabled Rudder Skills");
      expect(capture.prompt ?? "").toContain("## Skill: ascii-heart");
      expect(capture.prompt ?? "").not.toContain("operator-skill");
      expect(loadedSkills).toEqual([
        expect.objectContaining({
          key: "ascii-heart",
          runtimeName: "ascii-heart",
        }),
      ]);
      expect(realizedSkills).toEqual(loadedSkills);
      expect(promptInjectedSkills).toEqual(loadedSkills);
      expect(nativeDiscoverableSkills).toBeUndefined();
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes previously materialized Cursor skills when they are no longer selected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cursor-execute-prune-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const managedSkillsHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "cursor-home",
      ".cursor",
      "skills",
    );
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");
    await fs.mkdir(managedSkillsHome, { recursive: true });
    await fs.symlink(asciiHeartDir, path.join(managedSkillsHome, "ascii-heart"));

    let loadedSkills: unknown[] = [{ key: "before" }];
    const restoreEnv = setManagedCursorEnv(root);

    try {
      const result = await execute({
        runId: "run-4",
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
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt ?? "").not.toContain("## Skill: ascii-heart");
      await expect(fs.lstat(path.join(managedSkillsHome, "ascii-heart"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(loadedSkills).toEqual([]);
    } finally {
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
