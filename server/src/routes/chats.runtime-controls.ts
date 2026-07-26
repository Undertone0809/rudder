import { chatConversations } from "@rudderhq/db";
import { conflict } from "../errors.js";

export type ChatRuntimeSnapshot = {
  agentId: string | null;
  model: string | null;
  effort: string | null;
};

type RuntimeDescriptor = {
  runtimeAgentId?: string | null;
  model?: string | null;
  effort?: string | null;
};

export function chatRuntimeSnapshot(
  runtime: RuntimeDescriptor,
  preferredModel?: string | null,
): ChatRuntimeSnapshot {
  return {
    agentId: runtime.runtimeAgentId ?? null,
    model: preferredModel
      ?? (runtime.model === "Default model" ? null : runtime.model ?? null),
    effort: runtime.effort ?? null,
  };
}

export function chatRuntimeInvocationSnapshot(runtime: RuntimeDescriptor) {
  const snapshot = chatRuntimeSnapshot(runtime);
  return {
    agentIdSnapshot: snapshot.agentId,
    modelSnapshot: snapshot.model,
    effortSnapshot: snapshot.effort,
  };
}

export function queuedChatRuntimeInvocationSnapshot(item: {
  runtimeSnapshotVersion?: number | null;
  payload?: {
    agentId?: string | null;
    model?: string | null;
    effort?: string | null;
  } | null;
}) {
  return item.runtimeSnapshotVersion === 1
      ? {
        ...(typeof item.payload?.agentId === "string"
          ? { agentIdSnapshot: item.payload.agentId }
          : {}),
        modelSnapshot: item.payload?.model ?? null,
        effortSnapshot: item.payload?.effort ?? null,
      }
    : {};
}

type ConversationPatch = Partial<typeof chatConversations.$inferInsert>;

export function prepareChatConversationPatch(
  body: ConversationPatch & { resolvedAt?: string | Date | null },
  existingPreferredAgentId: string | null,
) {
  const preferredAgentChanged = typeof body.preferredAgentId === "string"
    && body.preferredAgentId !== existingPreferredAgentId;
  if (preferredAgentChanged && existingPreferredAgentId) {
    throw conflict("Chat agent is locked after the conversation starts");
  }
  const patch: ConversationPatch = {
    ...body,
    ...(preferredAgentChanged ? { modelOverride: null, effortOverride: null } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "resolvedAt")
      ? {
          resolvedAt: body.resolvedAt
            ? new Date(body.resolvedAt)
            : body.resolvedAt,
        }
      : {}),
  };
  const updatesAgentRuntimeInvariant = Object.prototype.hasOwnProperty.call(
    body,
    "preferredAgentId",
  )
    || Object.prototype.hasOwnProperty.call(body, "modelOverride")
    || Object.prototype.hasOwnProperty.call(body, "effortOverride");
  return { patch, updatesAgentRuntimeInvariant };
}
