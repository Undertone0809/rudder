import { describe, expect, it, vi } from "vitest";
import { aiSearchService } from "./ai-search.js";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("./product-intelligence.js", () => ({
  productIntelligenceService: () => ({ execute: executeMock }),
}));

vi.mock("./title-generation.js", () => ({
  runtimeResultText: (result: { text: string }) => result.text,
}));

function createDbStub(results: unknown[][]) {
  let selectIndex = 0;
  const select = vi.fn(() => {
    const result = results[selectIndex++] ?? [];
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(async () => result),
    };
    return query;
  });
  return { select };
}

describe("aiSearchService", () => {
  it("limits Smart Model candidates to the selected search scope", async () => {
    executeMock.mockResolvedValue({
      text: JSON.stringify({
        answer: "The issue matches.",
        matches: [{ key: "issue:issue-1", reason: "Issue scope match" }],
      }),
    });
    const db = createDbStub([
      [{ id: "issue-1", identifier: "RUD-1", title: "Issue match", description: "Issue content" }],
      [{ id: "chat-1", title: "Chat decoy", summary: "Chat content" }],
      [],
      [{ id: "project-1", name: "Project decoy", description: "Project content", status: "planned" }],
      [],
      [],
      [],
      [],
    ]);

    const response = await aiSearchService(db as never).search("org-1", "find issue", "issue");

    expect(response.results).toEqual([expect.objectContaining({ key: "issue:issue-1" })]);
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ searchScope: "issue" }),
      prompt: expect.stringContaining('"key":"issue:issue-1"'),
    }));
    expect(executeMock.mock.calls[0]?.[0].prompt).not.toContain("chat:chat-1");
    expect(executeMock.mock.calls[0]?.[0].prompt).not.toContain("project:project-1");
  });
});
