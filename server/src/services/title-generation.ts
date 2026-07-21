import { formatMessengerTitle } from "@rudderhq/shared";
import { createRequire } from "node:module";
import type { Logger } from "pino";

export const TITLE_SOURCE_LIMIT = 1600;
export const TITLE_MAX_LENGTH = 80;
export const CHAT_TITLE_PROMPT_TOKEN_LIMIT = 1500;

const CHAT_TITLE_MIDDLE_ELLIPSIS = " ... ";
const CHAT_TITLE_ENCODE_OPTIONS = { disallowedSpecial: new Set<string>() };
const require = createRequire(import.meta.url);
const chatTitleGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
type ChatTitleTokenizer = typeof import("gpt-tokenizer/encoding/o200k_base");
let chatTitleTokenizer: ChatTitleTokenizer | null = null;

function getChatTitleTokenizer() {
  chatTitleTokenizer ??= require(
    "gpt-tokenizer/encoding/o200k_base",
  ) as ChatTitleTokenizer;
  return chatTitleTokenizer;
}

export function countChatTitlePromptTokens(value: string) {
  return encodeChatTitleTokens(value).length;
}

function encodeChatTitleTokens(value: string) {
  return getChatTitleTokenizer().encode(value, CHAT_TITLE_ENCODE_OPTIONS);
}

function renderChatTitlePrompt(sourceLabel: string, bodies: string[]) {
  const source = bodies.length === 1
    ? bodies[0]
    : bodies.map((body, index) => `${index + 1}. ${body}`).join("\n\n");
  return [
    "Generate a concise title for this chat.",
    "Rules:",
    "- Return only the title text.",
    "- No quotes, markdown, emoji, or trailing punctuation.",
    `- Maximum ${TITLE_MAX_LENGTH} characters.`,
    "",
    `${sourceLabel}:`,
    source,
  ].join("\n");
}

function decodeStableTokenPrefix(tokens: number[]) {
  let end = tokens.length;
  while (end > 0) {
    const decoded = getChatTitleTokenizer().decode(tokens.slice(0, end));
    if (!decoded.endsWith("�")) return decoded;
    end -= 1;
  }
  return "";
}

function decodeStableTokenSuffix(tokens: number[]) {
  let start = 0;
  while (start < tokens.length) {
    const decoded = getChatTitleTokenizer().decode(tokens.slice(start));
    if (!decoded.startsWith("�")) return decoded;
    start += 1;
  }
  return "";
}

type TokenizedChatTitleBody = {
  value: string;
  tokens: number[];
  graphemeBoundaries?: number[];
};

function getGraphemeBoundaries(body: TokenizedChatTitleBody) {
  if (body.graphemeBoundaries) return body.graphemeBoundaries;
  const boundaries = [0];
  for (const segment of chatTitleGraphemeSegmenter.segment(body.value)) {
    boundaries.push(segment.index + segment.segment.length);
  }
  body.graphemeBoundaries = boundaries;
  return boundaries;
}

function lastBoundaryAtOrBefore(boundaries: number[], offset: number) {
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (boundaries[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return boundaries[low] ?? 0;
}

function firstBoundaryAtOrAfter(boundaries: number[], offset: number) {
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (boundaries[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return boundaries[low] ?? boundaries.at(-1) ?? 0;
}

function graphemeSafePrefix(body: TokenizedChatTitleBody, tokens: number[]) {
  const decoded = decodeStableTokenPrefix(tokens);
  const end = lastBoundaryAtOrBefore(getGraphemeBoundaries(body), decoded.length);
  return body.value.slice(0, end);
}

function graphemeSafeSuffix(body: TokenizedChatTitleBody, tokens: number[]) {
  const decoded = decodeStableTokenSuffix(tokens);
  const start = firstBoundaryAtOrAfter(
    getGraphemeBoundaries(body),
    body.value.length - decoded.length,
  );
  return body.value.slice(start);
}

function truncateMiddleToTokenBudget(body: TokenizedChatTitleBody, maxTokens: number) {
  const { value, tokens } = body;
  if (tokens.length <= maxTokens) return value;
  const ellipsisTokens = countChatTitlePromptTokens(CHAT_TITLE_MIDDLE_ELLIPSIS);
  if (maxTokens <= ellipsisTokens + 2) {
    return graphemeSafePrefix(body, tokens.slice(0, Math.max(0, maxTokens)));
  }

  let headTokenCount = Math.ceil((maxTokens - ellipsisTokens) / 2);
  let tailTokenCount = Math.floor((maxTokens - ellipsisTokens) / 2);
  while (headTokenCount > 0 && tailTokenCount > 0) {
    const head = graphemeSafePrefix(body, tokens.slice(0, headTokenCount));
    const tail = graphemeSafeSuffix(body, tokens.slice(-tailTokenCount));
    const candidate = `${head}${CHAT_TITLE_MIDDLE_ELLIPSIS}${tail}`;
    const candidateTokenCount = countChatTitlePromptTokens(candidate);
    if (candidateTokenCount <= maxTokens) return candidate;
    const excess = candidateTokenCount - maxTokens;
    const headReduction = Math.ceil(excess / 2);
    const tailReduction = Math.floor(excess / 2);
    headTokenCount = Math.max(0, headTokenCount - headReduction);
    tailTokenCount = Math.max(0, tailTokenCount - tailReduction);
    if (tailReduction === 0 && tailTokenCount > 0) tailTokenCount -= 1;
  }
  return graphemeSafePrefix(body, tokens.slice(0, Math.max(0, maxTokens)));
}

function allocateFairTokenBudgets(lengths: number[], totalBudget: number) {
  const budgets = Array.from({ length: lengths.length }, () => 0);
  let remainingBudget = Math.max(0, totalBudget);
  let remainingIndexes = lengths.map((_, index) => index);

  while (remainingIndexes.length > 0) {
    const equalShare = Math.floor(remainingBudget / remainingIndexes.length);
    const fittingIndexes = remainingIndexes.filter((index) => lengths[index]! <= equalShare);
    if (fittingIndexes.length === 0) {
      for (const index of remainingIndexes) budgets[index] = equalShare;
      let remainder = remainingBudget - equalShare * remainingIndexes.length;
      for (const index of [...remainingIndexes].reverse()) {
        if (remainder <= 0) break;
        budgets[index] = (budgets[index] ?? 0) + 1;
        remainder -= 1;
      }
      break;
    }
    for (const index of fittingIndexes) {
      budgets[index] = lengths[index]!;
      remainingBudget -= lengths[index]!;
    }
    remainingIndexes = remainingIndexes.filter((index) => !fittingIndexes.includes(index));
  }

  return budgets;
}

export function buildChatTitlePromptFromBodies(
  values: string[],
  sourceLabel = "Recent user messages (oldest to newest)",
) {
  const bodies = values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (bodies.length === 0) return null;

  const emptyPrompt = renderChatTitlePrompt(sourceLabel, bodies.map(() => ""));
  let bodyTokenBudget = Math.max(
    0,
    CHAT_TITLE_PROMPT_TOKEN_LIMIT - countChatTitlePromptTokens(emptyPrompt),
  );
  const tokenizedBodies = bodies.map<TokenizedChatTitleBody>((value) => ({
    value,
    tokens: encodeChatTitleTokens(value),
  }));
  const bodyTokenLengths = tokenizedBodies.map((body) => body.tokens.length);

  while (bodyTokenBudget >= 0) {
    const budgets = allocateFairTokenBudgets(bodyTokenLengths, bodyTokenBudget);
    const boundedBodies = tokenizedBodies.map((body, index) => (
      truncateMiddleToTokenBudget(body, budgets[index] ?? 0)
    ));
    const prompt = renderChatTitlePrompt(sourceLabel, boundedBodies);
    const promptTokens = countChatTitlePromptTokens(prompt);
    if (promptTokens <= CHAT_TITLE_PROMPT_TOKEN_LIMIT) return prompt;
    bodyTokenBudget -= Math.max(1, promptTokens - CHAT_TITLE_PROMPT_TOKEN_LIMIT);
  }

  return renderChatTitlePrompt(sourceLabel, bodies.map(() => ""));
}

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
  return buildChatTitlePromptFromBodies([body], sourceLabel)
    ?? renderChatTitlePrompt(sourceLabel, [""]);
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
  const fallbackTitle = fallbackTitleFromText(body);
  void (async () => {
    if (fallbackTitle) {
      await chats.updateDefaultTitle(conversation.id, fallbackTitle);
    } else {
      await Promise.resolve();
    }
    const prompt = buildChatTitlePrompt(body);
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
