// @vitest-environment jsdom

import type { ChatMessage } from "@rudderhq/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatScrollMap,
  chatScrollMapMarkdownExcerpt,
  chatScrollMapPlacement,
  chatScrollMapPreviewParts,
  chatScrollMapVisibleMessages,
  countScrollMapUserMessages,
} from "./Chat.scroll-map";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    orgId: "org-1",
    conversationId: "chat-1",
    role: "user",
    kind: "message",
    status: "completed",
    body: id,
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    replyingAgentId: null,
    chatTurnId: `turn-${id}`,
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
    updatedAt: new Date("2026-07-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ChatScrollMap", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  it("counts only visible user messages with content", () => {
    const messages = [
      message("visible"),
      message("attachment", {
        body: "",
        attachments: [{ id: "attachment-1" } as ChatMessage["attachments"][number]],
      }),
      message("assistant", { role: "assistant" }),
      message("proposal", { kind: "issue_proposal" }),
      message("empty", { body: "" }),
      message("superseded", { supersededAt: new Date("2026-07-18T00:01:00.000Z") }),
    ];

    expect(countScrollMapUserMessages(messages)).toBe(2);
    expect(chatScrollMapVisibleMessages(messages).map((candidate) => candidate.id))
      .toEqual(["visible", "attachment"]);
  });

  it("samples production-sized conversations to a stable 64 marker ceiling", () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(`message-${index}`));
    const visible = chatScrollMapVisibleMessages(messages);

    expect(visible).toHaveLength(64);
    expect(visible[0]?.id).toBe("message-0");
    expect(visible.at(-1)?.id).toBe("message-199");
    expect(new Set(visible.map((candidate) => candidate.id)).size).toBe(64);
  });

  it("shows the rail only when both message content and the floating preview have clearance", () => {
    expect(chatScrollMapPlacement({
      anchorLeft: 415,
      viewportWidth: 1600,
      visibleContentLeft: 440,
    })).toEqual({ left: 415, visible: true });
    expect(chatScrollMapPlacement({
      anchorLeft: 415,
      viewportWidth: 920,
      visibleContentLeft: 440,
    })).toEqual({ left: 415, visible: false });
    expect(chatScrollMapPlacement({
      anchorLeft: 415,
      viewportWidth: 1600,
      visibleContentLeft: 438,
    })).toEqual({ left: 415, visible: false });
  });

  it("keeps markdown links intact and uses the next assistant reply as preview context", () => {
    const user = message("user", {
      body: `Inspect [the architecture plan](https://example.test/architecture) ${"carefully ".repeat(20)}`,
    });
    const assistant = message("assistant", {
      role: "assistant",
      body: "The plan preserves the modular monolith and adds explicit boundaries.",
    });
    const preview = chatScrollMapPreviewParts(user, [user, assistant]);

    expect(preview.title).toContain("](https://example.test/architecture)");
    expect(preview.title).toMatch(/\.\.\.$/);
    expect(preview.summary).toBe(assistant.body);
    expect(chatScrollMapMarkdownExcerpt("short text", 20)).toBe("short text");
  });

  it("keeps malformed markdown previews bounded and starts fallback summaries safely", () => {
    const malformed = `\`${"unclosed code ".repeat(100)}`;
    const excerpt = chatScrollMapMarkdownExcerpt(malformed, 40);
    expect(excerpt.length).toBeLessThanOrEqual(44);
    expect(excerpt).toMatch(/\.\.\.$/u);
    expect(excerpt).not.toContain("unclosed code ".repeat(4));
    expect(chatScrollMapMarkdownExcerpt(`\`${"closed code ".repeat(100)}\``, 40).length)
      .toBeLessThanOrEqual(44);

    const user = message("malformed-user", {
      body: `${"context ".repeat(14)}[Navigator](agent://agent-123/notionists-neutral) ${"tail ".repeat(100)}`,
    });
    const preview = chatScrollMapPreviewParts(user, [user]);
    expect(preview.summary.length).toBeLessThanOrEqual(184);
    expect(preview.summary).not.toContain("agent://");
  });

  it("renders one marker per visible message and delegates jumps by message id", () => {
    const onJump = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <div data-testid="chat-messages-scroll-region">
          <div data-testid="chat-messages-shell">
            <ChatScrollMap
              messages={[message("first"), message("hidden", { role: "assistant" }), message("second")]}
              onJump={onJump}
            />
          </div>
        </div>,
      );
    });

    expect(container.querySelectorAll('[data-testid^="chat-scroll-map-marker-"]')).toHaveLength(2);
    const second = container.querySelector<HTMLButtonElement>('[data-testid="chat-scroll-map-marker-second"]');
    act(() => second?.click());
    expect(onJump).toHaveBeenCalledWith("second");

    act(() => root.unmount());
  });
});
