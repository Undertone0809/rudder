// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildChatMentionHref } from "@rudderhq/shared";
import { applyMentionChipDecoration, mentionChipInlineStyle, parseMentionChipHref, stripMentionChipLabelPrefix } from "./mention-chips";

describe("mention chips", () => {
  it("strips the legacy visible at-prefix from mention labels", () => {
    expect(stripMentionChipLabelPrefix("@rudder dev")).toBe("rudder dev");
    expect(stripMentionChipLabelPrefix("rudder dev")).toBe("rudder dev");
  });

  it("normalizes decorated legacy mention link text", () => {
    const element = document.createElement("a");
    element.textContent = "@rudder dev";

    applyMentionChipDecoration(element, {
      kind: "project",
      projectId: "project-123",
      color: "#336699",
    });

    expect(element.textContent).toBe("rudder dev");
    expect(element.dataset.mentionKind).toBe("project");
  });

  it("parses chat mention links for inline token rendering", () => {
    expect(parseMentionChipHref(buildChatMentionHref("chat-123"))).toEqual({
      kind: "chat",
      conversationId: "chat-123",
    });
  });

  it("keeps project color as an identity marker instead of restyling the whole chip", () => {
    const style = mentionChipInlineStyle({
      kind: "project",
      projectId: "project-123",
      color: "#336699",
    }) as Record<string, string>;

    expect(style["--rudder-mention-project-color"]).toBe("#336699");
    expect(style.color).toBeUndefined();
    expect(style.borderColor).toBeUndefined();
    expect(style.backgroundColor).toBeUndefined();
  });
});
