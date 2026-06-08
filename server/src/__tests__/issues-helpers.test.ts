import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  myLastCommentAtExpr,
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
