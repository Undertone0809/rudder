import type { Db } from "@rudderhq/db";
import { createProfileBoundRuntimeProviderCapabilityResolverFromConfig } from "../agent-runtimes/index.js";
import { asString } from "./chat-assistant.helpers.js";
import type { createChatTranscriptDelivery } from "./chat-assistant.transcript-delivery.js";
import { filterNativeTransportProfile, persistNativeTransportProfile } from "./runtime-kernel/native-transport-profile.js";
import {
  normalizeRuntimeProviderCapabilityResolution,
  type RuntimeProviderBindingRef,
  type RuntimeProviderCapabilityResolver,
} from "./runtime-kernel/provider-capabilities.js";

type Session = { sessionId?: string | null; sessionParams?: Record<string, unknown> | null; sessionDisplayId?: string | null };

export function resolveChatTranscriptCapability(input: {
  runtimeType: string;
  config: Record<string, unknown>;
  continuationTransport: Record<string, unknown>;
  providerProfileCwd: string;
  providerCapabilityResolver: RuntimeProviderCapabilityResolver;
  binding: RuntimeProviderBindingRef;
  session: Session;
}) {
  const resolver = input.runtimeType === "pi_local"
    ? createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
        runtimeType: input.runtimeType,
        runtimeConfig: { ...input.config, ...input.continuationTransport },
        cwd: asString(input.continuationTransport.cwd) || input.providerProfileCwd,
      })
    : input.providerCapabilityResolver;
  return normalizeRuntimeProviderCapabilityResolution(
    resolver(input.runtimeType, input.binding, {
      session: input.session.sessionId ? {
        sessionId: input.session.sessionId,
        sessionParams: input.session.sessionParams ?? { sessionId: input.session.sessionId },
        sessionDisplayId: input.session.sessionDisplayId ?? input.session.sessionId,
      } : null,
    }),
    input.runtimeType,
    input.binding,
  );
}

export async function persistChatNativeTransport(input: {
  db: Db;
  profile: Record<string, unknown>;
  runtimeType: string;
  config: Record<string, unknown>;
  providerProfileCwd: string;
  binding: RuntimeProviderBindingRef;
  continuity: "native" | "context_handoff" | "legacy";
  resumeSessionId: string | null;
  run: {
    id: string; orgId: string; runtimeSpanId?: string | null; runtimeSpanOwnerToken?: string | null;
    runtimeSpanAttemptEpoch?: number | null; runtimeAttemptRef?: { id: string } | null;
  };
  transcript: ReturnType<typeof createChatTranscriptDelivery>;
  isInactive: () => boolean;
}) {
  if (input.isInactive()) throw new Error("Native transport profile rejected: Chat Run ownership was lost");
  const transport = filterNativeTransportProfile(input.profile);
  const freshPiBinding = input.runtimeType === "pi_local" && transport.runtimeType === "pi_local"
    && !input.resumeSessionId && input.continuity === "native";
  const witnessed = freshPiBinding
    ? resolveChatTranscriptCapability({
        runtimeType: "pi_local", config: input.config, continuationTransport: transport,
        providerProfileCwd: input.providerProfileCwd,
        providerCapabilityResolver: createProfileBoundRuntimeProviderCapabilityResolverFromConfig(),
        binding: input.binding, session: {},
      })
    : null;
  const attested = witnessed?.profileResolved === true
    && witnessed.adapter.transcript?.evidence.status === "supported"
    && witnessed.adapter.transcript.evidence.profileBound === true;
  const { run } = input;
  const spanId = run.runtimeSpanId;
  const ownerToken = run.runtimeSpanOwnerToken;
  const attemptEpoch = run.runtimeSpanAttemptEpoch;
  const attemptId = run.runtimeAttemptRef?.id;
  if (!spanId || !ownerToken || attemptEpoch == null || !attemptId) {
    throw new Error("Native transport profile requires the current Run span and attempt");
  }
  const persist = (nativeTranscriptAttested: boolean) => persistNativeTransportProfile(input.db, {
    orgId: run.orgId, runId: run.id,
    spanId, ownerToken, attemptEpoch, attemptId,
    profile: transport, nativeTranscriptAttested,
  });
  if (attested && await input.transcript.onNativeTranscriptSource(() => persist(true))) return;
  await persist(false);
}
