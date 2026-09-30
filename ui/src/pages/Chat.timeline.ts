import type { TranscriptEntry } from "@/agent-runtimes";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import {
  activeChatStreamTimelineInsertionIndex
} from "@/lib/chat-stream-state";
import type { Agent, ChatConversation, ChatMessage } from "@rudderhq/shared";

export type ChatTimelineRow =
  | { kind: "message"; message: ChatMessage; messageIndex: number; activeStream?: ChatStreamDraft }
  | { kind: "active_stream" };

export type ChatAssistantRowIdentityMap = Map<string, string>;

function chatAssistantGenerationRowIdentityKey(generationId: string, turnVariant: number | undefined) {
  return JSON.stringify([generationId, turnVariant ?? 0]);
}

function chatAssistantTurnRowIdentityKey(chatTurnId: string, turnVariant: number | undefined) {
  return `assistant-turn:${chatTurnId}:variant:${turnVariant ?? 0}`;
}

export function chatAssistantStreamRowKey(
  stream: Pick<ChatStreamDraft, "generationId" | "streamKey">
    & Partial<Pick<ChatStreamDraft, "chatTurnId" | "turnVariant">>,
) {
  if (stream.chatTurnId) {
    return chatAssistantTurnRowIdentityKey(stream.chatTurnId, stream.turnVariant);
  }
  return `assistant-stream:${stream.streamKey}:variant:${stream.turnVariant ?? 0}`;
}

export function rememberChatAssistantStreamRowIdentity(
  identities: ChatAssistantRowIdentityMap,
  stream: Pick<ChatStreamDraft, "generationId" | "streamKey">
    & Partial<Pick<ChatStreamDraft, "chatTurnId" | "turnVariant">>,
) {
  if (!stream.generationId) return;
  identities.set(
    chatAssistantGenerationRowIdentityKey(stream.generationId, stream.turnVariant),
    chatAssistantStreamRowKey(stream),
  );
}

export function chatAssistantMessageRowKey(
  message: Pick<ChatMessage, "id" | "role" | "generationId">
    & Partial<Pick<ChatMessage, "chatTurnId" | "turnVariant">>,
  activeStream?: Pick<ChatStreamDraft, "generationId" | "streamKey">
    & Partial<Pick<ChatStreamDraft, "chatTurnId" | "turnVariant">>
    | null,
  activeAssistantMessageId?: string | null,
  rowIdentities?: ReadonlyMap<string, string>,
) {
  if (message.role !== "assistant") return message.id;
  const sameTurnVariant = activeStream && message.turnVariant === activeStream.turnVariant;
  if (activeStream && (
    message.id === `stream-draft:${activeStream.streamKey}`
    || message.id === activeAssistantMessageId
    || Boolean(
      activeStream.generationId
      && message.generationId === activeStream.generationId
      && sameTurnVariant
    )
  )) {
    return chatAssistantStreamRowKey(activeStream);
  }
  const rememberedRowKey = message.generationId
    ? rowIdentities?.get(chatAssistantGenerationRowIdentityKey(message.generationId, message.turnVariant))
    : undefined;
  if (rememberedRowKey) return rememberedRowKey;
  if (message.chatTurnId) {
    return chatAssistantTurnRowIdentityKey(message.chatTurnId, message.turnVariant);
  }
  if (message.generationId) {
    return `assistant-generation:${message.generationId}:variant:${message.turnVariant ?? 0}`;
  }
  return message.id;
}

export function chatStreamDraftAssistantMessage(
  stream: ChatStreamDraft,
  conversation: Pick<ChatConversation, "id" | "orgId">,
  body: string,
): ChatMessage {
  return {
    id: `stream-draft:${stream.streamKey}`,
    orgId: conversation.orgId,
    conversationId: conversation.id,
    role: "assistant",
    kind: "message",
    status: "streaming",
    body,
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    replyingAgentId: stream.replyingAgentId,
    chatTurnId: stream.chatTurnId,
    turnVariant: stream.turnVariant,
    supersededAt: null,
    createdAt: stream.createdAt,
    updatedAt: stream.createdAt,
    generationId: stream.generationId ?? null,
  };
}

function mergeTranscriptRevision(
  previous: Extract<TranscriptEntry, { kind: "assistant" }>,
  incoming: Extract<TranscriptEntry, { kind: "assistant" }>,
) {
  if (incoming.delta !== true) return incoming;
  return { ...incoming, text: previous.text + incoming.text };
}

export function chatFinalAnswerFromTranscript(entries: TranscriptEntry[]) {
  const finalEntries: Extract<TranscriptEntry, { kind: "assistant" }>[] = [];
  const sourcePositions = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "assistant" || entry.phase !== "final_answer") continue;
    const sourceKey = entry.sourceEntryId ?? null;
    const existingPosition = sourceKey === null ? undefined : sourcePositions.get(sourceKey);
    if (existingPosition === undefined) {
      if (sourceKey !== null) sourcePositions.set(sourceKey, finalEntries.length);
      finalEntries.push(entry);
      continue;
    }
    const previous = finalEntries[existingPosition];
    if (previous) finalEntries[existingPosition] = mergeTranscriptRevision(previous, entry);
  }

  let text = "";
  let previous: (typeof finalEntries)[number] | null = null;
  for (const entry of finalEntries) {
    const continuesDelta = Boolean(
      previous
      && entry.delta
      && previous.delta
      && (previous.segmentId || entry.segmentId
        ? previous.segmentId === entry.segmentId
        : true),
    );
    if (
      text
      && !continuesDelta
      && !text.endsWith("\n")
      && !entry.text.startsWith("\n")
    ) {
      text += "\n";
    }
    text += entry.text;
    previous = entry;
  }

  return text.trim() ? text : null;
}

export function chatAgentUsesCodexAppServer(
  agent: Pick<Agent, "agentRuntimeType" | "agentRuntimeConfig"> | null | undefined,
) {
  if (!agent || agent.agentRuntimeType !== "codex_local") return false;
  const enabled = agent.agentRuntimeConfig.chatAppServerEnabled;
  if (typeof enabled === "boolean") return enabled;
  const command = agent.agentRuntimeConfig.command;
  return command === undefined || command === "codex";
}

export function chatStreamingAssistantBody(
  entries: TranscriptEntry[],
  fallbackBody: string,
  requireFinalAnswerPhase = false,
) {
  const hasExplicitAssistantPhase = entries.some((entry) => (
    entry.kind === "assistant"
    && (entry.phase === "commentary" || entry.phase === "final_answer")
  ));
  if (requireFinalAnswerPhase || hasExplicitAssistantPhase) {
    return chatFinalAnswerFromTranscript(entries) ?? "";
  }
  return fallbackBody.trim() ? fallbackBody : chatFinalAnswerFromTranscript(entries) ?? fallbackBody;
}

export function chatProcessTranscriptEntries(entries: TranscriptEntry[]) {
  return entries.filter((entry) => entry.kind !== "user"
    && !(entry.kind === "assistant" && entry.phase === "final_answer"));
}

export function buildChatTimelineRows(
  messages: ChatMessage[],
  activeStream: ChatStreamDraft | null,
  showActiveStreamDraft: boolean,
  activeAssistantMessageId: string | null = null,
) {
  const rows: ChatTimelineRow[] = messages.map((message, messageIndex) => ({
    kind: "message",
    message,
    messageIndex,
  }));
  if (!showActiveStreamDraft || !activeStream) return rows;
  const terminalMessageExists = Boolean(
    messages.some((message) => (
      message.role === "assistant"
      && message.id === activeAssistantMessageId
      && message.status !== "streaming"
    ))
    || (activeStream.generationId && messages.some((message) => (
      message.role === "assistant"
      && message.generationId === activeStream.generationId
      && message.status !== "streaming"
    ))),
  );
  if (terminalMessageExists) return rows;
  const activeMessageIndex = rows.findIndex((row) => (
    row.kind === "message"
    && row.message.role === "assistant"
    && row.message.status === "streaming"
    && (activeAssistantMessageId
      ? row.message.id === activeAssistantMessageId
      : Boolean(activeStream.generationId && row.message.generationId === activeStream.generationId))
  ));
  if (activeMessageIndex >= 0) {
    const row = rows[activeMessageIndex];
    if (row?.kind === "message") {
      rows[activeMessageIndex] = { ...row, activeStream };
      return rows;
    }
  }
  rows.splice(activeChatStreamTimelineInsertionIndex(messages, activeStream), 0, {
    kind: "active_stream",
  });
  return rows;
}
