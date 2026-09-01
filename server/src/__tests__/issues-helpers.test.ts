import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  myLastCommentAtExpr,
  resolveIdempotentIssueOrigin,
  touchedByUserCondition,
  unreadForUserCondition,
} from "../services/issues.helpers";

const dialect = new PgDialect();

function compileSql(value: Parameters<typeof dialect.sqlToQuery>[0]) {
  return dialect.sqlToQuery(value).sql;
}

describe("issue helper predicates", () => {
  it("maps idempotent Issue origins to their unique constraints", () => {
    expect(resolveIdempotentIssueOrigin("agent_issue_creation", "request-1")).toEqual({
      kind: "agent_issue_creation",
      id: "request-1",
      constraint: "issues_agent_issue_creation_origin_uq",
    });
    expect(resolveIdempotentIssueOrigin("run_debug", "run-1")).toEqual({
      kind: "run_debug",
      id: "run-1",
      constraint: "issues_run_debug_origin_uq",
    });
    expect(resolveIdempotentIssueOrigin("manual", "manual-1")).toBeNull();
    expect(resolveIdempotentIssueOrigin("run_debug", null)).toBeNull();
  });

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
