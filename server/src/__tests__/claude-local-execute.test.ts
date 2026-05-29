import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, runClaudeLogin } from "@rudderhq/agent-runtime-claude-local/server";
import {
  clearInheritedGitIdentityEnv,
  expectPreparedGitConfigCapture,
  gitIdentityCaptureSnippet,
  type GitIdentityCapture,
} from "./local-runtime-git-identity-helpers";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
${gitIdentityCaptureSnippet}
const path = require("node:path");

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const addDirIndex = process.argv.indexOf("--add-dir");
const addDir = addDirIndex >= 0 ? process.argv[addDirIndex + 1] : null;
const appendSystemPromptFileIndex = process.argv.indexOf("--append-system-prompt-file");
const appendSystemPromptFile = appendSystemPromptFileIndex >= 0 ? process.argv[appendSystemPromptFileIndex + 1] : null;
const addDirSkillsPath = addDir ? path.join(addDir, ".claude", "skills") : null;
const managedClaudeSettingsPath = process.env.HOME
  ? path.join(process.env.HOME, ".claude", "settings.json")
  : null;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
  managedClaudeSettingsPath,
  managedClaudeSettings:
    managedClaudeSettingsPath && fs.existsSync(managedClaudeSettingsPath)
      ? fs.readFileSync(managedClaudeSettingsPath, "utf8")
      : null,
  appendedSystemPrompt:
    appendSystemPromptFile && fs.existsSync(appendSystemPromptFile)
      ? fs.readFileSync(appendSystemPromptFile, "utf8")
      : null,
  addDirSkillEntries:
    addDirSkillsPath && fs.existsSync(addDirSkillsPath)
      ? fs.readdirSync(addDirSkillsPath).sort()
      : [],
  gitIdentity: captureGitIdentityEnv(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-1",
  model: "claude-test",
}));
console.log(JSON.stringify({
  type: "assistant",
  session_id: "claude-session-1",
  message: {
    content: [{ type: "text", text: "hello" }],
  },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-1",
  result: "ok",
  usage: {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  },
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

describe("claude execute", () => {
  it("runs the current Claude auth login subcommand", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-login-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await runClaudeLogin({
        runId: "claude-login-test",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
          agentRuntimeConfig: {},
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
        },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };
      expect(capture.argv).toEqual(["auth", "login"]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs a loaded instructions file as stdout instead of stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Prefer concise status.\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("[rudder] Loaded agent instructions file: $AGENT_HOME/instructions/AGENTS.md"),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("[rudder] Loaded agent memory instructions file: $AGENT_HOME/instructions/MEMORY.md"),
        }),
      );
      expect(logs).not.toContainEqual(
        expect.objectContaining({
          stream: "stderr",
          chunk: expect.stringContaining("[rudder] Loaded agent instructions file: $AGENT_HOME/instructions/AGENTS.md"),
        }),
      );
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        appendedSystemPrompt: string | null;
        rudderEnvKeys: string[];
        gitIdentity: GitIdentityCapture;
      };
      expectPreparedGitConfigCapture(capture);
      expect(capture.appendedSystemPrompt).toContain("# Agent Instructions");
      expect(capture.appendedSystemPrompt).toContain("# Tacit Memory");
      expect(capture.rudderEnvKeys).toEqual(
        expect.arrayContaining(["RUDDER_ORG_ARTIFACTS_DIR"]),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports runtime image media as local prompt paths for Claude Code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-image-media-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const imagePath = path.join(root, "chat-image.png");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(imagePath, "png-bytes", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      let commandNotes: string[] = [];
      const result = await execute({
        runId: "run-claude-image",
        agent: {
          id: "agent-1",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
          promptTemplate: "Inspect {{context.chatAttachments}} before replying.",
        },
        context: {
          chatAttachments: [{
            attachmentId: "attachment-1",
            localPath: imagePath,
          }],
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
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        prompt: string;
      };
      expect(capture.argv).not.toContain("--image");
      expect(capture.prompt).toContain(imagePath);
      expect(commandNotes).toContain("Provided 1 local image attachment path in the prompt for Claude Code inspection.");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("mounts explicitly enabled user-installed Claude skills into the transient add-dir surface", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-external-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const externalSkillRoot = path.join(root, ".claude", "skills", "build-advisor");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(externalSkillRoot, { recursive: true });
    await fs.writeFile(path.join(externalSkillRoot, "SKILL.md"), "---\nname: build-advisor\n---\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-2",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          rudderRuntimeSkills: [
            {
              key: "adapter:claude_local:build-advisor",
              runtimeName: "build-advisor",
              source: externalSkillRoot,
            },
          ],
          rudderSkillSync: {
            desiredSkills: ["adapter:claude_local:build-advisor"],
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        addDirSkillEntries: string[];
      };
      expect(capture.addDirSkillEntries).toContain("build-advisor");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("inherits shared Claude settings into the managed home without reusing the shared skills dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-settings-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const sharedClaudeDir = path.join(root, ".claude");
    const sharedSkillsDir = path.join(sharedClaudeDir, "skills");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedSkillsDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedClaudeDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(sharedSkillsDir, "user-skill.txt"), "shared skill marker", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-3",
        agent: {
          id: "agent-3",
          orgId: "organization-1",
          name: "Claude Coder",
          agentRuntimeType: "claude_local",
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
            HOME: root,
            RUDDER_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the rudder heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        managedClaudeSettingsPath: string | null;
        managedClaudeSettings: string | null;
        addDirSkillEntries: string[];
      };
      expect(capture.managedClaudeSettingsPath).toContain("/.rudder/instances/default/organizations/organization-1/claude-home/.claude/settings.json");
      expect(capture.managedClaudeSettings).toContain("\"ANTHROPIC_API_KEY\":\"test-key\"");
      expect(capture.managedClaudeSettings).toContain("\"ANTHROPIC_BASE_URL\":\"https://example.invalid/anthropic\"");
      expect(capture.addDirSkillEntries).not.toContain("user-skill.txt");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(path.join(root, ".rudder"), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
