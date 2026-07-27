import { execute } from "@rudderhq/agent-runtime-codex-local/server";
import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_CONTRACT_VERSION,
  type AgentRuntimeControlHandle,
} from "@rudderhq/agent-runtime-utils";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createRuntimeSkillFixture,
  installCanonicalDesktopMcp,
  installVersionMismatchedDesktopMcp,
  readMcpToolNames,
} from "./local-runtime-browser-mismatch-helpers";

const execFileAsync = promisify(execFile);

function parseCodexRudderMcpConfig(content: string, serverName = "rudder-tools"): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  let section = "";
  let command = "";
  let args: string[] = [];
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line;
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = JSON.parse(line.slice(separator + 1).trim()) as unknown;
    if (section === `[mcp_servers.${serverName}]`) {
      if (key === "command" && typeof value === "string") command = value;
      if (key === "args" && Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        args = value as string[];
      }
    }
    if (
      section === `[mcp_servers.${serverName}.env]`
      && typeof value === "string"
    ) {
      env[key] = value;
    }
  }
  if (!command) throw new Error("Managed Codex config omitted the Rudder MCP command");
  return { command, args, env };
}

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
  rudderApiKey: process.env.RUDDER_API_KEY || null,
  rudderBrowserEnabled: process.env.RUDDER_BROWSER_ENABLED || null,
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

async function writeBlockingCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => undefined, 1_000);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeCodexAppServerCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const finalText = process.env.RUDDER_TEST_FINAL_TEXT || "hello";
const inlineVisualBody = process.env.RUDDER_TEST_INLINE_VISUAL_BODY;
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(process.argv.slice(2)), "utf8");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const writeInlineVisual = (threadId) => {
  if (!inlineVisualBody || !process.env.CODEX_HOME) return;
  const now = new Date();
  const parts = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ];
  const dir = path.join(process.env.CODEX_HOME, "visualizations", ...parts, threadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "release-signal.html"), inlineVisualBody, "utf8");
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (
    process.env.RUDDER_TEST_PROTOCOL_CAPTURE_PATH
    && ["thread/start", "thread/resume", "turn/start"].includes(message.method)
  ) {
    fs.appendFileSync(
      process.env.RUDDER_TEST_PROTOCOL_CAPTURE_PATH,
      JSON.stringify(message) + "\\n",
      "utf8",
    );
  }
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    writeInlineVisual("thread-default-app-server");
    send({ id: message.id, result: { thread: { id: "thread-default-app-server" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-default-app-server" } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-default-app-server",
      turnId: "turn-default-app-server",
      itemId: "agent-default",
      delta: finalText,
    } });
    send({ method: "item/completed", params: {
      threadId: "thread-default-app-server",
      turnId: "turn-default-app-server",
      item: { type: "agentMessage", id: "agent-default", text: finalText },
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-default-app-server",
      turn: { id: "turn-default-app-server", status: "completed", error: null },
    } });
  }
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeMemoryGitCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

process.stdin.resume();
process.stdin.on("end", () => {
  const memoriesGit = path.join(process.env.CODEX_HOME, "memories", ".git");
  const orgMemoriesGit = path.join(path.dirname(path.dirname(process.env.CODEX_HOME)), "memories", ".git");
  fs.mkdirSync(memoriesGit, { recursive: true });
  fs.writeFileSync(path.join(memoriesGit, "HEAD"), "ref: refs/heads/main\\n", "utf8");
  fs.mkdirSync(orgMemoriesGit, { recursive: true });
  fs.writeFileSync(path.join(orgMemoriesGit, "HEAD"), "ref: refs/heads/main\\n", "utf8");
  fs.mkdirSync(path.join(process.env.CODEX_HOME, "sessions", "2026"), { recursive: true });
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeUsageCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "costed" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000000, cached_input_tokens: 200000, output_tokens: 100000 } }));
});
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
  process.stderr.write("real stderr before\\n");
  process.stderr.write("  in-process app-server event stream lag");
  process.stderr.write("ged; dropped 42 events\\n");
  process.stderr.write("x".repeat(70 * 1024));
  process.stderr.write("real stderr after");
  process.stderr.write("\\nauth failed: in-process app-server event stream lagged; dropped 9 events\\n");
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

async function writeMcpProcessCleanupNoiseCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write([
    "2026-07-01T06:12:02.158754Z  WARN codex_rmcp_client::stdio_server_launcher: Failed to kill MCP process group for server rudder-tools: No such process (os error 3)",
    "2026-07-01T06:12:02.158755Z  WARN codex_rmcp_client::stdio_server_launcher: Failed to kill MCP process group for server rudder-browser: No such process (os error 3)",
  ].join("\\n") + "\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeExternalMcpProcessCleanupNoiseCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("2026-07-01T06:12:02.158754Z  WARN codex_rmcp_client::stdio_server_launcher: Failed to kill MCP process group for server external-Rudder: No such process (os error 3)\\n");
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
  rudderApiKey: string | null;
  rudderBrowserEnabled: string | null;
  pathEnv: string | null;
  workspaceSkillEntries: string[];
  codexSkillEntries: string[];
  rudderEnvKeys: string[];
};

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

async function readProtocolRequests(capturePath: string): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(capturePath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

describe("codex execute", { timeout: 20_000 }, () => {
  it("does not prepend resources already embedded in a Chat prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-chat-resources-once-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const resources = "## Organization Resources\n\n- Main codebase: ~/projects/rudder";
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await execute({
        runId: "run-chat-resources-once",
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
          env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "{{context.chatPrompt}}",
        },
        context: {
          rudderScene: "chat",
          chatMode: true,
          rudderChatPromptIncludesResources: true,
          chatPrompt: `${resources}\n\nConversation input: test`,
          rudderWorkspace: {
            orgResourcesPrompt: resources,
            resourcesPrompt: resources,
          },
        },
        onLog: async () => undefined,
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt.match(/## Organization Resources/g)).toHaveLength(1);
      expect(capture.prompt).toContain("Conversation input: test");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps custom Codex commands on exec unless App Server is explicitly enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-server-gate-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await execute({
        runId: "run-chat-app-server-gate",
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
          env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Reply in chat.",
        },
        context: {
          rudderScene: "chat",
          chatMode: true,
        },
        onLog: async () => undefined,
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("exec");
      expect(capture.argv).not.toContain("app-server");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses App Server by default for the standard Codex chat command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-server-default-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexAppServerCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await execute({
        runId: "run-chat-app-server-default",
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
          command: "codex",
          cwd: workspace,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Reply in chat.",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
        context: {
          rudderScene: "chat",
          chatMode: true,
        },
        onLog: async () => undefined,
      });

      expect(result).toMatchObject({
        exitCode: 0,
        summary: "hello",
        resultJson: { transport: "codex_app_server" },
      });
      const argv = JSON.parse(await fs.readFile(capturePath, "utf8")) as string[];
      expect(argv).toContain("app-server");
      expect(argv).not.toContain("exec");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["-s read-only", ["-s", "read-only"]],
    ["--sandbox read-only", ["--sandbox", "read-only"]],
    ["--sandbox=read-only", ["--sandbox=read-only"]],
  ])("keeps the standard Codex chat on native App Server with %s", async (_label, extraArgs) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-server-read-only-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    const capturePath = path.join(root, "capture.json");
    const protocolCapturePath = path.join(root, "protocol.ndjson");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexAppServerCommand(commandPath);

    let controlCapabilities: AgentRuntimeControlHandle["capabilities"] | null = null;
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await execute({
        runId: "run-chat-app-server-read-only",
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
          command: "codex",
          cwd: workspace,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
            RUDDER_TEST_PROTOCOL_CAPTURE_PATH: protocolCapturePath,
          },
          promptTemplate: "Inspect and plan.",
          extraArgs,
        },
        context: {
          rudderScene: "chat",
          chatMode: true,
        },
        controlAttempt: {
          attemptEpoch: 1,
          ownerToken: "read-only-owner",
          async register(handle) {
            controlCapabilities = handle.capabilities;
            return {
              isCurrent: () => true,
              async release() {},
            };
          },
          async complete() {},
        },
        onLog: async () => undefined,
      });

      expect(result).toMatchObject({
        exitCode: 0,
        summary: "hello",
        resultJson: { transport: "codex_app_server" },
      });
      expect(controlCapabilities).toEqual({ steer: "native", interrupt: "native" });
      const argv = JSON.parse(await fs.readFile(capturePath, "utf8")) as string[];
      expect(argv).toContain("app-server");
      expect(argv).not.toContain("exec");
      const requests = await readProtocolRequests(protocolCapturePath);
      expect(requests).toEqual([
        expect.objectContaining({
          method: "thread/start",
          params: expect.objectContaining({ sandbox: "read-only" }),
        }),
        expect.objectContaining({
          method: "turn/start",
          params: expect.objectContaining({ sandboxPolicy: { type: "readOnly" } }),
        }),
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["unsupported custom CLI args", { extraArgs: ["--profile", "custom"] }],
    ["a non-read-only sandbox", { extraArgs: ["--sandbox", "workspace-write"] }],
    ["explicit App Server disablement", { chatAppServerEnabled: false }],
  ])("keeps codex exec fallback for %s", async (_label, configOverride) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-server-fallback-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await execute({
        runId: "run-chat-app-server-fallback",
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
          command: "codex",
          cwd: workspace,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Reply in chat.",
          ...configOverride,
        },
        context: {
          rudderScene: "chat",
          chatMode: true,
        },
        onLog: async () => undefined,
      });

      expect(result.exitCode).toBe(0);
      expect(result.resultJson).not.toMatchObject({ transport: "codex_app_server" });
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("exec");
      expect(capture.argv).not.toContain("app-server");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("captures inline visuals from the default Codex App Server chat path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-server-visual-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexAppServerCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await execute({
        runId: "run-chat-app-server-visual",
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
          command: "codex",
          cwd: workspace,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RUDDER_TEST_FINAL_TEXT: [
              "Release signal",
              '::codex-inline-vis{file="release-signal.html"}',
            ].join("\n"),
            RUDDER_TEST_INLINE_VISUAL_BODY: '<div id="widget">Ready</div>',
          },
          promptTemplate: "Create an inline visual.",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
        context: {
          rudderScene: "chat",
          chatMode: true,
        },
        onLog: async () => undefined,
      });

      expect(result).toMatchObject({
        exitCode: 0,
        summary: 'Release signal\n::codex-inline-vis{file="release-signal.html"}',
        resultJson: {
          transport: "codex_app_server",
          inlineVisuals: [{
            directiveIndex: 0,
            file: "release-signal.html",
            status: "captured",
            contentType: "text/html",
            byteSize: 28,
          }],
        },
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves bundle mismatch metadata on the default Codex App Server path",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-server-mismatch-"));
      const workspace = path.join(root, "workspace");
      const binDir = path.join(root, "bin");
      const commandPath = path.join(binDir, "codex");
      const capturePath = path.join(root, "capture.json");
      const rudderHome = path.join(root, ".rudder");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await writeFakeCodexAppServerCommand(commandPath);
      const installedDesktopMcp = await installVersionMismatchedDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_HOME = rudderHome;
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};

      try {
        const result = await execute({
          runId: "run-chat-app-server-mismatch",
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
            command: "codex",
            cwd: workspace,
            rudderBrowserEnabled: true,
            env: {
              PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
              RUDDER_TEST_CAPTURE_PATH: capturePath,
            },
            promptTemplate: "Reply in chat.",
          },
          context: { rudderScene: "chat", chatMode: true },
          onLog: async () => undefined,
          onMeta: async (value) => { meta = value as Record<string, unknown>; },
        });

        expect(result).toMatchObject({
          exitCode: 0,
          resultJson: { transport: "codex_app_server" },
        });
        const argv = JSON.parse(await fs.readFile(capturePath, "utf8")) as string[];
        expect(argv).toContain("app-server");
        expect(argv).not.toContain("exec");
        expect(meta.rudderMcp).toMatchObject({
          available: true,
          contractVersion: RUDDER_MCP_CONTRACT_VERSION,
          coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
          provenance: "desktop_bundle",
          serverName: "rudder-tools",
          toolCount: 70,
          version: "0.4.6",
        });
        expect(meta.rudderMcp).not.toHaveProperty("browserAvailable");
        expect(meta.rudderMcp).not.toHaveProperty("contractHash");
        expect(meta.rudderMcp).not.toHaveProperty("diagnosticCode");
        expect(meta.browserMcp).toMatchObject({
          available: false,
          diagnosticCode: "browser_bundle_version_mismatch",
          serverName: "rudder-browser",
          version: "0.4.5",
        });
        expect((meta.browserMcp as { fallbackReason?: string }).fallbackReason).toContain(
          "bundle version mismatch",
        );
      } finally {
        installedDesktopMcp.restore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
        else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("publishes an interrupt-and-continue handle for Codex exec chat fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-exec-control-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "custom-codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeBlockingCodexCommand(commandPath);

    const controller = new AbortController();
    let releaseCount = 0;
    let publishHandle!: (handle: AgentRuntimeControlHandle) => void;
    const handleReady = new Promise<AgentRuntimeControlHandle>((resolve) => {
      publishHandle = resolve;
    });
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const execution = execute({
        runId: "run-chat-exec-control",
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
          promptTemplate: "Keep running.",
          chatAppServerEnabled: false,
          graceSec: 20,
        },
        context: {
          rudderScene: "chat",
          chatMode: true,
        },
        abortSignal: controller.signal,
        controlAttempt: {
          attemptEpoch: 1,
          ownerToken: "exec-owner",
          async register(handle) {
            publishHandle(handle);
            return {
              isCurrent: () => true,
              async release() {
                releaseCount += 1;
                await handle.dispose();
              },
            };
          },
          async complete() {},
        },
        onLog: async () => undefined,
      });

      const handle = await handleReady;
      expect(handle.capabilities).toEqual({
        steer: "interrupt_continue",
        interrupt: "process",
      });
      controller.abort(new Error("steer fallback"));
      await expect(handle.interrupt("steer_fallback")).resolves.toBe("acknowledged");
      const result = await execution;
      expect(result.signal).toBe("SIGTERM");
      expect(releaseCount).toBe(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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
      expect(capture.home).toBe(root);
      expect(capture.ident.ok).toBe(true);
      expect(capture.ident.stdout).toContain("Rudder Agent <rudder-agent@example.com>");
      expect(capture.rudderEnvKeys).toContain("RUDDER_PROJECT_LIBRARY_ROOT");
      expect(capture.rudderEnvKeys).toContain("RUDDER_PROJECT_LIBRARY_PATH");
      const managedConfigContents = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(managedConfigContents).toContain('RUDDER_PROJECT_LIBRARY_PATH = "projects/product"');
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

  it("prunes provider-managed Codex memory git state after execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-memory-git-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const operatorHome = path.join(root, "operator-home");
    const sharedCodexHome = path.join(operatorHome, ".codex");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    const managedOrgCodexHome = path.dirname(path.dirname(managedCodexHome));
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeMemoryGitCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = operatorHome;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    delete process.env.CODEX_HOME;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-memory-git",
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
      expect(result.sessionId).toBe("codex-session-1");
      await expect(fs.lstat(path.join(managedCodexHome, "memories"))).rejects.toThrow();
      await expect(fs.lstat(path.join(managedOrgCodexHome, "memories"))).rejects.toThrow();
      await expect(fs.lstat(path.join(managedCodexHome, "sessions", "2026"))).resolves.toBeTruthy();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Pruned provider-managed Codex memory state"),
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

  it("preserves the Codex execution result when provider memory cleanup fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-memory-cleanup-fail-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const operatorHome = path.join(root, "operator-home");
    const sharedCodexHome = path.join(operatorHome, ".codex");
    const paperclipHome = path.join(root, "rudder-home");
    const managedCodexHome = managedCodexHomePath({ rudderHome: paperclipHome });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeMemoryGitCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousPaperclipInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.RUDDER_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = operatorHome;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_IN_WORKTREE;
    delete process.env.CODEX_HOME;

    const originalRm = fs.rm;
    try {
      const logs: LogEntry[] = [];
      let failOnce = true;
      fs.rm = (async (target: fs.PathLike, options?: fs.RmOptions) => {
        if (failOnce && String(target).startsWith(path.join(managedCodexHome, "memories"))) {
          failOnce = false;
          throw new Error("simulated cleanup failure");
        }
        return originalRm(target, options);
      }) as typeof fs.rm;

      const result = await execute({
        runId: "run-memory-cleanup-fail",
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
      expect(result.summary).toBe("hello");
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stderr",
          chunk: expect.stringContaining("simulated cleanup failure"),
        }),
      );
    } finally {
      fs.rm = originalRm;
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

  it("uses gh-backed Git credentials from operator HOME while preserving managed Git identity guards", async () => {
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
      expect(capture.home).toBe(operatorHome);
      expect(capture.gitConfigGlobal).toBe(path.join(managedCodexHome, "git", ".gitconfig"));
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
    await fs.mkdir(path.join(operatorHome, ".agents", "skills", "home-leak"), { recursive: true });
    await fs.writeFile(path.join(operatorHome, ".agents", "skills", "home-leak", "SKILL.md"), "# Home leak\n", "utf8");
    await fs.writeFile(
      path.join(operatorHome, ".config", "gh", "hosts.yml"),
      "github.com:\n  oauth_token: operator\n",
      "utf8",
    );
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(path.join(sharedCodexHome, "skills", "shared-leak"), { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "skills", "shared-leak", "SKILL.md"), "# Shared leak\n", "utf8");
    await fs.mkdir(path.join(workspace, ".agents", "skills", "repo-leak"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".agents", "skills", "repo-leak", "SKILL.md"), "# Repo leak\n", "utf8");
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
      expect(capture.home).toBe(operatorHome);
      expect(capture.userProfile).toBe(process.env.USERPROFILE ?? operatorHome);
      expect(capture.agentHome).toBe(path.join(paperclipHome, "instances", "default", "organizations", "organization-1", "workspaces", "agents", "agent-1"));
      expect(capture.rudderOperatorHome).toBe(operatorHome);
      expect(capture.pathEnv?.split(":")[0]).not.toBe(path.join(managedCodexHome, "home", ".rudder", "local-cli-shims"));
      expect(capture.codexSkillEntries).toEqual(["rudder-docs"]);
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
      const managedSkillLink = path.join(managedCodexHome, "skills", "rudder-docs");
      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(managedConfig)).isFile()).toBe(true);
      const managedConfigContents = await fs.readFile(managedConfig, "utf8");
      expect(managedConfigContents).toContain('model = "codex-mini-latest"');
      expect(managedConfigContents).toContain("[skills.bundled]");
      expect(managedConfigContents).toContain("enabled = false");
      expect(managedConfigContents).toContain("[features]");
      expect(managedConfigContents).toContain("plugins = false");
      expect(managedConfigContents).toContain("[[skills.config]]");
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(operatorHome, ".agents", "skills"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(operatorHome, ".agents", "skills", "home-leak"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(operatorHome, ".agents", "skills", "home-leak", "SKILL.md"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(sharedCodexHome, "skills"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(sharedCodexHome, "skills", "shared-leak"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(sharedCodexHome, "skills", "shared-leak", "SKILL.md"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills", "repo-leak"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills", "repo-leak", "SKILL.md"))}`);
      await expect(fs.lstat(managedGh)).rejects.toThrow();
      await expect(fs.lstat(managedGhShim)).rejects.toThrow();
      expect((await fs.lstat(managedSkillLink)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedSkillLink)).toBe(
        await fs.realpath(path.join(process.cwd(), "server", "resources", "bundled-skills", "rudder-docs")),
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

  it("estimates metered cost for Codex subscription runs by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-subscription-cost-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const operatorHome = path.join(root, "operator-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(operatorHome, { recursive: true });
    await writeUsageCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.HOME = operatorHome;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await execute({
        runId: "run-cost",
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
          model: "gpt-5.5",
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.biller).toBe("chatgpt");
      expect(result.billingType).toBe("metered_api");
      expect(result.costUsd).toBeCloseTo(7.1, 6);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Codex subscription runs at zero cost when cost estimation is disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-subscription-cost-disabled-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const operatorHome = path.join(root, "operator-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(operatorHome, { recursive: true });
    await writeUsageCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.HOME = operatorHome;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await execute({
        runId: "run-cost-disabled",
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
          model: "gpt-5.5",
          countSubscriptionUsageAsCost: false,
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.biller).toBe("chatgpt");
      expect(result.billingType).toBe("subscription");
      expect(result.costUsd).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps unknown Codex subscription models as subscription usage when cost estimation is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-subscription-unknown-cost-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const operatorHome = path.join(root, "operator-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(operatorHome, { recursive: true });
    await writeUsageCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.HOME = operatorHome;
    process.env.RUDDER_HOME = paperclipHome;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await execute({
        runId: "run-cost-unknown",
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
          model: "custom-future-codex",
          countSubscriptionUsageAsCost: true,
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.biller).toBe("chatgpt");
      expect(result.billingType).toBe("subscription");
      expect(result.costUsd).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
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
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
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
      expect(managedConfig).toContain("[[skills.config]]");
      expect(managedConfig).toContain(`path = ${JSON.stringify(path.join(root, ".agents", "skills"))}`);
      expect(managedConfig).toContain(`path = ${JSON.stringify(path.join(sharedCodexHome, "skills"))}`);
      expect(managedConfig).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills"))}`);
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder-docs"))).isSymbolicLink()).toBe(true);
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
            RUDDER_AGENT_ID: "stale-agent",
            RUDDER_API_KEY: "stale-agent-key",
            RUDDER_API_URL: "https://stale.example.invalid",
            RUDDER_BROWSER_ENABLED: "true",
            RUDDER_ORG_ID: "stale-organization",
            RUDDER_PROJECT_LIBRARY_PATH: "stale/project-library",
            RUDDER_RUN_ID: "stale-run",
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
      expect(managedConfigContents).toContain("[mcp_servers.rudder-tools]");
      expect(managedConfigContents).toContain("command =");
      expect(managedConfigContents).toContain('"mcp-server"');
      expect(managedConfigContents).toContain("[mcp_servers.rudder-tools.env]");
      expect(managedConfigContents).toContain("RUDDER_MCP_RUDDER_BIN =");
      expect(managedConfigContents).toContain('RUDDER_API_URL = "http://localhost:3100"');
      expect(managedConfigContents).toContain('RUDDER_API_KEY = "run-jwt-token"');
      expect(managedConfigContents).not.toContain("stale-agent-key");
      expect(managedConfigContents).toContain('RUDDER_ORG_ID = "organization-1"');
      expect(managedConfigContents).toContain('RUDDER_AGENT_ID = "agent-1"');
      expect(managedConfigContents).toContain('RUDDER_RUN_ID = "run-strip-managed"');
      expect(managedConfigContents).not.toContain("RUDDER_BROWSER_ENABLED");
      expect(managedConfigContents).not.toContain("[mcp_servers.rudder-browser]");
      expect(managedConfigContents).not.toContain("stale.example.invalid");
      expect(managedConfigContents).not.toContain("stale-organization");
      expect(managedConfigContents).not.toContain('RUDDER_AGENT_ID = "stale-agent"');
      expect(managedConfigContents).not.toContain("stale-run");
      expect(managedConfigContents).not.toContain("stale/project-library");
      expect(managedConfigContents).not.toContain("notify =");
      expect(managedConfigContents).not.toContain("plugins = true");
      expect(managedConfigContents).not.toContain("[mcp_servers.linear]");
      expect(managedConfigContents).not.toContain('[plugins."linear@openai-curated"]');
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.rudderApiKey).toBe("run-jwt-token");
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

  it("records Rudder MCP availability in Codex runtime metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-mcp-meta-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "rudder-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);
    const installedDesktopMcp = await installCanonicalDesktopMcp(root);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.RUDDER_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.RUDDER_HOME = paperclipHome;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      let runtimeMetadata: Record<string, unknown> = {};
      const result = await execute({
        runId: "run-mcp-meta",
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
          rudderBrowserEnabled: true,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => { runtimeMetadata = meta as Record<string, unknown>; },
      });

      expect(result.exitCode).toBe(0);
      expect(runtimeMetadata.rudderMcp).toMatchObject({
        available: true,
        coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
        contractVersion: RUDDER_MCP_CONTRACT_VERSION,
        provenance: "desktop_bundle",
        serverName: "rudder-tools",
        toolCount: 70,
        version: "0.4.6",
      });
      expect(runtimeMetadata.rudderMcp).not.toHaveProperty("browserAvailable");
      expect(runtimeMetadata.rudderMcp).not.toHaveProperty("contractHash");
      expect(runtimeMetadata.rudderMcp).not.toHaveProperty("diagnosticCode");
      expect(runtimeMetadata.browserMcp).toMatchObject({
        available: true,
        contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
        contractVersion: RUDDER_MCP_CONTRACT_VERSION,
        diagnosticCode: null,
        provenance: "desktop_bundle",
        serverName: "rudder-browser",
        toolCount: RUDDER_BROWSER_MCP_TOOL_NAMES.length,
        version: "0.4.6",
      });
      const managedConfig = await fs.readFile(
        path.join(managedCodexHomePath({ rudderHome: paperclipHome }), "config.toml"),
        "utf8",
      );
      expect(managedConfig.match(/^\[mcp_servers\.(rudder-tools|rudder-browser)\]$/gmu)).toEqual([
        "[mcp_servers.rudder-tools]",
        "[mcp_servers.rudder-browser]",
      ]);
      const coreConfig = parseCodexRudderMcpConfig(managedConfig);
      const browserConfig = parseCodexRudderMcpConfig(managedConfig, "rudder-browser");
      expect(await readMcpToolNames(coreConfig)).toEqual([...RUDDER_CORE_MCP_TOOL_NAMES]);
      expect(await readMcpToolNames(browserConfig)).toEqual([...RUDDER_BROWSER_MCP_TOOL_NAMES]);
    } finally {
      installedDesktopMcp.restore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousPaperclipHome;
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
    const soulPath = path.join(root, "instructions", "SOUL.md");
    const toolsPath = path.join(root, "instructions", "TOOLS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    const heartbeatPath = path.join(root, "instructions", "HEARTBEAT.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(soulPath, "# Agent Soul\n", "utf8");
    await fs.writeFile(toolsPath, "# Agent Tools\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Keep updates concise.\n", "utf8");
    await fs.writeFile(heartbeatPath, "# Heartbeat\n\n- Check assigned issues.\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    let loadedSkills: unknown[] = [];
    let agentInstructionStack = "";
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
          promptTemplate: [
            "{{context.rudderWorkspace.orgResourcesPrompt}}",
            "{{context.rudderWorkspace.resourcesPrompt}}",
            "{{context.rudderResourcesPrompt}}",
            "Follow the rudder heartbeat.",
          ].join("\n"),
        },
        context: {
          rudderScene: "heartbeat",
          rudderResourcesPrompt: "## Your Current Automations\n\n- Daily inbox review",
          rudderWorkspace: {
            orgResourcesPrompt: "## Your Current Automations\n\n- Daily inbox review",
            resourcesPrompt: "## Your Current Automations\n\n- Daily inbox review",
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
          promptMetrics = meta.promptMetrics ?? {};
          loadedSkills = meta.loadedSkills ?? [];
          agentInstructionStack = meta.agentInstructionStack ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt).toContain("# Agent Instructions");
      expect(capture.prompt).toContain("# Agent Soul");
      expect(capture.prompt).toContain("# Agent Tools");
      expect(capture.prompt).toContain("# Tacit Memory");
      expect(capture.prompt).toContain("# Enabled Rudder Skills");
      expect(capture.prompt).toContain("Only skills listed in this section are enabled by Rudder for this run.");
      expect(capture.prompt).toContain("- rudder");
      expect(capture.prompt).not.toContain("- rudder: rudder/rudder");
      expect(capture.prompt).toContain("## Your Current Automations");
      expect(capture.prompt.match(/## Your Current Automations/g)).toHaveLength(1);
      expect(capture.prompt).toContain("# Rudder Heartbeat Instruction");
      expect(capture.prompt).not.toContain("# Heartbeat\n\n- Check assigned issues.");
      expect(capture.prompt.indexOf("# Agent Instructions")).toBeLessThan(capture.prompt.indexOf("# Agent Soul"));
      expect(capture.prompt.indexOf("# Agent Soul")).toBeLessThan(capture.prompt.indexOf("# Agent Tools"));
      expect(capture.prompt.indexOf("# Agent Tools")).toBeLessThan(capture.prompt.indexOf("# Tacit Memory"));
      expect(capture.prompt.indexOf("# Tacit Memory")).toBeLessThan(capture.prompt.indexOf("## Your Current Automations"));
      expect(capture.prompt.indexOf("## Your Current Automations")).toBeLessThan(capture.prompt.indexOf("## Current Time"));
      expect(capture.prompt.indexOf("## Current Time")).toBeLessThan(
        capture.prompt.indexOf("# Rudder Heartbeat Instruction"),
      );
      expect(agentInstructionStack).toBe(capture.prompt);
      expect(agentInstructionStack).toContain("# Agent Instructions");
      expect(agentInstructionStack).toContain("# Agent Soul");
      expect(agentInstructionStack).toContain("# Agent Tools");
      expect(agentInstructionStack).toContain("# Tacit Memory");
      expect(agentInstructionStack).toContain("# Enabled Rudder Skills");
      expect(agentInstructionStack).not.toContain("## Agent Instruction:");
      expect(agentInstructionStack).toContain("## Your Current Automations");
      expect(agentInstructionStack).not.toContain("[startup context omitted from persisted prompt]");
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
      expect(promptMetrics.skillBoundaryPromptChars).toBeGreaterThan(0);
      expect(promptMetrics.instructionEntryChars).toBeGreaterThan(0);
      expect(loadedSkills).toEqual([
        expect.objectContaining({
          key: "rudder/rudder-docs",
          runtimeName: "rudder-docs",
        }),
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["issue_commented", "issue_reopened_via_comment"] as const)(
    "does not inject runtime heartbeat instructions for %s issue wakes",
    async (wakeReason) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-comment-wake-instructions-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "codex");
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeCodexCommand(commandPath);

      const previousHome = process.env.HOME;
      process.env.HOME = root;

      let commandNotes: string[] = [];
      let promptMetrics: Record<string, number> = {};
      try {
        const result = await execute({
          runId: "run-comment-wake",
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
            promptTemplate: "Respond to the wake comment.",
          },
          context: {
            rudderScene: "heartbeat",
            wakeReason,
            wakeCommentId: "comment-1",
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
        expect(capture.prompt).toContain("# Rudder Agent Operating Contract");
        expect(capture.prompt).toContain("Respond to the wake comment.");
        expect(capture.prompt).not.toContain("# Rudder Heartbeat Instruction");
        expect(commandNotes).not.toContain("Loaded Rudder heartbeat instructions from runtime code");
        expect(promptMetrics.runtimeHeartbeatChars).toBe(0);
        expect(promptMetrics.heartbeatChars).toBe(0);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not inject runtime heartbeat instructions for issue assignment scene runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-issue-assignment-scene-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let commandNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    try {
      const result = await execute({
        runId: "run-issue-assignment",
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
          promptTemplate: "Work on the assigned issue.",
        },
        context: {
          rudderScene: "issue",
          wakeSource: "assignment",
          wakeReason: "issue_assigned",
          issueId: "issue-1",
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
      expect(capture.prompt).toContain("# Rudder Agent Operating Contract");
      expect(capture.prompt).toContain("Work on the assigned issue.");
      expect(capture.prompt).not.toContain("# Rudder Heartbeat Instruction");
      expect(commandNotes).not.toContain("Loaded Rudder heartbeat instructions from runtime code");
      expect(promptMetrics.runtimeHeartbeatChars).toBe(0);
      expect(promptMetrics.heartbeatChars).toBe(0);
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
      expect(isolatedConfigContents).toContain("[[skills.config]]");
      expect(isolatedConfigContents).toContain(`path = ${JSON.stringify(path.join(root, ".agents", "skills"))}`);
      expect(isolatedConfigContents).toContain(`path = ${JSON.stringify(path.join(sharedCodexHome, "skills"))}`);
      expect(isolatedConfigContents).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills"))}`);
      expect((await fs.lstat(path.join(isolatedCodexHome, "skills", "rudder-docs"))).isSymbolicLink()).toBe(true);
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
      expect(result.resultJson?.stderr).toContain("real stderr before");
      expect(result.resultJson?.stderr).toContain("real stderr after");
      expect(result.resultJson?.stderr).not.toMatch(/^\s*in-process app-server event stream lagged; dropped \d+ events\s*$/m);
      expect(result.resultJson?.stderr).toContain("auth failed: in-process app-server event stream lagged; dropped 9 events");
      expect(logs.some((entry) => entry.stream === "stderr" && entry.chunk.includes("real stderr before"))).toBe(true);
      expect(logs.some((entry) => entry.stream === "stderr" && entry.chunk.includes("real stderr after"))).toBe(true);
      expect(logs.some((entry) => entry.stream === "stderr" && entry.chunk.includes("auth failed: in-process"))).toBe(true);
      expect(logs.filter((entry) => entry.stream === "stderr").every((entry) => entry.chunk.length <= 64 * 1024)).toBe(true);
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

  it("filters benign Codex MCP process cleanup warnings from stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-mcp-cleanup-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeMcpProcessCleanupNoiseCodexCommand(commandPath);

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-mcp-cleanup-noise",
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

  it("keeps MCP process cleanup warnings for non-Rudder servers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-execute-external-mcp-cleanup-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeExternalMcpProcessCleanupNoiseCodexCommand(commandPath);

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-external-mcp-cleanup-noise",
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
      expect(result.resultJson?.stderr).toContain("external-Rudder");
      expect(logs.some((entry) => entry.stream === "stderr" && entry.chunk.includes("external-Rudder"))).toBe(true);
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
      expect(capture.codexHome).toBe(managedCodexHomePath({
        rudderHome: paperclipHome,
        instanceId: "worktree-1",
      }));
      await expect(fs.lstat(path.join(workspace, ".agents", "skills", "rudder-docs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(explicitCodexHome, "skills", "rudder-docs"))).rejects.toThrow();
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
      expect(managedConfigContents).toContain("[[skills.config]]");
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(root, ".agents", "skills"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(sharedCodexHome, "skills"))}`);
      expect(managedConfigContents).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills"))}`);
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder-docs"))).isSymbolicLink()).toBe(true);
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
      expect(capture.home).toBe(root);
      expect(capture.userProfile).toBe(process.env.USERPROFILE ?? root);
      expect(capture.agentHome).toBe(agentHome);
      expect(capture.codexSkillEntries).toEqual(["rudder-docs"]);
      await expect(fs.lstat(path.join(managedCodexHome, "skills", "stale-skill"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(managedCodexHome, "skills", ".system"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder-docs"))).isSymbolicLink()).toBe(true);
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

  it.skipIf(process.platform === "win32")(
    "removes Browser skill, prompt, tools, and metadata together after a bundle mismatch",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-browser-mismatch-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "codex");
      const capturePath = path.join(root, "capture.json");
      const rudderHome = path.join(root, ".rudder");
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeCodexCommand(commandPath);
      const browserSkill = await createRuntimeSkillFixture(root, "browser", "BROWSER_SKILL_PROMISE");
      const keepSkill = await createRuntimeSkillFixture(root, "keep-skill", "KEEP_SKILL_AVAILABLE");
      const installedDesktopMcp = await installVersionMismatchedDesktopMcp(root);
      const previousHome = process.env.HOME;
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.HOME = root;
      process.env.RUDDER_HOME = rudderHome;
      delete process.env.RUDDER_INSTANCE_ID;
      let meta: Record<string, unknown> = {};

      try {
        const result = await execute({
          runId: "run-codex-browser-mismatch",
          agent: {
            id: "agent-1",
            orgId: "organization-1",
            name: "Codex Agent",
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: {},
          },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
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
        expect(capture.rudderBrowserEnabled).toBe("false");
        expect(capture.prompt).toContain("- keep-skill");
        expect(capture.prompt).not.toContain("browser");
        expect(capture.codexSkillEntries).toEqual(["keep-skill"]);
        expect(meta.loadedSkills).toEqual([expect.objectContaining({ runtimeName: "keep-skill" })]);
        expect(meta.realizedSkills).toEqual(meta.loadedSkills);
        expect(meta.rudderMcp).toMatchObject({
          available: true,
          toolCount: 70,
        });
        expect(meta.rudderMcp).not.toHaveProperty("browserAvailable");
        expect(meta.rudderMcp).not.toHaveProperty("contractHash");
        expect(meta.rudderMcp).not.toHaveProperty("diagnosticCode");
        expect(meta.browserMcp).toMatchObject({
          available: false,
          diagnosticCode: "browser_bundle_version_mismatch",
          serverName: "rudder-browser",
          toolCount: RUDDER_BROWSER_MCP_TOOL_NAMES.length,
        });
        const managedConfig = await fs.readFile(
          path.join(managedCodexHomePath({ rudderHome }), "config.toml"),
          "utf8",
        );
        expect(managedConfig).not.toContain('RUDDER_BROWSER_ENABLED = "false"');
        expect(managedConfig).not.toContain("[mcp_servers.rudder-browser]");
        const generatedMcpConfig = parseCodexRudderMcpConfig(managedConfig);
        expect(generatedMcpConfig.command).toBe(installedDesktopMcp.command);
        expect(generatedMcpConfig.args).toEqual(installedDesktopMcp.args);
        expect(await readMcpToolNames(generatedMcpConfig)).toEqual([
          ...RUDDER_CORE_MCP_TOOL_NAMES,
        ]);
      } finally {
        installedDesktopMcp.restore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
        else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
