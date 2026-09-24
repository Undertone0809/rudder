import path from "node:path";

export type RuntimeProviderProfileSnapshot = {
  runtimeType: string;
  cwd?: string;
  providerVersion?: string;
  command?: string;
  codexHome?: string;
  nativeCapabilityMethods?: {
    threadResume: boolean;
    threadRead: boolean;
    threadFork: boolean;
  };
  claudeConfigDir?: string;
  hermesAcpCommand?: string;
  hermesAcpArgs?: string[];
  hermesAcpProtocolVersion?: number;
  hermesPythonCommand?: string;
  hermesSourcePath?: string;
  hermesHome?: string;
  serverCommand?: string;
  exportCommand?: string;
  exportEnv?: Record<string, string>;
  sessionDir?: string;
  rpcEnv?: Record<string, string>;
  cursorAcpCommand?: string;
  cursorAcpProtocolVersion?: number;
  cursorAcpAuthMethodId?: string;
  protocolVersion?: number;
  authMethodId?: string;
};

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = nonEmpty(value);
    if (result) return result;
  }
  return null;
}

function absolutePath(value: unknown): string | null {
  const result = nonEmpty(value);
  return result && path.isAbsolute(result) ? result : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function safeStringMap(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, entry]) => allowedKeys.has(key) && typeof entry === "string" && entry.trim().length > 0,
    ),
  ) as Record<string, string>;
}

function providerVersion(config: Record<string, unknown>, runtimeType: string): string | null {
  const runtimeVersionKey = {
    claude_local: "claudeProviderVersion",
    hermes_gateway: "hermesProviderVersion",
    pi_local: "piProviderVersion",
    cursor: "cursorProviderVersion",
  }[runtimeType];
  return firstString(config.providerVersion, runtimeVersionKey ? config[runtimeVersionKey] : null);
}

function addString(snapshot: Record<string, unknown>, key: string, value: unknown) {
  const result = nonEmpty(value);
  if (result) snapshot[key] = result;
}

function addAbsolutePath(snapshot: Record<string, unknown>, key: string, value: unknown) {
  const result = absolutePath(value);
  if (result) snapshot[key] = result;
}

function addStringArray(snapshot: Record<string, unknown>, key: string, value: unknown) {
  const result = stringArray(value);
  if (result) snapshot[key] = result;
}

function addPositiveNumber(snapshot: Record<string, unknown>, key: string, value: unknown) {
  const result = positiveNumber(value);
  if (result !== null) snapshot[key] = result;
}

/**
 * Build the static host-prepared profile persisted in a Run context.
 *
 * Dynamic OpenCode serverUrl and Pi rpcArgs are intentionally excluded. They
 * are only authoritative after the runtime adapter reports them through the
 * locked native transport callback.
 */
export function buildRuntimeProviderProfileSnapshot(
  runtimeType: string,
  config: Record<string, unknown>,
): RuntimeProviderProfileSnapshot {
  const snapshot: Record<string, unknown> = { runtimeType };
  addAbsolutePath(snapshot, "cwd", config.cwd);
  addString(snapshot, "providerVersion", providerVersion(config, runtimeType));

  if (runtimeType === "codex_local") {
    addAbsolutePath(snapshot, "codexHome", config.codexHome);
    const methods = asRecord(config.nativeCapabilityMethods);
    if (methods) {
      snapshot.nativeCapabilityMethods = {
        threadResume: methods.threadResume === true,
        threadRead: methods.threadRead === true,
        threadFork: methods.threadFork === true,
      };
    }
  }

  if (runtimeType === "claude_local") {
    addString(snapshot, "command", config.command);
    addAbsolutePath(snapshot, "claudeConfigDir", config.claudeConfigDir);
  }

  if (runtimeType === "hermes_gateway") {
    addString(snapshot, "hermesAcpCommand", config.hermesAcpCommand ?? config.acpCommand ?? config.command);
    addStringArray(snapshot, "hermesAcpArgs", config.hermesAcpArgs ?? config.acpArgs ?? config.args);
    addPositiveNumber(
      snapshot,
      "hermesAcpProtocolVersion",
      config.hermesAcpProtocolVersion ?? config.acpProtocolVersion ?? config.protocolVersion,
    );
    addAbsolutePath(snapshot, "hermesPythonCommand", config.hermesPythonCommand ?? config.hermesHistoryPythonCommand);
    addAbsolutePath(snapshot, "hermesSourcePath", config.hermesSourcePath ?? config.hermesHistorySourcePath);
    addAbsolutePath(snapshot, "hermesHome", config.hermesHome);
  }

  if (runtimeType === "opencode_local") {
    addString(snapshot, "command", config.command);
    addString(snapshot, "serverCommand", config.serverCommand ?? config.command);
    addString(snapshot, "exportCommand", config.exportCommand ?? config.command);
    const exportEnv = safeStringMap(config.exportEnv ?? config.opencodeExportEnv, SAFE_OPENCODE_EXPORT_ENV_KEYS);
    if (exportEnv) snapshot.exportEnv = exportEnv;
  }

  if (runtimeType === "pi_local") {
    addString(snapshot, "command", config.command);
    addAbsolutePath(snapshot, "sessionDir", config.sessionDir);
    const rpcEnv = safeStringMap(config.rpcEnv ?? config.piRpcEnv, SAFE_PI_RPC_ENV_KEYS);
    if (rpcEnv) snapshot.rpcEnv = rpcEnv;
  }

  if (runtimeType === "cursor") {
    addString(snapshot, "command", config.command);
    addString(snapshot, "cursorAcpCommand", config.cursorAcpCommand ?? config.command);
    addPositiveNumber(
      snapshot,
      "cursorAcpProtocolVersion",
      config.cursorAcpProtocolVersion ?? config.protocolVersion,
    );
    addString(snapshot, "cursorAcpAuthMethodId", config.cursorAcpAuthMethodId ?? config.authMethodId);
    addPositiveNumber(snapshot, "protocolVersion", config.protocolVersion ?? config.cursorAcpProtocolVersion);
    addString(snapshot, "authMethodId", config.authMethodId ?? config.cursorAcpAuthMethodId);
  }

  return snapshot as RuntimeProviderProfileSnapshot;
}

/** Re-apply the static allowlist when reading a Run context snapshot. */
export function sanitizeRuntimeProviderProfileSnapshot(
  value: unknown,
): RuntimeProviderProfileSnapshot | null {
  const record = asRecord(value);
  const runtimeType = nonEmpty(record?.runtimeType);
  return runtimeType && record
    ? buildRuntimeProviderProfileSnapshot(runtimeType, record)
    : null;
}

/** Convert a safe static snapshot to the bounded runtime config used by readers. */
export function runtimeConfigFromProviderProfileSnapshot(
  value: unknown,
): Record<string, unknown> {
  const snapshot = sanitizeRuntimeProviderProfileSnapshot(value);
  if (!snapshot) return {};
  const { runtimeType: _runtimeType, ...runtimeConfig } = snapshot;
  return runtimeConfig;
}
