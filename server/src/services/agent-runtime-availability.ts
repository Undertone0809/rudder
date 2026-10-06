import { ensurePathInEnv, prependPathEntry, resolveCommandPath } from "@rudderhq/agent-runtime-utils/server-utils";
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

async function hermesConfigValue(
  resolvedCommand: string,
  key: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(resolvedCommand, ["config", "get", key, "--json"], {
      cwd,
      env: prependPathEntry(env, path.dirname(resolvedCommand)),
      timeout: 5_000,
      maxBuffer: 8 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout.trim()) as unknown;
  } catch {
    // Hermes' config command may fail for unset or malformed values. Keep its
    // output private: it can contain user configuration and provider secrets.
    return undefined;
  }
}

function configuredHermesModel(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return [model.default, model.model, model.name].some(
    (entry) => typeof entry === "string" && Boolean(entry.trim()),
  );
}

async function hermesLocalProviderConfigured(
  resolvedCommand: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const configuredProvider = await hermesConfigValue(resolvedCommand, "model.provider", cwd, env);
  const provider = typeof configuredProvider === "string"
    ? configuredProvider.trim().toLowerCase()
    : "";
  const selectedProvider = provider || env.HERMES_INFERENCE_PROVIDER?.trim().toLowerCase() || "";
  // Hermes uses `auto` as a supported provider-resolution mode. It is a valid
  // local setup when the user has selected a concrete model; requiring a
  // provider name here would incorrectly mark that profile unavailable.
  if (!selectedProvider) return false;

  const model = await hermesConfigValue(resolvedCommand, "model.default", cwd, env)
    ?? await hermesConfigValue(resolvedCommand, "model.model", cwd, env);
  return configuredHermesModel(model);
}

async function hermesProductRpcGap(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homeDir: string,
): Promise<AgentRuntimeAvailability["hermesProductRpcCapabilityGap"]> {
  const configuredHome = env.HERMES_HOME?.trim();
  const hermesHome = configuredHome && path.isAbsolute(configuredHome)
    ? path.resolve(configuredHome)
    : path.join(homeDir, ".hermes");
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
  homeDir: string,
  checkedAt: string,
): Promise<AgentRuntimeAvailability> {
  const command = LOCAL_RUNTIME_COMMANDS.hermes_gateway;
  const commandCandidates = [
    env.HERMES_BIN?.trim(),
    command,
    path.join(homeDir, ".local", "bin", process.platform === "win32" ? "hermes.exe" : "hermes"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  let resolvedCommand: string | null = null;
  for (const candidate of commandCandidates) {
    resolvedCommand = await resolveCommandPath(candidate, cwd, env);
    if (resolvedCommand) break;
  }
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
      env: prependPathEntry(env, path.dirname(resolvedCommand)),
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

  if (!await hermesLocalProviderConfigured(resolvedCommand, cwd, env)) {
    return {
      agentRuntimeType: "hermes_gateway",
      status: "unavailable",
      command,
      resolvedCommand,
      message: "Hermes is installed, but its local provider and model setup is incomplete.",
      hint: "Finish provider and model setup in Hermes Agent, then retry local readiness.",
      checkedAt,
    };
  }

  const capabilityGap = await hermesProductRpcGap(env, cwd, homeDir);
  return {
    agentRuntimeType: "hermes_gateway",
    status: "available",
    command,
    resolvedCommand,
    hermesLocalBackend: capabilityGap ? "acp" : "native_product_rpc",
    ...(capabilityGap ? { hermesProductRpcCapabilityGap: capabilityGap } : {}),
    message: capabilityGap
      ? "Hermes ACP and local provider/model setup are ready; Rudder will use ACP because native Product RPC is unavailable."
      : "Hermes ACP and local provider/model setup are ready; native Product RPC prerequisites are present.",
    ...(capabilityGap ? { hint: "Native Product RPC capability gap detected; Rudder explicitly selects local ACP for this agent." } : {}),
    checkedAt,
  };
}

export async function listAgentRuntimeAvailability(
  input: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    now?: Date;
  } = {},
): Promise<AgentRuntimeAvailability[]> {
  const cwd = input.cwd ?? process.cwd();
  const homeDir = input.homeDir ?? os.homedir();
  const env = ensurePathInEnv(input.env ?? process.env);
  const checkedAt = (input.now ?? new Date()).toISOString();

  const results = await Promise.all(
    AGENT_RUNTIME_TYPES
      .filter((agentRuntimeType) => !HIDDEN_RUNTIME_TYPES.has(agentRuntimeType))
      .map(async (agentRuntimeType): Promise<AgentRuntimeAvailability> => {
        if (agentRuntimeType === "hermes_gateway") {
          return hermesAvailability(cwd, env, homeDir, checkedAt);
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
