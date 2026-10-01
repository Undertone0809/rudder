import { ensurePathInEnv, resolveCommandPath } from "@rudderhq/agent-runtime-utils/server-utils";
import type { AgentRuntimeAvailability } from "@rudderhq/shared";
import { AGENT_RUNTIME_TYPES } from "@rudderhq/shared";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveHermesProfilePython } from "../agent-runtimes/hermes-profile-python.js";

const execFileAsync = promisify(execFile);

const LOCAL_RUNTIME_COMMANDS: Record<string, string> = {
  claude_local: "claude",
  codex_local: "codex",
  opencode_local: "opencode",
  pi_local: "pi",
  cursor: "cursor-agent",
  hermes_gateway: "hermes",
};

const HIDDEN_RUNTIME_TYPES = new Set(["process", "http"]);

function localRuntimeLabel(agentRuntimeType: string) {
  switch (agentRuntimeType) {
    case "claude_local":
      return "Claude Code CLI";
    case "codex_local":
      return "Codex CLI";
    case "opencode_local":
      return "OpenCode CLI";
    case "pi_local":
      return "Pi CLI";
    case "cursor":
      return "Cursor CLI";
    case "hermes_gateway":
      return "Hermes";
    default:
      return agentRuntimeType;
  }
}

async function existingPath(value: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const info = await stat(value);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

async function hermesProductRpcGap(env: NodeJS.ProcessEnv, cwd: string): Promise<AgentRuntimeAvailability["hermesProductRpcCapabilityGap"]> {
  const configuredHome = env.HERMES_HOME?.trim();
  const hermesHome = configuredHome && path.isAbsolute(configuredHome)
    ? path.resolve(configuredHome)
    : path.join(os.homedir(), ".hermes");
  const configuredSource = env.HERMES_SOURCE?.trim();
  const sourcePath = configuredSource && path.isAbsolute(configuredSource)
    ? path.resolve(configuredSource)
    : path.join(hermesHome, "hermes-agent");
  const configuredPython = env.HERMES_PYTHON?.trim();
  const pythonCandidates = configuredPython && path.isAbsolute(configuredPython)
    ? [path.resolve(configuredPython)]
    : [
      path.join(sourcePath, ".venv", "bin", "python3"),
      path.join(sourcePath, "venv", "bin", "python3"),
      path.join(sourcePath, ".venv", "bin", "python"),
    ];
  if (!await existingPath(hermesHome, "directory")
    || !await existingPath(sourcePath, "directory")
    || !await existingPath(path.join(sourcePath, "hermes_state.py"), "file")) {
    return "profile_missing";
  }
  if (!await existingPath(path.join(sourcePath, "tui_gateway", "entry.py"), "file")) {
    return "entrypoint_missing";
  }
  return (await resolveHermesProfilePython(pythonCandidates, { cwd, env })).gap;
}

async function hermesAvailability(
  cwd: string,
  env: NodeJS.ProcessEnv,
  checkedAt: string,
): Promise<AgentRuntimeAvailability> {
  const command = LOCAL_RUNTIME_COMMANDS.hermes_gateway;
  const resolvedCommand = await resolveCommandPath(command, cwd, env);
  if (!resolvedCommand) {
    return {
      agentRuntimeType: "hermes_gateway",
      status: "unavailable",
      command,
      resolvedCommand: null,
      message: "Hermes was not found on this machine.",
      hint: "Install Hermes Agent and finish its local setup, or choose a custom Hermes API Server connection.",
      checkedAt,
    };
  }

  try {
    // ACP --check validates the installed local setup without submitting a
    // model turn. Never surface stdout/stderr because it may contain secrets.
    await execFileAsync(resolvedCommand, ["acp", "--check"], {
      cwd,
      env,
      timeout: 10_000,
      maxBuffer: 32 * 1024,
      windowsHide: true,
    });
  } catch {
    return {
      agentRuntimeType: "hermes_gateway",
      status: "unavailable",
      command,
      resolvedCommand,
      message: "Hermes is installed, but its local ACP setup check did not pass.",
      hint: "Run `hermes acp --check` and complete Hermes setup, or choose a custom Hermes API Server connection.",
      checkedAt,
    };
  }

  const capabilityGap = await hermesProductRpcGap(env, cwd);
  return {
    agentRuntimeType: "hermes_gateway",
    status: "available",
    command,
    resolvedCommand,
    hermesLocalBackend: capabilityGap ? "acp" : "native_product_rpc",
    ...(capabilityGap ? { hermesProductRpcCapabilityGap: capabilityGap } : {}),
    message: capabilityGap
      ? "Hermes is installed and its local ACP setup check passed; Rudder will use ACP because native Product RPC is unavailable."
      : "Hermes is installed and its local ACP setup check passed; native Product RPC prerequisites are present.",
    ...(capabilityGap ? { hint: "Native Product RPC capability gap detected; Rudder explicitly selects local ACP for this agent." } : {}),
    checkedAt,
  };
}

export async function listAgentRuntimeAvailability(
  input: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): Promise<AgentRuntimeAvailability[]> {
  const cwd = input.cwd ?? process.cwd();
  const env = ensurePathInEnv(input.env ?? process.env);
  const checkedAt = (input.now ?? new Date()).toISOString();

  const results = await Promise.all(
    AGENT_RUNTIME_TYPES
      .filter((agentRuntimeType) => !HIDDEN_RUNTIME_TYPES.has(agentRuntimeType))
      .map(async (agentRuntimeType): Promise<AgentRuntimeAvailability> => {
        if (agentRuntimeType === "hermes_gateway") {
          return hermesAvailability(cwd, env, checkedAt);
        }
        const command = LOCAL_RUNTIME_COMMANDS[agentRuntimeType] ?? null;
        if (!command) {
          return {
            agentRuntimeType,
            status: "unknown",
            command: null,
            resolvedCommand: null,
            message: "This runtime does not use a local CLI command probe.",
            hint: "Configure and test this runtime from its own settings.",
            checkedAt,
          };
        }

        const resolvedCommand = await resolveCommandPath(command, cwd, env);
        if (resolvedCommand) {
          return {
            agentRuntimeType,
            status: "available",
            command,
            resolvedCommand,
            message: `${localRuntimeLabel(agentRuntimeType)} default command is available.`,
            checkedAt,
          };
        }

        return {
          agentRuntimeType,
          status: "unavailable",
          command,
          resolvedCommand: null,
          message: `${localRuntimeLabel(agentRuntimeType)} default command was not found on PATH.`,
          hint: `Install the ${command} CLI, or set a custom command path in Advanced options and run Test runtime chain.`,
          checkedAt,
        };
      }),
  );

  return results;
}
