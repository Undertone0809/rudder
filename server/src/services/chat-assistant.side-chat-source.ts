import type { Db } from "@rudderhq/db";
import {
  chatMessages,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import type { ChatConversation } from "@rudderhq/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { asRecord, type ChatNativeContextHandoff, type StreamChatAssistantReplyInput } from "./chat-assistant.helpers.js";
import { filterNativeTransportProfile } from "./runtime-kernel/native-transport-profile.js";
import type { NativeSpanSelector } from "./runtime-kernel/provider-capabilities.js";
import type { SideChatForkSource, SideChatRuntimeAdmission } from "./side-chat-runtime-admission.js";

export function deriveSideChatContextHandoff(
  input: StreamChatAssistantReplyInput,
  admission: SideChatRuntimeAdmission | null,
  existingContinuity: string | null | undefined,
): ChatNativeContextHandoff | null {
  if (input.conversation.conversationKind !== "side_chat"
    || (admission?.continuity !== "context_handoff" && existingContinuity !== "context_handoff")) return null;
  const currentUserMessageId = input.userMessageId
    ?? [...input.messages].reverse().find((message) => message.role === "user")?.id ?? null;
  const items = input.messages
    .filter((message) => message.id !== currentUserMessageId)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, kind: message.kind, body: message.body, sourceId: message.id }));
  if (!items.length) return null;
  return {
    sourceConversationId: admission?.sourceConversationId
      ?? input.conversation.forkedFromConversationId ?? input.conversation.id,
    sourceMessageId: admission?.sourceMessageId
      ?? input.conversation.forkedFromMessageId ?? items.at(-1)!.sourceId,
    items,
  };
}

type LoadedSideChatForkSource = SideChatForkSource & {
  /** The exact closed Run span selector; never infer this from the segment head. */
  selectorJson: NativeSpanSelector | null;
};

export function sideChatForkBindingMatchesTarget(
  binding: SideChatForkSource["sourceBinding"],
  runtimeType: string,
  target: {
    orgId: string;
    principalScopeRef: string;
    hostId: string;
    profileId: string;
    workspaceBindingId: string | null;
    capabilityRevision: string;
  },
) {
  return Boolean(binding && binding.runtimeType === runtimeType
    && binding.orgId === target.orgId
    && binding.principalScopeRef === target.principalScopeRef
    && binding.hostId === target.hostId
    && binding.profileId === target.profileId
    && binding.workspaceBindingId === target.workspaceBindingId
    && binding.capabilityRevision === target.capabilityRevision);
}

export function sideChatForkSourceIdentityMatches(input: {
  orgId: string;
  sourceConversationId: string | null;
  sourceRun: {
    id: string;
    agentId: string;
    chatConversationId: string | null;
    sessionIdAfter?: string | null;
  } | null;
  sourceSpan: { runId: string; bindingId: string; selectorJson: unknown } | null;
  sourceSegment: {
    bindingId: string;
    runtimeType: string;
    nativeSessionId: string | null;
  } | null;
  sourceBinding: {
    id: string;
    orgId: string;
    conversationId: string | null;
    agentId: string;
    runtimeType: string;
  } | null;
  sourceProviderProfile: Record<string, unknown> | null;
}) {
  const selector = asRecord(input.sourceSpan?.selectorJson);
  const kind = selector?.kind;
  const selectorSessionId = kind === "codex_turn" ? selector?.threadId
    : kind === "claude_chain" ? selector?.sessionId
      : kind === "hermes_execution" ? selector?.sessionRef
        : kind === "opencode_input" ? selector?.sessionId
          : kind === "pi_branch_range" ? selector?.sessionResourceRef
            : kind === "cursor_execution" ? selector?.sessionId
              : null;
  const selectorRuntimeType = typeof selector?.runtimeType === "string" ? selector.runtimeType
    : kind === "codex_turn" ? "codex_local"
      : kind === "claude_chain" ? "claude_local"
        : kind === "hermes_execution" ? "hermes_gateway"
          : kind === "opencode_input" ? "opencode_local"
            : kind === "pi_branch_range" ? "pi_local"
              : kind === "cursor_execution" ? "cursor"
                : null;
  const sessionId = input.sourceSegment?.nativeSessionId?.trim();
  const runSessionId = input.sourceRun?.sessionIdAfter?.trim();
  return Boolean(
    input.sourceConversationId
    && input.sourceRun
    && input.sourceRun.chatConversationId === input.sourceConversationId
    && input.sourceSpan
    && input.sourceSpan.runId === input.sourceRun.id
    && input.sourceSegment
    && input.sourceSegment.bindingId === input.sourceSpan.bindingId
    && input.sourceBinding
    && input.sourceBinding.id === input.sourceSpan.bindingId
    && input.sourceBinding.orgId === input.orgId
    && input.sourceBinding.conversationId === input.sourceConversationId
    && input.sourceBinding.agentId === input.sourceRun.agentId
    && input.sourceBinding.runtimeType === input.sourceSegment.runtimeType
    && input.sourceProviderProfile?.runtimeType === input.sourceBinding.runtimeType
    && typeof selectorSessionId === "string"
    && selectorSessionId.trim() === sessionId
    && (!runSessionId || runSessionId === sessionId)
    && (!selectorRuntimeType || selectorRuntimeType === input.sourceBinding.runtimeType)
  );
}

export async function loadSideChatForkSource(
  db: Db,
  conversation: Pick<ChatConversation, "orgId" | "forkedFromConversationId" | "forkedFromMessageId">,
): Promise<LoadedSideChatForkSource> {
  const sourceConversationId = conversation.forkedFromConversationId?.trim() || null;
  const sourceMessageId = conversation.forkedFromMessageId?.trim() || null;
  const sourceMessage = sourceConversationId && sourceMessageId
    ? await db
      .select({ runId: chatMessages.runId })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, conversation.orgId),
        eq(chatMessages.conversationId, sourceConversationId),
        eq(chatMessages.id, sourceMessageId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  const sourceRun = sourceMessage?.runId
    ? await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        chatConversationId: heartbeatRuns.chatConversationId,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.orgId, conversation.orgId),
        eq(heartbeatRuns.id, sourceMessage.runId),
        eq(heartbeatRuns.chatConversationId, sourceConversationId!),
        eq(heartbeatRuns.status, "succeeded"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  // Chat messages point to a Run, not a native span. A multi-span Run has no
  // persisted message-to-span mapping, so do not guess which native boundary
  // the selected assistant message represents.
  const sourceSpans = sourceRun
    ? await db
      .select({
        id: runRuntimeSpans.id,
        runId: runRuntimeSpans.runId,
        nativeExecutionRef: runRuntimeSpans.nativeExecutionRef,
        segmentId: runRuntimeSpans.segmentId,
        bindingId: runRuntimeSpans.bindingId,
        selectorJson: runRuntimeSpans.selectorJson,
        state: runRuntimeSpans.state,
        completeness: runRuntimeSpans.completeness,
      })
      .from(runRuntimeSpans)
      .where(and(
        eq(runRuntimeSpans.orgId, conversation.orgId),
        eq(runRuntimeSpans.runId, sourceRun.id),
      ))
      .limit(2)
      .then((rows) => rows)
    : null;
  const onlySourceSpan = sourceSpans?.length === 1 ? sourceSpans[0] : null;
  const sourceSpan = onlySourceSpan?.state === "sealed" && onlySourceSpan.completeness === "complete"
    ? onlySourceSpan
    : null;
  const sourceSegment = sourceSpan
    ? await db
      .select({
        nativeSessionId: nativeSegments.nativeSessionId,
        bindingId: nativeSegments.bindingId,
        runtimeType: nativeSegments.runtimeType,
        providerStateJson: nativeSegments.providerStateJson,
        leafId: nativeSegments.leafId,
        sourceBoundaryRef: nativeSegments.sourceBoundaryRef,
      })
      .from(nativeSegments)
      .where(and(
        eq(nativeSegments.orgId, conversation.orgId),
        eq(nativeSegments.id, sourceSpan.segmentId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  const sessionId = sourceSegment?.nativeSessionId?.trim() || null;
  const sourceBinding = sourceSpan ? await db.select().from(runtimeBindings).where(and(
    eq(runtimeBindings.id, sourceSpan.bindingId), eq(runtimeBindings.orgId, conversation.orgId),
  )).limit(1).then((rows) => rows[0] ?? undefined) : undefined;
  const sourceProviderProfile = asRecord(asRecord(sourceRun?.contextSnapshot)?.runtimeProviderProfile);
  const sourceIdentityValid = sideChatForkSourceIdentityMatches({
    orgId: conversation.orgId,
    sourceConversationId,
    sourceRun,
    sourceSpan,
    sourceSegment: sourceSegment
      ? { ...sourceSegment, nativeSessionId: sourceSegment.nativeSessionId ?? null }
      : null,
    sourceBinding: sourceBinding ?? null,
    sourceProviderProfile,
  });
  const sourceBoundaryRef = sourceSpan?.nativeExecutionRef?.trim()
    || sourceSegment?.leafId?.trim()
    || sourceSegment?.sourceBoundaryRef?.trim()
    || null;

  return {
    sourceConversationId,
    sourceMessageId,
    sourceRunId: sourceIdentityValid ? sourceRun!.id : null,
    sourceBoundaryRef: sourceIdentityValid ? sourceBoundaryRef : null,
    sourceSpanId: sourceIdentityValid ? sourceSpan!.id : null,
    selectorJson: sourceIdentityValid
      ? (sourceSpan!.selectorJson as NativeSpanSelector | null | undefined) ?? null
      : null,
    sourceBinding: sourceIdentityValid ? sourceBinding : undefined,
    sourceProviderProfile: sourceIdentityValid ? sourceProviderProfile : null,
    session: sourceIdentityValid && sessionId
      ? {
        sessionId,
        sessionParams: sourceSegment?.providerStateJson ?? { sessionId },
        sessionDisplayId: sessionId,
      }
      : null,
  };
}

export function deriveSideChatForkSourceForCurrentProfile(
  source: LoadedSideChatForkSource,
  runtimeType: string,
  currentConfig: Record<string, unknown>,
): LoadedSideChatForkSource {
  if (
    runtimeType !== "opencode_local"
    || source.sourceBinding?.runtimeType !== runtimeType
    || source.sourceProviderProfile?.runtimeType !== runtimeType
    || !source.session
  ) {
    return source;
  }

  const sourceParams = asRecord(source.session.sessionParams) ?? {};
  const serverUrl = [currentConfig.serverUrl, currentConfig.opencodeServerUrl, sourceParams.serverUrl]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const transportProfile = filterNativeTransportProfile({
    runtimeType,
    command: currentConfig.command,
    cwd: currentConfig.cwd,
    serverCommand: currentConfig.serverCommand,
    exportCommand: currentConfig.exportCommand,
    providerVersion: currentConfig.providerVersion,
    serverUrl,
    exportEnv: currentConfig.exportEnv ?? currentConfig.opencodeExportEnv,
  });
  const sessionIdentity = Object.fromEntries(Object.entries(sourceParams).filter(([key]) => ![
    "command",
    "cwd",
    "directory",
    "serverUrl",
    "serverCommand",
    "exportCommand",
    "exportEnv",
    "providerVersion",
    "transport",
  ].includes(key)));
  const sessionParams = {
    ...sessionIdentity,
    ...transportProfile,
    transport: "opencode-managed-server-http",
    sessionId: source.session.sessionId,
  };
  return {
    ...source,
    sourceProviderProfile: transportProfile,
    session: {
      ...source.session,
      sessionParams,
    },
  };
}

export function chatContinuationTransportProfile(
  runtimeType: string,
  latestRunProfile: unknown,
  admittedSession: SideChatForkSource["session"] | null,
): Record<string, unknown> {
  const admittedParams = admittedSession ? asRecord(admittedSession.sessionParams) : null;
  const profile = admittedParams
    ? { ...admittedParams, runtimeType }
    : asRecord(latestRunProfile);
  return profile?.runtimeType === runtimeType
    && (runtimeType === "opencode_local" || runtimeType === "pi_local")
    ? filterNativeTransportProfile(profile)
    : {};
}

export async function loadChatContinuationTransportProfile(db: Db, input: {
  orgId: string;
  bindingId: string;
  segmentId: string;
  sessionId: string | null;
  runtimeType: string;
}) {
  if (!input.sessionId || !["pi_local", "opencode_local"].includes(input.runtimeType)) return null;
  const previous = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(runRuntimeSpans)
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, runRuntimeSpans.runId),
      eq(heartbeatRuns.orgId, runRuntimeSpans.orgId),
    ))
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.bindingId, input.bindingId),
      eq(runRuntimeSpans.segmentId, input.segmentId),
      eq(heartbeatRuns.sessionIdAfter, input.sessionId),
      sql`${heartbeatRuns.contextSnapshot}->'runtimeProviderProfile' ? ${input.runtimeType === "pi_local" ? "rpcArgs" : "serverUrl"}`,
    ))
    .orderBy(desc(runRuntimeSpans.openedAt), desc(runRuntimeSpans.ordinal))
    .limit(1).then((rows) => rows[0] ?? null);
  return asRecord(asRecord(previous?.contextSnapshot)?.runtimeProviderProfile);
}

export async function resolveChatContinuationSession(db: Db, input: {
  runtimeType: string;
  config: Record<string, unknown>;
  binding: NonNullable<SideChatForkSource["sourceBinding"]> & { id: string; orgId: string };
  segmentId: string;
  session: { sessionId: string | null; sessionParams: Record<string, unknown> | null; sessionDisplayId: string | null };
  admittedSession: SideChatForkSource["session"] | null;
}) {
  const previousProfile = await loadChatContinuationTransportProfile(db, {
    orgId: input.binding.orgId,
    bindingId: input.binding.id,
    segmentId: input.segmentId,
    sessionId: input.session.sessionId,
    runtimeType: input.runtimeType,
  });
  const transport = chatContinuationTransportProfile(input.runtimeType, previousProfile, input.admittedSession);
  // OpenCode's run-scoped export environment cannot be inherited from a
  // stopped Run; the current managed profile supplies its execution authority.
  const currentOpenCodeTransport = input.runtimeType === "opencode_local"
    ? filterNativeTransportProfile({ ...input.config, runtimeType: input.runtimeType })
    : null;
  const runtimeExecutionConfig = {
    ...input.config,
    ...(transport.runtimeType === input.runtimeType ? transport : {}),
    ...currentOpenCodeTransport,
    ...(currentOpenCodeTransport ? { exportEnv: currentOpenCodeTransport.exportEnv ?? {} } : {}),
  };
  return {
    runtimeExecutionConfig,
    continuationTransport: input.runtimeType === "opencode_local"
      ? filterNativeTransportProfile({ ...runtimeExecutionConfig, runtimeType: input.runtimeType })
      : transport,
    initialSession: chatSessionForCurrentProviderProfile(
      input.runtimeType, input.session, runtimeExecutionConfig, input.binding,
    ),
  };
}

export function chatSessionForCurrentProviderProfile(
  runtimeType: string,
  session: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
  },
  currentProfile: Record<string, unknown>,
  binding: NonNullable<SideChatForkSource["sourceBinding"]>,
) {
  if (runtimeType !== "opencode_local" || !session.sessionId) return session;

  const staleTransportKeys = new Set([
    "command",
    "cwd",
    "directory",
    "serverUrl",
    "serverCommand",
    "exportCommand",
    "providerVersion",
    "exportEnv",
    "transport",
    "hostId",
    "profileId",
    "profileBindingId",
    "profileOrgId",
    "workspaceBindingId",
    "capabilityRevision",
  ]);
  const sessionIdentity = Object.fromEntries(
    Object.entries(asRecord(session.sessionParams) ?? {}).filter(([key]) => !staleTransportKeys.has(key)),
  );
  const transportProfile = filterNativeTransportProfile({ ...currentProfile, runtimeType });

  return {
    ...session,
    sessionParams: {
      ...sessionIdentity,
      ...transportProfile,
      sessionId: session.sessionId,
      transport: "opencode-managed-server-http",
      hostId: binding.hostId,
      profileId: binding.profileId,
      ...(binding.id ? { profileBindingId: binding.id } : {}),
      ...(binding.orgId ? { profileOrgId: binding.orgId } : {}),
      ...(binding.workspaceBindingId ? { workspaceBindingId: binding.workspaceBindingId } : {}),
      ...(binding.capabilityRevision ? { capabilityRevision: binding.capabilityRevision } : {}),
      ...(typeof transportProfile.cwd === "string" ? { directory: transportProfile.cwd } : {}),
    },
  };
}
