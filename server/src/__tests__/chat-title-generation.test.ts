import { describe, expect, it, vi } from "vitest";
import { chatTitleGenerationService } from "../services/chat-title-generation.js";

describe("chat title generation service", () => {
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
});
