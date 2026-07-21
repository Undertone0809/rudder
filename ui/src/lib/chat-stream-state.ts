import type { TranscriptEntry } from "@/agent-runtimes";
import type { ChatMessage } from "@rudderhq/shared";

const EMBEDDED_NATIVE_STEER_DISPOSITIONS = new Set([
  "pending",
  "acceptance_unknown",
  "accepted_current",
]);

export type NativeSteerTranscriptAnchor = {
  message: ChatMessage;
  targetGenerationId: string;
  afterTranscriptEntryCount: number;
  generationSeq: number;
  controlActionId: string | null;
};

function structuredPayloadString(
  payload: Record<string, unknown> | null,
  key: string,
) {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function structuredPayloadNonNegativeInteger(
  payload: Record<string, unknown> | null,
  key: string,
) {
  const value = payload?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function nativeSteerTranscriptAnchor(
  message: ChatMessage,
): NativeSteerTranscriptAnchor | null {
  if (message.role !== "user" || message.structuredPayload?.source !== "steer") return null;
  const deliveryDisposition = structuredPayloadString(message.structuredPayload, "deliveryDisposition");
  if (!deliveryDisposition || !EMBEDDED_NATIVE_STEER_DISPOSITIONS.has(deliveryDisposition)) return null;
  const targetGenerationId = structuredPayloadString(message.structuredPayload, "targetGenerationId");
  const afterTranscriptEntryCount = structuredPayloadNonNegativeInteger(
    message.structuredPayload,
    "afterTranscriptEntryCount",
  );
  if (!targetGenerationId || afterTranscriptEntryCount === null) return null;
  return {
    message,
    targetGenerationId,
    afterTranscriptEntryCount,
    generationSeq: structuredPayloadNonNegativeInteger(message.structuredPayload, "generationSeq") ?? 0,
    controlActionId: structuredPayloadString(message.structuredPayload, "controlActionId"),
  };
}

export function mergeNativeSteerTranscriptEntries(
  entries: TranscriptEntry[],
  steerMessages: ChatMessage[],
): TranscriptEntry[] {
  const anchors = steerMessages
    .map(nativeSteerTranscriptAnchor)
    .filter((anchor): anchor is NativeSteerTranscriptAnchor => Boolean(anchor))
    .sort((left, right) => (
      left.afterTranscriptEntryCount - right.afterTranscriptEntryCount
      || left.generationSeq - right.generationSeq
      || new Date(left.message.createdAt).getTime() - new Date(right.message.createdAt).getTime()
      || left.message.id.localeCompare(right.message.id)
    ));
  if (anchors.length === 0) return entries;

  const anchorsByEntryCount = new Map<number, NativeSteerTranscriptAnchor[]>();
  for (const anchor of anchors) {
    const insertionIndex = Math.min(anchor.afterTranscriptEntryCount, entries.length);
    const bucket = anchorsByEntryCount.get(insertionIndex) ?? [];
    bucket.push(anchor);
    anchorsByEntryCount.set(insertionIndex, bucket);
  }

  const merged: TranscriptEntry[] = [];
  for (let entryCount = 0; entryCount <= entries.length; entryCount += 1) {
    if (entryCount > 0) merged.push(entries[entryCount - 1]!);
    for (const anchor of anchorsByEntryCount.get(entryCount) ?? []) {
      merged.push({
        kind: "user",
        source: "steer",
        ts: new Date(anchor.message.createdAt).toISOString(),
        text: anchor.message.body,
        messageId: anchor.message.id,
        controlActionId: anchor.controlActionId ?? undefined,
      });
    }
  }
  return merged;
}

export type ActiveChatStreamVisibilityState = {
  userCreatedAt: Date;
  chatTurnId: string | null;
};

export type ActiveChatStreamTimelineState = {
  userCreatedAt: Date;
  userMessageId: string | null;
};

export type ActiveChatStreamEditState = ActiveChatStreamTimelineState & {
  editedFromCreatedAt: Date | null;
};

export function setChatFlagState(
  current: Record<string, true>,
  chatId: string,
  inFlight: boolean,
): Record<string, true> {
  if (inFlight) {
    if (current[chatId]) return current;
    return { ...current, [chatId]: true };
  }
  if (!current[chatId]) return current;
  const { [chatId]: _removed, ...rest } = current;
  return rest;
}

export function setChatScopedState<T>(
  current: Record<string, T>,
  chatId: string,
  value: T | null,
): Record<string, T> {
  if (value === null) {
    if (!(chatId in current)) return current;
    const { [chatId]: _removed, ...rest } = current;
    return rest;
  }
  return { ...current, [chatId]: value };
}

export function readChatScopedFlag(
  current: Record<string, true>,
  chatId: string | null | undefined,
): boolean {
  return Boolean(chatId && current[chatId]);
}

export function readChatScopedState<T>(
  current: Record<string, T>,
  chatId: string | null | undefined,
): T | null {
  if (!chatId) return null;
  return current[chatId] ?? null;
}

export function shouldShowMessageDuringActiveStream(
  message: Pick<ChatMessage, "role" | "chatTurnId" | "createdAt">,
  activeStream: ActiveChatStreamVisibilityState,
): boolean {
  if (message.role === "user") return true;
  if (activeStream.chatTurnId && message.chatTurnId === activeStream.chatTurnId) return false;
  return new Date(message.createdAt).getTime() < activeStream.userCreatedAt.getTime();
}

export function activeChatStreamTimelineInsertionIndex(
  messages: Array<Pick<ChatMessage, "id" | "createdAt">>,
  activeStream: ActiveChatStreamTimelineState,
): number {
  const persistedUserMessageIndex = activeStream.userMessageId
    ? messages.findIndex((message) => message.id === activeStream.userMessageId)
    : -1;
  if (persistedUserMessageIndex >= 0) return persistedUserMessageIndex + 1;

  const firstMessageAtOrAfterActiveUser = messages.findIndex(
    (message) => new Date(message.createdAt).getTime() >= activeStream.userCreatedAt.getTime(),
  );
  return firstMessageAtOrAfterActiveUser >= 0 ? firstMessageAtOrAfterActiveUser : messages.length;
}

export function shouldShowMessageDuringActiveEdit(
  message: Pick<ChatMessage, "id" | "role" | "createdAt">,
  activeStream: ActiveChatStreamEditState,
): boolean {
  if (!activeStream.editedFromCreatedAt) return true;

  const messageCreatedAtMs = new Date(message.createdAt).getTime();
  if (messageCreatedAtMs < activeStream.editedFromCreatedAt.getTime()) return true;

  return message.role === "user"
    && message.id !== activeStream.userMessageId
    && messageCreatedAtMs >= activeStream.userCreatedAt.getTime();
}
