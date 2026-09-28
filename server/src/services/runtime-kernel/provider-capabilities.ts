import { runtimeProviderCapabilities as claudeLocalProviderCapabilities } from "@rudderhq/agent-runtime-claude-local/server";
import { runtimeProviderCapabilities as codexLocalProviderCapabilities } from "@rudderhq/agent-runtime-codex-local/server";
import { runtimeProviderCapabilities as cursorLocalProviderCapabilities } from "@rudderhq/agent-runtime-cursor-local/server";
import { runtimeProviderCapabilities as hermesGatewayProviderCapabilities } from "@rudderhq/agent-runtime-hermes-gateway/server";
import { runtimeProviderCapabilities as openCodeLocalProviderCapabilities } from "@rudderhq/agent-runtime-opencode-local/server";
import { runtimeProviderCapabilities as piLocalProviderCapabilities } from "@rudderhq/agent-runtime-pi-local/server";
import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
} from "@rudderhq/agent-runtime-utils";
import type {
  NativeSpanSelector,
  NativeTranscriptRawItem,
  NativeTranscriptReadInput,
  NativeTranscriptReaderHook,
  TranscriptAvailability,
  TranscriptCompleteness,
  TranscriptRange,
  TranscriptSource,
} from "./transcript-reader.js";

export type { NativeSpanSelector, NativeTranscriptRawItem, NativeTranscriptReadInput } from "./transcript-reader.js";

export type RuntimeProviderCapabilityStatus = "supported" | "unsupported" | "unknown";

export type RuntimeProviderCapabilityName =
  | "session_resume"
  | "input"
  | "transcript_range"
  | "control"
  | "fork"
  | "context_handoff";

/** Evidence is intentionally stricter than provider installation/version discovery. */
export interface RuntimeProviderCapabilityEvidence {
  status: RuntimeProviderCapabilityStatus;
  reason: string;
  providerVersion?: string | null;
  transport?: string | null;
  /** True only when the hook has been resolved against a concrete provider profile. */
  profileBound: boolean;
  /** Profile-bound I/O must not be advertised without a concrete binding. */
  profileRequired?: boolean;
}

export interface RuntimeProviderCapabilityDeclaration {
  evidence: RuntimeProviderCapabilityEvidence;
}

export interface RuntimeProviderSessionRef {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
}

/**
 * Context available when a provider resolver is re-entered by a reader or
 * another session-aware operation. Transport state remains host-owned; the
 * session is only an attested, persisted input for provider-side validation.
 */
export interface RuntimeProviderCapabilityResolverContext {
  session?: RuntimeProviderSessionRef | null;
  readerInput?: NativeTranscriptReadInput | null;
  /** Fork run whose persisted OpenCode profile is being cleaned after restart. */
  cleanupRunId?: string | null;
}

/** Opaque binding metadata; it never carries credentials or local paths. */
export interface RuntimeProviderBindingRef {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
}

export interface RuntimeProviderTranscriptReadRequest {
  runtimeType: string;
  session: RuntimeProviderSessionRef;
  selector?: NativeSpanSelector | null;
  binding?: RuntimeProviderBindingRef | null;
  range?: TranscriptRange | null;
  from?: string | null;
  through?: string | null;
  cursor?: string | null;
  readerInput?: NativeTranscriptReadInput | null;
  signal?: AbortSignal;
}

export interface RuntimeProviderTranscriptReadResult {
  items?: readonly NativeTranscriptRawItem[];
  entries?: readonly NativeTranscriptRawItem[];
  nextCursor?: string | null;
  revision?: string | null;
  source?: TranscriptSource;
  availability?: TranscriptAvailability;
  completeness?: TranscriptCompleteness;
}

export interface RuntimeProviderTranscriptCapability {
  evidence: RuntimeProviderCapabilityEvidence;
  readRange?: (
    input: RuntimeProviderTranscriptReadRequest,
  ) => Promise<RuntimeProviderTranscriptReadResult | readonly NativeTranscriptRawItem[]>;
}

export interface RuntimeProviderForkRequest {
  runtimeType: string;
  session: RuntimeProviderSessionRef;
  boundary: string;
  selector?: NativeSpanSelector | null;
  binding?: RuntimeProviderBindingRef | null;
  signal?: AbortSignal;
}

export interface RuntimeProviderForkResult {
  session: RuntimeProviderSessionRef;
  boundary: string;
  sourceBoundary?: string | null;
  identityMap?: Record<string, string>;
  continuity: "native";
}

export interface RuntimeProviderForkCapability {
  evidence: RuntimeProviderCapabilityEvidence;
  fork?: (input: RuntimeProviderForkRequest) => Promise<RuntimeProviderForkResult>;
}

export interface RuntimeProviderSideChatForkCleanupRequest {
  runtimeType: string;
  session: RuntimeProviderSessionRef;
  expectedParentSessionId: string;
  binding: RuntimeProviderBindingRef;
  forkRunId?: string | null;
  signal?: AbortSignal;
}

export interface RuntimeProviderSideChatForkCleanupCapability {
  evidence: RuntimeProviderCapabilityEvidence;
  deleteForkedSession?: (input: RuntimeProviderSideChatForkCleanupRequest) => Promise<void>;
}

export type RuntimeProviderControlOperation =
  | { kind: "steer"; input: AgentRuntimeControlSteerInput }
  | { kind: "interrupt"; reason: AgentRuntimeControlInterruptReason };

export type RuntimeProviderControlValue =
  | AgentRuntimeControlSteerResult
  | AgentRuntimeControlInterruptResult;

export interface RuntimeProviderControlRequest {
  runtimeType: string;
  handle: AgentRuntimeControlHandle | null;
  operation: RuntimeProviderControlOperation;
  session?: RuntimeProviderSessionRef | null;
  binding?: RuntimeProviderBindingRef | null;
}

export interface RuntimeProviderControlOperationCapability<T> {
  evidence: RuntimeProviderCapabilityEvidence;
  mode?: "native" | "process" | "remote" | "interrupt_continue";
  /** Some declarations are intentionally unknown until a profile hook is installed. */
  execute?: (input: RuntimeProviderControlRequest) => Promise<T>;
  /** True when this hook can only forward a live provider control handle. */
  requiresHandle?: boolean;
}

export interface RuntimeProviderControlCapability {
  steer?: RuntimeProviderControlOperationCapability<AgentRuntimeControlSteerResult>;
  interrupt?: RuntimeProviderControlOperationCapability<AgentRuntimeControlInterruptResult>;
}

export interface RuntimeProviderCapabilityAdapter {
  runtimeType: string;
  sessionResume?: RuntimeProviderCapabilityDeclaration;
  input?: RuntimeProviderCapabilityDeclaration;
  contextHandoff?: RuntimeProviderCapabilityDeclaration;
  transcript?: RuntimeProviderTranscriptCapability;
  fork?: RuntimeProviderForkCapability;
  sideChatForkCleanup?: RuntimeProviderSideChatForkCleanupCapability;
  control?: RuntimeProviderControlCapability;
}

/**
 * A resolver result is the server-owned attestation that the returned adapter
 * was selected for this exact opaque binding. The binding contains identity
 * metadata only; credentials and provider transport state stay in the
 * resolver/adapter closure.
 */
export interface RuntimeProviderCapabilityResolution {
  adapter: RuntimeProviderCapabilityAdapter;
  /** Null for declaration-only/static results. */
  binding: RuntimeProviderBindingRef | null;
  /** Static results are deliberately false; injected profile resolvers return true. */
  profileResolved: boolean;
}

/** Resolver shape used by provider packages before server attestation. */
export type RuntimeProviderAdapterResolver = (
  runtimeType: string,
  binding?: RuntimeProviderBindingRef | null,
  context?: RuntimeProviderCapabilityResolverContext,
) => RuntimeProviderCapabilityAdapter | null | undefined;

export type RuntimeProviderCapabilityResolver = (
  runtimeType: string,
  binding?: RuntimeProviderBindingRef | null,
  context?: RuntimeProviderCapabilityResolverContext,
) => RuntimeProviderCapabilityResolution | RuntimeProviderCapabilityAdapter | null | undefined;

export const PROVIDER_CAPABILITY_GAP_REASONS = {
  adapter: "No provider capability adapter has been registered for this runtime.",
  sessionResume: "No provider-declared session resume capability has been registered.",
  input: "No provider-declared input capability has been registered.",
  transcript: "No profile-bound provider transcript reader has been registered.",
  fork: "No profile-bound provider boundary fork hook has been registered.",
  sideChatForkCleanup: "No profile-bound Side Chat fork cleanup hook has been registered.",
  control: "No profile-bound provider control hook has been registered.",
  contextHandoff: "No provider-declared context handoff capability has been registered.",
} as const;

export interface RuntimeProviderCapabilityResolutionContext {
  binding?: RuntimeProviderBindingRef | null;
  /** A live provider handle is itself profile-bound evidence for control forwarding. */
  liveHandle?: boolean;
  /** True only when an injected resolver returned a matching profile adapter. */
  profileResolved?: boolean;
  /** Binding identity attested by the resolver. */
  resolvedBinding?: RuntimeProviderBindingRef | null;
  /** Native transcript/fork/control always require the injected resolver path. */
  requiresResolver?: boolean;
}

const BINDING_IDENTITY_KEYS = [
  "id",
  "orgId",
  "workspaceBindingId",
  "capabilityRevision",
] as const;

function hasBindingIdentity(binding: RuntimeProviderBindingRef | null | undefined): binding is RuntimeProviderBindingRef {
  return Boolean(binding?.hostId?.trim() && binding.profileId?.trim());
}

/** Compare only opaque binding identity; never inspect credentials or paths. */
export function runtimeProviderBindingsMatch(
  left: RuntimeProviderBindingRef | null | undefined,
  right: RuntimeProviderBindingRef | null | undefined,
): boolean {
  if (!hasBindingIdentity(left) || !hasBindingIdentity(right)) return false;
  if (left.hostId.trim() !== right.hostId.trim() || left.profileId.trim() !== right.profileId.trim()) return false;
  return BINDING_IDENTITY_KEYS.every((key) => {
    const leftValue = left[key] ?? null;
    const rightValue = right[key] ?? null;
    return leftValue === null && rightValue === null ? true : leftValue === rightValue;
  });
}

/** Normalize legacy provider-package resolver results at the server boundary. */
export function normalizeRuntimeProviderCapabilityResolution(
  result: RuntimeProviderCapabilityResolution | RuntimeProviderCapabilityAdapter | null | undefined,
  runtimeType: string,
  binding?: RuntimeProviderBindingRef | null,
): RuntimeProviderCapabilityResolution | null {
  if (!result || typeof result !== "object") return null;
  if ("adapter" in result) {
    const resolution = result as RuntimeProviderCapabilityResolution;
    if (resolution.adapter?.runtimeType !== runtimeType) return null;
    const resolvedBinding = resolution.binding;
    const profileResolved = resolution.profileResolved === true
      && hasBindingIdentity(binding)
      && hasBindingIdentity(resolvedBinding)
      && runtimeProviderBindingsMatch(resolvedBinding, binding);
    return {
      adapter: resolution.adapter,
      binding: hasBindingIdentity(resolvedBinding) ? { ...resolvedBinding } : null,
      profileResolved,
    };
  }
  const adapter = result as RuntimeProviderCapabilityAdapter;
  if (adapter.runtimeType !== runtimeType) return null;
  // A package's static registration is declaration-only. Only the explicit
  // adapter-resolver adapter path below may attest a concrete profile.
  return {
    adapter,
    binding: null,
    profileResolved: false,
  };
}

export function providerCapabilityReason(
  evidence: RuntimeProviderCapabilityEvidence | undefined,
  fallback: string,
  context: RuntimeProviderCapabilityResolutionContext = {},
): { status: RuntimeProviderCapabilityStatus; reason: string } {
  if (!evidence) return { status: "unsupported", reason: fallback };
  if (evidence.status === "unsupported") return { status: "unsupported", reason: evidence.reason };
  if (evidence.status === "unknown") return { status: "unknown", reason: evidence.reason };

  const binding = context.binding;
  const hasBinding = hasBindingIdentity(binding);
  const profileRequired = evidence.profileRequired === true;
  if (context.requiresResolver && context.profileResolved !== true) {
    return {
      status: "unknown",
      reason: `${evidence.reason} A profile-bound provider resolver has not resolved this capability.`,
    };
  }
  if (profileRequired && context.profileResolved !== true) {
    return {
      status: "unknown",
      reason: `${evidence.reason} A profile-bound provider resolver is required before this capability can be used.`,
    };
  }
  if (profileRequired && (!context.resolvedBinding || !runtimeProviderBindingsMatch(context.resolvedBinding, binding))) {
    return {
      status: "unsupported",
      reason: `${evidence.reason} The resolved provider profile does not match the requested binding.`,
    };
  }
  if (!evidence.profileBound && !context.liveHandle) {
    return {
      status: "unknown",
      reason: `${evidence.reason} The provider adapter has not produced profile-bound evidence.`,
    };
  }
  if (profileRequired && !hasBinding) {
    return {
      status: "unknown",
      reason: `${evidence.reason} Provider profile binding is required before this capability can be resolved.`,
    };
  }
  if (profileRequired && hasBinding && !evidence.profileBound && !context.liveHandle) {
    return {
      status: "unknown",
      reason: `${evidence.reason} The provider adapter has not confirmed the requested profile binding.`,
    };
  }
  return { status: "supported", reason: evidence.reason };
}

function bindingRefFromReaderInput(input: NativeTranscriptReadInput): RuntimeProviderBindingRef | null {
  const binding = input.binding;
  if (!binding || !binding.hostId.trim() || !binding.profileId.trim()) return null;
  return {
    id: binding.id,
    orgId: binding.orgId,
    hostId: binding.hostId,
    profileId: binding.profileId,
    workspaceBindingId: binding.workspaceBindingId,
    capabilityRevision: binding.capabilityRevision,
  };
}

function selectorSessionId(selector: NativeSpanSelector): string | null {
  const record = selector as Record<string, unknown>;
  switch (record.kind) {
    case "codex_turn": return typeof record.threadId === "string" ? record.threadId : null;
    case "claude_chain": return typeof record.sessionId === "string" ? record.sessionId : null;
    case "hermes_execution": return typeof record.sessionRef === "string" ? record.sessionRef : null;
    case "opencode_input": return typeof record.sessionId === "string" ? record.sessionId : null;
    case "pi_branch_range": return typeof record.sessionResourceRef === "string" ? record.sessionResourceRef : null;
    case "cursor_execution": return typeof record.sessionId === "string" ? record.sessionId : null;
    default: {
      return typeof record.sessionId === "string" ? record.sessionId : null;
    }
  }
}

function sessionFromReaderInput(input: NativeTranscriptReadInput): RuntimeProviderSessionRef | null {
  const sessionId = input.segment?.nativeSessionId?.trim() || selectorSessionId(input.selector);
  if (!sessionId) return null;
  const state = input.segment?.providerStateJson;
  const sessionParams = state && typeof state === "object" && !Array.isArray(state)
    ? { ...(state as Record<string, unknown>), sessionId }
    : { sessionId };
  return { sessionId, sessionParams, sessionDisplayId: sessionId };
}

function unavailableTranscriptResult(
  availability: TranscriptAvailability,
  completeness: TranscriptCompleteness,
  revision: string,
): RuntimeProviderTranscriptReadResult {
  return {
    items: [],
    nextCursor: null,
    source: "native",
    revision,
    availability,
    completeness,
  };
}

/**
 * Adapt verified provider capability registrations to the database-backed
 * Transcript Reader hook. The binding and span are required so a session ID
 * cannot be used as a global lookup key.
 */
export function createRuntimeNativeTranscriptReaderHook(
  resolve: RuntimeProviderCapabilityResolver,
): NativeTranscriptReaderHook & Required<Pick<NativeTranscriptReaderHook, "readRange">> {
  return {
    async readRange(input) {
      const runtimeType = input.binding?.runtimeType?.trim();
      const binding = bindingRefFromReaderInput(input);
      const session = sessionFromReaderInput(input);
      const resolution = runtimeType && binding
        ? normalizeRuntimeProviderCapabilityResolution(
          resolve(runtimeType, binding, { session, readerInput: input }),
          runtimeType,
          binding,
        )
        : null;
      const capability = resolution?.adapter.transcript ?? null;
      if (!runtimeType || !capability || !binding || !input.segment || !session) {
        return unavailableTranscriptResult(
          !input.binding || !input.segment ? "missing" : "offline",
          input.span.completeness,
          `unavailable:${input.span.id}`,
        );
      }
      const status = providerCapabilityReason(
        capability.evidence,
        PROVIDER_CAPABILITY_GAP_REASONS.transcript,
        {
          binding,
          profileResolved: resolution?.profileResolved === true,
          resolvedBinding: resolution?.binding,
          requiresResolver: true,
        },
      );
      if (status.status !== "supported" || !capability.readRange) {
        return unavailableTranscriptResult(
          "offline",
          input.span.completeness,
          `${status.status}:${input.span.id}`,
        );
      }
      return capability.readRange({
        runtimeType,
        session,
        selector: input.selector,
        binding,
        range: input.range,
        cursor: input.cursor,
        readerInput: input,
        signal: input.signal,
      });
    },
  };
}

export function capabilityAdapterMap(
  adapters: readonly RuntimeProviderCapabilityAdapter[],
): RuntimeProviderCapabilityResolver {
  const byType = new Map(adapters.map((adapter) => [adapter.runtimeType, adapter]));
  return (runtimeType) => {
    const adapter = byType.get(runtimeType);
    if (!adapter) return null;
    return {
      adapter: unresolvedStaticCapabilityAdapter(adapter),
      binding: null,
      profileResolved: false,
    };
  };
}

function unresolvedEvidence(
  evidence: RuntimeProviderCapabilityEvidence,
): RuntimeProviderCapabilityEvidence {
  if (evidence.status === "unsupported") return evidence;
  if (evidence.profileRequired !== true && evidence.profileBound === true) return evidence;
  return {
    ...evidence,
    status: "unknown",
    profileBound: false,
    reason: `${evidence.reason} Static provider declarations are not profile-bound evidence; inject a verified provider resolver.`,
  };
}

/** Keep static registration useful for generic declarations without exposing native provider I/O. */
function unresolvedStaticCapabilityAdapter(
  adapter: RuntimeProviderCapabilityAdapter,
): RuntimeProviderCapabilityAdapter {
  return {
    ...adapter,
    ...(adapter.sessionResume ? { sessionResume: { evidence: unresolvedEvidence(adapter.sessionResume.evidence) } } : {}),
    ...(adapter.input ? { input: { evidence: unresolvedEvidence(adapter.input.evidence) } } : {}),
    ...(adapter.contextHandoff ? { contextHandoff: { evidence: unresolvedEvidence(adapter.contextHandoff.evidence) } } : {}),
    ...(adapter.transcript ? { transcript: { ...adapter.transcript, evidence: unresolvedEvidence(adapter.transcript.evidence) } } : {}),
    ...(adapter.fork ? { fork: { ...adapter.fork, evidence: unresolvedEvidence(adapter.fork.evidence) } } : {}),
    ...(adapter.control ? {
      control: {
        ...adapter.control,
        ...(adapter.control.steer ? { steer: { ...adapter.control.steer, evidence: unresolvedEvidence(adapter.control.steer.evidence) } } : {}),
        ...(adapter.control.interrupt ? { interrupt: { ...adapter.control.interrupt, evidence: unresolvedEvidence(adapter.control.interrupt.evidence) } } : {}),
      },
    } : {}),
  };
}

/**
 * Adapt an existing provider-package resolver to the strict server contract.
 * The package resolver remains responsible for checking its concrete profile
 * transport identity; this wrapper records the requested opaque binding and
 * never copies transport credentials into it.
 */
export function adaptRuntimeProviderCapabilityResolver(
  resolve: RuntimeProviderAdapterResolver | null | undefined,
): RuntimeProviderCapabilityResolver {
  return (runtimeType, binding, context) => {
    if (!resolve || !hasBindingIdentity(binding)) return null;
    let adapter: RuntimeProviderCapabilityAdapter | null | undefined;
    try {
      adapter = resolve(runtimeType, binding, context);
    } catch {
      return null;
    }
    if (!adapter || adapter.runtimeType !== runtimeType) return null;
    const profileEvidence = [
      adapter.sessionResume?.evidence,
      adapter.input?.evidence,
      adapter.contextHandoff?.evidence,
      adapter.transcript?.evidence,
      adapter.fork?.evidence,
      adapter.control?.steer?.evidence,
      adapter.control?.interrupt?.evidence,
    ].find((evidence) => evidence?.status === "supported"
      && evidence.profileBound === true
      && (evidence.profileRequired === true || evidence === adapter.input?.evidence));
    if (!profileEvidence) return null;
    return {
      adapter,
      binding: { ...binding },
      profileResolved: true,
    };
  };
}

/**
 * Build the production resolver boundary from host-owned provider resolvers.
 * Only the selected runtime's resolver is called, and each result is
 * attested against the exact binding passed to the factory.
 */
export function createProfileBoundRuntimeProviderCapabilityResolver(
  resolvers: Readonly<Record<string, RuntimeProviderAdapterResolver | null | undefined>>,
): RuntimeProviderCapabilityResolver {
  const adaptedResolvers = new Map(
    Object.entries(resolvers).map(([runtimeType, resolve]) => [
      runtimeType,
      adaptRuntimeProviderCapabilityResolver(resolve),
    ]),
  );
  return (runtimeType, binding, context) => adaptedResolvers.get(runtimeType)?.(runtimeType, binding, context) ?? null;
}

/** Compose provider-specific profile resolvers without falling back to static declarations. */
export function composeRuntimeProviderCapabilityResolvers(
  resolvers: readonly (RuntimeProviderCapabilityResolver | null | undefined)[],
): RuntimeProviderCapabilityResolver {
  return (runtimeType, binding, context) => {
    if (!hasBindingIdentity(binding)) return null;
    for (const resolve of resolvers) {
      if (!resolve) continue;
      let result: RuntimeProviderCapabilityResolution | RuntimeProviderCapabilityAdapter | null | undefined;
      try {
        result = resolve(runtimeType, binding, context);
      } catch {
        result = null;
      }
      const resolution = normalizeRuntimeProviderCapabilityResolution(result, runtimeType, binding);
      if (!resolution || resolution.profileResolved !== true) continue;
      if (!runtimeProviderBindingsMatch(resolution.binding, binding)) continue;
      return resolution;
    }
    return null;
  };
}

/**
 * Production provider registration. These are exported by the provider
 * packages beside their real execute implementations; the resolver does not
 * infer capabilities from the generic registry adapter or session codec.
 * Profile-specific transports may replace an entry through the factory's
 * injected resolver once their evidence is verified.
 */
export const REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS: readonly RuntimeProviderCapabilityAdapter[] = [
  codexLocalProviderCapabilities as unknown as RuntimeProviderCapabilityAdapter,
  claudeLocalProviderCapabilities as unknown as RuntimeProviderCapabilityAdapter,
  hermesGatewayProviderCapabilities as unknown as RuntimeProviderCapabilityAdapter,
  openCodeLocalProviderCapabilities as unknown as RuntimeProviderCapabilityAdapter,
  piLocalProviderCapabilities as unknown as RuntimeProviderCapabilityAdapter,
  cursorLocalProviderCapabilities as unknown as RuntimeProviderCapabilityAdapter,
];

const registeredRuntimeProviderCapabilityResolver = capabilityAdapterMap(
  REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS,
);

export function resolveRegisteredRuntimeProviderCapabilities(
  runtimeType: string,
  binding?: RuntimeProviderBindingRef | null,
): RuntimeProviderCapabilityResolution | null {
  // The registered map is declaration-only. A binding ref alone is not
  // provider evidence and must never promote native I/O to supported.
  void binding;
  return normalizeRuntimeProviderCapabilityResolution(
    registeredRuntimeProviderCapabilityResolver(runtimeType, null),
    runtimeType,
    null,
  );
}
