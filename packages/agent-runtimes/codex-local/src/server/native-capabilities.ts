import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
} from "@rudderhq/agent-runtime-utils";
import path from "node:path";
import {
  codexProfileMethodEvidence,
  forkCodexNativeThread,
  readCodexNativeTranscript,
  type CodexAppServerProfileTransport,
  type CodexAppServerProfileTransportResolver,
  type CodexCapabilityEvidence,
  type CodexNativeForkRequest,
  type CodexNativeForkResult,
  type CodexNativeTranscriptReadRequest,
  type CodexNativeTranscriptReadResult,
  type CodexProviderBindingRef,
  type CodexProviderSessionRef
} from "./app-server-native.js";

export type {
  CodexAppServerProfileTransport,
  CodexAppServerProfileTransportResolver,
  CodexCapabilityEvidence, CodexNativeCapabilityError, CodexNativeCapabilityStatus, CodexNativeForkRequest,
  CodexNativeForkResult,
  CodexNativeTranscriptReadRequest,
  CodexNativeTranscriptReadResult,
  CodexProviderBindingRef,
  CodexProviderSessionRef
} from "./app-server-native.js";

type ProviderControlOperation =
  | { kind: "steer"; input: AgentRuntimeControlSteerInput }
  | { kind: "interrupt"; reason: AgentRuntimeControlInterruptReason };
type ProviderControlRequest = {
  runtimeType: string;
  handle: AgentRuntimeControlHandle | null;
  operation: ProviderControlOperation;
  session?: CodexProviderSessionRef | null;
  binding?: CodexProviderBindingRef | null;
};

export interface CodexRuntimeProviderCapabilityAdapter {
  runtimeType: "codex_local";
  sessionResume?: { evidence: CodexCapabilityEvidence };
  input?: { evidence: CodexCapabilityEvidence };
  contextHandoff?: { evidence: CodexCapabilityEvidence };
  transcript?: {
    evidence: CodexCapabilityEvidence;
    readRange?: (
      input: CodexNativeTranscriptReadRequest,
    ) => Promise<CodexNativeTranscriptReadResult | readonly Record<string, unknown>[]>;
  };
  fork?: {
    evidence: CodexCapabilityEvidence;
    fork?: (input: CodexNativeForkRequest) => Promise<CodexNativeForkResult>;
  };
  control?: {
    steer?: {
      evidence: CodexCapabilityEvidence;
      mode?: "native" | "process" | "remote" | "interrupt_continue";
      execute?: (input: ProviderControlRequest) => Promise<AgentRuntimeControlSteerResult>;
      requiresHandle?: boolean;
    };
    interrupt?: {
      evidence: CodexCapabilityEvidence;
      mode?: "native" | "process" | "remote" | "interrupt_continue";
      execute?: (input: ProviderControlRequest) => Promise<AgentRuntimeControlInterruptResult>;
      requiresHandle?: boolean;
    };
  };
}

function forwardLiveControl(
  input: ProviderControlRequest,
  expectedBinding?: CodexProviderBindingRef,
): Promise<AgentRuntimeControlSteerResult | AgentRuntimeControlInterruptResult> {
  if (!input.handle) {
    return Promise.resolve(input.operation.kind === "steer"
      ? {
        disposition: "acceptance_unknown" as const,
        reason: "Codex App Server control requires the live handle registered for the active turn.",
      }
      : "unverified" as const);
  }
  if (expectedBinding) {
    const requestedBinding = input.binding;
    const bindingMatches = Boolean(
      requestedBinding?.hostId?.trim()
        && requestedBinding.profileId?.trim()
        && requestedBinding.hostId.trim() === expectedBinding.hostId.trim()
        && requestedBinding.profileId.trim() === expectedBinding.profileId.trim()
        && (expectedBinding.id == null || requestedBinding.id === expectedBinding.id)
        && (expectedBinding.orgId == null || requestedBinding.orgId === expectedBinding.orgId)
        && (expectedBinding.workspaceBindingId == null
          || requestedBinding.workspaceBindingId === expectedBinding.workspaceBindingId)
        && (expectedBinding.capabilityRevision == null
          || requestedBinding.capabilityRevision === expectedBinding.capabilityRevision),
    );
    const handleThreadId = input.handle.providerThreadId?.trim() ?? "";
    const sessionThreadId = input.session?.sessionId?.trim() ?? "";
    const sessionParams = input.session?.sessionParams ?? {};
    const persistedThreadId = typeof sessionParams.threadId === "string"
      ? sessionParams.threadId.trim()
      : "";
    const identityError = !bindingMatches
      ? "Codex live control binding does not match the profile-bound resolver transport."
      : input.runtimeType !== "codex_local" || input.handle.runtimeType !== "codex_local"
        ? "Codex live control received a handle for a different runtime."
        : !handleThreadId
          ? "Codex live control handle has no provider thread identity."
          : sessionThreadId && sessionThreadId !== handleThreadId
            ? "Codex live control session does not match the live handle thread."
            : persistedThreadId && persistedThreadId !== handleThreadId
              ? "Codex persisted session thread does not match the live handle thread."
              : null;
    if (identityError) {
      return Promise.resolve(input.operation.kind === "steer"
        ? {
          disposition: "acceptance_unknown" as const,
          providerThreadId: input.handle.providerThreadId ?? null,
          providerTurnId: input.handle.providerTurnId ?? null,
          reason: identityError,
        }
        : "unverified" as const);
    }
  }
  return input.operation.kind === "steer"
    ? input.handle.steer(input.operation.input)
    : input.handle.interrupt(input.operation.reason);
}

async function forwardLiveSteer(input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> {
  if (input.operation.kind !== "steer") {
    return {
      disposition: "acceptance_unknown",
      reason: "Codex received an interrupt operation through the steer capability.",
    };
  }
  return forwardLiveControl(input) as Promise<AgentRuntimeControlSteerResult>;
}

async function forwardBoundLiveSteer(
  input: ProviderControlRequest,
  binding: CodexProviderBindingRef,
): Promise<AgentRuntimeControlSteerResult> {
  if (input.operation.kind !== "steer") {
    return {
      disposition: "acceptance_unknown",
      reason: "Codex received an interrupt operation through the steer capability.",
    };
  }
  return forwardLiveControl(input, binding) as Promise<AgentRuntimeControlSteerResult>;
}

async function forwardLiveInterrupt(input: ProviderControlRequest): Promise<AgentRuntimeControlInterruptResult> {
  if (input.operation.kind !== "interrupt") return "unverified";
  return forwardLiveControl(input) as Promise<AgentRuntimeControlInterruptResult>;
}

async function forwardBoundLiveInterrupt(
  input: ProviderControlRequest,
  binding: CodexProviderBindingRef,
): Promise<AgentRuntimeControlInterruptResult> {
  if (input.operation.kind !== "interrupt") return "unverified";
  return forwardLiveControl(input, binding) as Promise<AgentRuntimeControlInterruptResult>;
}

const staticSessionResumeEvidence: CodexCapabilityEvidence = {
  status: "supported",
  reason: "Codex execute resumes persisted threads through App Server thread/resume or the CLI session path.",
  transport: "app-server-stdio-or-cli",
  profileBound: false,
  profileRequired: true,
};

const staticInputEvidence: CodexCapabilityEvidence = {
  status: "supported",
  reason: "Codex execute is the registered prompt submission boundary.",
  transport: "app-server-stdio-or-cli",
  profileBound: true,
  profileRequired: false,
};

const staticContextHandoffEvidence: CodexCapabilityEvidence = {
  status: "supported",
  reason: "Codex execute accepts Rudder's explicitly selected visible context in the prompt boundary.",
  transport: "app-server-stdio-or-cli",
  profileBound: true,
  profileRequired: false,
};

const staticTranscriptEvidence: CodexCapabilityEvidence = {
  status: "unknown",
  reason: "Codex native history requires a profile-bound App Server transport and verified thread/read support.",
  transport: "codex-app-server-stdio",
  profileBound: false,
  profileRequired: true,
};

const staticForkEvidence: CodexCapabilityEvidence = {
  status: "unknown",
  reason: "Codex native fork requires a profile-bound App Server transport and verified thread/fork support.",
  transport: "codex-app-server-stdio",
  profileBound: false,
  profileRequired: true,
};

const staticControlEvidence: CodexCapabilityEvidence = {
  status: "supported",
  reason: "Codex App Server turns use the existing turn control handle.",
  transport: "app-server-stdio",
  profileBound: false,
  profileRequired: true,
};

/**
 * Conservative registry declaration. Actual history and fork hooks are only
 * returned by createCodexLocalProviderCapabilityResolver after a host has
 * resolved a concrete profile-bound command, cwd, environment, and version.
 */
export const runtimeProviderCapabilities: CodexRuntimeProviderCapabilityAdapter = {
  runtimeType: "codex_local",
  sessionResume: { evidence: staticSessionResumeEvidence },
  input: { evidence: staticInputEvidence },
  contextHandoff: { evidence: staticContextHandoffEvidence },
  transcript: { evidence: staticTranscriptEvidence },
  fork: { evidence: staticForkEvidence },
  control: {
    steer: {
      evidence: staticControlEvidence,
      mode: "native",
      requiresHandle: true,
      execute: forwardLiveSteer,
    },
    interrupt: {
      evidence: staticControlEvidence,
      mode: "native",
      requiresHandle: true,
      execute: forwardLiveInterrupt,
    },
  },
};

function bindingMatchesProfile(
  binding: CodexProviderBindingRef,
  profile: CodexAppServerProfileTransport,
): boolean {
  const actual = profile?.binding;
  if (!actual?.hostId?.trim() || !actual.profileId?.trim()) return false;
  const optionalIdentityMatches = (key: keyof CodexProviderBindingRef): boolean => {
    const expected = binding[key];
    return expected === undefined || expected === null
      ? true
      : actual[key] === expected;
  };
  return actual.hostId.trim() === binding.hostId.trim()
    && actual.profileId.trim() === binding.profileId.trim()
    && optionalIdentityMatches("id")
    && optionalIdentityMatches("orgId")
    && optionalIdentityMatches("workspaceBindingId")
    && optionalIdentityMatches("capabilityRevision");
}

function profileBindingEvidence(
  profile: CodexAppServerProfileTransport,
): CodexCapabilityEvidence {
  const hasTransport = Boolean(
    profile.command.trim()
      && path.isAbsolute(profile.cwd)
      && path.isAbsolute(profile.env.CODEX_HOME?.trim() ?? "")
      && profile.binding.hostId.trim()
      && profile.binding.profileId.trim(),
  );
  if (!hasTransport) {
    return {
      status: "unknown",
      reason: "Codex native capability transport is missing a verified profile command, cwd, CODEX_HOME, or binding.",
      providerVersion: profile.providerVersion ?? null,
      transport: "codex-app-server-stdio",
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!profile.providerVersion?.trim()) {
    return {
      status: "unknown",
      reason: "Codex native capability transport cannot safely select protocol methods without a provider version.",
      transport: "codex-app-server-stdio",
      profileBound: true,
      profileRequired: true,
    };
  }
  return {
    status: "supported",
    reason: `Codex App Server profile ${profile.binding.profileId} is bound to the native transport.`,
    providerVersion: profile.providerVersion,
    transport: "codex-app-server-stdio",
    profileBound: true,
    profileRequired: true,
  };
}

function unknownCapabilities(reason: string): CodexRuntimeProviderCapabilityAdapter {
  return {
    ...runtimeProviderCapabilities,
    transcript: {
      evidence: {
        ...staticTranscriptEvidence,
        reason: `${reason} Native transcript range remains unknown/unsupported until the binding is resolved.`,
      },
    },
    fork: {
      evidence: {
        ...staticForkEvidence,
        reason: `${reason} Native boundary fork remains unknown/unsupported until the binding is resolved.`,
      },
    },
  };
}

function boundCapabilities(profile: CodexAppServerProfileTransport): CodexRuntimeProviderCapabilityAdapter {
  const profileEvidence = profileBindingEvidence(profile);
  const resumeEvidence = codexProfileMethodEvidence(profile, "thread/resume");
  const readEvidence = codexProfileMethodEvidence(profile, "thread/read");
  const forkEvidence = codexProfileMethodEvidence(profile, "thread/fork");
  const sessionEvidence: CodexCapabilityEvidence = profileEvidence.status !== "supported"
    ? profileEvidence
    : resumeEvidence;
  return {
    runtimeType: "codex_local",
    sessionResume: { evidence: sessionEvidence },
    input: { evidence: profileEvidence },
    contextHandoff: { evidence: profileEvidence },
    transcript: {
      evidence: readEvidence,
      readRange: (input) => readCodexNativeTranscript(input, profile),
    },
    fork: {
      evidence: forkEvidence,
      fork: (input) => forkCodexNativeThread(input, profile),
    },
    control: {
      ...runtimeProviderCapabilities.control,
      steer: {
        ...runtimeProviderCapabilities.control?.steer,
        evidence: profileEvidence,
        execute: (input) => forwardBoundLiveSteer(input, profile.binding),
      },
      interrupt: {
        ...runtimeProviderCapabilities.control?.interrupt,
        evidence: profileEvidence,
        execute: (input) => forwardBoundLiveInterrupt(input, profile.binding),
      },
    },
  };
}

/** Create one concrete provider adapter for a verified profile transport. */
export function createCodexLocalProviderCapabilities(
  profile: CodexAppServerProfileTransport,
): CodexRuntimeProviderCapabilityAdapter {
  return boundCapabilities(profile);
}

/**
 * Adapt a host-owned profile resolver to the server provider capability
 * resolver contract without moving credentials, paths, or commands into the
 * opaque RuntimeProviderBindingRef.
 */
export function createCodexLocalProviderCapabilityResolver(
  resolveProfile: CodexAppServerProfileTransportResolver | null | undefined,
): (runtimeType: string, binding?: CodexProviderBindingRef | null) => CodexRuntimeProviderCapabilityAdapter | null {
  return (runtimeType, binding) => {
    if (runtimeType !== "codex_local") return null;
    if (!binding?.hostId?.trim() || !binding.profileId?.trim()) {
      return unknownCapabilities("Codex native history and fork have no host/profile binding.");
    }
    if (!resolveProfile) {
      return unknownCapabilities("No Codex profile-bound App Server transport resolver is installed.");
    }
    let profile: CodexAppServerProfileTransport | null | undefined;
    try {
      profile = resolveProfile(binding);
    } catch (error) {
      return unknownCapabilities(
        `Codex profile-bound transport resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!profile) return unknownCapabilities(`No Codex App Server transport is authorized for profile ${binding.profileId}.`);
    if (!bindingMatchesProfile(binding, profile)) {
      const mismatch = unknownCapabilities("Resolved Codex App Server transport does not match the requested profile binding.");
      const unsupportedReason = "Codex profile-bound transport identity mismatch; native history and fork are unsupported.";
      mismatch.transcript = { evidence: { ...mismatch.transcript!.evidence, status: "unsupported", reason: unsupportedReason } };
      mismatch.fork = { evidence: { ...mismatch.fork!.evidence, status: "unsupported", reason: unsupportedReason } };
      return mismatch;
    }
    return boundCapabilities(profile);
  };
}

export const resolveCodexLocalProviderCapabilities = createCodexLocalProviderCapabilityResolver;
