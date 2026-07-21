import { describe, expect, it, vi } from "vitest";
import {
  buildChatTitlePromptFromMessages,
  chatTitleGenerationService,
} from "../services/chat-title-generation.js";
import {
  buildChatTitlePrompt,
  CHAT_TITLE_PROMPT_TOKEN_LIMIT,
  countChatTitlePromptTokens,
} from "../services/title-generation.js";

describe("chat title generation service", () => {
  it("builds regeneration context from only the latest five non-empty user messages", () => {
    const prompt = buildChatTitlePromptFromMessages([
      { id: "user-old-1", role: "user", kind: "message", body: "OLD USER ONE" },
      { id: "assistant-old", role: "assistant", kind: "message", body: "ASSISTANT NOISE" },
      { id: "user-old-2", role: "user", kind: "message", body: "OLD USER TWO" },
      { id: "user-3", role: "user", kind: "message", body: "THIRD USER REQUEST" },
      { id: "user-empty", role: "user", kind: "message", body: "   " },
      { id: "user-event", role: "user", kind: "system_event", body: "USER EVENT NOISE" },
      { id: "user-4", role: "user", kind: "message", body: "FOURTH USER REQUEST" },
      { id: "assistant-new", role: "assistant", kind: "message", body: "LATEST ASSISTANT NOISE" },
      { id: "user-5", role: "user", kind: "message", body: "FIFTH USER REQUEST" },
      { id: "user-6", role: "user", kind: "message", body: "SIXTH USER REQUEST" },
      { id: "user-7", role: "user", kind: "message", body: "SEVENTH USER REQUEST" },
    ]);

    expect(prompt).not.toBeNull();
    expect(prompt).not.toContain("OLD USER ONE");
    expect(prompt).not.toContain("OLD USER TWO");
    expect(prompt).not.toContain("ASSISTANT NOISE");
    expect(prompt).not.toContain("LATEST ASSISTANT NOISE");
    expect(prompt).not.toContain("USER EVENT NOISE");
    for (const body of [
      "THIRD USER REQUEST",
      "FOURTH USER REQUEST",
      "FIFTH USER REQUEST",
      "SIXTH USER REQUEST",
      "SEVENTH USER REQUEST",
    ]) {
      expect(prompt).toContain(body);
    }
    expect(prompt?.indexOf("THIRD USER REQUEST")).toBeLessThan(
      prompt?.indexOf("SEVENTH USER REQUEST") ?? -1,
    );
  });

  it("keeps a long first-message prompt within 1,500 tokens while preserving both ends", () => {
    const prompt = buildChatTitlePrompt(
      `BEGINNING_MARKER ${"发布计划与回归检查 ".repeat(500)} ENDING_MARKER`,
    );

    expect(countChatTitlePromptTokens(prompt)).toBeLessThanOrEqual(CHAT_TITLE_PROMPT_TOKEN_LIMIT);
    expect(prompt).toContain("BEGINNING_MARKER");
    expect(prompt).toContain(" ... ");
    expect(prompt).toContain("ENDING_MARKER");
    expect(prompt).not.toContain("�");
  });

  it("redistributes unused message budget and preserves both ends of long regeneration messages", () => {
    const messages = [
      { id: "user-short", role: "user", kind: "message", body: "KEEP SHORT MESSAGE INTACT" },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `user-long-${index}`,
        role: "user",
        kind: "message",
        body: `LONG_${index}_BEGIN ${"发布计划与回归检查 ".repeat(300)} LONG_${index}_END`,
      })),
    ];

    const prompt = buildChatTitlePromptFromMessages(messages);

    expect(prompt).not.toBeNull();
    expect(countChatTitlePromptTokens(prompt ?? "")).toBeLessThanOrEqual(CHAT_TITLE_PROMPT_TOKEN_LIMIT);
    expect(prompt).toContain("KEEP SHORT MESSAGE INTACT");
    for (let index = 0; index < 4; index += 1) {
      expect(prompt).toContain(`LONG_${index}_BEGIN`);
      expect(prompt).toContain(`LONG_${index}_END`);
    }
    expect(prompt?.match(/ \.\.\. /g)).toHaveLength(4);
    expect(prompt).not.toContain("�");
  });

  it("does not split emoji or combining-character graphemes at truncation boundaries", () => {
    const graphemes = ["👩🏽‍💻", "e\u0301", "🇨🇳"];
    const prompt = buildChatTitlePromptFromMessages(graphemes.map((grapheme, index) => ({
      id: `user-${index}`,
      role: "user",
      kind: "message",
      body: `${grapheme.repeat(300)} ${grapheme.repeat(300)}`,
    })));

    expect(prompt).not.toBeNull();
    expect(countChatTitlePromptTokens(prompt ?? "")).toBeLessThanOrEqual(CHAT_TITLE_PROMPT_TOKEN_LIMIT);
    for (const grapheme of graphemes) {
      expect(prompt).toContain(`${grapheme} ... ${grapheme}`);
    }
  });

  it("treats special-token-like user text as ordinary title context", () => {
    const body = "Discuss <|fim_prefix|>, <|endoftext|>, and <|endofprompt|> literally";
    const prompt = buildChatTitlePrompt(body);

    expect(prompt).toContain(body);
    expect(countChatTitlePromptTokens(prompt)).toBeLessThanOrEqual(CHAT_TITLE_PROMPT_TOKEN_LIMIT);
  });

  it("uses lightweight intelligence to replace a Feishu fallback title when the caller supplies the expected title", async () => {
    const chats = {
      listMessages: vi.fn(async () => []),
      updateDefaultTitle: vi.fn(async () => null),
      replaceSystemGeneratedTitle: vi.fn(async () => null),
    };
    const productIntelligence = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "\"Available skills inquiry\"",
      })),
    };
    const service = chatTitleGenerationService({ chats, productIntelligence });

    service.startAutomaticGeneration(
      {
        id: "chat-1",
        orgId: "org-1",
        title: "hi, what skill do you have?",
      },
      {
        id: "message-1",
        role: "user",
        kind: "message",
        body: "hi, what skill do you have?",
        structuredPayload: {
          source: "agent_integration",
          provider: "feishu",
        },
      },
      {
        expectedCurrentTitle: "hi, what skill do you have?",
      },
    );

    await vi.waitUntil(() => productIntelligence.execute.mock.calls.length > 0);
    expect(productIntelligence.execute).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      purpose: "lightweight",
      feature: "chat_title",
      prompt: expect.stringContaining("hi, what skill do you have?"),
    }));
    await vi.waitUntil(() => chats.replaceSystemGeneratedTitle.mock.calls.length > 0);
    expect(chats.updateDefaultTitle).toHaveBeenCalledWith(
      "chat-1",
      "hi, what skill do you have?",
      "hi, what skill do you have?",
    );
    expect(chats.replaceSystemGeneratedTitle).toHaveBeenCalledWith(
      "chat-1",
      "hi, what skill do you have?",
      "Available skills inquiry",
    );
  });

  it("does not replace a Feishu title when the expected fallback no longer matches", async () => {
    const chats = {
      listMessages: vi.fn(async () => []),
      updateDefaultTitle: vi.fn(async () => null),
      replaceSystemGeneratedTitle: vi.fn(async () => null),
    };
    const productIntelligence = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "\"Available skills inquiry\"",
      })),
    };
    const service = chatTitleGenerationService({ chats, productIntelligence });

    service.startAutomaticGeneration(
      {
        id: "chat-1",
        orgId: "org-1",
        title: "Manually renamed Feishu chat",
      },
      {
        id: "message-1",
        role: "user",
        kind: "message",
        body: "hi, what skill do you have?",
      },
      {
        expectedCurrentTitle: "hi, what skill do you have?",
      },
    );

    await vi.waitUntil(() => productIntelligence.execute.mock.calls.length > 0);
    expect(chats.updateDefaultTitle).toHaveBeenCalledWith(
      "chat-1",
      "hi, what skill do you have?",
      "hi, what skill do you have?",
    );
    expect(chats.replaceSystemGeneratedTitle).toHaveBeenCalledWith(
      "chat-1",
      "hi, what skill do you have?",
      "Available skills inquiry",
    );
  });

  it("keeps the numbered title of a fork after its first new user message", async () => {
    const chats = {
      updateDefaultTitle: vi.fn(async () => null),
      replaceSystemGeneratedTitle: vi.fn(async () => null),
    };
    const productIntelligence = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Should not be used",
      })),
    };
    const service = chatTitleGenerationService({ chats, productIntelligence });

    service.startAutomaticGeneration(
      {
        id: "chat-fork-2",
        orgId: "org-1",
        title: "Launch plan (2)",
        forkedFromConversationId: "chat-root",
      },
      {
        id: "message-1",
        role: "user",
        kind: "message",
        body: "Explore a different launch plan",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chats.updateDefaultTitle).not.toHaveBeenCalled();
    expect(chats.replaceSystemGeneratedTitle).not.toHaveBeenCalled();
    expect(productIntelligence.execute).not.toHaveBeenCalled();
  });
});
