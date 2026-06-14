import { execute } from "@rudderhq/agent-runtime-codex-local/server";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const GIT_IDENTITY_TEST_ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_GLOBAL",
  "XDG_CONFIG_HOME",
] as const;

function clearInheritedGitIdentityEnv(): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of GIT_IDENTITY_TEST_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const workspaceSkillsPath = path.join(process.cwd(), ".agents", "skills");
const codexSkillsPath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "skills") : null;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  codexHome: process.env.CODEX_HOME || null,
  home: process.env.HOME || null,
  userProfile: process.env.USERPROFILE || null,
  agentHome: process.env.AGENT_HOME || null,
  rudderOperatorHome: process.env.RUDDER_OPERATOR_HOME || null,
  pathEnv: process.env.PATH || null,
  workspaceSkillEntries: fs.existsSync(workspaceSkillsPath)
    ? fs.readdirSync(workspaceSkillsPath).sort()
    : [],
  codexSkillEntries: codexSkillsPath && fs.existsSync(codexSkillsPath)
    ? fs.readdirSync(codexSkillsPath).sort()
    : [],
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFailingCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.error([
    "2026-04-13T09:25:56.430513Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at \\"/Users/test/.codex/shell_snapshots/019d8629-6e4c-7381-8538-7f93b18408cc.tmp-1776072355418943000\\": Os { code: 2, kind: NotFound, message: \\"No such file or directory\\" }",
    "file:///Users/test/.nvm/versions/node/v22.17.0/lib/node_modules/@openai/codex/bin/codex.js:100",
    "    throw new Error(",
    "          ^",
    "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
    "    at file:///Users/test/.nvm/versions/node/v22.17.0/lib/node_modules/@openai/codex/bin/codex.js:100:11",
    "    at ModuleJob.run (node:internal/modules/esm/module_job:329:25)",
    "Node.js v22.17.0",
  ].join("\\n"));
  process.exit(1);
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeBenignStderrCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("2026-04-13T09:25:56.430513Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at \\"/Users/test/.codex/shell_snapshots/019d8629-6e4c-7381-8538-7f93b18408cc.tmp-1776072355418943000\\": Os { code: 2, kind: NotFound, message: \\"No such file or directory\\" }\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeCodexRuntimeNoiseCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write([
    "2026-05-02T08:58:43.814979Z  WARN codex_protocol::openai_models: Model personality requested but model_messages is missing, falling back to base instructions. model=gpt-5.5 personality=pragmatic",
    "2026-05-05T09:41:25.271157Z ERROR codex_core::models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
    "2026-05-02T08:58:57.468646Z  WARN codex_analytics::analytics_client: events failed with status 403 Forbidden: <html>",
    "  <head>",
    "    <meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\" />",
    "  </head>",
    "  <body>",
    "    <div class=\\"container\\">Enable JavaScript and cookies to continue</div>",
    "  </body>",
    "</html>",
  ].join("\\n") + "\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeClosedStdinNoiseCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "error", message: "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done despite tool noise" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeMissingRolloutResumeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
  if (args.includes("resume")) {
    console.error("Error: thread/resume: thread/resume failed: no rollout found for thread id 019dc96b-3624-7ce1-8fb5-bd05d3f50afd");
    process.exit(1);
    return;
  }

  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-2" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "recovered" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeGitIdentityCaptureCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

function runGit(args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, { encoding: "utf8" }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : String(error.message || error),
    };
  }
}

process.stdin.resume();
process.stdin.on("end", () => {
  const ident = runGit(["var", "GIT_AUTHOR_IDENT"]);
  const useConfigOnly = runGit(["config", "--global", "--get", "user.useConfigOnly"]);
  const email = runGit(["config", "--global", "--get", "user.email"]);
  const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
  if (capturePath) {
    fs.writeFileSync(capturePath, JSON.stringify({
      home: process.env.HOME || null,
      ident,
      useConfigOnly,
      email,
      rudderEnvKeys: Object.keys(process.env)
        .filter((key) => key.startsWith("RUDDER_"))
        .sort(),
    }), "utf8");
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "captured git identity" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeGitCommitCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
process.stdin.resume();
process.stdin.on("end", () => {
  const result = spawnSync("git", ["commit", "--allow-empty", "-m", "agent commit"], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "git commit failed");
    process.exit(result.status || 1);
    return;
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "committed" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeGitCredentialCaptureCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

process.stdin.resume();
process.stdin.on("end", () => {
  const result = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\\nhost=github.com\\n\\n",
    encoding: "utf8",
  });
  const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
  if (capturePath) {
    fs.writeFileSync(capturePath, JSON.stringify({
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      home: process.env.HOME || null,
      gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL || null,
      gitConfigCount: process.env.GIT_CONFIG_COUNT || null,
      helperConfig: Object.keys(process.env)
        .filter((key) => /^GIT_CONFIG_(KEY|VALUE)_\\d+$/.test(key))
        .sort()
        .map((key) => [key, process.env[key]]),
    }), "utf8");
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "git credential fill failed");
    process.exit(result.status || 1);
    return;
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "credential captured" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function initGitRepoWithoutStoredIdentity(workspace: string) {
  await runGit(workspace, ["init"]);
  await fs.writeFile(path.join(workspace, "README.md"), "hello\n", "utf8");
  await runGit(workspace, ["add", "README.md"]);
  await runGit(workspace, [
    "-c",
    "user.name=Setup User",
    "-c",
    "user.email=setup@example.com",
    "commit",
    "-m",
    "Initial commit",
  ]);
}


type CapturePayload = {
  argv: string[];
  prompt: string;
  codexHome: string | null;
  home: string | null;
  userProfile: string | null;
  agentHome: string | null;
  rudderOperatorHome: string | null;
  pathEnv: string | null;
  workspaceSkillEntries: string[];
  codexSkillEntries: string[];
  rudderEnvKeys: string[];
};

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

function managedCodexHomePath(input: {
  rudderHome: string;
  instanceId?: string;
  orgId?: string;
  agentId?: string;
}): string {
  return path.join(
    input.rudderHome,
    "instances",
    input.instanceId ?? "default",
    "organizations",
    input.orgId ?? "organization-1",
    "codex-home",
    "agents",
    input.agentId ?? "agent-1",
  );
}

describe("codex execute", () => {
  it("prepares isolated HOME Git config from the workspace repository identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-git-identity-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await runGit(workspace, ["init"]);
    await runGit(workspace, ["config", "user.name", "Rudder Agent"]);
    await runGit(workspace, ["config", "user.email", "rudder-agent@example.com"]);
    await writeGitIdentityCaptureCodexCommand(commandPath);

    const restoreGitEnv = clearInheritedGitIdentityEnv();
    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-git-identity",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
            GIT_CONFIG_NOSYSTEM: "1",
          },
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
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string | null;
        ident: { ok: boolean; stdout: string; stderr: string };
        useConfigOnly: { ok: boolean; stdout: string; stderr: string };
        email: { ok: boolean; stdout: string; stderr: string };
        rudderEnvKeys: string[];
      };
      expect(capture.home).toBe(path.join(managedCodexHome, "home"));
      expect(capture.ident.ok).toBe(true);
      expect(capture.ident.stdout).toContain("Rudder Agent <rudder-agent@example.com>");
      expect(capture.rudderEnvKeys).toContain("RUDDER_PROJECT_LIBRARY_ROOT");
      expect(capture.rudderEnvKeys).toContain("RUDDER_PROJECT_LIBRARY_PATH");
      expect(capture.ident.stdout).not.toContain(".local");
      expect(capture.useConfigOnly.stdout).toBe("true\n");
      expect(capture.email.stdout).toBe("");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      restoreGitEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast instead of making fallback .local commits when no Git identity is available", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-missing-git-identity-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await initGitRepoWithoutStoredIdentity(workspace);
    await writeGitCommitCodexCommand(commandPath);

    const restoreGitEnv = clearInheritedGitIdentityEnv();
    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = path.join(root, "empty-host-home");
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-missing-git-identity",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            GIT_AUTHOR_NAME: "Zeeland",
            GIT_AUTHOR_EMAIL: "zeeland@ZeelanddeMacBook-Pro.local",
            GIT_COMMITTER_NAME: "Zeeland",
            GIT_COMMITTER_EMAIL: "zeeland@ZeelanddeMacBook-Pro.local",
            GIT_CONFIG_NOSYSTEM: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(128);
      expect(result.errorMessage).toContain("Author identity unknown");
      expect(result.resultJson?.stderr).toContain("auto-detection is disabled");
      expect(result.resultJson?.stderr).not.toContain(".local");
      const count = await runGit(workspace, ["rev-list", "--count", "HEAD"]);
      expect(count.stdout.trim()).toBe("1");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      restoreGitEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects a gh-backed Git credential helper while preserving managed HOME identity guards", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-git-credential-helper-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const ghHomeCapturePath = path.join(root, "gh-home.txt");
    const hostBin = path.join(root, "host-bin");
    const operatorHome = path.join(root, "operator-home");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(hostBin, { recursive: true });
    await fs.mkdir(path.join(operatorHome, ".config", "gh"), { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(path.join(managedCodexHome, "home", ".config", "gh"), { recursive: true });
    await fs.writeFile(path.join(operatorHome, "auth-ok"), "yes\n", "utf8");
    await fs.writeFile(path.join(managedCodexHome, "home", ".config", "gh", "hosts.yml"), "stale\n", "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.writeFile(
      path.join(hostBin, "gh"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
        "  test -f \"$HOME/auth-ok\"",
        "  exit $?",
        "fi",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"git-credential\" ]; then",
        `  printf '%s\\n' "$HOME" > ${JSON.stringify(ghHomeCapturePath)}`,
        "  cat >/dev/null",
        "  printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=operator-token\\n\\n'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(path.join(hostBin, "gh"), 0o755);
    await writeGitCredentialCaptureCodexCommand(commandPath);

    const restoreGitEnv = clearInheritedGitIdentityEnv();
    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = operatorHome;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-git-credential-helper",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            PATH: `${hostBin}:${process.env.PATH ?? ""}`,
            RUDDER_OPERATOR_HOME: operatorHome,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
            GIT_CONFIG_NOSYSTEM: "1",
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        status: number;
        stdout: string;
        stderr: string;
        home: string | null;
        gitConfigGlobal: string | null;
        gitConfigCount: string | null;
        helperConfig: Array<[string, string]>;
      };
      expect(capture.status).toBe(0);
      expect(capture.stdout).toContain("password=operator-token");
      expect(capture.home).toBe(path.join(managedCodexHome, "home"));
      expect(capture.gitConfigGlobal).toBe(path.join(managedCodexHome, "home", ".gitconfig"));
      expect(capture.gitConfigCount).toBe("2");
      expect(capture.helperConfig).toEqual(expect.arrayContaining([
        ["GIT_CONFIG_KEY_0", "credential.helper"],
        ["GIT_CONFIG_VALUE_0", ""],
        ["GIT_CONFIG_KEY_1", "credential.helper"],
        ["GIT_CONFIG_VALUE_1", "!gh auth git-credential"],
      ]));
      await expect(fs.readFile(ghHomeCapturePath, "utf8")).resolves.toBe(`${operatorHome}\n`);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      restoreGitEnv();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a Rudder-managed CODEX_HOME outside worktree mode while preserving shared auth and config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-default-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const hostBin = path.join(root, "host-bin");
    const operatorHome = path.join(root, "operator-home");
    const configIsolatedHome = path.join(root, "config-isolated-home");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(hostBin, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(operatorHome, ".config", "gh"), { recursive: true });
    await fs.writeFile(
      path.join(operatorHome, ".config", "gh", "hosts.yml"),
      "github.com:\n  oauth_token: operator\n",
      "utf8",
    );
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.writeFile(path.join(hostBin, "gh"), "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(path.join(hostBin, "gh"), 0o755);
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = operatorHome;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-default",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            HOME: configIsolatedHome,
            PATH: `${hostBin}:${process.env.PATH ?? ""}`,
            RUDDER_OPERATOR_HOME: operatorHome,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
          },
        },
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(managedCodexHome);
      expect(capture.home).toBe(path.join(managedCodexHome, "home"));
      expect(capture.userProfile).toBe(path.join(managedCodexHome, "home"));
      expect(capture.agentHome).toBe(path.join(managedCodexHome, "home"));
      expect(capture.rudderOperatorHome).toBe(operatorHome);
      expect(capture.pathEnv?.split(":")[0]).not.toBe(path.join(managedCodexHome, "home", ".rudder", "local-cli-shims"));
      expect(capture.codexSkillEntries).toEqual(["rudder"]);
      expect(capture.argv).toEqual(expect.arrayContaining([
        "exec",
        "--json",
        "--disable",
        "plugins",
        "-c",
        "skills.bundled.enabled=false",
        "-",
      ]));

      const managedAuth = path.join(managedCodexHome, "auth.json");
      const managedConfig = path.join(managedCodexHome, "config.toml");
      const managedGh = path.join(managedCodexHome, "home", ".config", "gh");
      const managedGhShim = path.join(managedCodexHome, "home", ".rudder", "local-cli-shims", "gh");
      const managedSkillLink = path.join(managedCodexHome, "skills", "rudder");
      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(managedConfig)).isFile()).toBe(true);
      const managedConfigContents = await fs.readFile(managedConfig, "utf8");
      expect(managedConfigContents).toContain('model = "codex-mini-latest"');
      expect(managedConfigContents).toContain("[skills.bundled]");
      expect(managedConfigContents).toContain("enabled = false");
      expect(managedConfigContents).toContain("[features]");
      expect(managedConfigContents).toContain("plugins = false");
      expect(managedConfigContents).not.toContain("[[skills.config]]");
      expect((await fs.lstat(managedGh)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedGh)).toBe(await fs.realpath(path.join(operatorHome, ".config", "gh")));
      await expect(fs.lstat(managedGhShim)).rejects.toThrow();
      expect((await fs.lstat(managedSkillLink)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedSkillLink)).toBe(
        await fs.realpath(path.join(process.cwd(), "server", "resources", "bundled-skills", "rudder")),
      );
      await expect(fs.lstat(path.join(sharedCodexHome, "organizations", "organization-1"))).rejects.toThrow();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using Rudder-managed Codex home"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates managed CODEX_HOME per agent inside the same organization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-agent-isolation-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const firstCapturePath = path.join(root, "capture-agent-1.json");
    const secondCapturePath = path.join(root, "capture-agent-2.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const baseRuntime = {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      };
      const baseConfig = {
        command: commandPath,
        cwd: workspace,
        promptTemplate: "Follow the rudder heartbeat.",
      };

      const [firstResult, secondResult] = await Promise.all([
        execute({
          runId: "run-agent-1",
          agent: {
            id: "agent-1",
            orgId: "organization-1",
            name: "Codex Coder 1",
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: {},
          },
          runtime: baseRuntime,
          config: {
            ...baseConfig,
            env: { RUDDER_TEST_CAPTURE_PATH: firstCapturePath },
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
        }),
        execute({
          runId: "run-agent-2",
          agent: {
            id: "agent-2",
            orgId: "organization-1",
            name: "Codex Coder 2",
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: {},
          },
          runtime: baseRuntime,
          config: {
            ...baseConfig,
            env: { RUDDER_TEST_CAPTURE_PATH: secondCapturePath },
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
        }),
      ]);

      expect(firstResult.exitCode).toBe(0);
      expect(secondResult.exitCode).toBe(0);

      const firstCapture = JSON.parse(await fs.readFile(firstCapturePath, "utf8")) as CapturePayload;
      const secondCapture = JSON.parse(await fs.readFile(secondCapturePath, "utf8")) as CapturePayload;
      expect(firstCapture.codexHome).toBe(managedCodexHomePath({ rudderHome: paperclipHome, agentId: "agent-1" }));
      expect(secondCapture.codexHome).toBe(managedCodexHomePath({ rudderHome: paperclipHome, agentId: "agent-2" }));
      expect(firstCapture.codexHome).not.toBe(secondCapture.codexHome);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes inherited Codex [[skills.config]] entries from the managed config before invocation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-sanitize-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.writeFile(
      path.join(managedCodexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        "[skills.bundled]",
        "enabled = true",
        "",
        "[[skills.config]]",
        'name = "vercel:ai-sdk"',
        "enabled = false",
        "",
        "[[skills.config]]",
        'path = "/tmp/valid-skill/SKILL.md"',
        "enabled = false",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-sanitize",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
          },
        },
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(managedCodexHome);

      const managedConfig = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(managedConfig).toContain("[skills.bundled]");
      expect(managedConfig).toContain("enabled = false");
      expect(managedConfig).not.toContain('name = "vercel:ai-sdk"');
      expect(managedConfig).not.toContain('path = "/tmp/valid-skill/SKILL.md"');
      expect(managedConfig).not.toContain("[[skills.config]]");
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Removed 2 inherited Codex [[skills.config]] entries"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("strips inherited Codex notify hooks, MCP server, and plugin tables from the managed config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-strip-managed-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'notify = ["legacy_notify"]',
        'model = "codex-mini-latest"',
        "",
        "[features]",
        "plugins = true",
        "",
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        "",
        '[plugins."linear@openai-curated"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-strip-managed",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const managedConfigContents = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(managedConfigContents).toContain('model = "codex-mini-latest"');
      expect(managedConfigContents).toContain("[skills.bundled]");
      expect(managedConfigContents).toContain("enabled = false");
      expect(managedConfigContents).toContain("[features]");
      expect(managedConfigContents).toContain("plugins = false");
      expect(managedConfigContents).not.toContain("notify =");
      expect(managedConfigContents).not.toContain("plugins = true");
      expect(managedConfigContents).not.toContain("[mcp_servers.linear]");
      expect(managedConfigContents).not.toContain('[plugins."linear@openai-curated"]');
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Removed 2 inherited Codex plugin/MCP configuration tables"),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Removed 1 inherited Codex notify hook"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prunes inherited Codex plugin cache state from the managed home before invocation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-prune-plugin-cache-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    const managedPluginSkill = path.join(
      managedCodexHome,
      "plugins",
      "cache",
      "openai-curated",
      "linear",
      "fb0a18376bcd9f2604047fbe7459ec5aed70c64b",
      "skills",
      "linear",
      "SKILL.md",
    );
    const managedTmpPluginManifest = path.join(
      managedCodexHome,
      ".tmp",
      "plugins",
      "plugins",
      "build-ios-apps",
      ".codex-plugin",
      "plugin.json",
    );
    const managedTmpPluginClone = path.join(
      managedCodexHome,
      ".tmp",
      "plugins-clone-demo",
      "placeholder.txt",
    );
    const managedTmpPluginMarker = path.join(
      managedCodexHome,
      ".tmp",
      "app-server-remote-plugin-sync-v1",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.mkdir(path.dirname(managedPluginSkill), { recursive: true });
    await fs.writeFile(managedPluginSkill, "# linear\n", "utf8");
    await fs.mkdir(path.dirname(managedTmpPluginManifest), { recursive: true });
    await fs.writeFile(managedTmpPluginManifest, '{"name":"build-ios-apps"}\n', "utf8");
    await fs.writeFile(path.join(managedCodexHome, ".tmp", "plugins.sha"), "sha\n", "utf8");
    await fs.mkdir(path.dirname(managedTmpPluginClone), { recursive: true });
    await fs.writeFile(managedTmpPluginClone, "clone\n", "utf8");
    await fs.writeFile(managedTmpPluginMarker, "marker\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-prune-plugin-cache",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      await expect(fs.access(path.join(managedCodexHome, "plugins"))).rejects.toThrow();
      await expect(fs.access(path.join(managedCodexHome, ".tmp", "plugins"))).rejects.toThrow();
      await expect(fs.access(path.join(managedCodexHome, ".tmp", "plugins.sha"))).rejects.toThrow();
      await expect(fs.access(path.join(managedCodexHome, ".tmp", "plugins-clone-demo"))).rejects.toThrow();
      await expect(fs.access(managedTmpPluginMarker)).rejects.toThrow();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Pruned 5 inherited Codex plugin cache entries"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits a command note that Codex auto-applies repo-scoped AGENTS.md files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-notes-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    const heartbeatPath = path.join(root, "instructions", "HEARTBEAT.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Keep updates concise.\n", "utf8");
    await fs.writeFile(heartbeatPath, "# Heartbeat\n\n- Check assigned issues.\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    let loadedSkills: unknown[] = [];
    try {
      const result = await execute({
        runId: "run-notes",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          instructionsFilePath: instructionsPath,
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: { rudderScene: "heartbeat" },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
          promptMetrics = meta.promptMetrics ?? {};
          loadedSkills = meta.loadedSkills ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt).toContain("# Agent Instructions");
      expect(capture.prompt).toContain("# Tacit Memory");
      expect(capture.prompt).toContain("# Rudder Heartbeat Instruction");
      expect(capture.prompt).not.toContain("# Heartbeat\n\n- Check assigned issues.");
      expect(commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(commandNotes).toContain("Loaded Rudder heartbeat instructions from runtime code");
      expect(commandNotes).not.toContain("Loaded supplemental agent heartbeat notes from $AGENT_HOME/instructions/HEARTBEAT.md");
      expect(commandNotes).toContain(
        "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Rudder does not currently suppress that discovery.",
      );
      expect(promptMetrics.memoryChars).toBeGreaterThan(0);
      expect(promptMetrics.runtimeHeartbeatChars).toBeGreaterThan(0);
      expect(promptMetrics.heartbeatFileChars).toBe(0);
      expect(promptMetrics.heartbeatChars).toBe(promptMetrics.runtimeHeartbeatChars);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
      expect(loadedSkills).toEqual([
        expect.objectContaining({
          key: "rudder/rudder",
          runtimeName: "rudder",
        }),
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("adds --skip-git-repo-check for chat-scene Codex runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-chat-scene-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-chat-scene",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Reply in chat.",
        },
        context: {
          rudderScene: "chat",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--skip-git-repo-check");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes runtime image media to Codex with native --image attachments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-image-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const imagePath = path.join(root, "chat-image.png");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(imagePath, "png-bytes", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      let commandNotes: string[] = [];
      const result = await execute({
        runId: "run-chat-image",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Reply in chat.",
        },
        context: {
          rudderScene: "chat",
        },
        media: [{
          source: "chat_attachment",
          attachmentId: "attachment-1",
          assetId: "asset-1",
          name: "chat-image.png",
          originalFilename: "chat-image.png",
          contentType: "image/png",
          byteSize: 9,
          localPath: imagePath,
        }],
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(expect.arrayContaining(["--image", imagePath]));
      expect(commandNotes).toContain("Attached 1 image attachment to the initial Codex prompt via --image.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes multiple runtime image media to Codex and ignores non-image media", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-images-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const firstImagePath = path.join(root, "first.png");
    const secondImagePath = path.join(root, "second.png");
    const textPath = path.join(root, "notes.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(firstImagePath, "first-image", "utf8");
    await fs.writeFile(secondImagePath, "second-image", "utf8");
    await fs.writeFile(textPath, "notes", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      let commandNotes: string[] = [];
      const result = await execute({
        runId: "run-multiple-images",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Describe attached media.",
        },
        context: {
          rudderScene: "chat",
        },
        media: [
          {
            source: "chat_attachment",
            attachmentId: "attachment-image-1",
            assetId: "asset-image-1",
            name: "first.png",
            originalFilename: "first.png",
            contentType: "image/png",
            byteSize: 11,
            localPath: firstImagePath,
          },
          {
            source: "chat_attachment",
            attachmentId: "attachment-text-1",
            assetId: "asset-text-1",
            name: "notes.txt",
            originalFilename: "notes.txt",
            contentType: "text/plain",
            byteSize: 5,
            localPath: textPath,
          },
          {
            source: "chat_attachment",
            attachmentId: "attachment-image-2",
            assetId: "asset-image-2",
            name: "second.png",
            originalFilename: "second.png",
            contentType: "image/png",
            byteSize: 12,
            localPath: secondImagePath,
          },
        ],
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(expect.arrayContaining(["--image", firstImagePath, "--image", secondImagePath]));
      expect(capture.argv).not.toContain(textPath);
      expect(commandNotes).toContain("Attached 2 image attachments to the initial Codex prompt via --image.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not add --skip-git-repo-check outside the chat scene", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-non-chat-scene-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-non-chat-scene",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Run the assigned task.",
        },
        context: {
          rudderScene: "issue_heartbeat",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).not.toContain("--skip-git-repo-check");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a worktree-isolated CODEX_HOME while preserving shared auth and config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const isolatedCodexHome = managedCodexHomePath({
      rudderHome: paperclipHome,
      instanceId: "worktree-1",
    });
    const workspaceSkill = path.join(workspace, ".agents", "skills", "rudder");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "worktree-1";
    process.env.RUDDER_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            orgWorkspaceRoot: path.join(root, "org-workspace"),
            orgSkillsDir: path.join(root, "org-workspace", "skills"),
          },
        },
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(isolatedCodexHome);
      expect(capture.argv).toEqual(expect.arrayContaining([
        "exec",
        "--json",
        "--disable",
        "plugins",
        "-c",
        "skills.bundled.enabled=false",
        "-",
      ]));
      expect(capture.prompt).toContain("Follow the rudder heartbeat.");
      expect(capture.rudderEnvKeys).toEqual(
        expect.arrayContaining([
          "RUDDER_AGENT_ID",
          "RUDDER_API_KEY",
          "RUDDER_API_URL",
          "RUDDER_ORG_ID",
          "RUDDER_RUN_ID",
        ]),
      );

      const isolatedAuth = path.join(isolatedCodexHome, "auth.json");
      const isolatedConfig = path.join(isolatedCodexHome, "config.toml");

      expect((await fs.lstat(isolatedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(isolatedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(isolatedConfig)).isFile()).toBe(true);
      const isolatedConfigContents = await fs.readFile(isolatedConfig, "utf8");
      expect(isolatedConfigContents).toContain('model = "codex-mini-latest"');
      expect(isolatedConfigContents).toContain("[skills.bundled]");
      expect(isolatedConfigContents).toContain("enabled = false");
      expect(isolatedConfigContents).toContain("[features]");
      expect(isolatedConfigContents).toContain("plugins = false");
      expect(isolatedConfigContents).not.toContain("[[skills.config]]");
      expect((await fs.lstat(path.join(isolatedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
      await expect(fs.lstat(workspaceSkill)).rejects.toMatchObject({ code: "ENOENT" });
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using worktree-isolated Codex home"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not materialize enabled Codex skills into the workspace surface", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-user-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "worktree-1";
    process.env.RUDDER_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-user-skill",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.workspaceSkillEntries).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("extracts the real Codex error from Node stack-style stderr output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-error-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-error",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_OPERATOR_HOME: path.join(root, "operator-home"),
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBe(
        "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("filters benign shell snapshot cleanup warnings from Codex stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-shell-snapshot-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeBenignStderrCodexCommand(commandPath);

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-shell-snapshot-noise",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_OPERATOR_HOME: path.join(root, "operator-home"),
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.resultJson).toMatchObject({
        stderr: "",
      });
      expect(logs.some((entry) => entry.stream === "stderr")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("filters benign Codex model refresh, model personality, and analytics warnings from stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-runtime-noise-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeCodexRuntimeNoiseCommand(commandPath);

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-runtime-noise",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_OPERATOR_HOME: path.join(root, "operator-home"),
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.resultJson).toMatchObject({
        stderr: "",
      });
      expect(logs.some((entry) => entry.stream === "stderr")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses closed-stdin Codex tool session noise without failing a successful run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-closed-stdin-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeClosedStdinNoiseCodexCommand(commandPath);

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-closed-stdin-noise",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_OPERATOR_HOME: path.join(root, "operator-home"),
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toBe("done despite tool noise");
      expect(result.resultJson).toMatchObject({
        stderr: "",
      });
      expect(logs.some((entry) => entry.stream === "stderr")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers from Codex resume errors when the thread rollout is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-missing-rollout-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeMissingRolloutResumeCodexCommand(commandPath);

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-missing-rollout",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
        },
        runtime: {
          sessionId: "old-codex-session",
          sessionParams: {
            sessionId: "old-codex-session",
            cwd: workspace,
          },
          sessionDisplayId: "old-codex-session",
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_OPERATOR_HOME: path.join(root, "operator-home"),
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.sessionId).toBe("codex-session-2");
      expect(result.summary).toBe("recovered");
      expect(result.resultJson).toMatchObject({
        stderr: "",
      });
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining('Codex resume session "old-codex-session" is unavailable'),
        }),
      );
      expect(logs.some((entry) => entry.stream === "stderr")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects an explicit CODEX_HOME config override even in worktree mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-explicit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const explicitCodexHome = path.join(root, "explicit-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    process.env.RUDDER_INSTANCE_ID = "worktree-1";
    process.env.RUDDER_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
            CODEX_HOME: explicitCodexHome,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
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
      expect(capture.codexHome).toBe(explicitCodexHome);
      await expect(fs.lstat(path.join(workspace, ".agents", "skills", "rudder"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(paperclipHome, "instances", "worktree-1", "codex-home"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not preserve inherited shared Codex skill entries in the managed config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-disable-inherited-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "codex-mini-latest"',
        "",
        "[[skills.config]]",
        'path = "/tmp/shared-enabled-skill/SKILL.md"',
        "enabled = true",
        "",
        "[[skills.config]]",
        'path = "/tmp/shared-legacy-skill/SKILL.md"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-disable-inherited",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const managedConfigContents = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(managedConfigContents).toContain("[skills.bundled]");
      expect(managedConfigContents).toContain("enabled = false");
      expect(managedConfigContents).not.toContain('path = "/tmp/shared-enabled-skill/SKILL.md"');
      expect(managedConfigContents).not.toContain('path = "/tmp/shared-legacy-skill/SKILL.md"');
      expect(managedConfigContents).not.toContain("[[skills.config]]");
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prunes stale managed-home skill directories including .system and isolates HOME from the shared user home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-prune-skill-surface-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    const staleManagedSkill = path.join(managedCodexHome, "skills", "stale-skill", "SKILL.md");
    const staleSystemSkill = path.join(managedCodexHome, "skills", ".system", "imagegen", "SKILL.md");
    const agentHome = path.join(root, "agent-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(path.dirname(staleManagedSkill), { recursive: true });
    await fs.mkdir(path.dirname(staleSystemSkill), { recursive: true });
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.writeFile(staleManagedSkill, "# stale\n", "utf8");
    await fs.writeFile(staleSystemSkill, "# system stale\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-prune-skill-surface",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Codex Coder",
          agentRuntimeType: "codex_local",
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
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {
          rudderWorkspace: {
            agentHome,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.home).toBe(agentHome);
      expect(capture.userProfile).toBe(agentHome);
      expect(capture.agentHome).toBe(agentHome);
      expect(capture.codexSkillEntries).toEqual(["rudder"]);
      await expect(fs.lstat(path.join(managedCodexHome, "skills", "stale-skill"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedCodexHome, "skills", ".system"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.RUDDER_IN_WORKTREE;
      else process.env.RUDDER_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
