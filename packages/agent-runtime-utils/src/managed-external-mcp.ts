const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const RESERVED_SERVER_NAMES = new Set(["rudder-tools", "rudder-browser"]);
const MAX_BINDINGS = 100;
const MAX_TOOLS = 500;

export interface ManagedExternalMcpBinding {
  bindingId: string;
  serverName: string;
  toolPolicy: {
    mode: "allowlist";
    allowedToolNames: string[];
  };
  required: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export interface ResolvedManagedExternalMcpBinding extends ManagedExternalMcpBinding {
  proxyUrl: string;
  bearerTokenEnvVar: "RUDDER_API_KEY";
}

export class ManagedExternalMcpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedExternalMcpConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ManagedExternalMcpConfigurationError(
      `${label} contains unsupported fields: ${unexpected.join(", ")}`,
    );
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ManagedExternalMcpConfigurationError(`${label} must be a positive integer`);
  }
  return value;
}

function parseBinding(value: unknown, index: number): ManagedExternalMcpBinding {
  const label = `managedExternalMcpBindings[${index}]`;
  if (!isRecord(value)) {
    throw new ManagedExternalMcpConfigurationError(`${label} must be an object`);
  }
  assertExactKeys(
    value,
    [
      "bindingId",
      "serverName",
      "toolPolicy",
      "required",
      "startupTimeoutMs",
      "toolTimeoutMs",
    ],
    label,
  );

  const bindingId = value.bindingId;
  if (typeof bindingId !== "string" || !UUID_RE.test(bindingId)) {
    throw new ManagedExternalMcpConfigurationError(`${label}.bindingId must be a UUID`);
  }

  const serverName = value.serverName;
  if (
    typeof serverName !== "string"
    || serverName.length > 80
    || !SERVER_NAME_RE.test(serverName)
    || RESERVED_SERVER_NAMES.has(serverName)
  ) {
    throw new ManagedExternalMcpConfigurationError(`${label}.serverName is invalid or reserved`);
  }

  if (!isRecord(value.toolPolicy)) {
    throw new ManagedExternalMcpConfigurationError(`${label}.toolPolicy must be an object`);
  }
  assertExactKeys(value.toolPolicy, ["mode", "allowedToolNames"], `${label}.toolPolicy`);
  if (value.toolPolicy.mode !== "allowlist" || !Array.isArray(value.toolPolicy.allowedToolNames)) {
    throw new ManagedExternalMcpConfigurationError(`${label}.toolPolicy must be an allowlist`);
  }
  if (value.toolPolicy.allowedToolNames.length > MAX_TOOLS) {
    throw new ManagedExternalMcpConfigurationError(`${label}.toolPolicy has too many tools`);
  }
  const allowedToolNames = value.toolPolicy.allowedToolNames.map((toolName, toolIndex) => {
    const expectedPrefix = `external.${serverName}.`;
    if (
      typeof toolName !== "string"
      || toolName.length === 0
      || toolName.length > 320
      || toolName.trim() !== toolName
      || !toolName.startsWith(expectedPrefix)
    ) {
      throw new ManagedExternalMcpConfigurationError(
        `${label}.toolPolicy.allowedToolNames[${toolIndex}] is invalid`,
      );
    }
    return toolName;
  });
  if (new Set(allowedToolNames).size !== allowedToolNames.length) {
    throw new ManagedExternalMcpConfigurationError(`${label}.toolPolicy contains duplicate tools`);
  }

  if (typeof value.required !== "boolean") {
    throw new ManagedExternalMcpConfigurationError(`${label}.required must be a boolean`);
  }

  return {
    bindingId,
    serverName,
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames,
    },
    required: value.required,
    startupTimeoutMs: positiveInteger(value.startupTimeoutMs, `${label}.startupTimeoutMs`),
    toolTimeoutMs: positiveInteger(value.toolTimeoutMs, `${label}.toolTimeoutMs`),
  };
}

export function parseManagedExternalMcpBindings(
  runtimeConfig: unknown,
): ManagedExternalMcpBinding[] {
  if (!isRecord(runtimeConfig) || runtimeConfig.managedExternalMcpBindings === undefined) {
    return [];
  }
  if (!Array.isArray(runtimeConfig.managedExternalMcpBindings)) {
    throw new ManagedExternalMcpConfigurationError(
      "managedExternalMcpBindings must be an array",
    );
  }
  if (runtimeConfig.managedExternalMcpBindings.length > MAX_BINDINGS) {
    throw new ManagedExternalMcpConfigurationError("managedExternalMcpBindings has too many entries");
  }

  const bindings = runtimeConfig.managedExternalMcpBindings.map(parseBinding);
  const bindingIds = new Set<string>();
  const serverNames = new Set<string>();
  for (const binding of bindings) {
    if (bindingIds.has(binding.bindingId)) {
      throw new ManagedExternalMcpConfigurationError(
        `Duplicate managed MCP binding ID: ${binding.bindingId}`,
      );
    }
    if (serverNames.has(binding.serverName)) {
      throw new ManagedExternalMcpConfigurationError(
        `Duplicate managed MCP server name: ${binding.serverName}`,
      );
    }
    bindingIds.add(binding.bindingId);
    serverNames.add(binding.serverName);
  }
  return bindings;
}

function resolveProxyBaseUrl(env: NodeJS.ProcessEnv | Record<string, string | undefined>): URL | null {
  const value = env.RUDDER_API_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function resolveManagedExternalMcpBindings(
  runtimeConfig: unknown,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ResolvedManagedExternalMcpBinding[] {
  const bindings = parseManagedExternalMcpBindings(runtimeConfig);
  if (bindings.length === 0) return [];

  const apiBaseUrl = resolveProxyBaseUrl(env);
  const hasRunToken = typeof env.RUDDER_API_KEY === "string"
    && env.RUDDER_API_KEY.trim().length > 0;
  if (!apiBaseUrl || !hasRunToken) {
    const required = bindings.find((binding) => binding.required);
    if (required) {
      throw new ManagedExternalMcpConfigurationError(
        `Required managed MCP binding "${required.serverName}" cannot be configured because run authentication is unavailable`,
      );
    }
    return [];
  }

  return bindings.map((binding) => ({
    ...binding,
    proxyUrl: new URL(
      `/api/mcp/runtime/bindings/${encodeURIComponent(binding.bindingId)}`,
      apiBaseUrl,
    ).toString(),
    bearerTokenEnvVar: "RUDDER_API_KEY",
  }));
}
