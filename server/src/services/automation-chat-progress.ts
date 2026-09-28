import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS } from "./chat-generation-provenance.js";
import type { chatService } from "./chats.js";

const LEGACY_TRANSCRIPT_PROGRESS_MIN_ENTRIES = 32;
const LEGACY_TRANSCRIPT_PROGRESS_INTERVAL_MS = 1_000;

type ChatService = ReturnType<typeof chatService>;
type ProgressOptions = {
  status?: "streaming" | "completed" | "failed" | "stopped";
  body?: string;
  replyingAgentId?: string | null;
  structuredPayload?: Record<string, unknown> | null;
  kind?: "message" | "ask_user" | "issue_proposal" | "operation_proposal";
  approvalId?: string | null;
  includeLegacyTranscript?: boolean;
};

type AutomationTranscriptWindow = {
  entries: TranscriptEntry[];
  entryBytes: number[];
  byteLength: number;
};

export function createAutomationChatProgress(input: {
  chatSvc: Pick<ChatService, "addMessage" | "updateMessage">;
  getUserMessage: () => ChatMessage | null;
  notifyChatChanged: (orgId: string, conversationId: string, details?: Record<string, unknown>) => void;
  logChatMessageAdded: (input: {
    orgId: string;
    conversationId: string;
    message: ChatMessage;
    agentId?: string | null;
  }) => Promise<void>;
  touchRunChatProgress: (messageId: string | null) => Promise<void>;
}) {
  const legacyTranscript: AutomationTranscriptWindow = { entries: [], entryBytes: [], byteLength: 0 };
  let assistantDraftBody = "";
  let assistantProgressMessageId: string | null = null;
  let assistantRunId: string | null = null;
  let legacyTranscriptEntriesSincePersist = 0;
  let lastLegacyTranscriptPersistMs = 0;
  let hasPersistedLegacyTranscript = false;

  function appendBoundedTranscriptEntry(entry: TranscriptEntry) {
    let entryBytes: number;
    try {
      const serialized = JSON.stringify(entry);
      entryBytes = typeof serialized === "string"
        ? Buffer.byteLength(serialized, "utf8")
        : CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes + 1;
    } catch {
      entryBytes = CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes + 1;
    }
    if (entryBytes > CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes) return false;

    legacyTranscript.entries.push(entry);
    legacyTranscript.entryBytes.push(entryBytes);
    legacyTranscript.byteLength += entryBytes;
    while (
      legacyTranscript.entries.length > CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.entries
      || legacyTranscript.byteLength > CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes
    ) {
      legacyTranscript.entries.shift();
      legacyTranscript.byteLength -= legacyTranscript.entryBytes.shift() ?? 0;
    }
    return true;
  }

  async function persistProgress(
    progressConversation: ChatConversation,
    options: ProgressOptions = {},
  ) {
    const userMessage = input.getUserMessage();
    if (!userMessage?.chatTurnId) return null;
    const status = options.status ?? "streaming";
    const body = options.body ?? assistantDraftBody;
    const replyingAgentId = options.replyingAgentId === undefined
      ? progressConversation.chatRuntime?.runtimeAgentId ?? progressConversation.preferredAgentId ?? null
      : options.replyingAgentId;
    const kind = options.kind ?? "message";
    const messageFields = {
      kind,
      status,
      body,
      ...(!assistantRunId && options.includeLegacyTranscript ? { transcript: legacyTranscript.entries } : {}),
      ...(options.structuredPayload !== undefined ? { structuredPayload: options.structuredPayload } : {}),
      ...(options.approvalId !== undefined ? { approvalId: options.approvalId } : {}),
      ...(assistantRunId ? { runId: assistantRunId } : {}),
      replyingAgentId,
    };
    if (assistantProgressMessageId) {
      const updated = await input.chatSvc.updateMessage(
        progressConversation.id,
        assistantProgressMessageId,
        messageFields,
      );
      if (updated) {
        assistantProgressMessageId = updated.id;
        input.notifyChatChanged(progressConversation.orgId, progressConversation.id, {
          messageId: assistantProgressMessageId,
          status,
        });
        await input.touchRunChatProgress(assistantProgressMessageId);
        return updated as ChatMessage;
      }
    }
    const assistantProgressMessage = await input.chatSvc.addMessage(progressConversation.id, {
      ...messageFields,
      orgId: progressConversation.orgId,
      role: "assistant",
      chatTurnId: userMessage.chatTurnId,
      turnVariant: userMessage.turnVariant,
    }) as ChatMessage;
    assistantProgressMessageId = assistantProgressMessage.id;
    await input.logChatMessageAdded({
      orgId: progressConversation.orgId,
      conversationId: progressConversation.id,
      message: assistantProgressMessage,
      agentId: replyingAgentId,
    });
    await input.touchRunChatProgress(assistantProgressMessage.id);
    return assistantProgressMessage;
  }

  async function persistLegacyTranscriptProgressIfDue(progressConversation: ChatConversation) {
    legacyTranscriptEntriesSincePersist += 1;
    const nowMs = Date.now();
    if (
      hasPersistedLegacyTranscript
      && legacyTranscriptEntriesSincePersist < LEGACY_TRANSCRIPT_PROGRESS_MIN_ENTRIES
      && nowMs - lastLegacyTranscriptPersistMs < LEGACY_TRANSCRIPT_PROGRESS_INTERVAL_MS
    ) return;

    await persistProgress(progressConversation, { includeLegacyTranscript: true });
    hasPersistedLegacyTranscript = true;
    legacyTranscriptEntriesSincePersist = 0;
    lastLegacyTranscriptPersistMs = Date.now();
  }

  return {
    appendAssistantDelta: async (progressConversation: ChatConversation, delta: string) => {
      assistantDraftBody = `${assistantDraftBody}${delta}`;
      await persistProgress(progressConversation);
    },
    getProgressMessageId: () => assistantProgressMessageId,
    onRunCreated: async (progressConversation: ChatConversation, runId: string) => {
      assistantRunId = runId;
      if (assistantProgressMessageId) {
        await input.chatSvc.updateMessage(progressConversation.id, assistantProgressMessageId, { runId });
      }
    },
    onTranscriptEntry: async (progressConversation: ChatConversation, entry: TranscriptEntry) => {
      if (assistantRunId) return;
      if (appendBoundedTranscriptEntry(entry)) {
        await persistLegacyTranscriptProgressIfDue(progressConversation);
      }
    },
    persistProgress,
  };
}
