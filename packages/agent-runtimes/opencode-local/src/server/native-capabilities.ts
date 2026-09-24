import path from "node:path";
import {
  forkOpenCodeNativeSession,
  isManagedOpenCodeRunConfigEnvironment,
  deleteOpenCodeSideChatForkSession,
  OpenCodeNativeCapabilityError,
  readOpenCodeNativeTranscript,
  type OpenCodeBinding,
  type OpenCodeForkRequest,
  type OpenCodeForkResult,
  type OpenCodeSession,
  type OpenCodeWorkspaceIdentity,
  type OpenCodeTranscriptRequest,
  type OpenCodeTranscriptResult,
} from "./native-protocol.js";

export type OpenCodeCapabilityStatus = "supported" | "unsupported" | "unknown";

export type OpenCodeCapabilityEvidence = {
  status: OpenCodeCapabilityStatus;
  reason: string;
  providerVersion?: string | null;
  transport?: string | null;
  profileBound: boolean;
  profileRequired?: boolean;
};

/**
 * Host-owned identity for an OpenCode profile. The reader never takes command,
 * cwd, server URL, or environment from a caller; it obtains those values from
 * the persisted provider session below and only uses these optional fields to
 * reject a session whose persisted transport no longer matches the profile.
 * The native transport removes an attested, Run-scoped config before history
 * reads and forks; it never reuses that deleted config as current authority.
 */
export type OpenCodeLocalProfileTransport = {
  binding: OpenCodeBinding;
  providerVersion?: string | null;
  command?: string | null;
  cwd?: string | null;
  serverUrl?: string | null;
};

export type OpenCodeLocalProfileTransportResolver = (
  binding: OpenCodeBinding,
) => OpenCodeLocalProfileTransport | null | undefined;

const nativeTransport = "opencode-managed-server-http";
const SAFE_PERSISTED_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "OPENCODE_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "RUDDER_OPERATOR_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function bindingMatches(
  requested: OpenCodeBinding,
  profile: OpenCodeLocalProfileTransport,
): boolean {
  const actual = profile.binding;
  const optionalIdentityMatches = (key: keyof OpenCodeBinding): boolean => {
    const expected = requested[key];
    return expected === undefined || expected === null || actual[key] === expected;
  };
  return Boolean(actual?.hostId?.trim() && actual.profileId?.trim())
    && actual.hostId.trim() === requested.hostId.trim()
    && actual.profileId.trim() === requested.profileId.trim()
    && optionalIdentityMatches("id")
    && optionalIdentityMatches("orgId")
    && optionalIdentityMatches("workspaceBindingId")
    && optionalIdentityMatches("capabilityRevision");
}

function profileEvidence(profile: OpenCodeLocalProfileTransport): OpenCodeCapabilityEvidence {
  if (
    !profile?.binding?.hostId?.trim()
    || !profile.binding.profileId.trim()
    || !profile.command?.trim()
    || !profile.cwd
    || !path.isAbsolute(profile.cwd)
  ) {
    return {
      status: "unknown",
      reason: "OpenCode profile transport is missing host/profile identity.",
      transport: nativeTransport,
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!profile.providerVersion?.trim()) {
    return {
      status: "unknown",
      reason: "OpenCode native capability evidence requires the installed provider version.",
      transport: nativeTransport,
      profileBound: true,
      profileRequired: true,
    };
  }
  return {
    status: "supported",
    reason: "OpenCode native capability transport is profile-bound; read and fork validate persisted session state before using managed transport.",
    providerVersion: profile.providerVersion ?? null,
    transport: nativeTransport,
    profileBound: true,
    profileRequired: true,
  };
}

function staticEvidence(reason: string): OpenCodeCapabilityEvidence {
  return {
    status: "unknown",
    reason,
    transport: nativeTransport,
    profileBound: false,
    profileRequired: true,
  };
}

function boundInputEvidence(profile: OpenCodeLocalProfileTransport): OpenCodeCapabilityEvidence {
  return {
    status: "supported",
    reason: `OpenCode prompt input uses the profile-bound ${profile.command?.trim() || "opencode"} runtime adapter; native history and fork remain separately attested.`,
    providerVersion: profile.providerVersion ?? null,
    transport: nativeTransport,
    profileBound: Boolean(profile.binding.hostId?.trim() && profile.binding.profileId?.trim()),
    profileRequired: false,
  };
}

const staticReason = "OpenCode native capability requires a host-owned profile resolver and persisted provider session transport state.";

function unavailable(reason: string): OpenCodeTranscriptResult {
  return {
    items: [],
    nextCursor: null,
    source: "native",
    revision: `incompatible:${reason}`,
    availability: "incompatible",
    completeness: "unknown",
  };
}

function localServerUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

function persistedEnvIsSafe(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (!Object.entries(record).every(
    ([key, entry]) => SAFE_PERSISTED_ENV_KEYS.has(key)
      && typeof entry === "string"
      && entry.trim().length > 0
      && (key !== "OPENCODE_CONFIG" || path.isAbsolute(entry)),
  )) return false;
  return !record.OPENCODE_CONFIG || isManagedOpenCodeRunConfigEnvironment(record as Record<string, string>);
}

function persistedTransportMismatch(
  profile: OpenCodeLocalProfileTransport,
  session: OpenCodeSession,
  binding: OpenCodeBinding | null | undefined,
  workspace?: OpenCodeWorkspaceIdentity | null,
): string | null {
  if (!binding || !bindingMatches(binding, profile)) return "OpenCode profile identity does not match the requested binding.";
  const params = session.sessionParams;
  const sessionId = nonEmpty(session.sessionId);
  if (!sessionId || nonEmpty(params.sessionId) !== sessionId) return "OpenCode persisted session identity is missing or does not match the requested session.";
  if (nonEmpty(params.hostId) !== binding.hostId.trim() || nonEmpty(params.profileId) !== binding.profileId.trim()) {
    return "OpenCode persisted session identity does not match the requested host/profile binding.";
  }
  const identityFields: Array<[string, unknown, unknown]> = [
    ["profile binding", params.profileBindingId, binding.id],
    ["organization", params.profileOrgId, binding.orgId],
    ["workspace binding", params.workspaceBindingId, binding.workspaceBindingId],
  ];
  for (const [label, storedValue, expectedValue] of identityFields) {
    const stored = nonEmpty(storedValue);
    const expected = nonEmpty(expectedValue);
    if (expected && stored !== expected) return `OpenCode persisted ${label} identity does not match the requested binding.`;
    if (!expected && stored) return `OpenCode current binding is missing persisted ${label} identity.`;
  }
  if (binding.capabilityRevision && nonEmpty(params.capabilityRevision) !== binding.capabilityRevision) {
    return "OpenCode persisted capability revision does not match the requested profile binding.";
  }
  if (nonEmpty(params.transport) !== nativeTransport) return "OpenCode persisted transport does not match the managed server transport.";
  const serverUrl = nonEmpty(params.serverUrl);
  const cwd = nonEmpty(params.cwd) ?? nonEmpty(params.directory);
  const serverCommand = nonEmpty(params.serverCommand);
  const exportCommand = nonEmpty(params.exportCommand);
  if (!serverUrl || !localServerUrl(serverUrl)) return "OpenCode persisted managed-server URL is missing or not loopback-bound.";
  if (!cwd || !path.isAbsolute(cwd)) return "OpenCode persisted session cwd is missing or not absolute.";
  if (!serverCommand || !exportCommand) return "OpenCode persisted server/export command is missing.";
  if (serverCommand !== exportCommand) return "OpenCode persisted server/export command does not match.";
  if (!persistedEnvIsSafe(params.exportEnv)) return "OpenCode persisted export environment is missing or contains unsupported keys.";
  if (profile.command && (serverCommand !== profile.command.trim() || exportCommand !== profile.command.trim())) return "OpenCode persisted command does not match the resolved profile.";
  if (profile.cwd && path.resolve(cwd) !== path.resolve(profile.cwd)) return "OpenCode persisted cwd does not match the resolved profile.";
  if (profile.serverUrl) {
    const expected = localServerUrl(profile.serverUrl.trim());
    if (!expected || expected.toString() !== localServerUrl(serverUrl)?.toString()) return "OpenCode persisted server URL does not match the resolved profile.";
  }
  if (nonEmpty(params.providerVersion) !== nonEmpty(profile.providerVersion)) {
    return "OpenCode persisted provider version does not match the resolved profile.";
  }
  const workspaceFields = ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const;
  if (workspace) {
    for (const field of workspaceFields) {
      const expected = nonEmpty(workspace[field]);
      const stored = nonEmpty(params[field]);
      if (expected && stored !== expected) return `OpenCode persisted ${field} does not match the current workspace.`;
      if (!expected && stored) return `OpenCode current workspace is missing persisted ${field} identity.`;
    }
  }
  return null;
}

function unknownCapabilities(reason: string): OpenCodeRuntimeProviderCapabilityAdapter {
  return {
    runtimeType: "opencode_local",
    sessionResume: { evidence: staticEvidence(reason) },
    input: { evidence: staticEvidence(reason) },
    contextHandoff: { evidence: staticEvidence(reason) },
    transcript: {
      evidence: staticEvidence(reason),
      readRange: async () => unavailable(reason),
    },
    fork: {
      evidence: staticEvidence(reason),
      fork: async () => {
        throw new OpenCodeNativeCapabilityError("unknown", reason);
      },
    },
    sideChatForkCleanup: {
      evidence: staticEvidence(reason),
      deleteForkedSession: async () => {
        throw new OpenCodeNativeCapabilityError("unknown", reason);
      },
    },
    control: {
      steer: { evidence: staticEvidence(reason) },
      interrupt: { evidence: staticEvidence(reason) },
    },
  };
}

function boundCapabilities(profile: OpenCodeLocalProfileTransport): OpenCodeRuntimeProviderCapabilityAdapter {
  const evidence = profileEvidence(profile);
  const cleanupEvidence: OpenCodeCapabilityEvidence = {
    ...evidence,
    reason: "OpenCode Side Chat cleanup requires its profile-bound /doc to attest session.delete and session.children, then verifies the exact parent and no descendants.",
  };
  return {
    runtimeType: "opencode_local",
    sessionResume: { evidence },
    input: { evidence: boundInputEvidence(profile) },
    contextHandoff: { evidence: boundInputEvidence(profile) },
    transcript: {
      evidence,
      readRange: async (input) => {
        const mismatch = persistedTransportMismatch(profile, input.session, input.binding, input.workspace);
        return mismatch ? unavailable(mismatch) : readOpenCodeNativeTranscript(input);
      },
    },
    fork: {
      evidence,
      fork: async (input) => {
        const mismatch = persistedTransportMismatch(profile, input.session, input.binding, input.workspace);
        if (mismatch) throw new OpenCodeNativeCapabilityError("unsupported", mismatch);
        return forkOpenCodeNativeSession(input);
      },
    },
    sideChatForkCleanup: {
      evidence: cleanupEvidence,
      deleteForkedSession: async (input) => {
        const mismatch = persistedTransportMismatch(profile, input.session, input.binding);
        if (mismatch) throw new OpenCodeNativeCapabilityError("unsupported", mismatch);
        await deleteOpenCodeSideChatForkSession({
          session: input.session,
          expectedParentSessionId: input.expectedParentSessionId,
          binding: input.binding,
          profileCommand: profile.command ?? "",
          profileCwd: profile.cwd ?? "",
          signal: input.signal,
        });
      },
    },
    control: {
      steer: { evidence: staticEvidence("OpenCode has no verified profile-bound live steer handle.") },
      interrupt: { evidence: staticEvidence("OpenCode has no verified profile-bound live interrupt handle.") },
    },
  };
}

export interface OpenCodeRuntimeProviderCapabilityAdapter {
  runtimeType: "opencode_local";
  sessionResume: { evidence: OpenCodeCapabilityEvidence };
  input: { evidence: OpenCodeCapabilityEvidence };
  contextHandoff: { evidence: OpenCodeCapabilityEvidence };
  transcript: {
    evidence: OpenCodeCapabilityEvidence;
    readRange: (input: OpenCodeTranscriptRequest) => Promise<OpenCodeTranscriptResult>;
  };
  fork: {
    evidence: OpenCodeCapabilityEvidence;
    fork: (input: OpenCodeForkRequest) => Promise<OpenCodeForkResult>;
  };
  sideChatForkCleanup: {
    evidence: OpenCodeCapabilityEvidence;
    deleteForkedSession: (input: {
      runtimeType: string;
      session: OpenCodeSession;
      expectedParentSessionId: string;
      binding: OpenCodeBinding;
      signal?: AbortSignal;
    }) => Promise<void>;
  };
  control: {
    steer: { evidence: OpenCodeCapabilityEvidence };
    interrupt: { evidence: OpenCodeCapabilityEvidence };
  };
}

export const runtimeProviderCapabilities: OpenCodeRuntimeProviderCapabilityAdapter = unknownCapabilities(staticReason);

export function createOpenCodeLocalProviderCapabilities(
  profile: OpenCodeLocalProfileTransport,
): OpenCodeRuntimeProviderCapabilityAdapter {
  return boundCapabilities(profile);
}

export function createOpenCodeLocalProviderCapabilityResolver(
  resolveProfile: OpenCodeLocalProfileTransportResolver | null | undefined,
): (runtimeType: string, binding?: OpenCodeBinding | null) => OpenCodeRuntimeProviderCapabilityAdapter | null {
  return (runtimeType, binding) => {
    if (runtimeType !== "opencode_local") return null;
    if (!binding?.hostId?.trim() || !binding.profileId.trim()) {
      return unknownCapabilities("OpenCode native capability requires an explicit host/profile binding.");
    }
    if (!resolveProfile) return unknownCapabilities("No OpenCode profile-bound transport resolver is installed.");
    let profile: OpenCodeLocalProfileTransport | null | undefined;
    try {
      profile = resolveProfile(binding);
    } catch (error) {
      return unknownCapabilities(`OpenCode profile transport resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!profile) return unknownCapabilities(`No OpenCode transport is authorized for profile ${binding.profileId}.`);
    if (!bindingMatches(binding, profile)) {
      return unknownCapabilities("OpenCode profile transport identity mismatch; native history and fork are unsupported.");
    }
    return boundCapabilities(profile);
  };
}

export const resolveOpenCodeLocalProviderCapabilities = createOpenCodeLocalProviderCapabilityResolver;
