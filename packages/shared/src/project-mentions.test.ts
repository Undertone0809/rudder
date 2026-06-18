import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildAutomationMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryEntryMentionHref,
  buildLibraryEntryMentionMarkdown,
  buildLibraryFileMentionHref,
  buildLibraryFileMentionMarkdown,
  buildProjectMentionHref,
  extractAgentMentionIds,
  extractAgentWakeMentionIds,
  extractAutomationMentionIds,
  extractChatMentionIds,
  extractIssueMentionIds,
  extractLibraryDirectoryMentionPaths,
  extractLibraryDocMentionIds,
  extractLibraryEntryMentionIds,
  extractLibraryFileMentionPaths,
  extractProjectMentionIds,
  parseAgentMentionHref,
  parseAutomationMentionHref,
  parseChatMentionHref,
  parseIssueMentionHref,
  parseLibraryDirectoryMentionHref,
  parseLibraryDocMentionHref,
  parseLibraryEntryMentionHref,
  parseLibraryFileMentionHref,
  parseProjectMentionHref,
} from "./project-mentions.js";

describe("project-mentions", () => {
  it("builds project mentions with only the stable project id", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(href).toBe("project://project-123");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: null,
    });
    expect(extractProjectMentionIds(`[@Rudder App](${href})`)).toEqual(["project-123"]);
  });

  it("parses legacy project display metadata without treating it as identity", () => {
    const href = "project://project-123?c=336699&i=plane";
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: null,
    });
    expect(extractProjectMentionIds(`[@Rudder App](${href})`)).toEqual(["project-123"]);
  });

  it("builds agent mentions with only the stable agent id", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(href).toBe("agent://agent-123");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: null,
      intent: "reference",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
    expect(extractAgentWakeMentionIds(`[@CodexCoder](${href})`)).toEqual([]);
  });

  it("builds automation mentions with only the stable automation id", () => {
    const href = buildAutomationMentionHref("automation-123", "Morning review");
    expect(href).toBe("automation://automation-123");
    expect(parseAutomationMentionHref(href)).toEqual({
      automationId: "automation-123",
      title: null,
    });
    expect(extractAutomationMentionIds(`[@Morning review](${href})`)).toEqual(["automation-123"]);
  });

  it("parses legacy agent icon metadata without treating it as identity", () => {
    const href = "agent://agent-123?i=dicebear%3Anotionists%3A11111111-1111-4111-8111-111111111111%3Fbg%3Dmint";
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: null,
      intent: "reference",
    });
  });

  it("extracts only wake-intent agent mentions for runtime wakeups", () => {
    const referenceHref = buildAgentMentionHref("agent-reference", "code");
    const wakeHref = buildAgentMentionHref("agent-wake", "code", "wake");

    expect(parseAgentMentionHref(wakeHref)).toEqual({
      agentId: "agent-wake",
      icon: null,
      intent: "wake",
    });
    expect(extractAgentMentionIds(`[@Reference](${referenceHref}) [@Wake](${wakeHref})`))
      .toEqual(["agent-reference", "agent-wake"]);
    expect(extractAgentWakeMentionIds(`[@Reference](${referenceHref}) [@Wake](${wakeHref})`))
      .toEqual(["agent-wake"]);
  });

  it("builds issue mentions with only the stable issue id", () => {
    const href = buildIssueMentionHref("issue-123", "PAP-123");
    expect(href).toBe("issue://issue-123");
    expect(parseIssueMentionHref(href)).toEqual({
      issueId: "issue-123",
      ref: null,
      commentId: null,
      status: null,
    });
    expect(extractIssueMentionIds(`[@PAP-123](${href})`)).toEqual(["issue-123"]);
  });

  it("round-trips issue mentions with comment anchors", () => {
    const href = buildIssueMentionHref("issue-123", "PAP-123", "comment-456");
    expect(href).toBe("issue://issue-123?c=comment-456");
    expect(parseIssueMentionHref(href)).toEqual({
      issueId: "issue-123",
      ref: null,
      commentId: "comment-456",
      status: null,
    });
    expect(parseIssueMentionHref("issue://issue-123?ref=PAP-123&commentId=comment-456")).toEqual({
      issueId: "issue-123",
      ref: null,
      commentId: "comment-456",
      status: null,
    });
  });

  it("does not emit or parse issue status display metadata", () => {
    const href = buildIssueMentionHref("issue-123", "PAP-123", null, "in_review");
    expect(href).toBe("issue://issue-123");
    expect(parseIssueMentionHref(href)).toEqual({
      issueId: "issue-123",
      ref: null,
      commentId: null,
      status: null,
    });
    expect(parseIssueMentionHref("issue://issue-123?ref=PAP-123&status=blocked")).toEqual({
      issueId: "issue-123",
      ref: null,
      commentId: null,
      status: null,
    });
  });

  it("builds chat mentions with only the stable conversation id", () => {
    const href = buildChatMentionHref("chat-123", "Launch planning");
    expect(href).toBe("chat://chat-123");
    expect(parseChatMentionHref(href)).toEqual({
      conversationId: "chat-123",
      title: null,
    });
    expect(extractChatMentionIds(`[@Launch planning](${href})`)).toEqual(["chat-123"]);
  });

  it("builds library doc mentions with only the stable document id", () => {
    const href = buildLibraryDocMentionHref("doc-123", "Product principles");
    expect(href).toBe("library-doc://doc-123");
    expect(parseLibraryDocMentionHref(href)).toEqual({
      documentId: "doc-123",
      title: null,
    });
    expect(extractLibraryDocMentionIds(`[@Product principles](${href})`)).toEqual(["doc-123"]);
  });

  it("builds library entry mentions with the stable entry id and optional path hint", () => {
    const href = buildLibraryEntryMentionHref("entry-123", "Product brief", "projects/rudder/product-brief.md");
    expect(href).toBe("library-entry://entry-123?p=projects%2Frudder%2Fproduct-brief.md");
    expect(parseLibraryEntryMentionHref(href)).toEqual({
      entryId: "entry-123",
      title: null,
      path: "projects/rudder/product-brief.md",
    });
    expect(extractLibraryEntryMentionIds(`[@Product brief](${href})`)).toEqual(["entry-123"]);
  });

  it("builds library mention markdown without requiring agents to hand-write URLs", () => {
    expect(buildLibraryEntryMentionMarkdown("entry-123", "Product [brief]", "projects/rudder/product-brief.md"))
      .toBe("[Product \\[brief\\]](library-entry://entry-123?p=projects%2Frudder%2Fproduct-brief.md)");
    expect(buildLibraryFileMentionMarkdown("projects/rudder/product-brief.md", "Product brief"))
      .toBe("[Product brief](library-file://file?p=projects%2Frudder%2Fproduct-brief.md)");
  });

  it("round-trips library file mentions with the stable file path identity", () => {
    const href = buildLibraryFileMentionHref("docs/product-brief.md", "Product brief");
    expect(parseLibraryFileMentionHref(href)).toEqual({
      filePath: "docs/product-brief.md",
      title: null,
    });
    expect(extractLibraryFileMentionPaths(`[@Product brief](${href})`)).toEqual(["docs/product-brief.md"]);
  });

  it("round-trips library directory mentions with the stable directory path identity", () => {
    const href = buildLibraryDirectoryMentionHref("projects/rudder-mkt", "Rudder marketing");
    expect(parseLibraryDirectoryMentionHref(href)).toEqual({
      directoryPath: "projects/rudder-mkt",
      title: null,
    });
    expect(extractLibraryDirectoryMentionPaths(`[@Rudder marketing](${href})`)).toEqual(["projects/rudder-mkt"]);
  });

  it("ignores mention-looking links inside markdown code", () => {
    expect(extractProjectMentionIds("`[@Project](project://id)` [@Real](project://project-123)"))
      .toEqual(["project-123"]);
    expect(extractAgentMentionIds("```md\n[@Agent](agent://id)\n```\n[@Real](agent://agent-123)"))
      .toEqual(["agent-123"]);
    expect(extractAutomationMentionIds("`[@Automation](automation://automation-1)` [@Real](automation://automation-2)"))
      .toEqual(["automation-2"]);
    expect(extractIssueMentionIds("`[@PAP-1](issue://id?r=PAP-1)` [@PAP-2](issue://issue-123?r=PAP-2)"))
      .toEqual(["issue-123"]);
    expect(extractChatMentionIds("`[@Chat](chat://chat-1)` [@Real](chat://chat-2)"))
      .toEqual(["chat-2"]);
    expect(extractLibraryDocMentionIds("`[@Doc](library-doc://doc-1)` [@Real](library-doc://doc-2)"))
      .toEqual(["doc-2"]);
    expect(extractLibraryEntryMentionIds("`[@Doc](library-entry://entry-1)` [@Real](library-entry://entry-2)"))
      .toEqual(["entry-2"]);
    expect(extractLibraryFileMentionPaths(
      "`[@Doc](library-file://file?p=docs%2Fignored.md)` [@Real](library-file://file?p=docs%2Freal.md)",
    )).toEqual(["docs/real.md"]);
    expect(extractLibraryDirectoryMentionPaths(
      "`[@Dir](library-directory://directory?p=docs%2Fignored)` [@Real](library-directory://directory?p=docs%2Freal)",
    )).toEqual(["docs/real"]);
  });
});
