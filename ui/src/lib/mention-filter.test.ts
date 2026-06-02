import { describe, expect, it } from "vitest";
import { MENTION_OPTION_RENDER_LIMIT, filterMentionOptions } from "./mention-filter";
import type { MentionOption } from "@/components/MarkdownEditor";

describe("filterMentionOptions", () => {
  it("promotes matching Library markdown files before broad issue and chat matches", () => {
    const broadMatches: MentionOption[] = Array.from({ length: 8 }, (_, index) => ({
      id: `issue:${index}`,
      name: `RUD-${index} unrelated work`,
      kind: "issue",
      issueId: `issue-${index}`,
      searchText: `RUD-${index} unrelated work md`,
    }));
    const mentions: MentionOption[] = [
      ...broadMatches,
      {
        id: "chat:1",
        name: "flomo memo export",
        kind: "chat",
        chatConversationId: "chat-1",
        searchText: "flomo memo export active md",
      },
      {
        id: "library-file:docs/product.md",
        name: "product.md",
        kind: "library_file",
        libraryFilePath: "docs/product.md",
        searchText: "product.md docs/product.md",
      },
    ];

    const filtered = filterMentionOptions(mentions, "@", "md");

    expect(filtered[0]).toMatchObject({
      id: "library-file:docs/product.md",
      kind: "library_file",
    });
    expect(filtered).toHaveLength(10);
  });

  it("keeps enough matches for smooth menu scrolling without rendering unbounded result sets", () => {
    const mentions: MentionOption[] = Array.from({ length: MENTION_OPTION_RENDER_LIMIT + 20 }, (_, index) => ({
      id: `library-file:docs/result-${index}.md`,
      name: `result-${index}.md`,
      kind: "library_file",
      libraryFilePath: `docs/result-${index}.md`,
      searchText: `result-${index}.md docs/result-${index}.md`,
    }));

    const filtered = filterMentionOptions(mentions, "@", "md");

    expect(filtered).toHaveLength(MENTION_OPTION_RENDER_LIMIT);
    expect(filtered[0]?.id).toBe("library-file:docs/result-0.md");
    expect(filtered.at(-1)?.id).toBe(`library-file:docs/result-${MENTION_OPTION_RENDER_LIMIT - 1}.md`);
  });

  it("keeps dollar mentions scoped to skills", () => {
    const mentions: MentionOption[] = [
      {
        id: "issue:1",
        name: "Build issue",
        kind: "issue",
        issueId: "issue-1",
      },
      {
        id: "skill:build-advisor",
        name: "Build Advisor",
        kind: "skill",
        skillRefLabel: "$build-advisor",
        skillMarkdownTarget: "skill://build-advisor",
      },
    ];

    expect(filterMentionOptions(mentions, "$", "build")).toEqual([
      expect.objectContaining({ id: "skill:build-advisor" }),
    ]);
  });
});
