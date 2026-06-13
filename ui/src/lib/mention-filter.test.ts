import type { MentionOption } from "@/components/MarkdownEditor";
import { describe, expect, it } from "vitest";
import { MENTION_OPTION_RENDER_LIMIT, filterMentionOptions } from "./mention-filter";

describe("filterMentionOptions", () => {
  it("keeps entity search results in the requested mention type order", () => {
    const mentions: MentionOption[] = [
      {
        id: "chat:1",
        name: "Deploy",
        kind: "chat",
        chatConversationId: "chat-1",
      },
      {
        id: "issue:1",
        name: "Deploy rollout",
        kind: "issue",
        issueId: "issue-1",
      },
      {
        id: "project:1",
        name: "Deploy project",
        kind: "project",
        projectId: "project-1",
      },
      {
        id: "skill:1",
        name: "Deploy skill",
        kind: "skill",
        skillRefLabel: "deploy-skill",
        skillMarkdownTarget: "/skills/deploy-skill/SKILL.md",
      },
      {
        id: "agent:1",
        name: "Deploy agent",
        kind: "agent",
        agentId: "agent-1",
      },
    ];

    expect(filterMentionOptions(mentions, "@", "deploy").map((option) => option.id)).toEqual([
      "agent:1",
      "skill:1",
      "project:1",
      "issue:1",
      "chat:1",
    ]);
  });

  it("promotes matching Library entries before broad issue and chat matches", () => {
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
        id: "library-directory:projects/rudder-mkt",
        name: "Rudder marketing",
        kind: "library_directory",
        libraryDirectoryPath: "projects/rudder-mkt",
        searchText: "Rudder marketing projects/rudder-mkt",
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
    expect(filterMentionOptions(mentions, "@", "rudder").map((option) => option.id)).toContain(
      "library-directory:projects/rudder-mkt",
    );
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
