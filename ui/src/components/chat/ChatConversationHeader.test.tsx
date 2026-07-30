// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CHAT_HEADER_TITLE_CHARACTER_LIMIT,
  ChatConversationHeader,
  compactChatHeaderTitle,
} from "./ChatConversationHeader";

describe("ChatConversationHeader", () => {
  it("keeps titles at the ten-character limit unchanged", () => {
    expect(compactChatHeaderTitle("这是一个刚好十个字符")).toBe("这是一个刚好十个字符");
    expect(Array.from("这是一个刚好十个字符")).toHaveLength(CHAT_HEADER_TITLE_CHARACTER_LIMIT);
  });

  it("keeps the ellipsis inside the ten-character display limit", () => {
    expect(compactChatHeaderTitle("这是一个超过十个字符的对话标题"))
      .toBe("这是一个超过十个字…");
    expect(Array.from(compactChatHeaderTitle("这是一个超过十个字符的对话标题")))
      .toHaveLength(CHAT_HEADER_TITLE_CHARACTER_LIMIT);
  });

  it("does not split a multi-code-point grapheme at the title boundary", () => {
    expect(compactChatHeaderTitle("12345678👨‍👩‍👧‍👦AB"))
      .toBe("12345678👨‍👩‍👧‍👦…");
  });

  it("renders the agent identity and keeps the full title accessible", () => {
    const markup = renderToStaticMarkup(
      <ChatConversationHeader
        agent={{
          id: "agent-1",
          name: "Noah",
          icon: null,
          role: "general",
        }}
        title="这是一个超过十个字符的对话标题"
      />,
    );

    expect(markup).toContain("Noah");
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Noah chat: 这是一个超过十个字符的对话标题"');
    expect(markup).toContain("这是一个超过十个字…");
    expect(markup).toContain('title="这是一个超过十个字符的对话标题"');
  });

  it("uses a neutral fallback instead of inventing an agent identity", () => {
    const markup = renderToStaticMarkup(
      <ChatConversationHeader agent={null} title="Unassigned chat" />,
    );

    expect(markup).toContain("Unknown agent");
    expect(markup).toContain('data-testid="chat-header-agent-fallback"');
    expect(markup).not.toContain("<img");
  });
});
