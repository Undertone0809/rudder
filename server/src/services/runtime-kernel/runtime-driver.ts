import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalHandle,
  AgentRuntimeApprovalRequest,
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  AgentRuntimeEnvironmentTestContext,
  AgentRuntimeEnvironmentTestResult,
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  AgentRuntimeMediaAttachment,
  AgentRuntimeNetworkSubmissionPhase,
  AgentRuntimeSessionCodec,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import { findServerAdapter } from "../../agent-runtimes/registry.js";
import { resolveExecutionSubmissionPhase } from "./model-fallback.js";
import type {
  NativeSessionState,
  RuntimeBindingInput,
  RuntimeBindingRecord,
} from "./native-session.js";
import type {
  NativeSpanSelector,
  NativeTranscriptRawItem,
  NativeTranscriptReadInput,
  RuntimeProviderBindingRef,
  RuntimeProviderCapabilityAdapter,
  RuntimeProviderCapabilityDeclaration,
  RuntimeProviderCapabilityEvidence,
  RuntimeProviderCapabilityResolution,
  RuntimeProviderCapabilityResolver,
  RuntimeProviderCapabilityResolverContext,
  RuntimeProviderControlOperation,
  RuntimeProviderForkResult,
  RuntimeProviderSessionRef,
  RuntimeProviderSideChatForkCleanupRequest,
  RuntimeProviderTranscriptReadResult,
} from "./provider-capabilities.js";
import {
  PROVIDER_CAPABILITY_GAP_REASONS,
  normalizeRuntimeProviderCapabilityResolution,
  providerCapabilityReason,
  resolveRegisteredRuntimeProviderCapabilities,
  runtimeProviderBindingsMatch,
} from "./provider-capabilities.js";
import type {
  RuntimeRetentionInspection,
  runtimeRetentionService,
} from "./runtime-retention.js";
import type {
  ReadConversationTranscript,
  ReadRunTranscript,
  TranscriptPage,
  TranscriptReader,
} from "./transcript-reader.js";
import type {
  UnifiedAcceptanceReconciliationInput,
  UnifiedAgentRunExecutionService,
  UnifiedAgentRunService,
} from "./unified-agent-run.contracts.js";
import type { UnifiedAgentRunEntry, UnifiedOwnerFence } from "./unified-agent-run.js";

/** Runtime adapters with a native-chat facade in this slice. */
export const NATIVE_CHAT_RUNTIME_TYPES = [
  "codex_local",
  "claude_local",
  "hermes_gateway",
  "opencode_local",
  "pi_local",
  "cursor",
] as const;

export type NativeChatRuntimeType = (typeof NATIVE_CHAT_RUNTIME_TYPES)[number];

export type RuntimeDriverCapabilityName =
  | "session_resume"
  | "input"
  | "transcript_range"
  | "control"
  | "fork"
  | "side_chat_fork_cleanup"
  | "context_handoff"
  | "session_binding"
  | "execution_inspection"
  | "execution_reconciliation"
  | "request_response"
  | "transcript_read"
  | "conversation_read"
  | "retention_inspection"
  | "retention_release"
  | "profile_probe";

export type RuntimeDriverCapabilityStatus = "supported" | "unsupported" | "unknown";

export interface RuntimeDriverCapability {
  status: RuntimeDriverCapabilityStatus;
  reason: string;
}

export interface RuntimeDriverControlCapabilities extends RuntimeDriverCapability {
  steer: RuntimeDriverCapability & {
    mode?: "native" | "interrupt_continue" | "native_or_interrupt_continue";
  };
  interrupt: RuntimeDriverCapability & {
    mode?: "native" | "process" | "remote" | "native_or_process";
  };
}

export interface RuntimeDriverCapabilities {
  sessionResume: RuntimeDriverCapability;
  input: RuntimeDriverCapability;
  transcriptRange: RuntimeDriverCapability;
  control: RuntimeDriverControlCapabilities;
  fork: RuntimeDriverCapability;
  sideChatForkCleanup: RuntimeDriverCapability;
  contextHandoff: RuntimeDriverCapability;
  sessionBinding: RuntimeDriverCapability;
  executionInspection: RuntimeDriverCapability;
  executionReconciliation: RuntimeDriverCapability;
  requestResponse: RuntimeDriverCapability;
  transcriptRead: RuntimeDriverCapability;
  conversationRead: RuntimeDriverCapability;
  retentionInspection: RuntimeDriverCapability;
  retentionRelease: RuntimeDriverCapability;
}

export interface RuntimeDriverProfileProbeRequest extends AgentRuntimeEnvironmentTestContext {
  binding?: RuntimeProviderBindingRef | null;
}

export interface RuntimeDriverProfileProbeResult {
  environment: AgentRuntimeEnvironmentTestResult;
  binding: RuntimeProviderBindingRef | null;
  capabilities: RuntimeDriverCapabilities;
  providerEvidence: Array<{
    capability: string;
    status: RuntimeDriverCapabilityStatus;
    reason: string;
    providerVersion?: string | null;
    transport?: string | null;
    profileBound: boolean;
  }>;
}

export interface RuntimeDriverSession {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
}

export interface RuntimeDriverResumeInput {
  sessionId?: string | null;
  sessionParams?: unknown;
  sessionDisplayId?: string | null;
  binding?: RuntimeProviderBindingRef | null;
}

export interface RuntimeDriverInput {
  text: string;
  media?: AgentRuntimeMediaAttachment[];
}

export interface RuntimeDriverSubmitInput {
  context: AgentRuntimeExecutionContext;
  session?: RuntimeDriverSession | null;
  input: RuntimeDriverInput;
}

export interface RuntimeDriverSubmission {
  phase: AgentRuntimeNetworkSubmissionPhase;
  result: AgentRuntimeExecutionResult;
  execution: {
    runId: string;
    binding: RuntimeProviderBindingRef | null;
    providerThreadId: string | null;
    providerTurnId: string | null;
    session: RuntimeDriverSession | null;
  };
}

export type RuntimeDriverSessionBindingOwner = {
  ensureBinding(input: RuntimeBindingInput): Promise<RuntimeBindingRecord>;
  currentSession(binding: RuntimeBindingRecord): Promise<NativeSessionState>;
};

export interface RuntimeDriverSessionReady {
  binding: RuntimeProviderBindingRef;
  segmentId: string;
  segmentState: string;
  /** Null means the host binding is ready but no provider session exists yet. */
  providerSession: RuntimeDriverOperation<RuntimeDriverSession> | null;
}

export interface RuntimeDriverExecutionInspection {
  state: "not_found" | "found";
  entry?: UnifiedAgentRunEntry;
}

export interface RuntimeDriverExecutionReconciliationRequest {
  runId: string;
  attemptId: string;
  fence: UnifiedOwnerFence;
  outcome: UnifiedAcceptanceReconciliationInput;
}

export type RuntimeDriverApprovalBridge = {
  requestApproval(request: AgentRuntimeApprovalRequest): Promise<AgentRuntimeApprovalHandle>;
  waitForApproval(approvalId: string, timeoutMs: number): Promise<AgentRuntimeApprovalDecision>;
};

export type RuntimeDriverRetentionService = Pick<
  ReturnType<typeof runtimeRetentionService>,
  "inspect" | "releaseClaims" | "releaseSourceAliases"
>;

export type RuntimeDriverRetentionInspectionRequest = Parameters<RuntimeDriverRetentionService["inspect"]>[0];

export type RuntimeDriverRetentionReleaseRequest =
  | { kind: "claims"; input: Parameters<RuntimeDriverRetentionService["releaseClaims"]>[0] }
  | { kind: "source_aliases"; input: Parameters<RuntimeDriverRetentionService["releaseSourceAliases"]>[0] };

export interface RuntimeDriverRetentionReleaseResult {
  kind: RuntimeDriverRetentionReleaseRequest["kind"];
  releasedIds: string[];
}

export interface RuntimeDriverRequestResponse {
  handle: AgentRuntimeApprovalHandle;
  decision: AgentRuntimeApprovalDecision;
}

export interface RuntimeDriverTranscriptRangeRequest {
  session: RuntimeDriverSession;
  from?: string | null;
  through?: string | null;
  cursor?: string | null;
  range?: import("./transcript-reader.js").TranscriptRange | null;
  selector?: NativeSpanSelector | null;
  binding?: RuntimeProviderBindingRef | null;
  /** Full authorized input when this operation is called by Transcript Reader. */
  readerInput?: NativeTranscriptReadInput | null;
  signal?: AbortSignal;
}

export interface RuntimeDriverReadSpanRequest extends Omit<ReadRunTranscript, "spanId"> {
  spanId: string;
}

export interface RuntimeDriverForkRequest {
  session: RuntimeDriverSession;
  boundary: string;
  selector?: NativeSpanSelector | null;
  binding?: RuntimeProviderBindingRef | null;
  signal?: AbortSignal;
}

export interface RuntimeDriverSideChatForkCleanupRequest {
  session: RuntimeDriverSession;
  expectedParentSessionId: string;
  binding?: RuntimeProviderBindingRef | null;
  forkRunId?: string | null;
  signal?: AbortSignal;
}

export interface RuntimeDriverContextHandoffItem {
  kind: string;
  text: string;
  sourceId?: string | null;
}

export interface RuntimeDriverContextHandoffRequest {
  source: RuntimeDriverSession;
  visibleContext: readonly RuntimeDriverContextHandoffItem[];
  input: string;
}

export interface RuntimeDriverContextHandoff {
  mode: "context_handoff";
  source: RuntimeDriverSession;
  visibleContext: readonly RuntimeDriverContextHandoffItem[];
  input: string;
}

export type RuntimeDriverOperation<T> =
  | { status: "supported"; value: T }
  | { status: "unsupported"; capability: RuntimeDriverCapabilityName; reason: string }
  | { status: "unknown"; capability: RuntimeDriverCapabilityName; reason: string }
  | { status: "invalid"; capability: RuntimeDriverCapabilityName; reason: string };

export type RuntimeDriverControlOperation =
  | { kind: "steer"; input: AgentRuntimeControlSteerInput }
  | { kind: "interrupt"; reason: AgentRuntimeControlInterruptReason };

export interface RuntimeDriverControlContext {
  session?: RuntimeProviderSessionRef | null;
  binding?: RuntimeProviderBindingRef | null;
}

export type RuntimeDriverControlValue =
  | AgentRuntimeControlSteerResult
  | AgentRuntimeControlInterruptResult;

export interface RuntimeDriverFactoryOptions {
  /** Test seam only; production callers should inject a profile-bound resolver. */
  adapter?: ServerAgentRuntimeModule;
  /** Pre-resolved adapters are declaration-only unless supplied through a resolver. */
  providerCapabilities?: RuntimeProviderCapabilityAdapter | null;
  /** Opaque binding identity used when resolving profile-bound provider capabilities. */
  providerBinding?: RuntimeProviderBindingRef | null;
  /** Resolver attesting the concrete provider profile transport for this binding. */
  providerCapabilityResolver?: RuntimeProviderCapabilityResolver | null;
  /** Existing host owner that persists a Runtime Binding and pending Segment. */
  sessionBindingOwner?: RuntimeDriverSessionBindingOwner | null;
  /** Authoritative durable Unified Run read/reconciliation ports. */
  unifiedRunReader?: Pick<UnifiedAgentRunService, "get"> | null;
  unifiedRunReconciler?: Pick<UnifiedAgentRunExecutionService, "reconcileAcceptance"> | null;
  /** Existing approval and authorized transcript services; never synthesized by the driver. */
  approvalBridge?: RuntimeDriverApprovalBridge | null;
  transcriptReader?: Pick<TranscriptReader, "readRun" | "readConversation"> | null;
  /** Runtime retention owner; release remains scoped and fenced by that owner. */
  retentionService?: RuntimeDriverRetentionService | null;
}

const unsupportedReasons = {
  transcriptRange: "The registry adapter does not expose an authorized transcript-range reader.",
  fork: "The registry adapter does not expose a provider-native boundary fork operation.",
} as const;

interface ProviderCapabilityState {
  adapter: RuntimeProviderCapabilityAdapter | null;
  binding: RuntimeProviderBindingRef | null;
  profileResolved: boolean;
}

const emptyProviderCapabilityState = (): ProviderCapabilityState => ({
  adapter: null,
  binding: null,
  profileResolved: false,
});

function capabilityFromDeclaration(
  declaration: RuntimeProviderCapabilityDeclaration | undefined,
  fallback: string,
  binding: RuntimeProviderBindingRef | null,
  state: ProviderCapabilityState,
  options: { liveHandle?: boolean; requiresResolver?: boolean } = {},
): RuntimeDriverCapability {
  return providerCapabilityReason(declaration?.evidence, fallback, {
    binding,
    liveHandle: options.liveHandle,
    profileResolved: state.profileResolved,
    resolvedBinding: state.binding,
    requiresResolver: options.requiresResolver,
  });
}

function isNativeChatRuntimeType(value: string): value is NativeChatRuntimeType {
  return (NATIVE_CHAT_RUNTIME_TYPES as readonly string[]).includes(value);
}

function genericSessionParams(input: RuntimeDriverResumeInput): Record<string, unknown> | null {
  if (input.sessionParams && typeof input.sessionParams === "object" && !Array.isArray(input.sessionParams)) {
    return { ...(input.sessionParams as Record<string, unknown>) };
  }
  const sessionId = input.sessionId?.trim();
  return sessionId ? { sessionId } : null;
}

const PERSISTED_RESUME_ATTESTATION_KEYS = [
  "capabilityRevision",
  "nativeTransport",
  "providerTransport",
  "runtimeTransport",
  "transport",
  "codexTransport",
  "codexNativeTransport",
  "codexAppServerTransport",
  "claudeTransport",
  "claudeNativeTransport",
  "hermesTransport",
  "opencodeTransport",
  "opencodeNativeTransport",
  "piTransport",
  "piNativeTransport",
  "cursorTransport",
  "cursorNativeTransport",
  "cursorAcpTransport",
] as const;

const PERSISTED_RESUME_TRANSPORT_KEYS: Record<NativeChatRuntimeType, readonly string[]> = {
  codex_local: ["nativeTransport", "providerTransport", "runtimeTransport", "transport", "codexTransport", "codexNativeTransport", "codexAppServerTransport"],
  claude_local: ["nativeTransport", "providerTransport", "runtimeTransport", "transport", "claudeTransport", "claudeNativeTransport"],
  hermes_gateway: ["nativeTransport", "providerTransport", "runtimeTransport", "transport", "hermesTransport"],
  opencode_local: ["nativeTransport", "providerTransport", "runtimeTransport", "transport", "opencodeTransport", "opencodeNativeTransport"],
  pi_local: ["nativeTransport", "providerTransport", "runtimeTransport", "transport", "piTransport", "piNativeTransport"],
  cursor: ["nativeTransport", "providerTransport", "runtimeTransport", "transport", "cursorTransport", "cursorNativeTransport", "cursorAcpTransport"],
};

const NATIVE_TRANSPORT_ALIASES: Record<NativeChatRuntimeType, readonly string[]> = {
  codex_local: ["app-server-stdio", "app-server-stdio-or-cli", "codex-app-server-stdio", "codex_app_server"],
  claude_local: ["claude-cli", "claude-cli-jsonl", "claude_cli"],
  hermes_gateway: ["hermes-http", "hermes-http-sse"],
  opencode_local: ["loopback-http", "opencode-managed-server-http", "opencode_server"],
  pi_local: ["rpc-stdio", "pi-rpc-stdio", "pi_rpc"],
  cursor: [],
};

const PROFILE_BOUND_TRANSPORT_ALIASES: Partial<Record<NativeChatRuntimeType, Readonly<Record<string, readonly string[]>>>> = {
  cursor: {
    // Legacy context-handoff sessions remain resumable only through a verified Cursor profile.
    "cursor-agent-acp-stdio": ["cursor-agent-cli-context-handoff"],
    "cursor-agent-cli": ["cursor-agent-cli-context-handoff"],
  },
};

function persistedResumeAttestation(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    PERSISTED_RESUME_ATTESTATION_KEYS.flatMap((key) => {
      const value = params[key];
      if (typeof value === "string" && value.trim()) return [[key, value.trim()]];
      return [];
    }),
  );
}

function readSessionId(params: Record<string, unknown> | null): string | null {
  if (!params) return null;
  for (const key of ["hermesSessionId", "sessionId", "session_id", "sessionID", "session"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function sessionFromParams(
  codec: AgentRuntimeSessionCodec | null,
  input: RuntimeDriverResumeInput,
): RuntimeDriverSession | null {
  const raw = genericSessionParams(input);
  if (!raw) return null;
  let params: Record<string, unknown> | null;
  try {
    params = codec?.deserialize(raw) ?? raw;
  } catch {
    return null;
  }
  if (!params) return null;
  const sessionId = codec?.getDisplayId?.(params)
    ?? readSessionId(params)
    ?? input.sessionId?.trim()
    ?? null;
  if (!sessionId) return null;
  let sessionParams: Record<string, unknown> | null;
  try {
    sessionParams = codec?.serialize(params) ?? params;
  } catch {
    return null;
  }
  if (!sessionParams) return null;
  // Session codecs intentionally allowlist provider state. Preserve the small
  // attestation envelope so a restart cannot drop transport or revision data
  // before the profile-bound resolver sees the persisted session.
  const attestation = persistedResumeAttestation(raw);
  return {
    sessionId,
    sessionParams: { ...sessionParams, ...attestation },
    sessionDisplayId: input.sessionDisplayId?.trim() || codec?.getDisplayId?.(sessionParams) || sessionId,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function persistedProfileIdentity(params: Record<string, unknown>): { hostId: string | null; profileId: string | null } {
  return {
    hostId: nonEmptyString(params.profileHostId ?? params.providerHostId ?? params.hostId),
    profileId: nonEmptyString(params.profileId ?? params.providerProfileId),
  };
}

function persistedTransport(runtimeType: NativeChatRuntimeType, params: Record<string, unknown>): string | null {
  for (const key of PERSISTED_RESUME_TRANSPORT_KEYS[runtimeType]) {
    const value = nonEmptyString(params[key]);
    if (value) return value;
  }
  return null;
}

function transportMatches(runtimeType: NativeChatRuntimeType, persisted: string, declared: string): boolean {
  const normalizedDeclared = declared.trim().toLowerCase();
  const accepted = new Set([
    normalizedDeclared,
    ...NATIVE_TRANSPORT_ALIASES[runtimeType],
    ...(PROFILE_BOUND_TRANSPORT_ALIASES[runtimeType]?.[normalizedDeclared] ?? []),
  ].map((value) => value.trim().toLowerCase()));
  return accepted.has(persisted.trim().toLowerCase());
}

type PersistedResumeValidationFailure = {
  status: "unsupported" | "unknown";
  reason: string;
};

function validatePersistedResume(
  runtimeType: NativeChatRuntimeType,
  session: RuntimeDriverSession,
  binding: RuntimeProviderBindingRef | null,
  evidence: RuntimeProviderCapabilityEvidence | undefined,
): PersistedResumeValidationFailure | null {
  const params = session.sessionParams;
  const persistedIdentity = persistedProfileIdentity(params);
  if ((persistedIdentity.hostId || persistedIdentity.profileId) && !binding) {
    return {
      status: "unknown",
      reason: "The persisted native session has a provider profile identity but no current binding can verify it.",
    };
  }
  if (binding && persistedIdentity.hostId && persistedIdentity.hostId !== binding.hostId.trim()) {
    return {
      status: "unsupported",
      reason: `The persisted native session belongs to host ${persistedIdentity.hostId}, not ${binding.hostId}.`,
    };
  }
  if (binding && persistedIdentity.profileId && persistedIdentity.profileId !== binding.profileId.trim()) {
    return {
      status: "unsupported",
      reason: `The persisted native session belongs to provider profile ${persistedIdentity.profileId}, not ${binding.profileId}.`,
    };
  }

  const revisionOrUnknown = (value: unknown) => {
    const revision = nonEmptyString(value);
    return revision && revision.toLowerCase() !== "unknown" ? revision : null;
  };
  const persistedCapabilityRevision = revisionOrUnknown(params.capabilityRevision);
  const currentCapabilityRevision = revisionOrUnknown(binding?.capabilityRevision);
  if (persistedCapabilityRevision && !currentCapabilityRevision) {
    return {
      status: "unknown",
      reason: "The persisted native session has a capability revision but the current provider binding does not.",
    };
  }
  if (currentCapabilityRevision && persistedCapabilityRevision !== currentCapabilityRevision) {
    return {
      status: persistedCapabilityRevision ? "unsupported" : "unknown",
      reason: persistedCapabilityRevision
        ? "The persisted native session capability revision does not match the current provider binding."
        : "The persisted native session has no capability revision that can be checked against the current provider binding.",
    };
  }

  const persistedNativeTransport = persistedTransport(runtimeType, params);
  const declaredNativeTransport = nonEmptyString(evidence?.transport);
  if (persistedNativeTransport && !declaredNativeTransport) {
    return {
      status: "unknown",
      reason: "The persisted native session declares a transport but the current resume capability has no verified transport.",
    };
  }
  if (
    persistedNativeTransport
    && declaredNativeTransport
    && !transportMatches(runtimeType, persistedNativeTransport, declaredNativeTransport)
  ) {
    return {
      status: "unsupported",
      reason: `The persisted native session transport ${persistedNativeTransport} does not match the verified ${declaredNativeTransport} transport.`,
    };
  }
  return null;
}

function controlCapabilitiesFor(
  state: ProviderCapabilityState,
  binding: RuntimeProviderBindingRef | null,
): RuntimeDriverControlCapabilities {
  const providerCapabilities = state.adapter;
  const providerControl = providerCapabilities?.control;
  const steer = capabilityFromDeclaration(
    providerControl?.steer,
    providerCapabilities ? "The provider adapter did not declare native steer." : PROVIDER_CAPABILITY_GAP_REASONS.control,
    binding,
    state,
    { requiresResolver: true },
  );
  const interrupt = capabilityFromDeclaration(
    providerControl?.interrupt,
    providerCapabilities ? "The provider adapter did not declare native interrupt." : PROVIDER_CAPABILITY_GAP_REASONS.control,
    binding,
    state,
    { requiresResolver: true },
  );
  const steerWithMode = {
    ...steer,
    mode: providerControl?.steer?.mode === "interrupt_continue" ? "interrupt_continue" as const : "native" as const,
  };
  const interruptWithMode = {
    ...interrupt,
    mode: providerControl?.interrupt?.mode === "remote"
      ? "remote" as const
      : providerControl?.interrupt?.mode === "process"
        ? "process" as const
        : "native" as const,
  };
  const controlStatus = steer.status === "supported" || interrupt.status === "supported"
    ? "supported"
    : steer.status === "unknown" || interrupt.status === "unknown"
      ? "unknown"
      : "unsupported";
  return {
    status: controlStatus,
    reason: [steer.reason, interrupt.reason].filter(Boolean).join(" ") || PROVIDER_CAPABILITY_GAP_REASONS.control,
    steer: steerWithMode,
    interrupt: interruptWithMode,
  };
}

function ownerCapability(available: boolean, reason: string): RuntimeDriverCapability {
  return available
    ? { status: "supported", reason: "The authoritative Rudder owner is bound to this driver." }
    : { status: "unknown", reason };
}

function capabilitiesFor(
  state: ProviderCapabilityState,
  binding: RuntimeProviderBindingRef | null,
  options: RuntimeDriverFactoryOptions = {},
): RuntimeDriverCapabilities {
  const providerCapabilities = state.adapter;
  const sessionResume = capabilityFromDeclaration(
    providerCapabilities?.sessionResume,
    PROVIDER_CAPABILITY_GAP_REASONS.sessionResume,
    binding,
    state,
  );
  const input = capabilityFromDeclaration(
    providerCapabilities?.input,
    PROVIDER_CAPABILITY_GAP_REASONS.input,
    binding,
    state,
  );
  const transcript = capabilityFromDeclaration(
    providerCapabilities?.transcript,
    PROVIDER_CAPABILITY_GAP_REASONS.transcript,
    binding,
    state,
    { requiresResolver: true },
  );
  const fork = capabilityFromDeclaration(
    providerCapabilities?.fork,
    PROVIDER_CAPABILITY_GAP_REASONS.fork,
    binding,
    state,
    { requiresResolver: true },
  );
  const sideChatForkCleanup = capabilityFromDeclaration(
    providerCapabilities?.sideChatForkCleanup,
    PROVIDER_CAPABILITY_GAP_REASONS.sideChatForkCleanup,
    binding,
    state,
    { requiresResolver: true },
  );
  const contextHandoff = capabilityFromDeclaration(
    providerCapabilities?.contextHandoff,
    PROVIDER_CAPABILITY_GAP_REASONS.contextHandoff,
    binding,
    state,
  );
  return {
    sessionResume,
    input,
    transcriptRange: transcript.status === "supported"
      ? transcript
      : { ...transcript, reason: transcript.reason || unsupportedReasons.transcriptRange },
    control: controlCapabilitiesFor(state, binding),
    fork: fork.status === "supported"
      ? fork
      : { ...fork, reason: fork.reason || unsupportedReasons.fork },
    sideChatForkCleanup,
    contextHandoff,
    sessionBinding: ownerCapability(
      Boolean(options.sessionBindingOwner),
      "No Runtime Binding owner is bound to this driver.",
    ),
    executionInspection: ownerCapability(
      Boolean(options.unifiedRunReader),
      "No durable Unified Run reader is bound to this driver.",
    ),
    executionReconciliation: ownerCapability(
      Boolean(options.unifiedRunReader && options.unifiedRunReconciler),
      "Durable Unified Run read and reconciliation ports are required.",
    ),
    requestResponse: ownerCapability(
      Boolean(options.approvalBridge),
      "No runtime approval bridge is bound to this driver.",
    ),
    transcriptRead: ownerCapability(
      Boolean(options.transcriptReader),
      "No authorized Transcript Reader is bound to this driver.",
    ),
    conversationRead: ownerCapability(
      Boolean(options.transcriptReader),
      "No authorized Transcript Reader is bound to this driver.",
    ),
    retentionInspection: ownerCapability(
      Boolean(options.retentionService),
      "No runtime retention owner is bound to this driver.",
    ),
    retentionRelease: ownerCapability(
      Boolean(options.retentionService),
      "No runtime retention owner is bound to this driver.",
    ),
  };
}

export interface RuntimeDriver {
  readonly runtimeType: NativeChatRuntimeType;
  readonly adapter: ServerAgentRuntimeModule;
  readonly sessionCodec: AgentRuntimeSessionCodec | null;
  readonly capabilities: RuntimeDriverCapabilities;
  readonly providerCapabilities: RuntimeProviderCapabilityAdapter | null;
  readonly providerBinding: RuntimeProviderBindingRef | null;

  probe(profile: RuntimeDriverProfileProbeRequest): Promise<RuntimeDriverOperation<RuntimeDriverProfileProbeResult>>;

  /** Establish Rudder binding/segment state without implying provider execution. */
  ensureSession(intent: RuntimeBindingInput): Promise<RuntimeDriverOperation<RuntimeDriverSessionReady>>;

  /** Decode and normalize an existing provider session without creating one. */
  resume(input: RuntimeDriverResumeInput): RuntimeDriverOperation<RuntimeDriverSession>;

  /** Submit one new input through the existing adapter execute boundary. */
  submitInput(input: RuntimeDriverSubmitInput): Promise<AgentRuntimeExecutionResult>;

  /** Execute one submission and report the existing conservative acceptance classification. */
  submit(input: RuntimeDriverSubmitInput): Promise<RuntimeDriverOperation<RuntimeDriverSubmission>>;

  inspectExecution(input: { runId: string; attemptId?: string | null }): Promise<RuntimeDriverOperation<RuntimeDriverExecutionInspection>>;

  reconcileExecution(
    request: RuntimeDriverExecutionReconciliationRequest,
  ): Promise<RuntimeDriverOperation<Awaited<ReturnType<UnifiedAgentRunExecutionService["reconcileAcceptance"]>>>>;

  respondToRequest(
    request: AgentRuntimeApprovalRequest,
    timeoutMs: number,
  ): Promise<RuntimeDriverOperation<RuntimeDriverRequestResponse>>;

  /** Alias for callers that already prepared the complete adapter context. */
  execute(context: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult>;

  readTranscriptRange(
    request: RuntimeDriverTranscriptRangeRequest,
  ): Promise<RuntimeDriverOperation<RuntimeProviderTranscriptReadResult>>;

  readSpan(request: RuntimeDriverReadSpanRequest): Promise<RuntimeDriverOperation<TranscriptPage>>;

  readConversation(request: ReadConversationTranscript): Promise<RuntimeDriverOperation<TranscriptPage>>;

  fork(request: RuntimeDriverForkRequest): Promise<RuntimeDriverOperation<RuntimeProviderForkResult>>;

  branchAt(request: RuntimeDriverForkRequest): Promise<RuntimeDriverOperation<RuntimeProviderForkResult>>;

  inspectRetention(
    request: RuntimeDriverRetentionInspectionRequest,
  ): Promise<RuntimeDriverOperation<RuntimeRetentionInspection>>;

  release(
    request: RuntimeDriverRetentionReleaseRequest,
  ): Promise<RuntimeDriverOperation<RuntimeDriverRetentionReleaseResult>>;

  deleteSideChatForkSession(
    request: RuntimeDriverSideChatForkCleanupRequest,
  ): Promise<RuntimeDriverOperation<void>>;

  buildContextHandoff(
    request: RuntimeDriverContextHandoffRequest,
  ): RuntimeDriverOperation<RuntimeDriverContextHandoff>;

  contextHandoff(
    request: RuntimeDriverContextHandoffRequest,
  ): RuntimeDriverOperation<RuntimeDriverContextHandoff>;

  control(
    handle: AgentRuntimeControlHandle | null | undefined,
    operation: RuntimeDriverControlOperation,
    context?: RuntimeDriverControlContext,
  ): Promise<RuntimeDriverOperation<RuntimeDriverControlValue>>;
}

function unsupportedOperation<T>(capability: RuntimeDriverCapabilityName, reason: string): RuntimeDriverOperation<T> {
  return { status: "unsupported", capability, reason };
}

function unknownOperation<T>(capability: RuntimeDriverCapabilityName, reason: string): RuntimeDriverOperation<T> {
  return { status: "unknown", capability, reason };
}

function blockedOperation<T>(
  capability: RuntimeDriverCapabilityName,
  state: RuntimeDriverCapability,
): RuntimeDriverOperation<T> {
  return state.status === "unknown"
    ? unknownOperation(capability, state.reason)
    : unsupportedOperation(capability, state.reason);
}

function invalidOperation<T>(capability: RuntimeDriverCapabilityName, reason: string): RuntimeDriverOperation<T> {
  return { status: "invalid", capability, reason };
}

/** Use the same admitted binding projection at qualification and dispatch. */
export function bindRuntimeExecutionConfig(
  config: AgentRuntimeExecutionContext["config"],
  providerBinding: RuntimeProviderBindingRef | null,
): AgentRuntimeExecutionContext["config"] {
  return providerBinding ? {
    ...config,
    providerHostId: providerBinding.hostId,
    providerProfileId: providerBinding.profileId,
    providerBindingId: providerBinding.id ?? null,
    providerOrgId: providerBinding.orgId ?? null,
    providerWorkspaceBindingId: providerBinding.workspaceBindingId ?? null,
    capabilityRevision: providerBinding.capabilityRevision ?? null,
  } : config;
}

function createDriver(
  runtimeType: NativeChatRuntimeType,
  adapter: ServerAgentRuntimeModule,
  providerState: ProviderCapabilityState,
  providerBinding: RuntimeProviderBindingRef | null = null,
  resolveProviderState: (
    binding: RuntimeProviderBindingRef | null,
    context?: RuntimeProviderCapabilityResolverContext,
  ) => ProviderCapabilityState = () => providerState,
  factoryOptions: RuntimeDriverFactoryOptions = {},
): RuntimeDriver {
  const sessionCodec = adapter.sessionCodec ?? null;
  const providerCapabilities = providerState.adapter;
  const capabilities = capabilitiesFor(providerState, providerBinding, factoryOptions);
  const boundExecutionConfig = (config: AgentRuntimeExecutionContext["config"]) =>
    bindRuntimeExecutionConfig(config, providerBinding);

  const buildContextHandoff = (request: RuntimeDriverContextHandoffRequest): RuntimeDriverOperation<RuntimeDriverContextHandoff> => {
    if (capabilities.contextHandoff.status !== "supported") {
      return blockedOperation("context_handoff", capabilities.contextHandoff);
    }
    if (!request.input.trim()) {
      return invalidOperation("context_handoff", "A context handoff must include a new user input.");
    }
    return {
      status: "supported",
      value: {
        mode: "context_handoff",
        source: request.source,
        visibleContext: request.visibleContext.map((item) => ({ ...item })),
        input: request.input,
      },
    };
  };

  const driver: RuntimeDriver = {
    runtimeType,
    adapter,
    sessionCodec,
    capabilities,
    providerCapabilities,
    providerBinding,
    async probe(profile) {
      if (profile.agentRuntimeType !== runtimeType) {
        return invalidOperation("profile_probe", `Profile runtime ${profile.agentRuntimeType} does not match driver ${runtimeType}.`);
      }
      if (!profile.orgId.trim()) return invalidOperation("profile_probe", "A runtime profile probe requires an organization id.");
      const binding = profile.binding ?? providerBinding;
      const state = resolveProviderState(binding);
      const resolvedBinding = state.binding ?? binding;
      const probeCapabilities = capabilitiesFor(state, resolvedBinding, factoryOptions);
      const environment = await adapter.testEnvironment({
        orgId: profile.orgId,
        agentRuntimeType: runtimeType,
        config: profile.config,
        deployment: profile.deployment,
      });
      const declarations = [
        ["session_resume", state.adapter?.sessionResume?.evidence, probeCapabilities.sessionResume],
        ["input", state.adapter?.input?.evidence, probeCapabilities.input],
        ["transcript_range", state.adapter?.transcript?.evidence, probeCapabilities.transcriptRange],
        ["fork", state.adapter?.fork?.evidence, probeCapabilities.fork],
        ["steer", state.adapter?.control?.steer?.evidence, probeCapabilities.control.steer],
        ["interrupt", state.adapter?.control?.interrupt?.evidence, probeCapabilities.control.interrupt],
        ["context_handoff", state.adapter?.contextHandoff?.evidence, probeCapabilities.contextHandoff],
      ] as const;
      const providerEvidence = declarations.flatMap(([capability, evidence, effective]) => evidence
        ? [{
          capability,
          status: effective.status,
          reason: effective.reason,
          providerVersion: evidence.providerVersion,
          transport: evidence.transport,
          profileBound: evidence.profileBound,
        }]
        : []);
      return {
        status: "supported",
        value: {
          environment,
          binding: resolvedBinding ? { ...resolvedBinding } : null,
          capabilities: probeCapabilities,
          providerEvidence,
        },
      };
    },
    async ensureSession(intent) {
      if (!factoryOptions.sessionBindingOwner) {
        return blockedOperation("session_binding", capabilities.sessionBinding);
      }
      if (intent.runtimeType !== runtimeType) {
        return invalidOperation("session_binding", `Binding runtime ${intent.runtimeType} does not match driver ${runtimeType}.`);
      }
      if (!intent.orgId.trim()) return invalidOperation("session_binding", "A runtime session intent requires an organization id.");
      if (providerBinding?.orgId && providerBinding.orgId !== intent.orgId) {
        return invalidOperation("session_binding", "The requested organization does not match the driver binding.");
      }
      if (providerBinding && (
        providerBinding.hostId.trim() !== (intent.hostId?.trim() || "local")
        || providerBinding.profileId.trim() !== (intent.profileId?.trim() || "default")
        || (providerBinding.workspaceBindingId ?? null) !== (intent.workspaceBindingId?.trim() || null)
        || (providerBinding.capabilityRevision != null
          && providerBinding.capabilityRevision !== (intent.capabilityRevision?.trim() || "unknown"))
      )) {
        return invalidOperation("session_binding", "The requested provider profile does not match the driver binding.");
      }
      const binding = await factoryOptions.sessionBindingOwner.ensureBinding(intent);
      if (binding.runtimeType !== runtimeType || binding.orgId !== intent.orgId) {
        return invalidOperation("session_binding", "Runtime Binding owner returned an identity outside the requested runtime scope.");
      }
      const state = await factoryOptions.sessionBindingOwner.currentSession(binding);
      if (
        state.binding.id !== binding.id
        || state.binding.orgId !== binding.orgId
        || state.segment.bindingId !== binding.id
        || state.segment.runtimeType !== runtimeType
      ) {
        return invalidOperation("session_binding", "Runtime Binding owner returned a mismatched current Segment.");
      }
      const resolvedBinding: RuntimeProviderBindingRef = {
        id: binding.id,
        orgId: binding.orgId,
        hostId: binding.hostId,
        profileId: binding.profileId,
        workspaceBindingId: binding.workspaceBindingId,
        capabilityRevision: binding.capabilityRevision,
      };
      return {
        status: "supported",
        value: {
          binding: resolvedBinding,
          segmentId: state.segment.id,
          segmentState: state.segment.state,
          providerSession: state.sessionId
            ? driver.resume({
              sessionId: state.sessionId,
              sessionParams: state.sessionParams,
              sessionDisplayId: state.sessionDisplayId,
              binding: resolvedBinding,
            })
            : null,
        },
      };
    },
    resume(input) {
      const session = sessionFromParams(sessionCodec, input);
      if (!session) {
        return capabilities.sessionResume.status !== "supported"
          ? blockedOperation("session_resume", capabilities.sessionResume)
          : invalidOperation("session_resume", "The persisted session state has no decodable provider session ID.");
      }

      // A persisted session must be checked against the current profile-bound
      // resolver. The factory-time capability only describes a provider in the
      // abstract and cannot attest the transport that owns this session.
      const binding = input.binding ?? providerBinding;
      const resolvedState = resolveProviderState(binding, { session });
      const resolvedBinding = resolvedState.binding ?? binding;
      const resolvedResumeCapability = capabilityFromDeclaration(
        resolvedState.adapter?.sessionResume,
        PROVIDER_CAPABILITY_GAP_REASONS.sessionResume,
        resolvedBinding,
        resolvedState,
      );
      if (resolvedResumeCapability.status !== "supported") {
        return blockedOperation("session_resume", resolvedResumeCapability);
      }
      const persistedResumeFailure = validatePersistedResume(
        runtimeType,
        session,
        resolvedBinding,
        resolvedState.adapter?.sessionResume?.evidence,
      );
      if (persistedResumeFailure) {
        return persistedResumeFailure.status === "unknown"
          ? unknownOperation("session_resume", persistedResumeFailure.reason)
          : unsupportedOperation("session_resume", persistedResumeFailure.reason);
      }
      return { status: "supported", value: session };
    },
    async submitInput(input) {
      if (capabilities.input.status !== "supported") {
        throw new Error(`Runtime input is ${capabilities.input.status} for ${runtimeType}: ${capabilities.input.reason}`);
      }
      if (!input.input.text.trim()) {
        throw new Error(`Runtime input must be non-empty for ${runtimeType}.`);
      }
      const session = input.session;
      const runtime = session === undefined
        ? input.context.runtime
        : {
          ...input.context.runtime,
          sessionId: session?.sessionId ?? null,
          sessionParams: session?.sessionParams ?? null,
          sessionDisplayId: session?.sessionDisplayId ?? null,
        };
      const context: AgentRuntimeExecutionContext = {
        ...input.context,
        config: boundExecutionConfig(input.context.config),
        runtime,
        media: input.input.media,
        context: {
          ...input.context.context,
          chatMode: true,
          chatPrompt: input.input.text,
        },
      };
      return adapter.execute(context);
    },
    async submit(input) {
      if (capabilities.input.status !== "supported") {
        return blockedOperation("input", capabilities.input);
      }
      if (!input.input.text.trim()) return invalidOperation("input", "Runtime input must be non-empty.");
      const result = await driver.submitInput(input);
      const runtime = input.context.runtime;
      const session = input.session === undefined
        ? sessionFromParams(sessionCodec, {
          sessionId: runtime.sessionId,
          sessionParams: runtime.sessionParams,
          sessionDisplayId: runtime.sessionDisplayId,
        })
        : input.session;
      return {
        status: "supported",
        value: {
          phase: resolveExecutionSubmissionPhase(result),
          result,
          execution: {
            runId: input.context.runId,
            binding: providerBinding ? { ...providerBinding } : null,
            providerThreadId: result.providerThreadId ?? null,
            providerTurnId: result.providerTurnId ?? null,
            session,
          },
        },
      };
    },
    async inspectExecution(input) {
      if (!factoryOptions.unifiedRunReader) {
        return blockedOperation("execution_inspection", capabilities.executionInspection);
      }
      if (!input.runId.trim()) return invalidOperation("execution_inspection", "Execution inspection requires a Run id.");
      const entry = await factoryOptions.unifiedRunReader.get(input.runId);
      if (!entry) return { status: "supported", value: { state: "not_found" } };
      if (entry.attempt.runtimeType !== runtimeType) {
        return invalidOperation("execution_inspection", "The current attempt belongs to a different runtime.");
      }
      if (input.attemptId && entry.attempt.ref.id !== input.attemptId) {
        return invalidOperation("execution_inspection", "The requested attempt is no longer current.");
      }
      return { status: "supported", value: { state: "found", entry } };
    },
    async reconcileExecution(request) {
      if (!factoryOptions.unifiedRunReader || !factoryOptions.unifiedRunReconciler) {
        return blockedOperation("execution_reconciliation", capabilities.executionReconciliation);
      }
      if (!request.runId.trim() || !request.attemptId.trim()) {
        return invalidOperation("execution_reconciliation", "Submission reconciliation requires a Run and Attempt id.");
      }
      const entry = await factoryOptions.unifiedRunReader.get(request.runId);
      if (!entry) return invalidOperation("execution_reconciliation", "The Unified Run no longer exists.");
      if (
        entry.attempt.runtimeType !== runtimeType
        || entry.attempt.ref.id !== request.attemptId
        || entry.ownerFence.ownerToken !== request.fence.ownerToken
        || entry.ownerFence.attemptEpoch !== request.fence.attemptEpoch
      ) {
        return invalidOperation("execution_reconciliation", "The Run, Attempt, or owner fence is no longer current.");
      }
      const result = await factoryOptions.unifiedRunReconciler.reconcileAcceptance(
        request.runId,
        request.fence,
        request.outcome,
      );
      return { status: "supported", value: result };
    },
    async respondToRequest(request, timeoutMs) {
      if (!factoryOptions.approvalBridge) {
        return blockedOperation("request_response", capabilities.requestResponse);
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return invalidOperation("request_response", "A runtime request response requires a positive timeout.");
      }
      const handle = await factoryOptions.approvalBridge.requestApproval(request);
      const decision = await factoryOptions.approvalBridge.waitForApproval(handle.id, timeoutMs);
      return { status: "supported", value: { handle, decision } };
    },
    execute(context) {
      return adapter.execute({ ...context, config: boundExecutionConfig(context.config) });
    },
    async readTranscriptRange(request) {
      const binding = request.binding ?? providerBinding;
      const state = resolveProviderState(binding, {
        session: request.session,
        readerInput: request.readerInput,
      });
      const resolvedProviderCapabilities = state.adapter;
      const resolvedBinding = state.binding ?? binding;
      const transcriptStatus = capabilityFromDeclaration(
        resolvedProviderCapabilities?.transcript,
        PROVIDER_CAPABILITY_GAP_REASONS.transcript,
        resolvedBinding,
        state,
        { requiresResolver: true },
      );
      if (transcriptStatus.status !== "supported") {
        return blockedOperation("transcript_range", transcriptStatus);
      }
      if (!resolvedBinding?.hostId.trim() || !resolvedBinding.profileId.trim()) {
        return unknownOperation(
          "transcript_range",
          "A transcript read requires an explicit host and provider profile binding.",
        );
      }
      const capability = resolvedProviderCapabilities?.transcript;
      if (!capability?.readRange) {
        return unknownOperation("transcript_range", "The provider declared transcript capability without a read hook.");
      }
      const result = await capability.readRange({
        runtimeType,
        session: request.session,
        selector: request.selector,
        binding: resolvedBinding,
        range: request.range,
        from: request.from,
        through: request.through,
        cursor: request.cursor,
        readerInput: request.readerInput,
        signal: request.signal,
      });
      const value: RuntimeProviderTranscriptReadResult = Array.isArray(result as unknown)
        ? { items: Array.from(result as readonly NativeTranscriptRawItem[]) }
        : result as RuntimeProviderTranscriptReadResult;
      return {
        status: "supported",
        value,
      };
    },
    async readSpan(request) {
      if (!factoryOptions.transcriptReader) {
        return blockedOperation("transcript_read", capabilities.transcriptRead);
      }
      if (!request.orgId.trim() || !request.runId.trim() || !request.spanId.trim()) {
        return invalidOperation("transcript_read", "A span read requires organization, Run, and Span ids.");
      }
      if (providerBinding?.orgId && providerBinding.orgId !== request.orgId) {
        return invalidOperation("transcript_read", "The requested organization does not match the driver binding.");
      }
      const value = await factoryOptions.transcriptReader.readRun(request);
      return { status: "supported", value };
    },
    async readConversation(request) {
      if (!factoryOptions.transcriptReader) {
        return blockedOperation("conversation_read", capabilities.conversationRead);
      }
      if (!request.orgId.trim() || !request.conversationId.trim()) {
        return invalidOperation("conversation_read", "A conversation read requires organization and conversation ids.");
      }
      if (providerBinding?.orgId && providerBinding.orgId !== request.orgId) {
        return invalidOperation("conversation_read", "The requested organization does not match the driver binding.");
      }
      const value = await factoryOptions.transcriptReader.readConversation(request);
      return { status: "supported", value };
    },
    async fork(request) {
      const binding = request.binding ?? providerBinding;
      const state = resolveProviderState(binding, { session: request.session });
      const resolvedProviderCapabilities = state.adapter;
      const resolvedBinding = state.binding ?? binding;
      const forkStatus = capabilityFromDeclaration(
        resolvedProviderCapabilities?.fork,
        PROVIDER_CAPABILITY_GAP_REASONS.fork,
        resolvedBinding,
        state,
        { requiresResolver: true },
      );
      if (forkStatus.status !== "supported") {
        return blockedOperation("fork", forkStatus);
      }
      if (!resolvedBinding?.hostId.trim() || !resolvedBinding.profileId.trim()) {
        return unknownOperation(
          "fork",
          "A provider fork requires an explicit host and provider profile binding.",
        );
      }
      if (!request.boundary.trim()) {
        return invalidOperation("fork", "A provider fork requires a non-empty native boundary.");
      }
      const capability = resolvedProviderCapabilities?.fork;
      if (!capability?.fork) {
        return unknownOperation("fork", "The provider declared fork capability without a fork hook.");
      }
      return {
        status: "supported",
        value: await capability.fork({
          runtimeType,
          session: request.session,
          boundary: request.boundary,
          selector: request.selector,
          binding: resolvedBinding,
          signal: request.signal,
        }),
      };
    },
    branchAt(request) {
      return driver.fork(request);
    },
    async inspectRetention(request) {
      if (!factoryOptions.retentionService) {
        return blockedOperation("retention_inspection", capabilities.retentionInspection);
      }
      if (!request.orgId.trim() || request.resourceRefs.length === 0) {
        return invalidOperation("retention_inspection", "Retention inspection requires an organization and resource references.");
      }
      if (providerBinding?.orgId && providerBinding.orgId !== request.orgId) {
        return invalidOperation("retention_inspection", "The requested organization does not match the driver binding.");
      }
      const value = await factoryOptions.retentionService.inspect(request);
      return { status: "supported", value };
    },
    async release(request) {
      if (!factoryOptions.retentionService) {
        return blockedOperation("retention_release", capabilities.retentionRelease);
      }
      if (providerBinding?.orgId && providerBinding.orgId !== request.input.orgId) {
        return invalidOperation("retention_release", "The requested organization does not match the driver binding.");
      }
      if (request.kind === "claims") {
        const { orgId, purpose, principalScopeRef } = request.input;
        if (!orgId.trim() || !purpose.trim() || !principalScopeRef.trim()) {
          return invalidOperation("retention_release", "Claim release requires organization, purpose, and principal scope.");
        }
        const released = await factoryOptions.retentionService.releaseClaims(request.input);
        return {
          status: "supported",
          value: { kind: request.kind, releasedIds: released.map((claim) => claim.id) },
        };
      }
      const { orgId, principalScopeRef, sourceRefs } = request.input;
      if (!orgId.trim() || !principalScopeRef.trim() || !sourceRefs?.length || sourceRefs.some((ref) => !ref.trim())) {
        return invalidOperation("retention_release", "Alias release requires organization, principal scope, and explicit source references.");
      }
      const released = await factoryOptions.retentionService.releaseSourceAliases(request.input);
      return {
        status: "supported",
        value: { kind: request.kind, releasedIds: released.map((alias) => alias.id) },
      };
    },
    async deleteSideChatForkSession(request) {
      const binding = request.binding ?? providerBinding;
      const state = resolveProviderState(binding, {
        session: request.session,
        cleanupRunId: request.forkRunId ?? null,
      });
      const resolvedBinding = state.binding ?? binding;
      const capability = state.adapter?.sideChatForkCleanup;
      const status = capabilityFromDeclaration(
        capability,
        PROVIDER_CAPABILITY_GAP_REASONS.sideChatForkCleanup,
        resolvedBinding,
        state,
        { requiresResolver: true },
      );
      if (status.status !== "supported") {
        return blockedOperation("side_chat_fork_cleanup", status);
      }
      if (!resolvedBinding?.hostId.trim() || !resolvedBinding.profileId.trim()) {
        return unknownOperation(
          "side_chat_fork_cleanup",
          "Side Chat fork cleanup requires an explicit host and provider profile binding.",
        );
      }
      const expectedParentSessionId = request.expectedParentSessionId.trim();
      if (!expectedParentSessionId || expectedParentSessionId === request.session.sessionId.trim()) {
        return invalidOperation(
          "side_chat_fork_cleanup",
          "Side Chat fork cleanup requires a distinct, verified parent session id.",
        );
      }
      if (!capability?.deleteForkedSession) {
        return unknownOperation(
          "side_chat_fork_cleanup",
          "The provider declared Side Chat fork cleanup without an executable hook.",
        );
      }
      await capability.deleteForkedSession({
        runtimeType,
        session: request.session,
        expectedParentSessionId,
        binding: resolvedBinding,
        forkRunId: request.forkRunId ?? null,
        signal: request.signal,
      } satisfies RuntimeProviderSideChatForkCleanupRequest);
      return { status: "supported", value: undefined };
    },
    buildContextHandoff,
    contextHandoff: buildContextHandoff,
    async control(handle, operation, context) {
      const binding = context?.binding ?? providerBinding;
      const state = resolveProviderState(binding, { session: context?.session ?? null });
      const resolvedProviderCapabilities = state.adapter;
      const resolvedBinding = state.binding ?? binding;
      if (operation.kind === "steer") {
        const providerControl = resolvedProviderCapabilities?.control?.steer;
        const controlStatus = capabilityFromDeclaration(
          providerControl,
          resolvedProviderCapabilities ? "The provider adapter did not declare native steer." : PROVIDER_CAPABILITY_GAP_REASONS.control,
          resolvedBinding,
          state,
          { liveHandle: Boolean(handle), requiresResolver: true },
        );
        if (controlStatus.status !== "supported") return blockedOperation("control", controlStatus);
        if (providerControl?.requiresHandle && !handle) {
          return unknownOperation("control", "The provider control hook requires a live provider control handle.");
        }
        if (providerControl?.execute) {
          const value = await providerControl.execute({
            runtimeType,
            handle: handle ?? null,
            operation: operation as RuntimeProviderControlOperation,
            session: context?.session ?? null,
            binding: resolvedBinding,
          });
          return { status: "supported", value };
        }
        return unknownOperation("control", "The provider declared steer capability without an executable hook.");
      }
      const providerControl = resolvedProviderCapabilities?.control?.interrupt;
      const controlStatus = capabilityFromDeclaration(
        providerControl,
        resolvedProviderCapabilities ? "The provider adapter did not declare native interrupt." : PROVIDER_CAPABILITY_GAP_REASONS.control,
        resolvedBinding,
        state,
        { liveHandle: Boolean(handle), requiresResolver: true },
      );
      if (controlStatus.status !== "supported") return blockedOperation("control", controlStatus);
      if (providerControl?.requiresHandle && !handle) {
        return unknownOperation("control", "The provider control hook requires a live provider control handle.");
      }
      if (providerControl?.execute) {
        const value = await providerControl.execute({
          runtimeType,
          handle: handle ?? null,
          operation: operation as RuntimeProviderControlOperation,
          session: context?.session ?? null,
          binding: resolvedBinding,
        });
        return { status: "supported", value };
      }
      return unknownOperation("control", "The provider declared interrupt capability without an executable hook.");
    },
  };
  return driver;
}

export function createRuntimeDriver(
  runtimeType: string,
  options: RuntimeDriverFactoryOptions = {},
): RuntimeDriver {
  if (!isNativeChatRuntimeType(runtimeType)) {
    throw new Error(`Runtime type is not supported by the native chat driver: ${runtimeType}`);
  }
  const adapter = options.adapter ?? findServerAdapter(runtimeType);
  if (!adapter) throw new Error(`Runtime adapter is not registered: ${runtimeType}`);
  if (adapter.type !== runtimeType) {
    throw new Error(`Runtime adapter type mismatch: expected ${runtimeType}, received ${adapter.type}`);
  }
  const providerBinding = options.providerBinding ?? null;
  const resolveProviderState = (
    binding: RuntimeProviderBindingRef | null,
    context?: RuntimeProviderCapabilityResolverContext,
  ) => resolveProviderCapabilityState(runtimeType, options, binding, context);
  const providerState = resolveProviderState(providerBinding);
  return createDriver(runtimeType, adapter, providerState, providerBinding, resolveProviderState, options);
}

function resolveProviderCapabilityState(
  runtimeType: NativeChatRuntimeType,
  options: RuntimeDriverFactoryOptions,
  providerBinding: RuntimeProviderBindingRef | null,
  context?: RuntimeProviderCapabilityResolverContext,
): ProviderCapabilityState {
  if (options.providerCapabilities !== undefined) {
    const adapter = options.providerCapabilities;
    return adapter?.runtimeType === runtimeType
      ? { adapter, binding: null, profileResolved: false }
      : emptyProviderCapabilityState();
  }

  const usesStaticDeclarations = options.providerCapabilityResolver === undefined;
  const resolve = usesStaticDeclarations
    ? resolveRegisteredRuntimeProviderCapabilities
    : options.providerCapabilityResolver;
  if (!resolve) return emptyProviderCapabilityState();

  let resolution: RuntimeProviderCapabilityResolution | null | undefined;
  try {
    const resolved = context === undefined
      ? resolve(runtimeType, providerBinding)
      : resolve(runtimeType, providerBinding, context);
    resolution = normalizeRuntimeProviderCapabilityResolution(
      resolved,
      runtimeType,
      providerBinding,
    );
  } catch {
    return emptyProviderCapabilityState();
  }
  if (!resolution || resolution.adapter.runtimeType !== runtimeType) return emptyProviderCapabilityState();

  if (usesStaticDeclarations) {
    return {
      adapter: resolution.adapter,
      binding: null,
      profileResolved: false,
    };
  }
  const resolvedBinding = resolution.binding;
  if (
    resolution.profileResolved !== true
    || !resolvedBinding
    || !runtimeProviderBindingsMatch(resolvedBinding, providerBinding)
  ) {
    return emptyProviderCapabilityState();
  }
  return {
    adapter: resolution.adapter,
    binding: { ...resolvedBinding },
    profileResolved: true,
  };
}

export function getRuntimeDriver(
  runtimeType: string,
  options: RuntimeDriverFactoryOptions = {},
): RuntimeDriver | null {
  if (!isNativeChatRuntimeType(runtimeType)) return null;
  try {
    return createRuntimeDriver(runtimeType, options);
  } catch {
    return null;
  }
}

export function listRuntimeDrivers(options: RuntimeDriverFactoryOptions = {}): RuntimeDriver[] {
  return NATIVE_CHAT_RUNTIME_TYPES.map((runtimeType) => createRuntimeDriver(runtimeType, options));
}
