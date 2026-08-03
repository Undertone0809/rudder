// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatConversationHeader } from "./ChatConversationHeader";

describe("ChatConversationHeader", () => {
  it("renders the full title and limits the combined header to one third of its parent", () => {
    const fullTitle = "这是一个超过十个字符的对话标题";
    const markup = renderToStaticMarkup(
      <ChatConversationHeader
        agent={{
          id: "agent-1",
          name: "Noah",
          icon: null,
          role: "general",
        }}
        title={fullTitle}
      />,
    );

    expect(markup).toContain("Noah");
    expect(markup).toContain('role="group"');
    expect(markup).toContain(`aria-label="Noah chat: ${fullTitle}"`);
    expect(markup).toContain(fullTitle);
    expect(markup).toContain(`title="${fullTitle}"`);
    expect(markup).toContain("max-w-[calc(33.333333%+0.75rem)]");
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
