import { formatMessengerTitle } from "@rudderhq/shared";
import type { Logger } from "pino";

export const TITLE_SOURCE_LIMIT = 1600;
export const TITLE_MAX_LENGTH = 80;

export function runtimeResultText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const candidate = result as Record<string, unknown>;
  if (candidate.timedOut === true || candidate.signal !== null || candidate.exitCode !== 0) return "";
  for (const key of ["output", "stdout", "text", "message", "summary"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  if (candidate.resultJson && typeof candidate.resultJson === "object") {
    const resultJson = candidate.resultJson as Record<string, unknown>;
    for (const key of ["output", "stdout", "text", "message", "summary"]) {
      const value = resultJson[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return "";
}

export function sanitizeGeneratedTitle(raw: string) {
  let title = raw
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
  title = title.replace(/[.!?:;]+$/g, "").trim();
  if (!title) return null;
  return title.length > TITLE_MAX_LENGTH
    ? title.slice(0, TITLE_MAX_LENGTH).trim()
    : title;
}

export function fallbackTitleFromText(value: string) {
  return formatMessengerTitle(value, { max: TITLE_MAX_LENGTH });
}

export function buildTitlePrompt({
  instruction,
  sourceLabel,
  source,
}: {
  instruction: string;
  sourceLabel: string;
  source: string;
}) {
  const normalized = source.replace(/\s+/g, " ").trim();
  const boundedSource = normalized.length > TITLE_SOURCE_LIMIT
    ? `${normalized.slice(0, TITLE_SOURCE_LIMIT)}\n\n[Input truncated for title generation.]`
    : normalized;
  return [
    instruction,
    "Rules:",
    "- Return only the title text.",
    "- No quotes, markdown, emoji, or trailing punctuation.",
    `- Maximum ${TITLE_MAX_LENGTH} characters.`,
    "",
    `${sourceLabel}:`,
    boundedSource,
  ].join("\n");
}

export function buildChatTitlePrompt(body: string, sourceLabel = "First user message") {
  return buildTitlePrompt({
    instruction: "Generate a concise title for this chat.",
    sourceLabel,
    source: body,
  });
}

export interface ChatTitleGenerationConversation {
  id: string;
  orgId: string;
  title: string;
}

export interface ChatTitleGenerationStore {
  updateDefaultTitle(id: string, title: string): Promise<unknown>;
  replaceSystemGeneratedTitle(id: string, expectedTitle: string, title: string): Promise<unknown>;
}

export interface ChatTitleGenerationProductIntelligence {
  execute(input: {
    orgId: string;
    purpose: "lightweight";
    feature: "chat_title";
    prompt: string;
  }): Promise<unknown>;
}

export function startChatTitleGeneration(input: {
  conversation: ChatTitleGenerationConversation;
  body: string;
  chats: ChatTitleGenerationStore;
  productIntelligence: ChatTitleGenerationProductIntelligence;
  logger: Pick<Logger, "warn">;
}) {
  const { conversation, body, chats, productIntelligence, logger } = input;
  if (conversation.title !== "New chat" || body.trim().length === 0) return;
  const prompt = buildChatTitlePrompt(body);
  const fallbackTitle = fallbackTitleFromText(body);
  void (async () => {
    if (fallbackTitle) {
      await chats.updateDefaultTitle(conversation.id, fallbackTitle);
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
          await chats.updateDefaultTitle(conversation.id, title);
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

export function buildMessengerGroupTitlePrompt(titles: string[]) {
  return buildTitlePrompt({
    instruction: "Generate a concise title for this Messenger group.",
    sourceLabel: "Messenger item titles",
    source: titles
      .map((title, index) => `${index + 1}. ${title}`)
      .join("\n"),
  });
}
