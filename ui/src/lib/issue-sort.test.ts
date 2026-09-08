import type { Issue } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { compareIssueText, sortIssues } from "./issue-sort";

const baseIssue = {
  id: "issue-1",
  identifier: "RUD-1",
  title: "Issue",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-02T00:00:00.000Z"),
} as Issue;

function issue(overrides: Partial<Issue>): Issue {
  return { ...baseIssue, ...overrides };
}

describe("issue sorting", () => {
  it("uses the same raw lexical order for punctuation, case, and Unicode text", () => {
    const values = [
      "😀 emoji",
      "same title",
      "中 文",
      "éclair",
      "alpha",
      "Alpha",
      "! punctuation",
      "\u{10000} astral",
      "\uE000 BMP",
    ];

    expect([...values].sort(compareIssueText)).toEqual([
      "! punctuation",
      "Alpha",
      "alpha",
      "same title",
      "éclair",
      "中 文",
      "\uE000 BMP",
      "\u{10000} astral",
      "😀 emoji",
    ]);
  });

  it("uses the stable identifier tie-breaker across page boundaries", () => {
    const issues = [
      issue({ id: "issue-a", identifier: "case-a", title: "same title" }),
      issue({ id: "issue-b", identifier: "!case-b", title: "same title" }),
      issue({ id: "issue-c", identifier: "Case-c", title: "same title" }),
      issue({ id: "issue-d", identifier: "中-case-d", title: "same title" }),
    ];

    expect(sortIssues(issues, { sortField: "title", sortDir: "asc" }).map((item) => item.identifier)).toEqual([
      "!case-b",
      "Case-c",
      "case-a",
      "中-case-d",
    ]);
  });
});
