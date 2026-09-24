import { resolveOrganizationStorageKey } from "@rudderhq/agent-runtime-utils";
import {
  ensureAbsoluteDirectory,
  resolveLocalOperatorHome,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)\b/u;
const TARGET_RUNTIME_TYPES = new Set([
  "claude_local",
  "hermes_gateway",
  "opencode_local",
  "pi_local",
  "cursor",
]);

const SAFE_OPENCODE_EXPORT_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "RUDDER_OPERATOR_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

const SAFE_PI_RPC_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
]);

type RuntimeProfilePreparationInput = {
  runtimeType: string;
  orgId: string;
  agentId: string;
  config: Record<string, unknown>;
  workspace?: Record<string, unknown> | null;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = nonEmpty(value);
    if (result) return result;
  }
  return null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function readPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function absolutePath(value: unknown): string | null {
  const result = nonEmpty(value);
  return result && path.isAbsolute(result) ? path.resolve(result) : null;
}

async function existingPath(value: string | null, kind: "file" | "directory"): Promise<string | null> {
  if (!value) return null;
  try {
    const info = await stat(value);
    return (kind === "file" ? info.isFile() : info.isDirectory()) ? value : null;
  } catch {
    return null;
  }
}

async function resolveHermesHistoryProfile(
  config: Record<string, unknown>,
  configuredEnv: Record<string, string>,
  hermesHome: string | null,
): Promise<{ pythonCommand: string | null; sourcePath: string | null }> {
  const configuredPython = absolutePath(
    firstString(config.hermesPythonCommand, config.hermesHistoryPythonCommand, configuredEnv.HERMES_PYTHON),
  );
  const configuredSource = absolutePath(
    firstString(config.hermesSourcePath, config.hermesHistorySourcePath, configuredEnv.HERMES_SOURCE),
  );
  const candidatePython = configuredPython ?? (hermesHome
    ? absolutePath(path.join(hermesHome, "hermes-agent", "venv", "bin", "python3"))
    : null);
  const candidateSource = configuredSource ?? (hermesHome
    ? absolutePath(path.join(hermesHome, "hermes-agent"))
    : null);
  const [pythonCommand, sourcePath] = await Promise.all([
    existingPath(candidatePython, "file"),
    existingPath(candidateSource, "directory"),
  ]);
  if (!pythonCommand || !sourcePath) return { pythonCommand: null, sourcePath: null };
  const stateModule = await existingPath(path.join(sourcePath, "hermes_state.py"), "file");
  return stateModule ? { pythonCommand, sourcePath } : { pythonCommand: null, sourcePath: null };
}

function resolveEffectiveCwd(config: Record<string, unknown>, workspace?: Record<string, unknown> | null): string {
  const configuredCwd = nonEmpty(config.cwd);
  const workspaceSource = nonEmpty(workspace?.source);
  const workspaceCwd = firstString(
    workspace?.executionWorkspaceCwd,
    workspace?.cwd,
    workspace?.worktreePath,
  );
  return workspaceSource === "agent_home" && configuredCwd
    ? configuredCwd
    : workspaceCwd ?? configuredCwd ?? process.cwd();
}

function resolveManagedHome(
  env: Record<string, string>,
  orgId: string,
  suffix: "claude-home" | "opencode-home" | "pi-home",
): string {
  const rudderHome = path.resolve(
    firstString(env.RUDDER_HOME, process.env.RUDDER_HOME) ?? path.join(os.homedir(), ".rudder"),
  );
  const instanceId = firstString(env.RUDDER_INSTANCE_ID, process.env.RUDDER_INSTANCE_ID) ?? "default";
  return path.resolve(
    rudderHome,
    "instances",
    instanceId,
    "organizations",
    resolveOrganizationStorageKey(orgId),
    suffix,
  );
}

function operatorEnvironment(configuredEnv: Record<string, string>): {
  operatorHome: string;
  userProfile: string;
  probeEnv: Record<string, string>;
} {
  const operatorHome = resolveLocalOperatorHome(process.env);
  const userProfile = firstString(process.env.USERPROFILE) ?? operatorHome;
  return {
    operatorHome,
    userProfile,
    // Execute protects the operator home from runtime config overrides. The
    // same boundary applies to version discovery; provider auth is not read
    // from a persisted session or copied into the returned profile.
    probeEnv: {
      ...Object.fromEntries(
        Object.entries({ ...process.env, ...configuredEnv }).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      HOME: operatorHome,
      USERPROFILE: userProfile,
      RUDDER_OPERATOR_HOME: operatorHome,
    },
  };
}

function managedEnv(
  configuredEnv: Record<string, string>,
  operatorHome: string,
  userProfile: string,
  values: Record<string, string>,
): Record<string, string> {
  return {
    ...configuredEnv,
    HOME: operatorHome,
    USERPROFILE: userProfile,
    RUDDER_OPERATOR_HOME: operatorHome,
    ...values,
  };
}

function safeRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(stringRecord(value)).filter(([key]) => allowed.has(key)),
  );
}

function localLoopbackUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol))) return null;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function versionFromOutput(stdout: string): string | null {
  return stdout.match(VERSION_PATTERN)?.[1] ?? null;
}

async function discoverProviderVersion(input: {
  runtimeType: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<string> {
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(input.command, ["--version"], {
      cwd: input.cwd,
      env: input.env,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    throw new Error(
      `${input.runtimeType} provider version discovery failed for ${input.command}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Pi's installed CLI writes --version to stderr when stdout is a pipe.
  const version = versionFromOutput(stdout) ?? versionFromOutput(stderr);
  if (!version) {
    throw new Error(`${input.runtimeType} provider version discovery returned no parseable version for ${input.command}`);
  }
  return version;
}

function withProviderVersion(
  config: Record<string, unknown>,
  providerVersion: string,
  providerKey?: string,
): Record<string, unknown> {
  return {
    ...config,
    providerVersion,
    ...(providerKey ? { [providerKey]: providerVersion } : {}),
  };
}

/**
 * Prepare the host-owned defaults needed before native capability admission.
 *
 * This helper deliberately discovers installation identity only. It does not
 * start a model session, read a persisted session, or invent dynamic transport
 * selectors such as Pi's per-run RPC argv or OpenCode's managed server URL.
 */
export async function prepareOtherRuntimeProviderProfile(
  input: RuntimeProfilePreparationInput,
): Promise<Record<string, unknown>> {
  if (!TARGET_RUNTIME_TYPES.has(input.runtimeType)) return input.config;

  const config = { ...input.config };
  const configuredEnv = stringRecord(config.env);
  const cwd = resolveEffectiveCwd(config, input.workspace);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const { operatorHome, userProfile, probeEnv } = operatorEnvironment(configuredEnv);

  if (input.runtimeType === "claude_local") {
    const command = firstString(config.command) ?? "claude";
    const home = resolveManagedHome(probeEnv, input.orgId, "claude-home");
    const configDir = path.join(home, ".claude");
    const providerVersion = await discoverProviderVersion({ runtimeType: input.runtimeType, command, cwd, env: probeEnv });
    return {
      ...withProviderVersion(config, providerVersion, "claudeProviderVersion"),
      command,
      cwd,
      claudeConfigDir: configDir,
      env: managedEnv(configuredEnv, operatorHome, userProfile, {
        CLAUDE_CONFIG_DIR: configDir,
        RUDDER_CLAUDE_HOME: home,
      }),
    };
  }

  if (input.runtimeType === "hermes_gateway") {
    const command = firstString(config.hermesAcpCommand, config.acpCommand, config.command) ?? "hermes";
    const args = readStringArray(config.hermesAcpArgs ?? config.acpArgs ?? config.args) ?? ["acp"];
    const providerVersion = await discoverProviderVersion({ runtimeType: input.runtimeType, command, cwd, env: probeEnv });
    const protocolVersion = readPositiveNumber(
      config.hermesAcpProtocolVersion,
      config.acpProtocolVersion,
      config.protocolVersion,
    ) ?? 1;
    const hermesHome = absolutePath(firstString(config.hermesHome, configuredEnv.HERMES_HOME));
    const historyProfile = await resolveHermesHistoryProfile(config, configuredEnv, hermesHome);
    return {
      ...withProviderVersion(config, providerVersion, "hermesProviderVersion"),
      hermesAcpCommand: command,
      hermesAcpArgs: args,
      cwd,
      hermesAcpProtocolVersion: protocolVersion,
      ...(historyProfile.pythonCommand ? { hermesPythonCommand: historyProfile.pythonCommand } : {}),
      ...(historyProfile.sourcePath ? { hermesSourcePath: historyProfile.sourcePath } : {}),
      ...(hermesHome ? { hermesHome, env: { ...configuredEnv, HERMES_HOME: hermesHome } } : { env: configuredEnv }),
    };
  }

  if (input.runtimeType === "opencode_local") {
    const command = firstString(config.serverCommand, config.exportCommand, config.command) ?? "opencode";
    const home = resolveManagedHome(probeEnv, input.orgId, "opencode-home");
    const exportEnv: Record<string, string> = {
      ...safeRecord(config.exportEnv ?? config.opencodeExportEnv, SAFE_OPENCODE_EXPORT_ENV_KEYS),
      HOME: operatorHome,
      USERPROFILE: userProfile,
      RUDDER_OPERATOR_HOME: operatorHome,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
    };
    delete exportEnv.OPENCODE_CONFIG;
    const configuredServerUrl = firstString(config.serverUrl, config.opencodeServerUrl);
    const serverUrl = configuredServerUrl ? localLoopbackUrl(configuredServerUrl) : null;
    if (configuredServerUrl && !serverUrl) {
      throw new Error("opencode_local native profile requires a loopback managed server URL");
    }
    const providerVersion = await discoverProviderVersion({ runtimeType: input.runtimeType, command, cwd, env: probeEnv });
    return {
      ...withProviderVersion(config, providerVersion),
      command,
      serverCommand: command,
      exportCommand: command,
      cwd,
      exportEnv,
      ...(serverUrl ? { serverUrl } : {}),
      env: managedEnv(configuredEnv, operatorHome, userProfile, {
        XDG_CONFIG_HOME: exportEnv.XDG_CONFIG_HOME,
        XDG_DATA_HOME: exportEnv.XDG_DATA_HOME,
        XDG_CACHE_HOME: exportEnv.XDG_CACHE_HOME,
      }),
    };
  }

  if (input.runtimeType === "pi_local") {
    const command = firstString(config.command) ?? "pi";
    const home = resolveManagedHome(probeEnv, input.orgId, "pi-home");
    const sessionDir = path.join(home, ".pi", "paperclips");
    const rpcEnv = {
      ...safeRecord(config.rpcEnv ?? config.piRpcEnv, SAFE_PI_RPC_ENV_KEYS),
      HOME: operatorHome,
      USERPROFILE: userProfile,
      PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
    };
    const providerVersion = await discoverProviderVersion({ runtimeType: input.runtimeType, command, cwd, env: probeEnv });
    const rpcArgs = readStringArray(config.rpcArgs);
    return {
      ...withProviderVersion(config, providerVersion, "piProviderVersion"),
      command,
      cwd,
      sessionDir,
      rpcEnv,
      ...(rpcArgs ? { rpcArgs } : {}),
      env: managedEnv(configuredEnv, operatorHome, userProfile, {
        PI_CODING_AGENT_DIR: rpcEnv.PI_CODING_AGENT_DIR,
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
      }),
    };
  }

  const command = firstString(config.cursorAcpCommand, config.acpCommand, config.command) ?? "agent";
  const providerVersion = await discoverProviderVersion({ runtimeType: input.runtimeType, command, cwd, env: probeEnv });
  const protocolVersion = readPositiveNumber(config.cursorAcpProtocolVersion, config.protocolVersion) ?? 1;
  const authMethodId = firstString(config.cursorAcpAuthMethodId, config.authMethodId) ?? "cursor_login";
  return {
    ...withProviderVersion(config, providerVersion, "cursorProviderVersion"),
    command,
    cursorAcpCommand: command,
    cwd,
    cursorAcpProtocolVersion: protocolVersion,
    protocolVersion,
    cursorAcpAuthMethodId: authMethodId,
    authMethodId,
    env: managedEnv(configuredEnv, operatorHome, userProfile, {}),
  };
}

export { versionFromOutput };
