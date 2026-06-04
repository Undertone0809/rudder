// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyMentionChipDecoration,
  mentionChipInlineStyle,
  mentionChipNavigationPath,
  parseMentionChipHref,
  stripMentionChipLabelPrefix,
} from "./mention-chips";

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

  it("uses agent avatar images when an agent mention has an image-backed icon", () => {
    const style = mentionChipInlineStyle({
      kind: "agent",
      agentId: "agent-123",
      icon: "asset:11111111-1111-4111-8111-111111111111?bg=sky",
    }) as Record<string, string>;

    expect(style["--rudder-mention-agent-avatar-background"]).toContain("/api/assets/11111111-1111-4111-8111-111111111111/content");
    expect(style["--rudder-mention-agent-avatar-shell-background"]).toContain("#bae6fd");
    expect(style["--rudder-mention-icon-mask"]).toBe("none");
  });

  it("parses and decorates library document mention links", () => {
    expect(parseMentionChipHref("library-doc://doc-123?t=Product%20principles")).toEqual({
      kind: "library_doc",
      documentId: "doc-123",
      title: "Product principles",
    });

    const element = document.createElement("a");
    element.textContent = "@Product principles";
    applyMentionChipDecoration(element, {
      kind: "library_doc",
      documentId: "doc-123",
      title: "Product principles",
    });

    expect(element.textContent).toBe("Product principles");
    expect(element.dataset.mentionKind).toBe("library_doc");
    expect(element.classList.contains("rudder-mention-chip--library_doc")).toBe(true);
  });

  it("parses and decorates chat mention links", () => {
    expect(parseMentionChipHref("chat://chat-123?t=Launch%20planning")).toEqual({
      kind: "chat",
      conversationId: "chat-123",
      title: "Launch planning",
    });

    const element = document.createElement("a");
    element.textContent = "@Launch planning";
    applyMentionChipDecoration(element, {
      kind: "chat",
      conversationId: "chat-123",
      title: "Launch planning",
    });

    expect(element.textContent).toBe("Launch planning");
    expect(element.dataset.mentionKind).toBe("chat");
    expect(element.classList.contains("rudder-mention-chip--chat")).toBe(true);
  });

  it("parses, decorates, and navigates issue comment mention links", () => {
    const mention = parseMentionChipHref("issue://issue-123?r=RUD-123&c=comment-456");
    expect(mention).toEqual({
      kind: "issue",
      issueId: "issue-123",
      ref: "RUD-123",
      commentId: "comment-456",
    });

    expect(mention ? mentionChipNavigationPath(mention) : null).toBe("/issues/RUD-123#comment-comment-456");

    const element = document.createElement("a");
    element.textContent = "Issue comment comment-";
    applyMentionChipDecoration(element, {
      kind: "issue",
      issueId: "issue-123",
      ref: "RUD-123",
      commentId: "comment-456",
    });

    expect(element.dataset.mentionKind).toBe("issue");
    expect(element.classList.contains("rudder-mention-chip--issue")).toBe(true);
  });

  it("parses and decorates library file mention links", () => {
    expect(parseMentionChipHref("library-file://file?p=docs%2Fproduct-brief.md&t=Product%20brief")).toEqual({
      kind: "library_file",
      filePath: "docs/product-brief.md",
      title: "Product brief",
    });

    const element = document.createElement("a");
    element.textContent = "@product-brief.md";
    applyMentionChipDecoration(element, {
      kind: "library_file",
      filePath: "docs/product-brief.md",
      title: "Product brief",
    });

    expect(element.textContent).toBe("product-brief.md");
    expect(element.dataset.mentionKind).toBe("library_file");
    expect(element.classList.contains("rudder-mention-chip--library_file")).toBe(true);
  });

  it("parses and decorates library directory mention links", () => {
    expect(parseMentionChipHref("library-directory://directory?p=projects%2Frudder-mkt&t=Rudder%20marketing")).toEqual({
      kind: "library_directory",
      directoryPath: "projects/rudder-mkt",
      title: "Rudder marketing",
    });

    const element = document.createElement("a");
    element.textContent = "@Rudder marketing";
    applyMentionChipDecoration(element, {
      kind: "library_directory",
      directoryPath: "projects/rudder-mkt",
      title: "Rudder marketing",
    });

    expect(element.textContent).toBe("Rudder marketing");
    expect(element.dataset.mentionKind).toBe("library_directory");
    expect(element.classList.contains("rudder-mention-chip--library_directory")).toBe(true);
  });
});
