import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  myLastCommentAtExpr,
  normalizeIssueListLimit,
  normalizeIssueListOffset,
  normalizeIssueSearchFields,
  touchedByUserCondition,
  unreadForUserCondition,
} from "../services/issues.helpers";

const dialect = new PgDialect();

function compileSql(value: Parameters<typeof dialect.sqlToQuery>[0]) {
  return dialect.sqlToQuery(value).sql;
}

describe("issue helper predicates", () => {
  it("ignores soft-deleted comments when deriving user touch and unread state", () => {
    expect(compileSql(touchedByUserCondition("org-1", "user-1"))).toContain(
      '"issue_comments"."deleted_at" IS NULL',
    );
    expect(compileSql(myLastCommentAtExpr("org-1", "user-1"))).toContain(
      '"issue_comments"."deleted_at" IS NULL',
    );
    expect(compileSql(unreadForUserCondition("org-1", "user-1"))).toContain(
      '"issue_comments"."deleted_at" IS NULL',
    );
  });
});

describe("issue list input normalization", () => {
  it("keeps supported search fields and falls back to title", () => {
    expect([...normalizeIssueSearchFields(["description", "comment", "title"])]).toEqual([
      "description",
      "comment",
      "title",
    ]);
    expect([...normalizeIssueSearchFields([])]).toEqual(["title"]);
    expect([...normalizeIssueSearchFields(undefined)]).toEqual(["title"]);
  });

  it("bounds limits and rejects non-positive or non-finite pagination values", () => {
    expect(normalizeIssueListLimit(12.8)).toBe(12);
    expect(normalizeIssueListLimit(900)).toBe(500);
    expect(normalizeIssueListLimit(0)).toBeUndefined();
    expect(normalizeIssueListLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeIssueListOffset(4.8)).toBe(4);
    expect(normalizeIssueListOffset(-1)).toBeUndefined();
    expect(normalizeIssueListOffset(Number.NaN)).toBeUndefined();
  });
});
