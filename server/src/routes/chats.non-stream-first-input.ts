import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import type { Request, Response } from "express";
import { conflict } from "../errors.js";
import { chatMessageMutationFingerprint } from "../services/chat-message-mutation-fingerprint.js";
import type { sideChatService } from "../services/side-chats.js";
import type { getActorInfo } from "./authz.js";

type MutationFingerprintInput = Parameters<typeof chatMessageMutationFingerprint>[0];
type SideChatFirstInputService = Pick<
  ReturnType<typeof sideChatService>,
  "claimFirstInput" | "releaseFirstInputClaim"
>;

export async function admitNonStreamChatSideChatFirstInput(input: {
  conversation: ChatConversation;
  request: Request;
  response: Response;
  actor: ReturnType<typeof getActorInfo>;
  clientMutationId: string | null;
  clientMutationFingerprint: string | null;
  body: string;
  editUserMessageId?: string | null;
  inlineAnnotationsProvided: boolean;
  inlineAnnotations?: MutationFingerprintInput["inlineAnnotations"];
  modelOverride?: string | null;
  effortOverride?: string | null;
  sideChats: SideChatFirstInputService;
  boardUserId: (request: Request) => string;
  getMessage: (conversationId: string, messageId: string) => Promise<ChatMessage | null>;
  recoverSideChatFirstInputActivity: (
    conversation: ChatConversation,
    userMessage: ChatMessage,
    actor: ReturnType<typeof getActorInfo>,
  ) => Promise<void>;
}): Promise<{
  claimToken: string | null;
  requestFingerprint: string | null;
  replayed: boolean;
  releaseClaim: (() => Promise<void>) | null;
}> {
  const { conversation, sideChats } = input;
  let claimToken: string | null = null;
  if (conversation.conversationKind !== "side_chat") {
    return {
      claimToken,
      requestFingerprint: null,
      replayed: false,
      releaseClaim: null,
    };
  }

  const requestFingerprint = input.clientMutationFingerprint
    ?? chatMessageMutationFingerprint({
      body: input.body,
      editUserMessageId: input.editUserMessageId ?? null,
      inlineAnnotationsProvided: input.inlineAnnotationsProvided,
      inlineAnnotations: input.inlineAnnotations,
      modelOverride: input.modelOverride ?? null,
      effortOverride: input.effortOverride ?? null,
      files: [],
    });
  const claimFirstInput = () => sideChats.claimFirstInput({
    orgId: conversation.orgId,
    conversationId: conversation.id,
    userId: input.boardUserId(input.request),
    clientMutationId: input.clientMutationId,
    requestFingerprint,
  });
  let firstInput = await claimFirstInput();
  const claimWaitUntil = Date.now() + 10_000;
  while (firstInput.kind === "pending" && Date.now() < claimWaitUntil) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    firstInput = await claimFirstInput();
  }
  if (firstInput.kind === "pending") {
    throw conflict("Side Chat first input is still being accepted; retry with the same mutation key", {
      code: "side_chat_first_input_in_progress",
    });
  }
  if (firstInput.kind === "claimed") {
    claimToken = firstInput.claimToken;
  } else if (firstInput.kind === "replay") {
    const firstUserMessage = await input.getMessage(conversation.id, firstInput.userMessageId);
    if (!firstUserMessage || firstUserMessage.role !== "user") {
      throw conflict("Accepted Side Chat first input is no longer readable", {
        code: "side_chat_first_input_readback_missing",
      });
    }
    if (!firstInput.activityLogged) {
      await input.recoverSideChatFirstInputActivity(
        conversation,
        firstUserMessage,
        input.actor,
      );
    }
    input.response.status(200).json({ messages: [firstUserMessage] });
    return {
      claimToken,
      requestFingerprint,
      replayed: true,
      releaseClaim: null,
    };
  }

  return {
    claimToken,
    requestFingerprint,
    replayed: false,
    releaseClaim: claimToken
      ? async () => sideChats.releaseFirstInputClaim({
        conversationId: conversation.id,
        claimToken,
      })
      : null,
  };
}
