import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import type {
  ChatAttachment,
  ChatConversation,
  ChatMessage,
} from "@rudderhq/shared";
import type { Router } from "express";
import { createAssistantTextAccumulator } from "../services/chat-assistant.helpers.js";
import type { StorageService } from "../storage/types.js";

export type ChatStreamRouteContext = {
  router: Router;
  db: Db;
  storage: StorageService;
  [key: string]: any;
};

export type AtomicChatFirstTurn = {
  conversation: ChatConversation;
  userMessage: ChatMessage;
  uploadPrepared: boolean;
  expectedTitleForAutomaticGeneration: string | null;
};

export type StartingChatGenerationGate = {
  generationReady: Promise<string | null>;
  stopApplied: Promise<void>;
  stopRequested: boolean;
  resolveGeneration: (generationId: string | null) => void;
  resolveStopApplied: () => void;
};

export const startingChatGenerationGates = new Map<string, StartingChatGenerationGate>();
export const CHAT_ASSISTANT_RECOVERABLE_FAILURE_FALLBACK_MESSAGE =
  "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";
export const CHAT_ASSISTANT_STOPPED_FALLBACK_MESSAGE =
  "Chat run stopped before a final reply. Continue the conversation to resume from the preserved context.";

export function createStartingChatGenerationGate(): StartingChatGenerationGate {
  let resolveGeneration!: (generationId: string | null) => void;
  let resolveStopApplied!: () => void;
  return {
    generationReady: new Promise<string | null>((resolve) => {
      resolveGeneration = resolve;
    }),
    stopApplied: new Promise<void>((resolve) => {
      resolveStopApplied = resolve;
    }),
    stopRequested: false,
    resolveGeneration,
    resolveStopApplied,
  };
}

export function outputAdmissionClosed(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && Number((error as { status?: unknown }).status) === 409
    && "message" in error
    && (error as { message?: unknown }).message === "Chat-visible output admission is closed for this generation",
  );
}

export function normalizeMultipartFirstTurnBody(
  body: Record<string, unknown> | undefined,
) {
  if (!body) return {};
  const normalized = { ...body };
  if (typeof normalized.planMode === "string") {
    if (normalized.planMode === "true") normalized.planMode = true;
    else if (normalized.planMode === "false") normalized.planMode = false;
  }
  if (typeof normalized.contextLinks === "string") {
    try {
      normalized.contextLinks = JSON.parse(normalized.contextLinks);
    } catch {
      // Leave invalid JSON in place so the shared schema returns a normal 400.
    }
  }
  return normalized;
}

export function normalizeMultipartMessageBody(
  body: Record<string, unknown> | undefined,
) {
  if (!body) return {};
  const normalized = { ...body };
  if (typeof normalized.inlineAnnotations === "string") {
    try {
      normalized.inlineAnnotations = JSON.parse(normalized.inlineAnnotations);
    } catch {
      // Leave invalid JSON in place so the shared schema returns a normal 400.
    }
  }
  return normalized;
}

type StoredChatMessageFile = {
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
};

export function createChatStreamFileStaging(input: {
  conversation: ChatConversation;
  shouldStage: boolean;
  files: Array<{ mimetype: string; buffer: Buffer; originalname: string }>;
  store: (
    conversation: ChatConversation,
    files: Array<{ mimetype: string; buffer: Buffer; originalname: string }>,
  ) => Promise<StoredChatMessageFile[]>;
  cleanup: (
    conversation: ChatConversation,
    storedFiles: Array<{ objectKey: string }>,
  ) => Promise<void>;
}) {
  let files: StoredChatMessageFile[] = [];
  let committed = false;
  let cleaned = false;
  return {
    get files() {
      return files;
    },
    async stage() {
      files = input.shouldStage && input.files.length > 0
        ? await input.store(input.conversation, input.files)
        : [];
    },
    markCommitted() {
      committed = true;
    },
    async cleanup() {
      if (committed || cleaned || files.length === 0) return;
      cleaned = true;
      await input.cleanup(input.conversation, files);
    },
  };
}

export function resolveStoppedAssistantState(input: {
  stopCutoff: { body: string; transcript: TranscriptEntry[] } | null;
  admittedAssistantBody: string;
  transcript: TranscriptEntry[];
  fallbackBody: string;
}) {
  if (!input.stopCutoff) {
    return {
      body: input.admittedAssistantBody.trim()
        ? input.admittedAssistantBody
        : input.fallbackBody,
      transcript: [...input.transcript],
    };
  }
  const accumulator = createAssistantTextAccumulator();
  for (const entry of input.stopCutoff.transcript) {
    if (entry.kind === "assistant") {
      accumulator.push(entry.text, entry.delta === true);
    }
  }
  return {
    body: input.stopCutoff.body.trim()
      ? input.stopCutoff.body
      : accumulator.fullText,
    transcript: input.stopCutoff.transcript,
  };
}

export function withMergedChatMessageAttachments(
  message: ChatMessage,
  additionalAttachments: ChatAttachment[],
): ChatMessage {
  const attachmentsById = new Map<string, ChatAttachment>();
  for (const attachment of message.attachments ?? []) {
    attachmentsById.set(attachment.id, attachment);
  }
  for (const attachment of additionalAttachments) {
    attachmentsById.set(attachment.id, attachment);
  }
  return {
    ...message,
    attachments: [...attachmentsById.values()],
  };
}
