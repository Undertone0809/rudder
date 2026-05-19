import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildIssueMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";
import { mentionMarkdown } from "./MilkdownMarkdownEditor";
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
});
