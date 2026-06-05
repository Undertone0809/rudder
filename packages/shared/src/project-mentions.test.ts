import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
  extractAgentMentionIds,
  extractAgentWakeMentionIds,
  extractChatMentionIds,
  extractIssueMentionIds,
  extractLibraryDirectoryMentionPaths,
  extractLibraryDocMentionIds,
  extractLibraryFileMentionPaths,
  extractProjectMentionIds,
  parseAgentMentionHref,
  parseChatMentionHref,
  parseIssueMentionHref,
  parseLibraryDirectoryMentionHref,
  parseLibraryDocMentionHref,
  parseLibraryFileMentionHref,
  parseProjectMentionHref,
} from "./project-mentions.js";
import { PROJECT_COLORS } from "./constants.js";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Rudder App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips project mentions with gradient metadata", () => {
    const href = buildProjectMentionHref("project-123", PROJECT_COLORS[0]);
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: PROJECT_COLORS[0],
    });
    expect(extractProjectMentionIds(`[@Rudder App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: "code",
      intent: "reference",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
    expect(extractAgentWakeMentionIds(`[@CodexCoder](${href})`)).toEqual([]);
  });

  it("round-trips agent mentions with avatar metadata", () => {
    const icon = "dicebear:notionists:11111111-1111-4111-8111-111111111111?bg=mint";
    const href = buildAgentMentionHref("agent-123", icon);
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon,
      intent: "reference",
    });
  });

  it("extracts only wake-intent agent mentions for runtime wakeups", () => {
    const referenceHref = buildAgentMentionHref("agent-reference", "code");
    const wakeHref = buildAgentMentionHref("agent-wake", "code", "wake");

    expect(parseAgentMentionHref(wakeHref)).toEqual({
      agentId: "agent-wake",
      icon: "code",
      intent: "wake",
    });
    expect(extractAgentMentionIds(`[@Reference](${referenceHref}) [@Wake](${wakeHref})`))
      .toEqual(["agent-reference", "agent-wake"]);
    expect(extractAgentWakeMentionIds(`[@Reference](${referenceHref}) [@Wake](${wakeHref})`))
      .toEqual(["agent-wake"]);
  });

  it("round-trips issue mentions with identifier metadata", () => {
    const href = buildIssueMentionHref("issue-123", "PAP-123");
    expect(parseIssueMentionHref(href)).toEqual({
      issueId: "issue-123",
      ref: "PAP-123",
      commentId: null,
    });
    expect(extractIssueMentionIds(`[@PAP-123](${href})`)).toEqual(["issue-123"]);
  });

  it("round-trips issue mentions with comment anchors", () => {
    const href = buildIssueMentionHref("issue-123", "PAP-123", "comment-456");
    expect(href).toBe("issue://issue-123?r=PAP-123&c=comment-456");
    expect(parseIssueMentionHref(href)).toEqual({
      issueId: "issue-123",
      ref: "PAP-123",
      commentId: "comment-456",
    });
    expect(parseIssueMentionHref("issue://issue-123?ref=PAP-123&commentId=comment-456")).toEqual({
      issueId: "issue-123",
      ref: "PAP-123",
      commentId: "comment-456",
    });
  });

  it("round-trips chat mentions with title metadata", () => {
    const href = buildChatMentionHref("chat-123", "Launch planning");
    expect(parseChatMentionHref(href)).toEqual({
      conversationId: "chat-123",
      title: "Launch planning",
    });
    expect(extractChatMentionIds(`[@Launch planning](${href})`)).toEqual(["chat-123"]);
  });

  it("round-trips library doc mentions with title metadata", () => {
    const href = buildLibraryDocMentionHref("doc-123", "Product principles");
    expect(parseLibraryDocMentionHref(href)).toEqual({
      documentId: "doc-123",
      title: "Product principles",
    });
    expect(extractLibraryDocMentionIds(`[@Product principles](${href})`)).toEqual(["doc-123"]);
  });

  it("round-trips library file mentions with path metadata", () => {
    const href = buildLibraryFileMentionHref("docs/product-brief.md", "Product brief");
    expect(parseLibraryFileMentionHref(href)).toEqual({
      filePath: "docs/product-brief.md",
      title: "Product brief",
    });
    expect(extractLibraryFileMentionPaths(`[@Product brief](${href})`)).toEqual(["docs/product-brief.md"]);
  });

  it("round-trips library directory mentions with path metadata", () => {
    const href = buildLibraryDirectoryMentionHref("projects/rudder-mkt", "Rudder marketing");
    expect(parseLibraryDirectoryMentionHref(href)).toEqual({
      directoryPath: "projects/rudder-mkt",
      title: "Rudder marketing",
    });
    expect(extractLibraryDirectoryMentionPaths(`[@Rudder marketing](${href})`)).toEqual(["projects/rudder-mkt"]);
  });

  it("ignores mention-looking links inside markdown code", () => {
    expect(extractProjectMentionIds("`[@Project](project://id)` [@Real](project://project-123)"))
      .toEqual(["project-123"]);
    expect(extractAgentMentionIds("```md\n[@Agent](agent://id)\n```\n[@Real](agent://agent-123)"))
      .toEqual(["agent-123"]);
    expect(extractIssueMentionIds("`[@PAP-1](issue://id?r=PAP-1)` [@PAP-2](issue://issue-123?r=PAP-2)"))
      .toEqual(["issue-123"]);
    expect(extractChatMentionIds("`[@Chat](chat://chat-1)` [@Real](chat://chat-2)"))
      .toEqual(["chat-2"]);
    expect(extractLibraryDocMentionIds("`[@Doc](library-doc://doc-1)` [@Real](library-doc://doc-2)"))
      .toEqual(["doc-2"]);
    expect(extractLibraryFileMentionPaths(
      "`[@Doc](library-file://file?p=docs%2Fignored.md)` [@Real](library-file://file?p=docs%2Freal.md)",
    )).toEqual(["docs/real.md"]);
    expect(extractLibraryDirectoryMentionPaths(
      "`[@Dir](library-directory://directory?p=docs%2Fignored)` [@Real](library-directory://directory?p=docs%2Freal)",
    )).toEqual(["docs/real"]);
  });
});
