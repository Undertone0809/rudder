import type { TranscriptEntry } from "@/agent-runtimes";
import {
  isInternalTranscriptLifecycleEntry,
  isRudderEchoedStructuredConversationInputEntry,
} from "@/components/transcript/RunTranscriptView.common";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { activeChatStreamTimelineInsertionIndex } from "@/lib/chat-stream-state";
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
  return `assistant-stream:${stream.streamKey}:variant:${stream.turnVariant ?? 0}`;
}

export function rememberChatAssistantStreamRowIdentity(
  identities: ChatAssistantRowIdentityMap,
  stream: Pick<ChatStreamDraft, "generationId" | "streamKey">
    & Partial<Pick<ChatStreamDraft, "chatTurnId" | "turnVariant">>,
) {
  const rowKey = chatAssistantStreamRowKey(stream);
  if (stream.generationId) {
    identities.set(
      chatAssistantGenerationRowIdentityKey(stream.generationId, stream.turnVariant),
      rowKey,
    );
  }
  if (stream.chatTurnId) {
    identities.set(chatAssistantTurnRowIdentityKey(stream.chatTurnId, stream.turnVariant), rowKey);
  }
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
  const sameTurnVariant = activeStream
    && (message.turnVariant ?? 0) === (activeStream.turnVariant ?? 0);
  if (activeStream && (
    message.id === `stream-draft:${activeStream.streamKey}`
    || message.id === activeAssistantMessageId
    || Boolean(
      activeStream.generationId
      && message.generationId === activeStream.generationId
      && sameTurnVariant
    )
    || Boolean(
      activeStream.chatTurnId
      && message.chatTurnId === activeStream.chatTurnId
      && sameTurnVariant
    )
  )) {
    return chatAssistantStreamRowKey(activeStream);
  }
  const rememberedGenerationRowKey = message.generationId
    ? rowIdentities?.get(chatAssistantGenerationRowIdentityKey(message.generationId, message.turnVariant))
    : undefined;
  if (rememberedGenerationRowKey) return rememberedGenerationRowKey;
  const rememberedTurnRowKey = message.chatTurnId
    ? rowIdentities?.get(chatAssistantTurnRowIdentityKey(message.chatTurnId, message.turnVariant))
    : undefined;
  if (rememberedTurnRowKey) return rememberedTurnRowKey;
  if (message.chatTurnId) {
    return chatAssistantTurnRowIdentityKey(message.chatTurnId, message.turnVariant);
  }
  if (message.generationId) {
    return `assistant-generation:${message.generationId}:variant:${message.turnVariant ?? 0}`;
  }
  return message.id;
}

export function buildFailedChatRetryInput<TConversation extends Pick<ChatConversation, "id">>(
  sourceUserMessage: Pick<ChatMessage, "id" | "body">,
  conversation: TConversation,
) {
  return {
    bodyOverride: sourceUserMessage.body,
    filesOverride: [] as File[],
    conversationOverride: conversation,
    editUserMessageIdOverride: sourceUserMessage.id,
    editIntent: "retry" as const,
  };
}

export function shouldShowOptimisticChatUserMessage(
  activeStream: Pick<ChatStreamDraft, "userBody" | "userFiles" | "userMessageId">
    | null,
  messages: ChatMessage[],
) {
  if (!activeStream) return false;
  const userFiles = activeStream.userFiles ?? [];
  if (!activeStream.userMessageId) return true;
  const existingUserMessage = messages.find((message) => message.id === activeStream.userMessageId);
  if (!existingUserMessage) return true;
  const matchingPersistedAttachments = [...existingUserMessage.attachments];
  const optimisticFilesArePersisted = userFiles.every((file) => {
    const attachmentIndex = matchingPersistedAttachments.findIndex((attachment) => (
      attachment.originalFilename === file.name
      && attachment.byteSize === file.size
    ));
    if (attachmentIndex < 0) return false;
    matchingPersistedAttachments.splice(attachmentIndex, 1);
    return true;
  });
  if (
    existingUserMessage.role === "user"
    && existingUserMessage.body === activeStream.userBody
    && optimisticFilesArePersisted
  ) {
    return false;
  }
  return existingUserMessage.role !== "user"
    || existingUserMessage.body !== activeStream.userBody
    || userFiles.length > 0;
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
  return entries.filter((entry) => {
    // Process is for agent work, not a second copy of user-authored input.
    if (entry.kind === "user") return false;
    if (isRudderEchoedStructuredConversationInputEntry(entry)) return false;
    if (entry.kind === "assistant" && entry.phase === "final_answer") return false;
    return !isInternalTranscriptLifecycleEntry(entry);
  });
}

function anchorChatTimelineRowAfterActiveUser(
  rows: ChatTimelineRow[],
  rowIndex: number,
  activeStream: ChatStreamDraft,
) {
  const [row] = rows.splice(rowIndex, 1);
  if (!row) return rows;
  const messages = rows.flatMap((candidate) => candidate.kind === "message" ? [candidate.message] : []);
  const insertionIndex = activeChatStreamTimelineInsertionIndex(messages, activeStream);
  rows.splice(insertionIndex, 0, row);
  return rows;
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
  const activeMessageIndex = rows.findIndex((row) => (
    row.kind === "message"
    && row.message.role === "assistant"
    && (row.message.id === activeAssistantMessageId
      || (activeStream.generationId && row.message.generationId === activeStream.generationId)
      || (activeStream.chatTurnId
        && row.message.chatTurnId === activeStream.chatTurnId
        && (row.message.turnVariant ?? 0) === (activeStream.turnVariant ?? 0)))
  ));
  if (activeMessageIndex >= 0) {
    const row = rows[activeMessageIndex];
    if (row?.kind === "message") {
      if (row.message.status === "streaming") {
        rows[activeMessageIndex] = { ...row, activeStream };
      }
      return anchorChatTimelineRowAfterActiveUser(rows, activeMessageIndex, activeStream);
    }
  }
  rows.splice(activeChatStreamTimelineInsertionIndex(messages, activeStream), 0, {
    kind: "active_stream",
  });
  return rows;
}
