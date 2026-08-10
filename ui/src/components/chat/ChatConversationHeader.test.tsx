// @vitest-environment node

import { TooltipProvider } from "@/components/ui/tooltip";
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
    expect(markup).toContain("max-w-[33.333333%]");
  });

  it("uses a neutral fallback instead of inventing an agent identity", () => {
    const markup = renderToStaticMarkup(
      <ChatConversationHeader agent={null} title="Unassigned chat" />,
    );

    expect(markup).toContain("Unknown agent");
    expect(markup).toContain('data-testid="chat-header-agent-fallback"');
    expect(markup).not.toContain("<img");
  });

  it("places an always-visible sidebar opener immediately before the agent avatar", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ChatConversationHeader
          agent={{
            id: "agent-1",
            name: "Noah",
            icon: null,
            role: "general",
          }}
          title="Sidebar placement"
          onOpenSidebar={() => {}}
        />
      </TooltipProvider>,
    );

    const openerIndex = markup.indexOf('data-testid="workspace-sidebar-reopen-button"');
    const avatarIndex = markup.indexOf('data-testid="chat-header-agent-icon"');
    expect(openerIndex).toBeGreaterThan(-1);
    expect(avatarIndex).toBeGreaterThan(openerIndex);
    expect(markup).not.toContain("opacity-0");
  });
});
