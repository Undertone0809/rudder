import { logger } from "../middleware/logger.js";
import type { ProductIntelligenceExecuteInput } from "./product-intelligence.js";
import {
  buildChatTitlePrompt,
  fallbackTitleFromText,
  runtimeResultText,
  sanitizeGeneratedTitle,
} from "./title-generation.js";

const CHAT_TITLE_REGENERATION_MESSAGE_LIMIT = 12;

type ChatTitleConversation = {
  id: string;
  orgId: string;
  title: string;
  forkedFromConversationId?: string | null;
};

type ChatTitleMessage = {
  id: string;
  role: string;
  kind: string;
  body: string;
  structuredPayload?: Record<string, unknown> | null;
};

type ChatTitleStore = {
  listMessages(conversationId: string, options?: { includeTranscript?: boolean }): Promise<ChatTitleMessage[] | null>;
  updateDefaultTitle(
    id: string,
    title: string,
    expectedCurrentTitle?: string,
  ): Promise<ChatTitleConversation | null>;
  replaceSystemGeneratedTitle(
    id: string,
    expectedTitle: string,
    title: string,
  ): Promise<ChatTitleConversation | null>;
};

type ProductIntelligenceRunner = {
  execute(input: ProductIntelligenceExecuteInput): Promise<unknown>;
};

export type ChatTitleGenerationOptions = {
  expectedCurrentTitle?: string | null;
};

export function buildChatTitlePromptFromMessages(messages: ChatTitleMessage[]) {
  const source = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-CHAT_TITLE_REGENERATION_MESSAGE_LIMIT)
    .map((message) => `${message.role}: ${message.body}`)
    .join("\n\n")
    .trim();
  return source ? buildChatTitlePrompt(source, "Conversation excerpt") : null;
}

export function chatTitleGenerationService(input: {
  chats: ChatTitleStore;
  productIntelligence: ProductIntelligenceRunner;
}) {
  const { chats, productIntelligence } = input;

  function titleGenerationExpectedCurrentTitle(
    conversation: ChatTitleConversation,
    options: ChatTitleGenerationOptions = {},
  ) {
    if (options.expectedCurrentTitle !== undefined) {
      const expected = options.expectedCurrentTitle?.trim();
      return expected && expected.length > 0 ? expected : null;
    }
    const currentTitle = conversation.title.trim();
    if (currentTitle === "New chat") return "New chat";
    if (conversation.forkedFromConversationId && currentTitle.length > 0) return currentTitle;
    return null;
  }

  function isForkSystemEvent(message: ChatTitleMessage) {
    if (message.role !== "system" || message.kind !== "system_event") return false;
    if (message.structuredPayload?.eventType === "chat_fork" || message.structuredPayload?.type === "chat_fork") {
      return true;
    }
    return message.body.startsWith("Forked from ");
  }

  async function isFirstUserMessageAfterFork(conversationId: string, userMessage: ChatTitleMessage) {
    const messages = (await chats.listMessages(conversationId, { includeTranscript: false })) ?? [];
    let forkEventIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && isForkSystemEvent(message)) {
        forkEventIndex = index;
        break;
      }
    }
    if (forkEventIndex < 0) return false;
    const firstNewUserMessage = messages
      .slice(forkEventIndex + 1)
      .find((message) => message.role === "user" && message.kind === "message");
    return firstNewUserMessage?.id === userMessage.id;
  }

  function startAutomaticGeneration(
    conversation: ChatTitleConversation,
    userMessage: ChatTitleMessage,
    options: ChatTitleGenerationOptions = {},
  ) {
    const body = userMessage.body;
    const expectedCurrentTitle = titleGenerationExpectedCurrentTitle(conversation, options);
    if (!expectedCurrentTitle || body.trim().length === 0) return;
    const prompt = buildChatTitlePrompt(body);
    const fallbackTitle = fallbackTitleFromText(body);
    const updateTitleIfExpected = (title: string) =>
      expectedCurrentTitle === "New chat"
        ? chats.updateDefaultTitle(conversation.id, title)
        : chats.updateDefaultTitle(conversation.id, title, expectedCurrentTitle);
    void (async () => {
      if (conversation.forkedFromConversationId) {
        const shouldRetitleFork = await isFirstUserMessageAfterFork(conversation.id, userMessage);
        if (!shouldRetitleFork) return;
      }
      if (fallbackTitle) {
        await updateTitleIfExpected(fallbackTitle);
      }
      try {
        const result = await productIntelligence.execute({
          orgId: conversation.orgId,
          purpose: "lightweight",
          feature: "chat_title",
          prompt,
        });
        const title = sanitizeGeneratedTitle(runtimeResultText(result));
        if (title) {
          if (fallbackTitle) {
            await chats.replaceSystemGeneratedTitle(conversation.id, fallbackTitle, title);
          } else {
            await updateTitleIfExpected(title);
          }
        }
      } catch (error) {
        logger.warn(
          {
            err: error,
            conversationId: conversation.id,
            orgId: conversation.orgId,
          },
          "Failed to generate chat title with organization lightweight model",
        );
      }
    })().catch((error) => {
      logger.warn(
        {
          err: error,
          conversationId: conversation.id,
          orgId: conversation.orgId,
        },
        "Failed to update chat title",
      );
    });
  }

  return {
    startAutomaticGeneration,
  };
}
