import {
  createClaudeLocalProviderCapabilityResolver,
  type ClaudeLocalProfileTransport,
  type ClaudeLocalProfileTransportResolver,
} from "@rudderhq/agent-runtime-claude-local/server";
import {
  buildCodexProfileEnvironment,
  createCodexLocalProviderCapabilityResolver,
  type CodexAppServerProfileTransport,
  type CodexAppServerProfileTransportResolver,
} from "@rudderhq/agent-runtime-codex-local/server";
import {
  createCursorLocalProviderCapabilityResolver,
  type CursorLocalProfileTransport,
  type CursorLocalProfileTransportResolver,
} from "@rudderhq/agent-runtime-cursor-local/server";
import {
  createHermesAcpProviderCapabilityResolver,
  createHermesGatewayProviderCapabilityResolver,
  type HermesAcpProfileTransport,
  type HermesGatewayProfileTransport,
  type HermesGatewayProfileTransportResolver,
} from "@rudderhq/agent-runtime-hermes-gateway/server";
import {
  createOpenCodeLocalProviderCapabilityResolver,
  type OpenCodeLocalProfileTransport,
  type OpenCodeLocalProfileTransportResolver,
} from "@rudderhq/agent-runtime-opencode-local/server";
import {
  createPiLocalProviderCapabilityResolver,
  type PiLocalProfileTransport,
  type PiLocalProfileTransportResolver,
} from "@rudderhq/agent-runtime-pi-local/server";
import path from "node:path";
import {
  createProfileBoundRuntimeProviderCapabilityResolver as createProfileBoundRuntimeProviderCapabilityResolverFromMap,
  type RuntimeProviderAdapterResolver,
  type RuntimeProviderBindingRef,
  type RuntimeProviderCapabilityAdapter,
  type RuntimeProviderCapabilityEvidence,
  type RuntimeProviderCapabilityResolver,
  type RuntimeProviderCapabilityResolverContext,
} from "../services/runtime-kernel/provider-capabilities.js";

export type {
  AgentRuntimeAgent, AgentRuntimeEnvironmentCheck, AgentRuntimeEnvironmentCheckLevel, AgentRuntimeEnvironmentTestContext, AgentRuntimeEnvironmentTestResult, AgentRuntimeEnvironmentTestStatus, AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult, AgentRuntimeInvocationMeta, AgentRuntimeLoadedMcpServerMeta, AgentRuntimeLoadedSkillMeta, AgentRuntimeSessionCodec, AgentRuntimeState, ServerAgentRuntimeModule, UsageSummary
} from "@rudderhq/agent-runtime-utils";
export {
  composeRuntimeProviderCapabilityResolvers, createProfileBoundRuntimeProviderCapabilityResolver, type RuntimeProviderAdapterResolver,
  type RuntimeProviderBindingRef,
  type RuntimeProviderCapabilityAdapter,
  type RuntimeProviderCapabilityResolution,
  type RuntimeProviderCapabilityResolver,
  type RuntimeProviderCapabilityResolverContext
} from "../services/runtime-kernel/provider-capabilities.js";
export {
  discoverAgentRuntimeModels,
  findServerAdapter,
  getServerAdapter,
  listAgentRuntimeModels,
  listServerAdapters
} from "./registry.js";
export { runningProcesses } from "./utils.js";

/** Host-owned profile lookup functions used by tests and external profile stores. */
export interface ProfileBoundRuntimeProviderCapabilityResolverCallbacks {
  codex_local?: CodexAppServerProfileTransportResolver | null;
  claude_local?: ClaudeLocalProfileTransportResolver | null;
  hermes_gateway?: HermesGatewayProfileTransportResolver | null;
  opencode_local?: OpenCodeLocalProfileTransportResolver | null;
  pi_local?: PiLocalProfileTransportResolver | null;
  cursor?: CursorLocalProfileTransportResolver | null;
}

/** Runtime config captured for one authorized agent invocation. */
export interface RuntimeProviderProfileConfig {
  runtimeType: string;
  runtimeConfig: Record<string, unknown>;
  /** The effective workspace cwd chosen by Rudder for this run. */
  cwd?: string | null;
  /** Historical readers must never use persisted session transport as profile evidence. */
  resolutionMode?: "live" | "historical";
}

type ProfileBoundRuntimeProviderCapabilityResolverConfig =
  | ProfileBoundRuntimeProviderCapabilityResolverCallbacks
  | RuntimeProviderProfileConfig;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string")
    ? value.map((entry) => entry.trim()).filter(Boolean)
    : null;
}

function readStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === "string")) return null;
  return Object.fromEntries(entries as Array<[string, string]>);
}

function profileEnvironment(
  config: RuntimeProviderProfileConfig,
  ...keys: readonly string[]
): Record<string, string> | null {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(config.runtimeConfig, key)) {
      return stringRecord(config.runtimeConfig[key]);
    }
  }
  return stringRecord(config.runtimeConfig.env);
}

function sessionEnvironmentMatches(
  context: RuntimeProviderCapabilityResolverContext | undefined,
  key: string,
  expected: Record<string, string>,
): boolean {
  const params = context?.session?.sessionParams;
  const actual = params ? stringRecord(params[key]) : null;
  return actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = readString(value);
    if (result) return result;
  }
  return null;
}

function profileCwd(config: RuntimeProviderProfileConfig): string {
  return firstString(config.cwd, config.runtimeConfig.cwd) ?? "";
}

function providerVersion(config: RuntimeProviderProfileConfig): string | null {
  const runtimeConfig = config.runtimeConfig;
  return firstString(
    runtimeConfig.providerVersion,
    runtimeConfig.codexProviderVersion,
    runtimeConfig.claudeProviderVersion,
    runtimeConfig.hermesProviderVersion,
    runtimeConfig.cursorProviderVersion,
  );
}

function providerBinding(binding: RuntimeProviderBindingRef): RuntimeProviderBindingRef {
  return { ...binding };
}

function unknownNativeEvidence(
  evidence: RuntimeProviderCapabilityEvidence | undefined,
  reason: string,
): RuntimeProviderCapabilityEvidence {
  return {
    ...(evidence ?? {}),
    status: "unknown",
    reason,
    profileBound: false,
    profileRequired: true,
  };
}

/**
 * A live Chat adapter may still submit through the ordinary runtime adapter
 * while a dynamic native transport is unavailable. Do not expose the native
 * transcript/fork/control hooks until the host has independently resolved it.
 */
function withoutUnresolvedNativeTransport(
  adapter: RuntimeProviderCapabilityAdapter,
  reason: string,
): RuntimeProviderCapabilityAdapter {
  const withoutControlExecution = <T extends { evidence: RuntimeProviderCapabilityEvidence; execute?: unknown }>(
    capability: T,
  ) => {
    const { execute: _execute, ...declaration } = capability;
    return {
      ...declaration,
      evidence: unknownNativeEvidence(capability.evidence, reason),
    };
  };

  return {
    ...adapter,
    ...(adapter.transcript
      ? { transcript: { evidence: unknownNativeEvidence(adapter.transcript.evidence, reason) } }
      : {}),
    ...(adapter.fork
      ? { fork: { evidence: unknownNativeEvidence(adapter.fork.evidence, reason) } }
      : {}),
    ...(adapter.control
      ? {
        control: {
          ...adapter.control,
          ...(adapter.control.steer
            ? { steer: withoutControlExecution(adapter.control.steer) }
            : {}),
          ...(adapter.control.interrupt
            ? { interrupt: withoutControlExecution(adapter.control.interrupt) }
            : {}),
        },
      }
      : {}),
  };
}

function profileResolvers(config: RuntimeProviderProfileConfig): Record<string, RuntimeProviderAdapterResolver> {
  const runtimeConfig = config.runtimeConfig;
  const env = readStringMap(runtimeConfig.env);
  const historical = config.resolutionMode === "historical";

  const codex: RuntimeProviderAdapterResolver = (_runtimeType, binding) => {
    if (!binding) return null;
    const codexHome = firstString(
      runtimeConfig.codexHome,
      env.CODEX_HOME,
    );
    const methodsRecord = asRecord(runtimeConfig.nativeCapabilityMethods);
    const methods = Object.keys(methodsRecord).length > 0
      ? {
        threadResume: methodsRecord.threadResume === true,
        threadRead: methodsRecord.threadRead === true,
        threadFork: methodsRecord.threadFork === true,
      }
      : undefined;
    const profile: CodexAppServerProfileTransport = {
      binding: providerBinding(binding),
      command: firstString(runtimeConfig.command) ?? "codex",
      args: readStringArray(runtimeConfig.extraArgs ?? runtimeConfig.args) ?? undefined,
      cwd: profileCwd(config),
      // Match execute's host environment (PATH/HOME/auth helpers) while the
      // explicitly resolved managed home remains the history authority.
      env: buildCodexProfileEnvironment({ configured: env, codexHome: codexHome ? path.resolve(codexHome) : null }),
      providerVersion: providerVersion(config),
      methods,
    };
    return createCodexLocalProviderCapabilityResolver(() => profile)(_runtimeType, binding);
  };

  const claude: RuntimeProviderAdapterResolver = (_runtimeType, binding) => {
    if (!binding) return null;
    const configDir = firstString(runtimeConfig.claudeConfigDir, env.CLAUDE_CONFIG_DIR);
    const profile: ClaudeLocalProfileTransport = {
      binding: providerBinding(binding),
      command: firstString(runtimeConfig.command) ?? "claude",
      cwd: profileCwd(config),
      configDir: configDir ?? "",
      providerVersion: providerVersion(config) ?? "",
    };
    return createClaudeLocalProviderCapabilityResolver(() => profile)(_runtimeType, binding);
  };

  const hermes: RuntimeProviderAdapterResolver = (_runtimeType, binding, context) => {
    if (!binding) return null;
    const transport = firstString(context?.session?.sessionParams?.transport);
    // Historical HTTP sessions retain their original reader. New Chat bindings
    // resolve the same ACP profile that execute uses, without an opt-in flag.
    if (transport === "hermes-acp-stdio" || (!transport && !historical)) {
      const configuredMcp = runtimeConfig.hermesAcpMcpServers ?? runtimeConfig.mcpServers;
      const profile: HermesAcpProfileTransport = {
        binding: providerBinding(binding),
        command: firstString(runtimeConfig.hermesAcpCommand, runtimeConfig.acpCommand, runtimeConfig.command) ?? "hermes",
        args: readStringArray(runtimeConfig.hermesAcpArgs ?? runtimeConfig.acpArgs ?? runtimeConfig.args) ?? ["acp"],
        cwd: profileCwd(config),
        env,
        hermesPythonCommand: firstString(runtimeConfig.hermesPythonCommand, runtimeConfig.hermesHistoryPythonCommand),
        hermesSourcePath: firstString(runtimeConfig.hermesSourcePath, runtimeConfig.hermesHistorySourcePath),
        hermesHome: firstString(runtimeConfig.hermesHome, env.HERMES_HOME),
        providerVersion: providerVersion(config),
        protocolVersion: typeof runtimeConfig.hermesAcpProtocolVersion === "number" ? runtimeConfig.hermesAcpProtocolVersion : 1,
        authMethodId: firstString(runtimeConfig.hermesAcpAuthMethodId, runtimeConfig.authMethodId),
        mcpServers: Array.isArray(configuredMcp) ? configuredMcp.filter((value) => value && typeof value === "object" && !Array.isArray(value)) : [],
      };
      return createHermesAcpProviderCapabilityResolver(() => profile)(_runtimeType, binding);
    }
    const headers = readStringMap(runtimeConfig.headers);
    const apiKey = firstString(
      runtimeConfig.apiKey,
      runtimeConfig.hermesApiKey,
      runtimeConfig.bearerToken,
      env.HERMES_API_KEY,
    );
    const profile: HermesGatewayProfileTransport = {
      binding: providerBinding(binding),
      baseUrl: firstString(
        runtimeConfig.url,
        runtimeConfig.baseUrl,
        runtimeConfig.hermesBaseUrl,
        runtimeConfig.gatewayUrl,
      ) ?? "",
      providerVersion: providerVersion(config) ?? "",
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
    return createHermesGatewayProviderCapabilityResolver(() => profile)(_runtimeType, binding);
  };

  const openCode: RuntimeProviderAdapterResolver = (_runtimeType, binding, context) => {
    if (!binding) return null;
    const command = firstString(runtimeConfig.serverCommand, runtimeConfig.exportCommand, runtimeConfig.command);
    const cwd = profileCwd(config) || null;
    const serverUrl = firstString(runtimeConfig.serverUrl, runtimeConfig.opencodeServerUrl);
    const profileEnv = profileEnvironment(config, "exportEnv", "opencodeExportEnv");
    const version = providerVersion(config);
    const missing = [
      command ? null : "command",
      cwd ? null : "cwd",
      serverUrl ? null : "managed server URL",
      version ? null : "provider version",
      profileEnv ? null : "export environment",
    ].filter((value): value is string => Boolean(value));
    if (historical && missing.length > 0) return null;
    if (historical && context?.session && profileEnv && !sessionEnvironmentMatches(context, "exportEnv", profileEnv)) {
      return null;
    }
    const profile: OpenCodeLocalProfileTransport = {
      binding: providerBinding(binding),
      providerVersion: version,
      command,
      cwd,
      serverUrl,
    };
    const adapter = createOpenCodeLocalProviderCapabilityResolver(() => profile)(_runtimeType, binding);
    return missing.length > 0 && adapter
      ? withoutUnresolvedNativeTransport(
        adapter,
        `OpenCode native transport is unknown until the host-owned profile resolves ${missing.join(", ")}; persisted session transport is validation input only.`,
      )
      : adapter;
  };

  const pi: RuntimeProviderAdapterResolver = (_runtimeType, binding, context) => {
    if (!binding) return null;
    const command = firstString(runtimeConfig.command);
    const cwd = profileCwd(config) || null;
    const sessionDir = firstString(runtimeConfig.sessionDir);
    const rpcArgs = readStringArray(runtimeConfig.rpcArgs);
    const profileEnv = profileEnvironment(config, "rpcEnv", "piRpcEnv");
    const version = providerVersion(config);
    const missing = [
      command ? null : "command",
      cwd ? null : "cwd",
      sessionDir ? null : "session directory",
      rpcArgs ? null : "RPC args",
      version ? null : "provider version",
      profileEnv ? null : "RPC environment",
    ].filter((value): value is string => Boolean(value));
    if (historical && missing.length > 0) return null;
    if (historical && context?.session && profileEnv && !sessionEnvironmentMatches(context, "rpcEnv", profileEnv)) {
      return null;
    }
    const profile: PiLocalProfileTransport = {
      binding: providerBinding(binding),
      providerVersion: version,
      command,
      cwd,
      sessionDir,
      rpcArgs: rpcArgs ?? undefined,
    };
    const adapter = createPiLocalProviderCapabilityResolver(() => profile)(_runtimeType, binding);
    return missing.length > 0 && adapter
      ? withoutUnresolvedNativeTransport(
        adapter,
        `Pi native transport is unknown until the host-owned profile resolves ${missing.join(", ")}; persisted session transport is validation input only.`,
      )
      : adapter;
  };

  const cursor: RuntimeProviderAdapterResolver = (_runtimeType, binding) => {
    if (!binding) return null;
    const profile: CursorLocalProfileTransport = {
      binding: providerBinding(binding),
      command: firstString(runtimeConfig.command) ?? undefined,
      cwd: profileCwd(config),
      providerVersion: providerVersion(config) ?? "",
      env,
      authMethodId: firstString(runtimeConfig.authMethodId) ?? undefined,
      protocolVersion: typeof runtimeConfig.protocolVersion === "number" ? runtimeConfig.protocolVersion : undefined,
    };
    return createCursorLocalProviderCapabilityResolver(() => profile)(_runtimeType, binding);
  };

  return {
    codex_local: codex,
    claude_local: claude,
    hermes_gateway: hermes,
    opencode_local: openCode,
    pi_local: pi,
    cursor,
  };
}

/**
 * Build the resolver injected by Chat and Run Detail. Production callers pass
 * the effective runtime config for this invocation; callback maps remain
 * supported for tests and installations with a separate profile store.
 */
export function createProfileBoundRuntimeProviderCapabilityResolverFromConfig(
  config: ProfileBoundRuntimeProviderCapabilityResolverConfig = {},
): RuntimeProviderCapabilityResolver {
  if ("runtimeType" in config && "runtimeConfig" in config) {
    return createProfileBoundRuntimeProviderCapabilityResolverFromMap(profileResolvers(config));
  }
  return createProfileBoundRuntimeProviderCapabilityResolverFromMap({
    codex_local: config.codex_local ? createCodexLocalProviderCapabilityResolver(config.codex_local) : null,
    claude_local: config.claude_local ? createClaudeLocalProviderCapabilityResolver(config.claude_local) : null,
    hermes_gateway: config.hermes_gateway ? createHermesGatewayProviderCapabilityResolver(config.hermes_gateway) : null,
    opencode_local: config.opencode_local ? createOpenCodeLocalProviderCapabilityResolver(config.opencode_local) : null,
    pi_local: config.pi_local ? createPiLocalProviderCapabilityResolver(config.pi_local) : null,
    cursor: config.cursor ? createCursorLocalProviderCapabilityResolver(config.cursor) : null,
  });
}

export {
  createRuntimeDriver,
  getRuntimeDriver,
  listRuntimeDrivers,
  NATIVE_CHAT_RUNTIME_TYPES,
  type NativeChatRuntimeType,
  type RuntimeDriver,
  type RuntimeDriverCapabilities,
  type RuntimeDriverCapability,
  type RuntimeDriverCapabilityName,
  type RuntimeDriverCapabilityStatus,
  type RuntimeDriverContextHandoff,
  type RuntimeDriverContextHandoffItem,
  type RuntimeDriverContextHandoffRequest,
  type RuntimeDriverControlCapabilities,
  type RuntimeDriverControlOperation,
  type RuntimeDriverControlValue,
  type RuntimeDriverFactoryOptions,
  type RuntimeDriverForkRequest,
  type RuntimeDriverInput,
  type RuntimeDriverOperation,
  type RuntimeDriverResumeInput,
  type RuntimeDriverSession,
  type RuntimeDriverSubmitInput,
  type RuntimeDriverTranscriptRangeRequest
} from "../services/runtime-kernel/runtime-driver.js";
