import { execute } from "@rudderhq/agent-runtime-gemini-local/server";
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

async function writeFakeGeminiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  home: process.env.HOME || null,
  userProfile: process.env.USERPROFILE || null,
  geminiCliHome: process.env.GEMINI_CLI_HOME || null,
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
  gitIdentity: captureGitIdentityEnv(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
if (process.env.RUDDER_TEST_GEMINI_INELIGIBLE_TIER === "1") {
  console.error("Warning: Basic terminal detected (TERM=dumb).");
  console.error("YOLO mode is enabled. All tool calls will be automatically approved.");
  console.error("Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. reasonCode: 'UNSUPPORTED_CLIENT'");
  process.exit(1);
}
if (process.env.RUDDER_TEST_GEMINI_SEMANTIC_AUTH_ERROR === "1") {
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-session-1",
    model: "gemini-2.5-pro",
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "error",
    session_id: "gemini-session-1",
    error: { message: "Please set an Auth method in your managed .gemini/settings.json" },
  }));
  process.exit(0);
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "gemini-session-1",
  model: "gemini-2.5-pro",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "gemini-session-1",
  result: "ok",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  home: string | null;
  userProfile: string | null;
  geminiCliHome: string | null;
  rudderEnvKeys: string[];
  gitIdentity: GitIdentityCapture;
};

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("gemini execute", { timeout: 20_000 }, () => {
  it("passes prompt via --prompt and injects rudder env vars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-gemini-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    const operatorSkillPath = path.join(root, ".gemini", "skills", "operator-skill", "SKILL.md");
    const operatorExtensionPath = path.join(root, ".gemini", "extensions", "operator-extension", "gemini-extension.json");
    const operatorHookPath = path.join(root, ".gemini", "hooks", "operator-hook.json");
    const operatorSettingsPath = path.join(root, ".gemini", "settings.json");
    const operatorCredentialsPath = path.join(root, ".gemini", "oauth_creds.json");
    const operatorGoogleAccountsPath = path.join(root, ".gemini", "google_accounts.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(operatorSkillPath), { recursive: true });
    await fs.mkdir(path.dirname(operatorExtensionPath), { recursive: true });
    await fs.mkdir(path.dirname(operatorHookPath), { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(operatorSkillPath, "---\nname: operator-skill\n---\n", "utf8");
    await fs.writeFile(operatorExtensionPath, "{\"name\":\"operator-extension\"}\n", "utf8");
    await fs.writeFile(operatorHookPath, "{\"name\":\"operator-hook\"}\n", "utf8");
    await fs.writeFile(
      operatorSettingsPath,
      "{\"mcpServers\":{\"operator\":{}},\"security\":{\"auth\":{\"selectedType\":\"oauth-personal\"}}}\n",
      "utf8",
    );
    await fs.writeFile(operatorCredentialsPath, "{\"refresh_token\":\"operator\"}\n", "utf8");
    await fs.writeFile(operatorGoogleAccountsPath, "{\"active\":\"operator@example.com\"}\n", "utf8");
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Use concise updates.\n", "utf8");
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Gemini Coder",
          agentRuntimeType: "gemini_local",
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
          model: "gemini-2.5-pro",
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
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expectPreparedGitConfigCapture(capture);
      const managedGeminiHome = path.join(
        root,
        ".rudder",
        "instances",
        "default",
        "organizations",
        "organization-1",
        "gemini-home",
      );
      expect(capture.home).toBe(managedGeminiHome);
      expect(capture.userProfile).toBe(managedGeminiHome);
      expect(capture.geminiCliHome).toBe(managedGeminiHome);
      expect(capture.argv).toContain("--output-format");
      expect(capture.argv).toContain("stream-json");
      expect(capture.argv).toContain("--prompt");
      expect(capture.argv).toContain("--skip-trust");
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      expect(capture.argv).toContain("--extensions");
      expect(capture.argv[capture.argv.indexOf("--extensions") + 1]).toBe("");
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(promptArg).toContain("# Agent Instructions");
      expect(promptArg).toContain("# Tacit Memory");
      expect(promptArg).toContain("Follow the rudder heartbeat.");
      expect(promptArg).toContain("Rudder runtime note:");
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
      expect(invocationPrompt).toContain("Rudder runtime note:");
      expect(invocationPrompt).toContain("# Tacit Memory");
      expect(invocationPrompt).toContain("RUDDER_API_URL");
      expect(invocationPrompt).toContain("Rudder CLI access note:");
      expect(invocationPrompt).toContain("run_shell_command");
      expect(invocationPrompt).toContain("rudder agent me --json");
      expect(result.question).toBeNull();
      await expect(fs.lstat(path.join(root, ".gemini", "skills", "rudder"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedGeminiHome, ".gemini", "extensions"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedGeminiHome, ".gemini", "hooks"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const managedSettings = JSON.parse(
        await fs.readFile(path.join(managedGeminiHome, ".gemini", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(managedSettings).toEqual({
        security: {
          auth: {
            selectedType: "oauth-personal",
          },
        },
      });
      expect(await fs.realpath(path.join(managedGeminiHome, ".gemini", "oauth_creds.json"))).toBe(
        await fs.realpath(operatorCredentialsPath),
      );
      expect(await fs.realpath(path.join(managedGeminiHome, ".gemini", "google_accounts.json"))).toBe(
        await fs.realpath(operatorGoogleAccountsPath),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOperatorHome === undefined) {
        delete process.env.RUDDER_OPERATOR_HOME;
      } else {
        process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("always passes --skip-trust and --approval-mode yolo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-gemini-yolo-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      await execute({
        runId: "run-yolo",
        agent: { id: "a1", orgId: "c1", name: "G", agentRuntimeType: "gemini_local", agentRuntimeConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--skip-trust");
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      expect(capture.argv).toContain("--extensions");
      expect(capture.argv[capture.argv.indexOf("--extensions") + 1]).toBe("");
      expect(capture.argv).not.toContain("--policy");
      expect(capture.argv).not.toContain("--allow-all");
      expect(capture.argv).not.toContain("--allow-read");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOperatorHome === undefined) {
        delete process.env.RUDDER_OPERATOR_HOME;
      } else {
        process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces the meaningful Gemini auth error after terminal warnings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-gemini-auth-error-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-gemini-auth-error",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Gemini Coder",
          agentRuntimeType: "gemini_local",
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
            RUDDER_TEST_GEMINI_INELIGIBLE_TIER: "1",
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("gemini_auth_required");
      expect(result.errorMessage).toContain("IneligibleTierError");
      expect(result.errorMessage).not.toContain("Basic terminal detected");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOperatorHome === undefined) {
        delete process.env.RUDDER_OPERATOR_HOME;
      } else {
        process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns an adapter error when Gemini reports a semantic auth error with exit zero", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-gemini-semantic-auth-error-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
    process.env.HOME = root;
    process.env.RUDDER_OPERATOR_HOME = root;

    try {
      const result = await execute({
        runId: "run-gemini-semantic-auth-error",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Gemini Coder",
          agentRuntimeType: "gemini_local",
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
            RUDDER_TEST_GEMINI_SEMANTIC_AUTH_ERROR: "1",
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBe("gemini_auth_required");
      expect(result.errorMessage).toContain("Please set an Auth method");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOperatorHome === undefined) {
        delete process.env.RUDDER_OPERATOR_HOME;
      } else {
        process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes previously materialized Gemini skills when they are no longer selected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-gemini-prune-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const managedSkillsHome = path.join(
      root,
      ".rudder",
      "instances",
      "default",
      "organizations",
      "organization-1",
      "gemini-home",
      ".gemini",
      "skills",
    );
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

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
        runId: "run-gemini-prune-skill",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Gemini Coder",
          agentRuntimeType: "gemini_local",
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
          model: "gemini-2.5-pro",
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
});
