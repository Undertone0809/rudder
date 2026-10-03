import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import type { Request } from "express";
import { conflict } from "../errors.js";
import { chatMessageMutationFingerprint } from "../services/chat-message-mutation-fingerprint.js";
import type { sideChatService } from "../services/side-chats.js";
import type { getActorInfo } from "./authz.js";

type MutationFingerprintInput = Parameters<typeof chatMessageMutationFingerprint>[0];

export async function admitChatStreamSideChatFirstInput(input: {
  atomicFirstTurn: boolean;
  conversation: ChatConversation;
  request: Request;
  clientMutationId: string | null;
  clientMutationFingerprint: string | null | undefined;
  body: string;
  editUserMessageId?: string | null;
  inlineAnnotationsProvided: boolean;
  inlineAnnotations?: MutationFingerprintInput["inlineAnnotations"];
  modelOverride?: string | null;
  effortOverride?: string | null;
  files: MutationFingerprintInput["files"];
  sideChats: Pick<ReturnType<typeof sideChatService>, "claimFirstInput">;
  boardUserId: (request: Request) => string;
  getMessage: (conversationId: string, messageId: string) => Promise<ChatMessage | null>;
  recoverSideChatFirstInputActivity: (
    conversation: ChatConversation,
    userMessage: ChatMessage,
    actor: ReturnType<typeof getActorInfo>,
  ) => Promise<void>;
  actor: ReturnType<typeof getActorInfo>;
}): Promise<{
  claimToken: string | null;
  requestFingerprint: string | null;
  replayed: boolean;
  userMessage: ChatMessage | null;
}> {
  if (input.atomicFirstTurn || input.conversation.conversationKind !== "side_chat") {
    return { claimToken: null, requestFingerprint: null, replayed: false, userMessage: null };
  }

  const requestFingerprint = input.clientMutationFingerprint
    ?? chatMessageMutationFingerprint({
      body: input.body,
      editUserMessageId: input.editUserMessageId ?? null,
      inlineAnnotationsProvided: input.inlineAnnotationsProvided,
      inlineAnnotations: input.inlineAnnotations,
      modelOverride: input.modelOverride ?? null,
      effortOverride: input.effortOverride ?? null,
      files: input.files,
    });
  let firstInput = await input.sideChats.claimFirstInput({
    orgId: input.conversation.orgId,
    conversationId: input.conversation.id,
    userId: input.boardUserId(input.request),
    clientMutationId: input.clientMutationId,
    requestFingerprint,
  });
  const claimWaitUntil = Date.now() + 10_000;
  while (firstInput.kind === "pending" && Date.now() < claimWaitUntil) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    firstInput = await input.sideChats.claimFirstInput({
      orgId: input.conversation.orgId,
      conversationId: input.conversation.id,
      userId: input.boardUserId(input.request),
      clientMutationId: input.clientMutationId,
      requestFingerprint,
    });
  }
  if (firstInput.kind === "pending") {
    throw conflict("Side Chat first input is still being accepted; retry with the same mutation key", {
      code: "side_chat_first_input_in_progress",
    });
  }
  if (firstInput.kind === "claimed") {
    return { claimToken: firstInput.claimToken, requestFingerprint, replayed: false, userMessage: null };
  }
  if (firstInput.kind !== "replay") {
    return { claimToken: null, requestFingerprint, replayed: false, userMessage: null };
  }

  const firstUserMessage = await input.getMessage(input.conversation.id, firstInput.userMessageId);
  if (!firstUserMessage || firstUserMessage.role !== "user") {
    throw conflict("Accepted Side Chat first input is no longer readable", {
      code: "side_chat_first_input_readback_missing",
    });
  }
  if (!firstInput.activityLogged) {
    await input.recoverSideChatFirstInputActivity(
      input.conversation,
      firstUserMessage,
      input.actor,
    );
  }
  return {
    claimToken: null,
    requestFingerprint,
    replayed: true,
    userMessage: firstUserMessage,
  };
}
