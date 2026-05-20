// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";
import { applyMention, isRudderTokenHref, mentionMarkdown, readCanonicalFragmentMarkdown } from "./MilkdownMarkdownEditor";
import type { MentionOption } from "./MarkdownEditor";

describe("MilkdownMarkdownEditor mention serialization", () => {
  it("keeps canonical Rudder mention markdown for all mention kinds", () => {
    const options: Array<{ option: MentionOption; expected: string }> = [
      {
        option: {
          id: "agent:agent-1",
          name: "Jade",
          kind: "agent",
          agentId: "agent-1",
          agentIcon: "bot",
        },
        expected: `[Jade](${buildAgentMentionHref("agent-1", "bot")}) `,
      },
      {
        option: {
          id: "issue:issue-1",
          name: "R-6",
          kind: "issue",
          issueId: "issue-1",
          issueIdentifier: "R-6",
        },
        expected: `[R-6](${buildIssueMentionHref("issue-1", "R-6")}) `,
      },
      {
        option: {
          id: "project:project-1",
          name: "Editor Migration",
          kind: "project",
          projectId: "project-1",
          projectColor: "#4f46e5",
        },
        expected: `[Editor Migration](${buildProjectMentionHref("project-1", "#4f46e5")}) `,
      },
      {
        option: {
          id: "chat:chat-1",
          name: "Launch planning",
          kind: "chat",
          chatConversationId: "chat-1",
          chatTitle: "Launch planning",
        },
        expected: `[Launch planning](${buildChatMentionHref("chat-1", "Launch planning")}) `,
      },
      {
        option: {
          id: "library-doc:doc-1",
          name: "Milkdown proposal",
          kind: "library_doc",
          libraryDocumentId: "doc-1",
          libraryDocumentTitle: "Milkdown proposal",
        },
        expected: `[Milkdown proposal](${buildLibraryDocMentionHref("doc-1", "Milkdown proposal")}) `,
      },
      {
        option: {
          id: "library-file:docs/editor.md",
          name: "docs/editor.md",
          kind: "library_file",
          libraryFilePath: "docs/editor.md",
        },
        expected: `[docs/editor.md](${buildLibraryFileMentionHref("docs/editor.md", "docs/editor.md")}) `,
      },
      {
        option: {
          id: "skill:writer",
          name: "Writer",
          kind: "skill",
          skillRefLabel: "$writer",
          skillMarkdownTarget: "skill://writer",
        },
        expected: "[$writer](skill://writer) ",
      },
    ];

    for (const { option, expected } of options) {
      expect(mentionMarkdown(option)).toBe(expected);
    }
  });

  it("recognizes Rudder mention and skill links as token links", () => {
    expect(isRudderTokenHref("agent://agent-1", "Jade")).toBe(true);
    expect(isRudderTokenHref("issue://issue-1?ref=R-1", "R-1")).toBe(true);
    expect(isRudderTokenHref("chat://chat-1?t=Launch", "Launch")).toBe(true);
    expect(isRudderTokenHref("project://project-1", "Project")).toBe(true);
    expect(isRudderTokenHref("library-doc://doc-1?t=Spec", "Spec")).toBe(true);
    expect(isRudderTokenHref("library-file://file?p=docs%2Fspec.md&t=spec.md", "spec.md")).toBe(true);
    expect(isRudderTokenHref("skill://writer", "$writer")).toBe(true);
    expect(isRudderTokenHref("/workspace/skills/build-advisor/SKILL.md", "$build-advisor")).toBe(true);
    expect(isRudderTokenHref("https://example.com", "Example")).toBe(false);
  });

  it("replaces the active repeated mention query instead of the last matching text", () => {
    const editable = document.createElement("div");
    const textNode = document.createTextNode("first @dyl second @dyl");
    editable.append(textNode);
    document.body.append(editable);

    const option: MentionOption = {
      id: "agent:agent-1",
      name: "Dylan",
      kind: "agent",
      agentId: "agent-1",
    };
    const markdown = applyMention(
      "first @dyl second @dyl",
      {
        trigger: "@",
        query: "dyl",
        top: 0,
        left: 0,
        viewportTop: 0,
        viewportBottom: 0,
        viewportLeft: 0,
        textNode,
        atPos: 6,
        endPos: 10,
      },
      option,
      editable,
    );

    expect(markdown).toBe(`first [Dylan](${buildAgentMentionHref("agent-1", null)}) second @dyl`);
    editable.remove();
  });

  it("copies selected Rudder token links as canonical Markdown", () => {
    const fragment = document.createDocumentFragment();
    fragment.append("Ask ");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "agent://agent-1");
    anchor.textContent = "Jade";
    fragment.append(anchor);
    fragment.append(" today");

    expect(readCanonicalFragmentMarkdown(fragment)).toBe("Ask [Jade](agent://agent-1) today");
  });
});
