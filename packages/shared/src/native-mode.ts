export const RUDDER_NATIVE_MODES = ["auto", "node", "required"] as const;

export type RudderNativeMode = (typeof RUDDER_NATIVE_MODES)[number];

export const RUDDER_NATIVE_CAPABILITIES = [
  "local-app-process",
  "agent-run-process",
  "workspace-backup",
  "runtime-payload",
  "run-evidence",
  "workspace-manifest",
] as const;

export type RudderNativeCapability = (typeof RUDDER_NATIVE_CAPABILITIES)[number];
export type RudderNativeEngine = "rust" | "node";

type NativeEnvironment = Readonly<Record<string, string | undefined>>;

export interface RudderNativeCapabilityPolicy {
  capability: RudderNativeCapability;
  mode: RudderNativeMode;
  enabled: boolean;
  required: boolean;
  fallbackAllowed: boolean;
  disableEnv: string;
  disabledBy: string | null;
}

export interface ResolveRudderNativeCapabilityOptions {
  capability: RudderNativeCapability;
  env?: NativeEnvironment;
  legacyToggleEnvs?: readonly string[];
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function normalizedEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function isTrue(value: string | undefined): boolean {
  const normalized = normalizedEnvValue(value);
  return normalized !== undefined && TRUE_VALUES.has(normalized);
}

function isFalse(value: string | undefined): boolean {
  const normalized = normalizedEnvValue(value);
  return normalized !== undefined && FALSE_VALUES.has(normalized);
}

export function parseRudderNativeMode(value: string | undefined): RudderNativeMode {
  const normalized = normalizedEnvValue(value) ?? "auto";
  if ((RUDDER_NATIVE_MODES as readonly string[]).includes(normalized)) {
    return normalized as RudderNativeMode;
  }
  throw new Error(`Invalid RUDDER_NATIVE_MODE: ${value}. Expected auto, node, or required.`);
}

export function rudderNativeCapabilityDisableEnv(capability: RudderNativeCapability): string {
  return `RUDDER_NATIVE_${capability.replaceAll("-", "_").toUpperCase()}_DISABLED`;
}

export function resolveRudderNativeCapability(
  options: ResolveRudderNativeCapabilityOptions,
): RudderNativeCapabilityPolicy {
  const env = options.env ?? {};
  const mode = parseRudderNativeMode(env.RUDDER_NATIVE_MODE);
  const disableEnv = rudderNativeCapabilityDisableEnv(options.capability);

  let disabledBy: string | null = isTrue(env[disableEnv]) ? disableEnv : null;
  if (!disabledBy) {
    disabledBy = options.legacyToggleEnvs?.find((name) => isFalse(env[name])) ?? null;
  }

  const enabled = mode !== "node" && disabledBy === null;
  return {
    capability: options.capability,
    mode,
    enabled,
    required: enabled && mode === "required",
    fallbackAllowed: enabled && mode === "auto",
    disableEnv,
    disabledBy: mode === "node" ? "RUDDER_NATIVE_MODE" : disabledBy,
  };
}

export interface RudderNativeDiagnostic {
  capability: RudderNativeCapability;
  target: string;
  binaryVersion: string;
  protocolVersion: string;
  effectiveEngine: RudderNativeEngine;
  fallbackCode: string | null;
}

export function resolveRudderNativeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32") {
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "x64") return "x86_64-pc-windows-msvc";
  }
  return null;
}

export function createRudderNativeDiagnostic(input: {
  capability: RudderNativeCapability;
  effectiveEngine: RudderNativeEngine;
  fallbackCode: string | null;
  target?: string | null;
  binaryVersion?: string | null;
  protocolVersion?: string | number | null;
}): RudderNativeDiagnostic {
  return {
    capability: input.capability,
    target: input.target || resolveRudderNativeTarget() || "unsupported",
    binaryVersion: input.binaryVersion || "unavailable",
    protocolVersion: input.protocolVersion === null || input.protocolVersion === undefined
      ? "unavailable"
      : String(input.protocolVersion),
    effectiveEngine: input.effectiveEngine,
    fallbackCode: input.fallbackCode,
  };
}
