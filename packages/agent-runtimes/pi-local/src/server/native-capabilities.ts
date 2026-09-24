import path from "node:path";
import type {
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
} from "@rudderhq/agent-runtime-utils";
import {
  forkPiNativeSession,
  PiNativeCapabilityError,
  readPiNativeTranscript,
  type PiBinding,
  type PiForkRequest,
  type PiForkResult,
  type PiSession,
  type PiWorkspaceIdentity,
  type PiTranscriptRequest,
  type PiTranscriptResult,
} from "./native-protocol.js";

export type PiCapabilityStatus = "supported" | "unsupported" | "unknown";

export type PiCapabilityEvidence = {
  status: PiCapabilityStatus;
  reason: string;
  providerVersion?: string | null;
  transport?: string | null;
  profileBound: boolean;
  profileRequired?: boolean;
};

/**
 * Host-owned Pi profile identity. Native readers use the persisted session
 * file, cwd, command, RPC args, and RPC environment; this profile object never
 * lets a request replace those values after a Reader restart.
 */
export type PiLocalProfileTransport = {
  binding: PiBinding;
  providerVersion?: string | null;
  command?: string | null;
  cwd?: string | null;
  sessionDir?: string | null;
  rpcArgs?: readonly string[];
  rpcEnv?: Readonly<Record<string, string>>;
};

export type PiLocalProfileTransportResolver = (
  binding: PiBinding,
) => PiLocalProfileTransport | null | undefined;

export type PiLocalProviderCapabilityResolverContext = {
  session?: PiSession | null;
  workspace?: PiWorkspaceIdentity | null;
};

type ProviderControlOperation =
  | { kind: "steer"; input: AgentRuntimeControlSteerInput }
  | { kind: "interrupt"; reason: AgentRuntimeControlInterruptReason };

type ProviderControlRequest = {
  runtimeType: string;
  handle: {
    steer(input: AgentRuntimeControlSteerInput): Promise<AgentRuntimeControlSteerResult>;
    interrupt(reason: AgentRuntimeControlInterruptReason): Promise<AgentRuntimeControlInterruptResult>;
  } | null;
  operation: ProviderControlOperation;
  session?: PiSession | null;
  binding?: PiBinding | null;
  workspace?: PiWorkspaceIdentity | null;
};

const nativeTransport = "pi-rpc-stdio";
const SAFE_PERSISTED_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
]);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function persistedEnvIsSafe(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).every(
    ([key, entry]) => SAFE_PERSISTED_ENV_KEYS.has(key) && typeof entry === "string" && entry.trim().length > 0,
  );
}

function sameStringRecord(left: unknown, right: Readonly<Record<string, string>>): boolean {
  const actual = asRecord(left);
  if (!actual) return false;
  const actualEntries = Object.entries(actual).sort(([a], [b]) => a.localeCompare(b));
  const expectedEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return actualEntries.length === expectedEntries.length
    && actualEntries.every(([key, value], index) => {
      const expected = expectedEntries[index];
      return Boolean(expected) && key === expected[0] && value === expected[1];
    });
}

function bindingMatches(requested: PiBinding, profile: PiLocalProfileTransport): boolean {
  const actual = profile.binding;
  const optionalIdentityMatches = (key: keyof PiBinding): boolean => {
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

function profileEvidence(profile: PiLocalProfileTransport, unresolvedReason?: string): PiCapabilityEvidence {
  if (
    !profile?.binding?.hostId?.trim()
    || !profile.binding.profileId.trim()
    || !profile.command?.trim()
    || !profile.cwd
    || !path.isAbsolute(profile.cwd)
    || !profile.sessionDir
    || !path.isAbsolute(profile.sessionDir)
    || !Array.isArray(profile.rpcArgs)
    || profile.rpcArgs.length === 0
    || !profile.rpcArgs.every((value) => typeof value === "string")
    || !profile.providerVersion?.trim()
  ) {
    return {
      status: "unknown",
      reason: unresolvedReason ?? "Pi profile transport is missing host/profile identity, transport boundaries, or provider version.",
      transport: nativeTransport,
      profileBound: false,
      profileRequired: true,
    };
  }
  return {
    status: "supported",
    reason: "Pi native capability transport is profile-bound; read, fork, and control use only persisted provider session state.",
    providerVersion: profile.providerVersion ?? null,
    transport: nativeTransport,
    profileBound: true,
    profileRequired: true,
  };
}

function staticEvidence(reason: string): PiCapabilityEvidence {
  return {
    status: "unknown",
    reason,
    transport: nativeTransport,
    profileBound: false,
    profileRequired: true,
  };
}

function boundInputEvidence(profile: PiLocalProfileTransport): PiCapabilityEvidence {
  return {
    status: "supported",
    reason: `Pi prompt input uses the profile-bound ${profile.command?.trim() || "pi"} runtime adapter; native RPC history, fork, and control remain separately attested.`,
    providerVersion: profile.providerVersion ?? null,
    transport: nativeTransport,
    profileBound: Boolean(profile.binding.hostId?.trim() && profile.binding.profileId?.trim()),
    profileRequired: false,
  };
}

const staticReason = "Pi native capability requires a host-owned profile resolver and persisted provider session transport state.";

function unavailable(reason: string): PiTranscriptResult {
  return {
    items: [],
    nextCursor: null,
    source: "native",
    revision: `incompatible:${reason}`,
    availability: "incompatible",
    completeness: "unknown",
  };
}

function persistedTransportMismatch(
  profile: PiLocalProfileTransport,
  session: PiSession,
  binding: PiBinding | null | undefined,
  workspace?: PiWorkspaceIdentity | null,
): string | null {
  if (!binding || !bindingMatches(binding, profile)) return "Pi profile identity does not match the requested binding.";
  if (!Array.isArray(profile.rpcArgs) || profile.rpcArgs.length === 0) {
    return "Pi host-owned profile does not contain the RPC args reported by the runtime adapter.";
  }
  const params = session.sessionParams;
  const sessionId = nonEmpty(session.sessionId);
  if (!sessionId || nonEmpty(params.sessionId) !== sessionId) return "Pi persisted session identity is missing or does not match the requested session.";
  if (nonEmpty(params.hostId) !== binding.hostId.trim() || nonEmpty(params.profileId) !== binding.profileId.trim()) {
    return "Pi persisted session identity does not match the requested host/profile binding.";
  }
  const identityFields: Array<[string, unknown, unknown]> = [
    ["profile binding", params.profileBindingId, binding.id],
    ["organization", params.profileOrgId, binding.orgId],
    ["workspace binding", params.workspaceBindingId, binding.workspaceBindingId],
  ];
  for (const [label, storedValue, expectedValue] of identityFields) {
    const stored = nonEmpty(storedValue);
    const expected = nonEmpty(expectedValue);
    if (expected && stored !== expected) return `Pi persisted ${label} identity does not match the requested binding.`;
    if (!expected && stored) return `Pi current binding is missing persisted ${label} identity.`;
  }
  if (binding.capabilityRevision && nonEmpty(params.capabilityRevision) !== binding.capabilityRevision) {
    return "Pi persisted capability revision does not match the requested profile binding.";
  }
  if (nonEmpty(params.transport) !== nativeTransport) return "Pi persisted transport does not match the RPC transport.";
  const sessionFile = nonEmpty(params.sessionFile);
  const sessionDir = nonEmpty(params.sessionDir);
  const cwd = nonEmpty(params.cwd);
  const command = nonEmpty(params.command);
  const rpcEnv = asRecord(params.rpcEnv);
  const rpcArgs = params.rpcArgs;
  if (!sessionFile || !sessionDir || !cwd || !command || !rpcEnv || !Array.isArray(rpcArgs)) {
    return "Pi persisted session transport is missing session file/dir, cwd, command, RPC args, or RPC environment.";
  }
  if (path.resolve(sessionFile) !== path.resolve(sessionId)) {
    return "Pi persisted session file does not match the requested session.";
  }
  if (!path.isAbsolute(sessionFile) || !path.isAbsolute(sessionDir) || !path.isAbsolute(cwd)) {
    return "Pi persisted session transport contains a non-absolute path.";
  }
  if (path.resolve(sessionDir) !== path.dirname(path.resolve(sessionFile))) {
    return "Pi persisted session directory does not contain the persisted session file.";
  }
  if (!rpcArgs.every((value) => typeof value === "string")) return "Pi persisted RPC args contain a non-string value.";
  if (!persistedEnvIsSafe(params.rpcEnv)) return "Pi persisted RPC environment is missing or contains unsupported keys.";
  if (profile.rpcEnv && !sameStringRecord(params.rpcEnv, profile.rpcEnv)) {
    return "Pi persisted RPC environment does not match the resolved profile.";
  }
  if (profile.command && command !== profile.command.trim()) return "Pi persisted command does not match the resolved profile.";
  if (profile.cwd && path.resolve(cwd) !== path.resolve(profile.cwd)) return "Pi persisted cwd does not match the resolved profile.";
  if (profile.sessionDir && path.resolve(sessionDir) !== path.resolve(profile.sessionDir)) return "Pi persisted session directory does not match the resolved profile.";
  if (profile.rpcArgs && JSON.stringify(rpcArgs) !== JSON.stringify(profile.rpcArgs)) return "Pi persisted RPC args do not match the resolved profile.";
  if (nonEmpty(params.providerVersion) !== nonEmpty(profile.providerVersion)) {
    return "Pi persisted provider version does not match the resolved profile.";
  }
  const workspaceFields = ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const;
  if (workspace) {
    for (const field of workspaceFields) {
      const expected = nonEmpty(workspace[field]);
      const stored = nonEmpty(params[field]);
      if (expected && stored !== expected) return `Pi persisted ${field} does not match the current workspace.`;
      if (!expected && stored) return `Pi current workspace is missing persisted ${field} identity.`;
    }
  }
  return null;
}

async function executeSteer(input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> {
  if (!input.handle || input.operation.kind !== "steer") {
    return { disposition: "acceptance_unknown", reason: "Pi native steer requires a live RPC handle." };
  }
  return input.handle.steer(input.operation.input);
}

async function executeInterrupt(input: ProviderControlRequest): Promise<AgentRuntimeControlInterruptResult> {
  if (!input.handle || input.operation.kind !== "interrupt") return "unverified";
  return input.handle.interrupt(input.operation.reason);
}

function steerWithoutSession(input: ProviderControlRequest, reason: string): Promise<AgentRuntimeControlSteerResult> {
  void input;
  return Promise.resolve({ disposition: "acceptance_unknown", reason });
}

function interruptWithoutSession(input: ProviderControlRequest, reason: string): Promise<AgentRuntimeControlInterruptResult> {
  void input;
  return Promise.resolve("unverified");
}

function unknownCapabilities(reason: string): PiRuntimeProviderCapabilityAdapter {
  return {
    runtimeType: "pi_local",
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
        throw new PiNativeCapabilityError("unknown", reason);
      },
    },
    control: {
      steer: {
        evidence: staticEvidence(reason),
        mode: "native",
        requiresHandle: true,
        execute: (input) => steerWithoutSession(input, reason),
      },
      interrupt: {
        evidence: staticEvidence(reason),
        mode: "native",
        requiresHandle: true,
        execute: (input) => interruptWithoutSession(input, reason),
      },
    },
  };
}

function unknownNativeTransportCapabilities(
  profile: PiLocalProfileTransport,
  reason: string,
): PiRuntimeProviderCapabilityAdapter {
  return {
    ...unknownCapabilities(reason),
    input: { evidence: boundInputEvidence(profile) },
    contextHandoff: { evidence: boundInputEvidence(profile) },
  };
}

function boundCapabilities(profile: PiLocalProfileTransport, unresolvedReason?: string): PiRuntimeProviderCapabilityAdapter {
  const evidence = profileEvidence(profile, unresolvedReason);
  const executeBoundSteer = (input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> => {
    const mismatch = input.session
      ? persistedTransportMismatch(profile, input.session, input.binding, input.workspace)
      : "Pi native control requires the persisted provider session state.";
    return mismatch ? steerWithoutSession(input, mismatch) : executeSteer(input);
  };
  const executeBoundInterrupt = (input: ProviderControlRequest): Promise<AgentRuntimeControlInterruptResult> => {
    const mismatch = input.session
      ? persistedTransportMismatch(profile, input.session, input.binding, input.workspace)
      : "Pi native control requires the persisted provider session state.";
    return mismatch ? interruptWithoutSession(input, mismatch) : executeInterrupt(input);
  };
  return {
    runtimeType: "pi_local",
    sessionResume: { evidence },
    input: { evidence: boundInputEvidence(profile) },
    contextHandoff: { evidence: boundInputEvidence(profile) },
    transcript: {
      evidence,
      readRange: async (input) => {
        const mismatch = persistedTransportMismatch(profile, input.session, input.binding, input.workspace);
        return mismatch ? unavailable(mismatch) : readPiNativeTranscript(input);
      },
    },
    fork: {
      evidence,
      fork: async (input) => {
        const mismatch = persistedTransportMismatch(profile, input.session, input.binding, input.workspace);
        if (mismatch) throw new PiNativeCapabilityError("unsupported", mismatch);
        return forkPiNativeSession({
          ...input,
          binding: { ...profile.binding, ...input.binding, providerVersion: profile.providerVersion },
        });
      },
    },
    control: {
      steer: { evidence, mode: "native", requiresHandle: true, execute: executeBoundSteer },
      interrupt: { evidence, mode: "native", requiresHandle: true, execute: executeBoundInterrupt },
    },
  };
}

export interface PiRuntimeProviderCapabilityAdapter {
  runtimeType: "pi_local";
  sessionResume: { evidence: PiCapabilityEvidence };
  input: { evidence: PiCapabilityEvidence };
  contextHandoff: { evidence: PiCapabilityEvidence };
  transcript: {
    evidence: PiCapabilityEvidence;
    readRange: (input: PiTranscriptRequest) => Promise<PiTranscriptResult>;
  };
  fork: {
    evidence: PiCapabilityEvidence;
    fork: (input: PiForkRequest) => Promise<PiForkResult>;
  };
  control: {
    steer: {
      evidence: PiCapabilityEvidence;
      mode: "native";
      requiresHandle: true;
      execute: (input: ProviderControlRequest) => Promise<AgentRuntimeControlSteerResult>;
    };
    interrupt: {
      evidence: PiCapabilityEvidence;
      mode: "native";
      requiresHandle: true;
      execute: (input: ProviderControlRequest) => Promise<AgentRuntimeControlInterruptResult>;
    };
  };
}

export const runtimeProviderCapabilities: PiRuntimeProviderCapabilityAdapter = unknownCapabilities(staticReason);

export function createPiLocalProviderCapabilities(
  profile: PiLocalProfileTransport,
): PiRuntimeProviderCapabilityAdapter {
  return boundCapabilities(profile);
}

export function createPiLocalProviderCapabilityResolver(
  resolveProfile: PiLocalProfileTransportResolver | null | undefined,
): (
  runtimeType: string,
  binding?: PiBinding | null,
  context?: PiLocalProviderCapabilityResolverContext,
) => PiRuntimeProviderCapabilityAdapter | null {
  return (runtimeType, binding, context) => {
    if (runtimeType !== "pi_local") return null;
    if (!binding?.hostId?.trim() || !binding.profileId.trim()) {
      return unknownCapabilities("Pi native capability requires an explicit host/profile binding.");
    }
    if (!resolveProfile) return unknownCapabilities("No Pi profile-bound transport resolver is installed.");
    let profile: PiLocalProfileTransport | null | undefined;
    try {
      profile = resolveProfile(binding);
    } catch (error) {
      return unknownCapabilities(`Pi profile transport resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!profile) return unknownCapabilities(`No Pi transport is authorized for profile ${binding.profileId}.`);
    if (!bindingMatches(binding, profile)) {
      return unknownCapabilities("Pi profile transport identity mismatch; native history, fork, and control are unsupported.");
    }
    if (context?.session) {
      const mismatch = persistedTransportMismatch(profile, context.session, binding, context.workspace);
      if (mismatch) return unknownNativeTransportCapabilities(profile, mismatch);
    }
    return boundCapabilities(profile);
  };
}

export const resolvePiLocalProviderCapabilities = createPiLocalProviderCapabilityResolver;
